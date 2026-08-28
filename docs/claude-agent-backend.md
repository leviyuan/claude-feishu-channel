# Claude Agent SDK Backend Memo

## Goal
让 Lodestar 在保留 Codex 支持的同时，可以把非 GPT 模型交给 Claude Agent SDK 执行。外层飞书群、Card Kit、`hi` / `stop` / `restart` / `model` 等会话体验保持不变；差异只落在 session 后端进程。

## Confirmed Facts
- 不能使用 `claude -p` 作为每轮一次的命令。
- Claude Agent SDK 的推荐长驻模式是 `query({ prompt: AsyncIterable<SDKUserMessage> })`，它会启动一个 Claude Code SDK transport 进程，并通过 `--input-format stream-json` / `--output-format stream-json` 做双向流。
- 本机 SDK 长驻探针已验证：同一个 `query()` 后端可连续处理多轮 user message，并保持同一个 `session_id`。
- SDK 在没有第一条用户输入时不会发 `init`；收到第一条 input 后才返回 `system/init`。
- 本机 Claude Code 已可用，当前上游由用户侧配置路由到 GLM-5.2。SDK 需要 `settingSources: ['user']` 才会读取用户配置。

## Design
新增一个 Lodestar 内部后端接口，让 `Session` 不直接依赖 `CodexProcess` 的具体类：

- `CodexProcess` 继续负责 GPT / Codex app-server。
- `ClaudeAgentProcess` 负责 Claude Agent SDK streaming input。
- `model` 命令仍展示 Codex app-server 返回的 GPT 模型，同时追加 Claude 后端选项：
  - `claude:default`：不注入模型 profile，使用本机 Claude Code / OMC 当前配置。
  - `claude:glm`：通过 env 把 opus / sonnet / haiku 映射为 `5.2` / `5.2` / `4.7`。
  - `claude:deepseek`：通过 env 把 opus / sonnet / haiku 映射为 `DeepSeekv4pro` / `v4pro` / `v4flash`。
- 持久化模型选择扩展为 provider-aware，旧数据默认视为 Codex。
- 会话 resume id 也按 provider 分开保存，避免 Claude session id 覆盖 Codex thread id。
- `[[askusr: ...]]` 是 Codex 专属 host marker；Claude 不消费这个 marker，Claude 需要问用户时走 SDK 自己的 `AskUserQuestion` / `request_user_dialog` 路径。

## Claude Model Profiles
内置 profile 位于 `src/claude-models.ts`，也可在 `config.toml` 中覆盖或新增：

```toml
[claude.models.glm]
display_name = "Claude Code · GLM"
opus = "5.2"
sonnet = "5.2"
haiku = "4.7"

[claude.models.deepseek]
display_name = "Claude Code · DeepSeek"
opus = "DeepSeekv4pro"
sonnet = "v4pro"
haiku = "v4flash"
```

模型路由的真相源是 `~/.claude/settings.json`(SDK 经 `settingSources:['user']` 读取):`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_DEFAULT_OPUS_MODEL` 等都在那里配。Lodestar 不再注入这些 env,`[claude.env]` 仅作可选 escape hatch。

可执行文件解析:`resolveClaudeExecutableConfig()` 默认自动查找 `claude`(`~/.local/npm-global/bin` → `~/.local/bin` → PATH → SDK 自带)。`config.toml` 设 `[claude].bin`(支持 `~`)可显式覆盖,用于 reclaude 这类参数透传包装器;路径不存在时 `sendInitialize` 直接抛错,不静默回退。日志 `executable=config:<路径>` 确认生效。

主线程 SDK `model` 不直传 `5.2` / `v4pro` 这类上游模型代码,而是传 `opus` 档位 alias,Claude Code 再按 settings.json 的 `ANTHROPIC_DEFAULT_*_MODEL` 路由。实际 smoke 证明直传 `5.2` 会返回 “模型不存在”。

## Claude Event Mapping
`ClaudeAgentProcess` 把 SDK message 映射为现有 Session 已会处理的事件：

