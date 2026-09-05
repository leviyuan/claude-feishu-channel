# 核心实现

`Session` 管理生命周期，`AgentProcess` 定义双后端事件，具体进程类转换协议，`cardkit.ts` 串行写卡。

## 会话与后端

- 命令、模型、权限、工具、临时会话、worktree、Agent 身份和任务清单放在对应 `session-*.ts` helper；这些模块可协作访问 Session 的内部字段。
- 修改 `AgentProcess` 时检查 Codex、Claude、Session 消费方和卡片。单端能力用明确分支或 capability 表达。
- Codex 通过 app-server JSON-RPC 管理 thread、turn、权限、提问、plan/goal、usage、compaction 和 collab 子 Agent。未知或畸形 payload 要记录。
- Claude 使用 `query()` streaming input。`permissionMode: default` 下普通工具由 `canUseTool` 放行，`AskUserQuestion` 等待回答；保留 `task_*`、`compact_boundary`、resume/fork 和项目配置。
- Token Source factory 管理 enabled、模型刷新、spawn env、模型解析、settings 来源和额度。GLM/DeepSeek 清除冲突 Anthropic env 后注入凭据，默认读取 project/local；native 读取 user。跨 source 必须换进程。
- 主会话的模型面板是 source → model → effort。同源设置走 `setModelSettings`；跨 provider/source 或 Claude profile 的切换在 turn、开卡或排队期间拒绝，空闲时终止不匹配进程。
- `fk`、`bk` 和进程停止后的 `rs` 使用原生会话能力：Claude transcript + `forkSession/resumeSessionAt`，Codex `thread/list` + `thread/fork(lastTurnId)`。checkpoint 包含 provider、源会话、cwd 和原生锚点。Claude fork 在首条输入前保存 pending launch，得到新 session id 后才清除。不得扫描或复制 Codex rollout，也不能把 fork 失败当成 resume。

## 委派 Agent

- `agent-*` 提供任意任务的模型委派。主 Agent 查实时身份后传入原始 prompt；同一任务的多个身份放在一个 run 内并发，不同 run 可并行并组成父子 DAG。
- 共用 `agent-launch.ts` 的完整 coding-agent 启动入口。Codex 固定 `danger-full-access`，保留 apps/plugins/multi_agent/MCP/hooks；Claude 固定 `claude_code` preset、完整工具、项目 MCP 和 daemon Skill。不添加评审角色、工具白名单或自动 deny。
- 每个 worker 获得独立、可撤销的 `LODESTAR_AGENT_*` capability，只能访问自己的 run 子树。并发和深度限制要显示排队原因，不能改变模型、effort 或工具权限。
- 提问进入 `needs_input` 并暂停 watchdog，answer 后恢复；非输入权限请求放行。follow-up 复用 provider 原生 session。
- 每次状态转换原子落盘；大 prompt/输出单独存入私有 artifact，快照不重复内嵌。委派 session id 单独登记，从主会话 `rs`/`fk` 历史排除。
- 父 run 取消、Session stop/kill/restart 和 daemon shutdown 在首次 await 前关闭新建入口、吊销 capability，并递归回收后代进程。
- Skill 内容由 `managed-skills.ts` 同源同步至 Codex/Claude standalone 目录和 Claude 本地插件。排除 user settings 的主会话显式加载插件，不能为发现 Skill 混入 user env。

## 卡片与持久化

- 生产 Card Kit mutation 经 per-card queue，在执行时分配 sequence。需要据结果更新 rendered 或持久状态的事务使用 checked API。
- 公式在 Markdown code range 外识别：简单 inline 转 Unicode，其余经 MathJax → SVG → Resvg。中文使用 SVG `<text>` 和系统字体；不使用字符占位或 path swap。
- 含公式的段落由固定 id 的顶层 `column_set` 承载，先放原始 Markdown，渲染后以一次 checked PUT 替换有序的 markdown/image 子元素。失败保留原文，不逐图追加或触发整卡换卡。
- 关闭或轮换卡片前按 cardId 等待公式渲染，成功后才标记 rendered。临时 PNG 使用唯一 `mkdtemp(tmpdir())` 目录、异步文件 API，并在 finally 清理；并发去重、缓存有界。MathJax/Resvg 保持延迟加载以支持 Node 构建。
- `config.ts` 的 import-time 错误、`paths.ts` 的跨平台路径和 `feishu.ts` 的持久 map 是公共契约。测试隔离真实配置，使用子进程或统一 mock。

## 验证

- 双后端与账号切换：`bun test src/codex-process.test.ts src/claude-agent-process.test.ts src/session.test.ts src/token-source-glm.test.ts`。
- 公式与卡片事务：`bun test src/math-render.test.ts src/cardkit.test.ts src/session.test.ts src/cards/elements.test.ts`。
- 其他改动运行对应测试；共享路径最终运行全量 `bun test`。SDK/native 依赖、动态加载和 Node/Bun 兼容性变化再运行 `bun run build`。
