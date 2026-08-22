# `src/` 局部指引

本目录实现核心状态机与外部协议。`Session` 决定生命周期，`AgentProcess` 统一双后端事件，具体进程翻译协议，`cardkit.ts` 串行卡片写入。

## 边界与不变式

- `Session` 的 package-internal 字段由 `session-*.ts` helper 协作访问；命令、模型、权限、工具、临时会话、worktree、agy 与 tasklist 逻辑继续放在对应 helper，不把它们重新堆回 `session.ts`。
- `AgentProcess` 是 Codex/Claude 的共享契约。新增事件或方法时，必须同时检查 `codex-process.ts`、`claude-agent-process.ts`、Session 消费方和卡片呈现；只有一端支持的能力用显式 capability/分支表达，不能伪造 parity。
- Codex 进程只通过 app-server JSON-RPC 管理 thread、turn、权限、`request_user_input`、plan/goal、usage、compaction 与 collab 子 agent；未知或畸形 payload 要记录，不得静默当成功。
- Claude 进程使用 Agent SDK `query()` streaming input。`permissionMode: default` 下普通工具由 `canUseTool` 明确放行，AskUserQuestion 必须等待飞书回答；`task_*`、`compact_boundary`、resume/fork 与 project profile 行为不可在通用事件归一化时丢失。
- Token Source 通过 factory 自注册并拥有 enabled、模型刷新、spawn env、模型解析、setting sources 和额度。GLM/DeepSeek 注入凭据前要 scrub 其他 Anthropic env，默认只读 project/local settings；native 才读取 user settings。跨 source 即使同属 Claude，也必须换进程才能更换 base URL/凭据。
- 模型面板是 source→model→effort。同 provider/source 的设置调用 `setModelSettings`；Claude 下一轮生效，Codex 仍需 restart 才应用持久目标。跨 provider/source 或 Claude profile 切换在 turn/开卡/排队期间拒绝，空闲时终止不匹配进程；resume id 按 provider 隔离。
- `fk`/`bk`/进程已停时的 `rs` 使用 backend-native 会话能力：Claude 以 transcript + `forkSession/resumeSessionAt` 实现，Codex 以 app-server `thread/list` + `thread/fork(lastTurnId)` 实现。共享 checkpoint 必须携带 provider、源会话 id 与原生锚点；Claude fork 在首条输入前必须持久化 pending launch，materialize 新 session id 后才能清除。禁止扫描/复制 Codex rollout、重建旁路索引或把 fork 失败静默退化成 resume。
- 所有生产 Card Kit mutation 经 `cardkit.ts` 的 per-card queue 和执行时 sequence。必须知道写入结果的事务使用 checked API；普通 fire-and-forget 调用不能用于决定 rendered/持久状态是否成功。
- `math-render.ts` 在共享的 Markdown code-range 解析之外识别公式：简单 inline 转 Unicode，复杂 inline 与 display 用 MathJax→SVG→Resvg 生成图片；CJK 使用 SVG `<text>` 与平台系统字体链，禁止恢复字符占位/path swap。
- 公式结果是严格按源码顺序的 markdown/image blocks。含公式的 assistant 段以固定 segment id 的顶层 `column_set` 承载 raw markdown，渲染完成后用一次 checked PUT 原子替换子元素链；渲染、上传或 PUT 失败都保留原始 LaTeX，不能逐图顶层追加或因增强失败触发整卡换卡。turn close/rotation 按 cardId 等待 math in-flight，成功后才标记 rendered。
- 公式临时 PNG 使用 `node:fs/promises`、`mkdtemp(tmpdir())` 和唯一目录，并在 `finally` 清理；同 uploader/公式并发去重且缓存有界。MathJax/Resvg 仍需延迟加载，避免破坏 Node 单文件构建。
- `config.ts` 的 import-time 报错、`paths.ts` 的 XDG/跨平台路径和 `feishu.ts` 的持久 map 是公共契约。新增状态定义显式路径与失败行为；需隔离配置的测试使用子进程或统一 mock。

## 验证

- 双后端协议和 provider/source 切换：`bun test src/codex-process.test.ts src/claude-agent-process.test.ts src/session.test.ts src/token-source-glm.test.ts`。
- 公式与卡片事务：`bun test src/math-render.test.ts src/cardkit.test.ts src/session.test.ts src/cards/elements.test.ts`。
- 配置、持久 map 或 task worker：运行对应 `*.test.ts`；触及共享 Session/Feishu 路径后再运行 `bun test`。
- 构建入口、SDK/native dependency、动态加载或 Node/Bun 兼容性变化时运行 `bun run build`。
