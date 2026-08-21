# `scripts/` 局部指引

这里的脚本面向安装、真实飞书探针和人工 smoke。多数脚本直接加载生产配置、XDG 状态与 `src/` 实现，不是隔离测试；`Session` 按目标群持久选择启动对应后端。

## 边界与副作用

- `smoke.ts` 与 `test-all.ts` 会在真实群发送消息、卡片、reaction 和文件，并自行创建 `Session`；同一群的 live daemon 必须停止以免双 session 争用。运行脚本和停止 daemon 分别需要用户在当前消息中明确授权。
- `test-inject.ts` 依赖正在运行的 debug socket，每次注入都会先向已 seed 的群发送成员可见消息；`test-mid-turn-rotation.ts` 还会发送 `kill` 和长 turn。不要把它们当成无副作用单元测试。
- `cardkit-probe.ts` 会发送多张探针卡并直调真实 Card Kit API；`seed-debug-ctx.ts` 会查询群成员并写 XDG debug context。执行前显式复核 chat/group，禁止依赖硬编码或 `test1` 默认值。
- 脚本复用 `src/feishu.ts`、`src/session.ts` 与 `src/paths.ts`，不要复制生产 API、provider 选择、凭据解析或状态路径；不得把 debug context、成员信息或 token 写进仓库。
- `postinstall.cjs` 只输出安装提示，并检查/补装 Claude Agent SDK 当前平台的 native binary；不得在 npm lifecycle 中启动交互向导。首次向导由 `cli.ts` 在真实 TTY 触发，native 最终不可用时由 agent 启动路径显式报错。
- Smoke 覆盖声明必须与实际 provider 能力一致；不要把默认 Claude session 注释成强制 Codex，也不要用单后端通过冒充双后端验证完成。

## 验证

- 修改脚本后先运行其导入模块的单元测试；修改 npm lifecycle、native dependency、构建产物引用或跨平台入口后运行 `bun run build`。
- 真实 smoke 不是默认验证。只有目标群、副作用、provider/source 和 live daemon 前置条件都获授权后，才执行 `bun scripts/<name>.ts ...`，完成后报告发送内容与本地状态变更。
