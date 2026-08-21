# Lodestar 项目指引

Lodestar 是一个 Bun/TypeScript daemon：它从飞书 WebSocket 接收消息，把每个群映射为一个 `Session`，再通过统一 `AgentProcess` 驱动 Codex app-server 或 Claude Agent SDK，并把 turn、工具与状态渲染到 Feishu Card Kit schema 2.0 卡片。

本仓库的维护入口和 AI 协作说明统一以 Codex/`AGENTS.md` 为准；这只是维护方式迁移，不是产品后端迁移。Codex、Claude、GLM、DeepSeek 与 Claude native 路径都是受支持产品能力，未经用户明确提出产品变更，不得因清理维护文件、缺少本机凭据或个人偏好而删除、弱化或伪装任一后端。

## 范围地图

- `cli.ts` 只处理首次配置与 PID guard，`daemon.ts` 负责 WS、session registry、Card action 和本机通知；业务逻辑放在 `src/`。
- `src/` 是 session、双 agent 进程、token sources、飞书 API、Card Kit 队列、任务清单和 worktree 的核心实现。修改前读取 `src/AGENTS.md`。
- `src/cards/` 只维护卡片模板和渲染辅助。修改前同时读取 `src/AGENTS.md` 与 `src/cards/AGENTS.md`。
- `scripts/` 会复用生产配置并触达真实群或 daemon；运行或修改前读取 `scripts/AGENTS.md`。
- `docs/` 保存后端设计 memo；修改双后端架构前按 `docs/AGENTS.md` 选择性阅读，但最终事实仍以源码和测试为准。
- 从仓库根目录启动的 agent 不会自动获得更深目录的说明；编辑子树前主动读取该路径适用的嵌套 `AGENTS.md`。

## 工作规则

- 开发运行时是 Bun，源码入口用 `bun daemon.ts` 或 `bun run start`；发布产物由 `bun run build` 生成可在 Node.js 18+ 运行的入口。
- `config.ts` 在 import 时同步加载配置且缺失即报错；首次安装的延迟导入只能留在 `cli.ts`。不要吞掉配置、凭据、Codex 登录、Claude SDK native binary 或飞书 API 错误。
- 配置默认在 `~/.config/lodestar/config.toml`，日志和 session/chat/resume/model/tasklist 等状态默认在 `~/.local/share/lodestar/`。新增持久状态统一经 `src/paths.ts` 放到 XDG/平台数据目录，不要写回仓库。
- 凭据只存在于用户配置、登录状态或环境变量。禁止把 token、App Secret、聊天成员数据、debug context、`~/.codex`/`~/.claude` 内容或本机绝对配置复制到跟踪文件。
- API、模型目录、额度、上传或 agent 启动失败必须显式记录并向调用方显示失败；不得伪造数据、静默成功或偷偷换 provider/source。只允许针对已知瞬态条件的有限重试，最终失败仍需暴露。
- 保留用户已有改动；不要覆盖无关脏文件。依赖变更同步更新 `bun.lock`，不要手工改锁文件内容。
- 所有展示到工具卡片的 shell 命令第一行使用 `# desc: <中文摘要>`；`src/cards/shell-command.ts` 依赖这个约定提取可读标题。
- Card action `kind`、共享 `element_id`、群命令、resume/model map 和 token source id 都是持久 wire contract。重命名时同步修改生产分发、迁移和测试，不能只改显示层。

## 跨模块不变式