- `system/init` -> `init`
- assistant text block -> `assistant_text` + `assistant_block_stop`
- assistant `tool_use` block -> `tool_use`
- user `tool_result` message -> `tool_result`
- `result` -> `token_usage` + `result`
- `system/compact_boundary` -> `context_compacted`

权限：Codex 侧走 SDK `canUseTool` callback，callback 挂起并 emit `can_use_tool` 给 Session，飞书按钮回调再通过 `sendPermissionResponse()` resolve。Claude 侧 `bypassPermissions` 全自动，`canUseTool` 不触发（无审批 UI 死代码）；其 `askUserQuestion` 走 `onUserDialog`，同样 emit `can_use_tool` 给 Session 处理。

Claude 自带 ask 工具额外接了 SDK `onUserDialog`：

- 声明 `supportedDialogKinds = ask_user_question | askUserQuestion | AskUserQuestion`。
- 将 dialog payload 规范化成现有 `AskUserQuestion` 卡片的 `questions` 结构。
- 先登记 pending control，再 emit `tool_use` / `can_use_tool`，避免同步回包 race。
- 用户点击选项或群里回复后，仍通过 `updatedInput.answers` 回填给 SDK。

## First Version Scope
- 支持 Claude backend 普通任务执行、工具展示、工具结果展示、打断、停止、重启、模型切换。
- 支持 Claude usage / cost / context window 在 footer 展示。
- 跨 Codex / Claude provider 切换只在空闲或下次启动边界生效；当前 turn 或排队消息存在时直接拒绝。
- `compact` 只对 Codex app-server 生效；Claude backend 明确返回不支持，不做静默替代。
- host-side `[[askusr: ...]]` 只对 Codex 生效；Claude 使用 SDK ask，不混用 Codex marker。
- 不重启 live daemon；代码变更后只报告需要重启。

## Codex Parity Audit
以改动前 Codex 行为为基线逐项对照：

- 启动与恢复：Codex 仍走 `codex app-server --listen stdio://`，仍检查 `codex login`，仍等待 app-server `init` 后把 session 置为 ready；`restart` 仍用 Codex thread id 恢复。
- turn 调度：Codex 的 eager-open、cold-start、mid-turn buffer、OneSecond reaction、stop interrupt、result 后 drain 逻辑保持同一条 Session 路径；不会在当前 turn 中途迁移到 Claude。
- 模型选择：Codex 模型列表仍来自 app-server `model/list`，Codex effort 仍只接受 app-server/Codex 定义的 `none|minimal|low|medium|high|xhigh`。
- 卡片与控制台：Codex action value 保持旧形状，不额外带 `provider`；Codex 控制台标题保持原来的 `当前模型`，不显示 `(Codex)`。
- 使用量与上下文：Codex token usage、context window、manual compact、thread goal、plan delta 事件仍按原 app-server 事件处理。
- 持久化兼容：旧版 `session-resume-map.json` 的 string 值按 Codex thread id 读取；旧版 `session-model-map.json` 的 string/object 若无 provider，按模型名前缀推断，普通 GPT 模型仍按 Codex 读取。

## Claude Differences From Codex
这些差异来自 Claude Agent SDK 能力边界或本机模型路由，不能伪装成 Codex 完全同构：

- 启动时机：Claude SDK 在没有第一条 user input 前不会发 `system/init`，所以 `hi` 启动 Claude 后不会强等 init；首条消息触发 init 和真实 session id。
- 模型项：Claude 暴露 `claude:default`、`claude:glm`、`claude:deepseek`。GLM/DeepSeek profile 通过 env 做档位映射，SDK 主模型默认请求 `opus` alias。
- resume id：Claude `session_id` 与 Codex thread id 分开保存；切换 provider 不共享上下文。
- compact：Claude SDK 没有 Lodestar 所用的 Codex `thread/compact/start` 等价接口，`compact` 会明确失败并说明不支持。
- ask：Codex 的 `[[askusr: ...]]` host marker 不给 Claude 使用；Claude 的 ask 来自 SDK `AskUserQuestion` / user-dialog，仍渲染成同一套飞书问答卡。

