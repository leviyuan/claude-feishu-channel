# `docs/` 局部指引

本目录保存已经落地架构的叙述性 memo，不是待实现 spec。代码、测试和根/`src` 指引优先于 memo；冲突时先核对当前源码，再修正文档。

## 边界与不变式

- `claude-agent-backend.md` 记录 Claude Agent SDK 接入、统一 `AgentProcess`、模型 profile、事件映射、Codex parity audit 和首版验证。产品仍支持该后端，不得因维护入口迁到 Codex 而删除或改写成废弃说明。
- 修改 `agent-process.ts`、`claude-agent-process.ts`、Claude model/profile、AskUserQuestion、compact、后台任务或双后端事件契约前按需阅读该 memo；token source、DeepSeek 和后续演进仍以当前源码为准，不能把历史 memo 当完整清单。
- 文档只陈述已实现且可验证的事实。不要在这里创建第二套产品规范、计划或第三方生成的 spec，也不要用目标状态覆盖当前差异。
- 更新“验证结果”时必须实际运行并记录对应命令；不要复制过期通过数、session id、凭据、主机路径或真实群数据。

## 验证

- 纯文字修改不要求运行源码测试，但需核对所引用的文件、方法和命令仍存在。
- 若文档修改伴随实现变化，按 `src/AGENTS.md` 运行相关双后端测试；涉及共享接口时再运行 `bun test` 与 `bun run build`。