- 一个飞书群只对应一个 `Session` 和一个当前 agent 进程。Codex 走 `codex app-server --listen stdio://` JSON-RPC；Claude/GLM/DeepSeek/native 走 `@anthropic-ai/claude-agent-sdk` 的 streaming-input `query()`。不要恢复 tmux、旧 JSONL 队列或旁路进程控制。
- Token Source 是账号、凭据、模型目录、spawn env 和额度的真相源。内置 source 包括 Codex subscription、GLM Coding Plan、DeepSeek 与 Claude native；GLM/DeepSeek 可由 config 或本机 Claude settings 探测，存在显式 Claude-side source 时 native 让位。新增 source 按 factory 注册模式扩展，禁止在 model/session 层再建固定枚举。
- `model` 是账号→模型→effort 三级动态面板。Codex 模型来自 app-server `model/list`，GLM/DeepSeek 来自兼容端点并允许受验证的补录，native 使用 SDK aliases；失败显示 MISS，不造假选项。
- 同 provider、同 token source 的模型设置走 `setModelSettings`：Claude 从后续 turn 使用，Codex 持久目标需重启进程生效。跨 provider 或跨 source 会改变进程/env，只能在空闲时停止旧进程并按各 provider 独立 resume id 重新启动；活跃或排队状态按现有规则拒绝切换。
- Claude 路径保留原生 session resume/fork、`fk`/`bk`/`rs`、AskUserQuestion、project profile、MCP/skills、主动 `/compact` 和 SDK `task_*` 后台任务；Codex 路径保留 app-server 权限、`request_user_input`、plan/goal、compaction、usage 与 collab 子 agent 映射。共享卡片事件不能抹平两端确有差异。
- `cardkit.ts` 独占生产卡的 sequence、队列、流式 TTL 重开、元素计数和写失败状态。session 与模板不得旁路它直调 Card Kit HTTP；专用探针只能在 `scripts/cardkit-probe.ts` 中显式操作测试卡。
- Assistant 正文按完整 block 插入静态元素，不走 `/content` 逐字输出；footer 用 element replace。公式渲染、换卡和 turn 收尾服从同一 per-card 队列，具体事务见 `src/AGENTS.md`。
- `worktree.ts` 独占 `work/*` 分支和同级 `<project>[name]` worktree 操作；`agy-task.ts` 独占 agy 参数与 Git 快照；任务绑定、worker 调度和模板分别留在既有模块。
- `[[send: /abs/path]]` 由 outbound marker 流程解析并作为独立飞书文件消息发送；正文保留原标记作为可见回执，卡片模板本身不得读取本机文件。

## Live daemon 操作

- 修改代码不等于获得 live 操作授权。除非用户在当前消息中明确要求对应的 stop、restart、reload、切换或接管，否则不得影响正在运行的 daemon/user service；授权不跨用户消息、中断恢复或上下文压缩继承。
- “测试”“预览”“发张卡看看”都不授权停止、重启、shadow、并行启动或改 service 指向。无法无扰验证时，说明影响并等待明确许可。
- 收到重启要求后先只读确认实际 unit，并比较 `systemctl --user show <unit> -p ActiveEnterTimestamp` 与工作区源码 mtime；运行中的代码不落后时不要重启。不要用 commit 时间代替进程启动时间判断。
- 需要终止进程时先列出 PID 和完整命令行，只操作精确 PID 或精确 unit；禁止 `pkill -f`、`killall` 和宽泛 systemd/Docker/tmux 目标。
- restart 会终止承载当前对话的宿主。执行命令只负责一次重启，不在同一命令中 `sleep` 后核实；恢复后只根据新 PID、启动时间和 journal 确认结果。同一用户消息最多执行一次 restart。
- 永久后台进程必须由 user systemd 管理；不要用裸 `&`、`nohup` 或临时工具 session 冒充常驻服务。

## 验证与发布

- 常规源码变更运行 `bun test`；构建入口、CLI、依赖或发布路径变更再运行 `bun run build`。双后端公共接口改动必须覆盖 Codex、Claude、provider/source 切换与卡片共享路径。
- 聚焦命令写在适用的嵌套 AGENTS 中。共享 Session、Card Kit、飞书协议或持久状态有改动时，最终仍跑全量测试。
- 真实飞书、任一 agent 登录/凭据、Card action、建群/解散或 worktree 流程只能在明确目标群和副作用后做人工 smoke；碰 live daemon 的前置操作仍需单独获得当前消息授权。
- 发布前必须通过 `bun test` 与 `bun run build`。除非用户明确要求 minor/major，版本只递增 patch；同一版本需发布 npm 与 GitHub Packages、推送 `main` 和 tag，并创建对应 GitHub Release。仓库没有 `gh` CLI 时使用 GitHub REST，临时认证文件用完立即删除。
