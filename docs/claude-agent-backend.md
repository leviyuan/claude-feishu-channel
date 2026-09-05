# 后端与模型路由

Lodestar 通过 `AgentProcess` 接口连接 Codex app-server 和 Claude Agent SDK。`Session` 负责群会话、消息排队和卡片；具体进程类负责协议转换。主会话和委派 Agent 共用 `agent-launch.ts` 的启动入口。

## 进程与会话

| 行为 | Codex | Claude、GLM、DeepSeek |
| --- | --- | --- |
| 进程 | `codex app-server --listen stdio://`，通过 JSON-RPC 通信 | SDK `query()`，通过 `AsyncIterable<SDKUserMessage>` 连续输入 |
| 初始化 | 等待初始化和 thread 启动事务完成 | 首条输入才触发 `system/init`；启动时只检查早期错误 |
| 恢复与分叉 | `thread/list`、`thread/fork(lastTurnId)` | 同目录 transcript、`forkSession`、`resumeSessionAt` |
| 澄清提问 | `item/tool/requestUserInput` | `canUseTool` 中处理 `AskUserQuestion` |
| 主动压缩 | `thread/compact/start` | 向 streaming input 发送 `/compact`，等待 `compact_boundary` |
| 后台任务 | app-server collab 子 Agent 事件 | SDK `task_*` 事件 |

会话引用包含 provider、原生 session id 和 cwd。两种后端分别保存恢复记录，切换后端不会共用同一段上下文。Claude fork 在首条输入前持久保存启动意图，获得新 session id 后才清除；历史会话通过原生 fork 接入新群，避免两个群写同一个会话。

主动压缩没有固定完成时限，以完成事件为准，进程退出或报错时失败。Claude 明确返回 `Not enough messages to compact` 时视为无需压缩，普通 `result` 事件不能代替完成通知。

## 账号和模型

Token Source 管理账号凭据、模型目录、启动环境、默认模型、effort 和额度。内置来源如下：

| 来源 | 配置和模型目录 |
| --- | --- |
| Codex subscription | 使用 Codex 登录态，模型来自 app-server `model/list` |
| GLM Coding Plan | `[token_source.glm]` 或本机 Claude settings；模型来自兼容端点，可补录已验证模型 |
| DeepSeek | `[token_source.deepseek]` 或本机 Claude settings；模型来自兼容端点，可补录已验证模型 |
| Claude native | 沿用本机 Claude 配置，提供 SDK aliases；有其他已启用的 Claude 侧来源时让位 |

`model` 面板按账号 → 模型 → effort 展示，获取失败显示 `MISS`。同 provider/source 的切换调用 `setModelSettings`：Claude 从后续 turn 使用，Codex 保存选择并在重启进程后应用。跨 provider/source 或需要变更项目启动配置时，只能在空闲状态更换进程。

`[claude.models.<name>].model` 保留旧 `claude:<name>` 路由的解析。账号、显示名和模型目录由 Token Source 管理；Claude 槽位映射使用账号的 `slots`。

## Claude 启动配置

GLM、DeepSeek 等来源先清除冲突的 Anthropic 环境变量，再注入各自凭据；默认读取 `project`、`local` settings。Claude native 沿用本机环境并读取 `user`、`project`、`local`。Token Source 指定的 settings 来源优先；未绑定 Token Source 时才使用项目 `setting_sources`。给注入凭据的来源加上 `user` 会重新引入本机 settings 中的路由。

`[projects.<name>]` 的 `cwd` 对两个后端生效；`tools`、`setting_sources`、`strict_mcp`、`load_project_mcp` 用于 Claude。主会话默认发现项目 `.mcp.json`。排除 user settings 的 Claude 会话通过 SDK 本地插件加载 daemon 管理的 Skill，安装内容统一由 `managed-skills.ts` 生成。

`[claude].bin` 可指定包装器，路径无效时启动失败。未指定时由 `resolveClaudeExecutableConfig()` 查找本机 Claude 或 SDK native binary，Windows `.cmd`/`.bat` 通过 shell shim 启动。

Claude 使用 `permissionMode: default`：普通工具在 `canUseTool` 中放行，`AskUserQuestion` 等待用户回答。不能改成 `bypassPermissions`，否则 SDK 会绕开提问回调。

## 事件和委派

`claude-agent-process.ts` 将 SDK 文本、工具、结果、用量、压缩和后台任务转换成 `AgentProcess` 事件。共享事件由 Session 和卡片消费，保留两种后端在初始化、上下文和后台任务上的差异。

委派 Agent 使用完整工具集和项目 MCP，并拥有独立、可撤销的调用凭据。`AgentService` 负责并发、父子运行关系、输入回填、原生会话续跑和递归取消。运行状态原子落盘，大段输入输出单独存放；委派会话登记后从主群的历史列表中排除。

## 源码与验证

- 启动与协议：`src/agent-launch.ts`、`src/agent-process.ts`、`src/codex-process.ts`、`src/claude-agent-process.ts`。
- 路由与配置：`src/token-source*.ts`、`src/session-model.ts`、`src/config.ts`、`src/claude-models.ts`。
- 会话分支：`src/conversation.ts`、`src/session-temp.ts`、`src/temp-session-runtime.ts`、`src/feishu.ts`。
- 委派：`src/agent-service.ts`、`src/agent-runner.ts`、`src/agent-session-registry.ts`。

本地检查使用 `bun run typecheck`、`bun test` 和 `bun run build`。真实后端与飞书交互需要单独指定账号、目标群和允许的副作用；历史探针结果不代表当前版本已完成线上验证。
