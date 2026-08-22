# `src/cards/` 局部指引

本目录只生成 Feishu Card Kit schema 2.0 JSON 与展示文本；API 调用、文件读取、进程状态和持久化留在调用方。模板必须同时承接 Codex 与 Claude 的统一事件和明确差异。

## 边界与不变式

- 共享 `element_id` 从 `ELEMENTS` 取得；动态 ID 必须稳定、同卡唯一，并与 session/cardkit 的 replace、delete 和换卡逻辑一致。不要在模板间复制裸 ID。
- 模板保持纯函数：控制台、usage、模型、任务和主机信息只格式化传入快照，不在渲染时请求网络或读取系统。
- Feishu 对空 markdown、元素上限、按钮 action 和 streaming 设置敏感。空正文使用明确占位，终态统一关闭 streaming；缺失字段显示 `MISS`/`—`，不得虚构成功。
- 手机窄屏优先。高频选择按钮保持短文案；model 面板是账号→模型→effort，action 携带 `panel_id` 与 `source_id`，旧 panel 必须被拒绝。
- Codex `request_user_input` 与 Claude AskUserQuestion 共用问答卡，但保留各自回包语义；卡片要保存历史回答、当前问题和自定义回答入口。
- `tool.ts` 负责工具摘要，`shell-command.ts` 统一解析 Bash、PowerShell 和引号包装后的首行 `# desc:`。Claude TaskCreate/Update/List/Get 由 `task-board.ts` 累积成完整任务板；不要按 Codex 一次性列表语义错误覆盖。
- `background.ts` 同时消费 Claude SDK `task_*` 与 Codex collab 子 agent 事件。子 agent 细节只进 active/pending 后台状态机，不混入主线程 timeline；终态历史卡停止刷新耗时。
- 临时会话选择卡只携带 `panel_id` + opaque `choice_id`，provider/cwd/source/owner/launch 留在 Session 的短期 panel state；禁止把可执行的 thread id、anchor 数组下标或本机路径直接信任为回调真相源。
- 含公式的 assistant 段始终由固定 id 的单个顶层 `column_set` 承载，raw 与渲染态只替换内部 markdown/image 子元素链。保持源码顺序；小图可用 `crop_center` + 精确 `size`，超过手机安全宽度的图必须用 `fit_horizontal` 且不传 `size`，由卡片容器响应式缩小。不要拆成多个顶层元素或把公式集中到段尾。
- `card.action.trigger` 立即替换原卡时返回 `{ card: { type: 'raw', data: card } }`；禁止返回裸卡、`{ card }` 或在 ACK 前 `message.patch`。
- 异步更新先返回不带 card 的 toast ACK，再调用 `feishu.updateCard()`/`message.patch`。不要使用 `/interactive/v1/card/update` callback-token 端点；它会让 schema 2.0 卡渲染空白。`notify_callback` 必须在 Session 存在性检查前分流。

## 验证

- 通用模板、问答、工具和 IDs：`bun test src/cards/turn.test.ts src/cards/elements.test.ts src/cards/shell-command.test.ts`。
- 双后端任务卡：`bun test src/cards/task-board.test.ts src/cards/background.test.ts src/session.test.ts`。
- 公式布局：`bun test src/math-render.test.ts src/cardkit.test.ts src/session.test.ts src/cards/elements.test.ts`。
- Card action：`bun test src/card-action.test.ts src/notify-callbacks.test.ts`；真实交互只在明确授权的目标群 smoke。
