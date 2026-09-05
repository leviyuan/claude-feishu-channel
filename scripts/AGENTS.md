# 脚本使用

这里包含安装脚本、真实飞书探针和人工 smoke。多数脚本会加载生产配置与 XDG 状态；`Session` 按群保存的选择启动后端。

| 脚本 | 副作用 |
| --- | --- |
| `smoke.ts`、`test-all.ts` | 在真实群发送文本、卡片、reaction 和文件，自行创建 Session |
| `test-inject.ts` | 向 debug context 指定的群发送可见消息，再注入正在运行的 daemon |
| `test-mid-turn-rotation.ts` | 通过 debug socket 发送 `kill` 和长任务，读取日志 |
| `cardkit-probe.ts` | 发多张测试卡，直调 Card Kit API |
| `seed-debug-ctx.ts` | 查询群成员，将指定成员写入本机 debug context |
| `postinstall.cjs` | 提示安装步骤，检查或补装 Claude SDK 当前平台 native binary |

`smoke-session.ts` 共用账号、持久状态加载和完成检查；`debug-client.ts` 共用注入请求。它们不作为独立命令运行。

- 真实 smoke 需要明确账号、目标群和副作用。自行创建 Session 的脚本要求目标群的 live daemon 已停止；停止 daemon 仍需当前消息单独授权。
- 探针必须显式指定目标，不使用硬编码群或 `test1` 默认值。凭据、成员和 debug context 不写进仓库。
- 复用 `src/feishu.ts`、`src/session.ts` 和 `src/paths.ts`，不复制生产 API、账号路由和状态路径。覆盖说明与实际 provider 一致。
- npm lifecycle 不启动交互向导；首次向导由 `cli.ts` 在 TTY 中触发。native binary 不可用时由启动路径明确报错。
- 修改后先运行相关单元测试。npm lifecycle、native 依赖、构建引用或跨平台入口有变动时运行 `bun run build`。真实 smoke 完成后报告发送内容和本地状态变化。
