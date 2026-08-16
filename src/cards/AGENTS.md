<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-31 | Updated: 2026-07-26 -->

# cards

## Purpose
`src/cards/` 维护所有 Feishu Card Kit schema 2.0 模板和渲染辅助函数。它把一轮 Codex 对话、工具调用、权限请求、AskUserQuestion、控制台、状态卡、`model` 选择卡、`wt` worktree 卡、`agy` 任务卡、`task` 清单面板和 Claude Code Task 工具(TaskCreate/Update/List/Get)的累积任务板、SDK `task_*` 后台任务/子 agent 的「后台游标卡」、临时会话 `fk`/`bk`/`rs` 的列表与回滚卡,都格式化成 session 可以交给 `cardkit.ts` 写入的 JSON 结构。

## Key Files
| File | Description |
|------|-------------|
| `elements.ts` | 集中定义卡片 `element_id` 命名约定，例如 `user_input`、`footer`、`model_panel`、`tasklist_panel`、`tool_<i>`、`assistant_<i>`。 |
| `turn.ts` | 对话主卡、assistant 分段、计划/目标/上下文压缩元素和 AskUserQuestion 面板；工具相关导出从 `tool.ts` 兼容 re-export。 |
| `tool.ts` | 工具折叠面板、权限按钮、Read / Edit 批次面板，以及 Bash/FileChange/WebSearch/MCP/Image/Agent 等工具输入/输出摘要。 |
| `task-board.ts` | Claude Code Task 工具(TaskCreate/Update/List/Get)的累积任务板。codex 的 TodoWrite 一次就带完整列表,但 Claude Code 拆成 4 个单点工具,这里维护一份以 task id 为 key 的 board(`applyTaskTool` 跨调用累积),`taskBoardElement` 渲染整个板产出与 codex 一致的列表效果。board 由 `session-tools.ts` 在 Session 级持有。 |
| `agy.ts` | `agy <prompt>` 任务卡片，渲染 prompt、状态统计、执行结果、仓库变更和转发 Codex 按钮。 |
| `console.ts` | `hi` 控制台、状态卡、菜单卡、`model` 三级选择卡（`providerSelectionCard` 选账号 → `modelSelectionCard` 选模型 → `modelEffortSelectionCard` 选 effort → `modelResultCard` 结果，账号/模型列表由 `session-model.ts` 从 token sources 传入）、额度/主机信息格式化和关闭 streaming 设置。 |
| `worktree.ts` | `wt` 列表卡和创建/加入提示卡，展示 `work/*` 分支状态、归档摘要并提供常驻删除按钮。 |
| `task.ts` | `task` 清单面板卡，展示项目、清单名、绑定 GUID、分组状态、清单链接，以及启用/删除/确认删除按钮。 |
| `background.ts` | SDK `task_*` 消息族(子 agent / 后台 bash / MCP / workflow)的状态累积 + 「后台游标卡」渲染:active/pending 双池(workflow/monitor 白名单 task_started 直入 active,其余前台 task 进 pending,对话推进时提升),吸附对话末尾,被新消息超越时沉降为历史快照,全终态固化留在原地。含 `elapsedBucket` / `liveElapsed`(footer 与活跃 header 的 bucket/second 耗时模式)。 |
| `temp.ts` | 临时会话 `fk`/`bk`/`rs` 卡片:`fk`/`bk` 的用户输入(turn 锚点)列表卡、`rs` 空闲模式的项目最近会话列表卡、`bk` 回滚后的 Write 记录卡;按钮 `value.kind`(`temp_fork_select`/`temp_back_select`/`temp_resume_select`)在 `daemon.ts` `handleCardAction` 里 dispatch。 |
| `turn.test.ts` | Bun 测试，覆盖 turn card、模型选择、工具摘要、权限元素和 console/status card 的关键渲染。 |
| `agy.test.ts` | Bun 测试，覆盖 agy 卡片结构、状态行、输出清理、仓库摘要和转发按钮。 |
| `worktree.test.ts` | Bun 测试，覆盖 `wt` 卡片的归档隐藏和状态排序。 |
| `task.test.ts` | Bun 测试，覆盖 `task` 面板未启用、已启用和删除确认状态。 |
| `task-board.test.ts` | Bun 测试，覆盖 Task 工具累积语义(Create 抓 id/Update 改 status/List 全量替换与空数组清空/Get 补全)、board 统计摘要和整个板的列表渲染。 |
| `background.test.ts` | Bun 测试，覆盖后台任务状态机(started/progress/updated/settled/tool_use/tool_result)、active/pending 双池提升、live 卡与 history 卡切换。 |
| `temp.test.ts` | Bun 测试，覆盖 `fk`/`bk` turn 锚点列表卡、`rs` 会话列表卡和回滚 Write 记录卡的渲染。 |
| `elements.test.ts` | Bun 测试，覆盖 `ELEMENTS` element_id 命名约定和 `sanitizeMarkdownForCardKit`。 |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| _None_ | 此目录没有非排除子目录。 |

## For AI Agents

