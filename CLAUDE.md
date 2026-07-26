# feishu (lodestar) 项目备注

## restart feishu-daemon(铁律)

`systemctl --user restart feishu-daemon` —— **命令发出去就是成功**。

- **必须用户明确授权**才 restart,绝不擅自(restart 是全局的,会打断所有正在跑的会话)。
- **授权后立即执行** —— 不犹豫、不再确认、不要解释"会中断当前会话所以做不了"。daemon 有 session-resume(`session-resume-map.json`),用户视角会话延续;当前 agent turn 被重启杀掉是正常的,用户在新 turn 继续。**别把"我会被杀"当成不执行 restart 的借口。** 2026-07-26 因此被痛骂:先漏发 restart 命令(只说不做),后用"会断当前会话没法演示"当理由不执行。
- exit 144 = 假失败,实际成功。别重试,别连环 restart。
- restart 前先 smoke 验证代码:`bun build daemon.ts --target=bun`(项目无 tsconfig,bun build 是导入链/引用断不断的验证手段)。

## footer / 后台任务卡的计时

**不数秒。** 显示相对时长档位:`<30s / <1m / <3m / <5m / <10m`,超过 10m 后每 10 分钟一档(`10m+ / 20m+ …`)。逻辑在 `src/cards/background.ts` 的 `elapsedBucket`(导出,session 直接 `import { elapsedBucket } from './cards/background'`)。

更新只在**档位边界**(自适应 `setTimeout` 链),不是固定 tick:
- `startFooterTimer`(状态卡 / 冷启动卡)
- `startFooterStatus`(turn footer:Thinking/Writing/Working)
- `startBackgroundRefreshTick`(后台任务卡:取所有活跃任务最近的档位边界)

别改回固定 `setInterval(..., 1000)`——那是调用量大头,已删。

## 飞书 API 配额(免费版)

当前 100 万次/月(2026-06 限时,2026-07-26 官方原文核实)。收消息走 WS 事件订阅**不计入**;发消息 + Card Kit 卡片更新计入。卡片**没有本地计时组件**,任何"跳动/计时"必须服务端 push,所以用档位(极少 push)而非秒表。