## Audit Fixes
本轮对照后补掉的遗漏：

- 跨 provider 切换只允许在空闲/启动边界执行；当前 turn 或排队消息存在时直接拒绝，避免中途切换改变原 turn 调度。
- 旧后端的迟到 `session_id` / exit 事件不会覆盖当前已选择后端的 `lastSessionId` 或新进程状态。
- Claude 启动前会显式检查 `claude` 可执行文件；找不到时直接启动失败并提示，不让 session 先进入 ready 再异步报错。
- Claude streaming-input 后端在首条用户输入前不会发 `init`；Lodestar 启动 Claude 时只等待短暂同步/早期错误，不再把“无输入所以没 init”当启动失败。
- Claude 使用 `bypassPermissions` 全自动;`canUseTool` 在该模式下被 SDK override(旧飞书审批 UI 已清),不再走权限卡。
- Codex 控制台和启动消息恢复原显示，不新增 `Codex ·` / `(Codex)` 这类额外标记。
- `claude:default` 运行中重新选择时只更新 effort，不再尝试给 SDK 设置空模型名。
- Claude profile 变化需要 env 生效；空闲切换时停止当前 Claude 子进程，下轮按新 env 启动；忙碌时拒绝，避免声称当前进程已切换。
- `claude:glm` 的主线程 SDK model 为 `opus` alias;具体 GLM 代码通过 settings.json 的 env 路由(`claude:deepseek` 已随二元化下线)。
- `[[askusr: ...]]` 处理链路加 provider 守卫，Claude 输出同名 marker 不会触发 Codex host ask 卡或续跑。
- Claude `onUserDialog` 接入现有 `AskUserQuestion` 卡片和 `updatedInput.answers` 回填协议，并修复同步权限回包 race。
- spawn prompt 按 provider 分开：Codex 继续收到 `[[askusr: ...]]` 说明，Claude 收到 “使用 AskUserQuestion，不要输出 askusr marker”。
- 一次性跨模型咨询收敛为 daemon-owned `ConsultService` + 主 Agent `lodestar-consult` Skill，不经过主 Session 的消息/resume 路径。
- 对话卡续卡 banner 在 Codex 下保持 `Codex turn` 原文，在 Claude 下显示 `Claude turn`。

## Verification Plan
- SDK 长驻探针：同一 `ClaudeAgentProcess` 处理两轮输入，返回同一 `session_id`。
- Claude ask smoke：独立临时目录启动 `ClaudeAgentProcess(model=claude:glm)`，要求模型调用 `AskUserQuestion`，自动回填答案后期待 `DONE`。
- 单元测试：`bun test`。
- 构建验证：`bun run build`。

## Verification Result
- `bun test`: 112 pass。
- `bun run build`: daemon / setup / stop / update / version 全部 bundle 成功。
- Claude init probe: `sendInitialize()` 后无首条输入时 8 秒内没有 stream `init`；`start()` 已改为短暂等待早期错误后 ready，冷启动首条用户消息会先发 input 再由 SDK 触发 init。
- Claude SDK smoke: 临时目录中连续发送“只回复数字 1”和“只回复数字 2”，中途执行 `setModelSettings("claude:default", "low")` 成功；收到两次 `result subtype=success`，且两次 `session_id` 均为 `1e18c8b5-90f8-452f-a39a-e485e3ec4734`。
- Claude ask smoke: `claude:glm` 启动时 SDK 日志显示 `model=opus`；实际触发 `AskUserQuestion`，自动回答后 assistant 输出 `DONE`，`result subtype=success` 且 `is_error=false`。
- smoke 结束时本机 Claude 插件的 `SessionEnd` hook 在 stderr 报 `/bin/sh` ENOENT；`/bin/sh` 本机存在，turn 已成功完成。该警告来自外部 Claude 插件 hook，不属于 Lodestar ask/model 路径失败。