### Working In This Directory
- 保持 schema 2.0 JSON 结构清晰，所有共享 `element_id` 都从 `ELEMENTS` 取值，避免手写重复 ID。
- 工具摘要和工具面板渲染集中在 `tool.ts`；新增工具类型时先更新摘要/正文渲染，再在 session 工具流程中接线。
- 模型选择卡使用单个可替换的 `model_panel`，流程是账号面板 → 模型列表面板 → effort 面板 → 成功结果面板（三级选择 + 结果，账号/模型列表由 `session-model.ts` 从 token sources 传入）。
- Bash 工具摘要会解析第一行 shell 注释里的 `desc` / `说明`；修改这段逻辑会影响飞书卡片中 shell 命令的可读性。
- 控制台卡片中的 usage、context window、host info 都是传入快照的格式化结果，不要在卡片模板里发起网络或系统调用。
- `worktree.ts` 的列表卡要优先适配手机宽度，按钮文本保持短，避免把操作按钮藏进折叠面板；已合并且未挂载的分支只放入归档摘要。
- `agy.ts` 卡片风格要和既有卡片一致：prompt 折叠标题固定为 `📥 agy收到`，状态保持单行，结果正文不折叠，转发按钮放在结果后，按钮文案尽量短。
- `task.ts` 只渲染清单绑定状态和按钮 action，不读取飞书任务内容，也不发起 API；分组状态缺失必须显示 `MISS`，不要用静默成功文案遮盖问题。
- Feishu 对空 markdown、元素数量和 streaming TTL 都比较敏感；模板变更要和 `cardkit.ts` 的空内容过滤、元素计数和关闭 streaming 设置配合。

### Testing Requirements
- 修改 `turn.ts` 或 `console.ts` 后运行 `bun test src/cards/turn.test.ts`。
- 修改 `agy.ts` 后运行 `bun test src/cards/agy.test.ts src/agy-task.test.ts`。
- 修改 `worktree.ts` 后运行 `bun test src/cards/worktree.test.ts src/worktree.test.ts`，必要时用 debug 注入在真实群里检查卡片渲染和按钮回调。
- 修改 `task.ts` 后运行 `bun test src/cards/task.test.ts src/tasklist-worker.test.ts`。
- 修改 `background.ts` 后运行 `bun test src/cards/background.test.ts`;触及 session 事件接线时再跑全量 `bun test`。
- 修改 `temp.ts` 后运行 `bun test src/cards/temp.test.ts`;触及 `session-temp.ts` 或 `daemon.ts` `handleCardAction` 的 `temp_*_select` dispatch 时再跑全量 `bun test`。
- 如果变更影响 `contextPercent`、usage 或控制台展示，也运行 `bun test src/context-window.test.ts`。
- 影响真实 Card Kit schema、按钮 action 或 streaming 设置时，需要在飞书群里做 smoke。

### Common Patterns
- 对话卡用顶部收起的 `user_input` 面板保存本轮收到的用户输入；工具和 assistant 片段按 Codex 事件顺序追加。
- 工具面板以折叠 panel 展示 header 摘要，正文按工具类型渲染命令、diff、网页搜索、MCP、图片生成或 agent 信息。
- AskUserQuestion 面板要保留历史回答、当前问题和自定义回答入口，并通过 action value 回到 session 权限流程。
- `agy` 卡片固定包含 prompt、stats、result、forward placeholder/button 和 repo 这几类元素；完成后用 `replaceElement` 更新结果、仓库变更和转发按钮。
- `model` 面板是三级选择（账号 → 模型 → effort），按钮 action value 的 `kind` 分别为 `provider_select` / `model_select` / `model_effort_select`，并带 `panel_id`（以及 `source_id`）防止旧卡回调污染当前选择。
- `task` 面板的按钮 action value 使用 `tasklist_enable`、`tasklist_delete_prompt` 和 `tasklist_delete_confirm`；删除前必须进入确认态，并携带当前绑定 GUID 防止旧卡删除新清单。
- 控制台和状态卡统一通过 `streamingOffSettings` 在终态关闭 streaming 并写 summary。
- `wt` 列表使用 `column_set` 保持状态和删除按钮同屏可见；创建/加入提示使用轻量 notice card。
- 「后台游标卡」维护 active/pending 双池:workflow/monitor 白名单 task_started 直入 active,其余前台 task 进 pending 观察池,待对话推进(`promotePendingOnAdvance`)再提升;全终态时固化留在原地,只有被新消息超越才沉降成历史快照(`backgroundHistoryCard`)。
- `temp` 列表卡(`fk`/`bk`/`rs`)按钮 `value.kind` 固定为 `temp_fork_select`/`temp_back_select`/`temp_resume_select`,并带锚点/会话 id 防止旧卡回调污染新选择;回滚后额外发一张 Write 记录卡供复制。

## Dependencies

### Internal
- `src/cards.ts` 统一 re-export 本目录导出，调用方通常 `import * as cards from './cards'`。
- `src/session.ts` 和 `src/session-*` helper 依赖本目录生成卡片元素。
- `session-model.ts` 使用 `console.ts` 渲染 `model` 面板，`session-worktree.ts` 使用 `worktree.ts` 渲染 `wt` 列表卡/提示卡/解散按钮，`session-agy.ts` 使用 `agy.ts` 渲染外部 agy 任务卡，`session-tasklist.ts` 使用 `task.ts` 渲染任务清单启用/删除面板,`session-temp.ts` 使用 `temp.ts` 渲染 `fk`/`bk`/`rs` 列表与回滚卡;`background.ts` 的 active/pending 双池由 `session.ts`/`session-tools.ts` 经 SDK `task_*` 事件驱动,渲染成吸附对话末尾的后台游标卡。
- `task.ts` 依赖 `src/tasklist.ts` 的分组常量和绑定类型，但不直接依赖 `feishu.ts`。
- `console.ts` 依赖 `src/sysinfo.ts`、`src/usage.ts` 和 `src/context-window.ts` 的类型与格式输入。

### External
- Feishu Card Kit schema 2.0：模板字段、按钮 action、markdown 和 streaming config 需要符合飞书接口约束。
- Bun test：执行 `turn.test.ts`、`agy.test.ts`、`worktree.test.ts` 和 `task.test.ts`。

<!-- MANUAL: Add manually maintained notes below this line. -->
