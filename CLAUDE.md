# feishu (lodestar) 项目备注

## restart feishu-daemon(铁律)

> ⚠️ **restart = 全局打断,放炸弹**:杀 daemon 会一刀切断本机**所有**正在跑的飞书会话 —— 不只当前这个群、不只当前这个 turn,别的群里别人正在跑的会话也一起断。不是"重启试试看",是拿所有在线会话当赌注。想 restart 前先掂量这个后果,用户没明确说就绝对别碰。

`systemctl --user restart feishu-daemon` —— **命令发出去就是成功**。

- **必须用户明确授权**才 restart,绝不擅自。授权是**单次**的:那一次把命令打出去就结束,不许连环 restart、不许"再 restart 一次确认"、不许跨 turn 反复念叨。
- **授权后当 turn 直接发命令**:用户说 restart,**同一个 turn** 里一条 Bash 把 `systemctl --user restart feishu-daemon` 打出去。**绝不许** turn 结尾写"发命令:" / "先 smoke...再 restart:" 然后停 turn 等下一轮 —— 这就是反复犯的"只说不做"。
- smoke 要么 restart 前早做过,要么和 restart 放**同一条** Bash(`bun build daemon.ts --target=bun --outfile /tmp/x.js && systemctl --user restart feishu-daemon`),**不许**拆成"先 smoke"一个 turn、"再 restart" 另一个 turn。
- **别把"我会被杀"当借口不执行**:daemon 有 session-resume(`session-resume-map.json`),用户视角会话延续;当前 agent turn 被杀正常,用户在新 turn 继续。
- exit 144 = 假失败,实际成功。**别重试,别连环 restart**。
- restart 前先 smoke 验证代码:`bun build daemon.ts --target=bun`(项目无 tsconfig,bun build 验证导入链)。

**复发记录(2026-07-26):** 这条铁律当天加,当天又犯 —— 用户授权 restart 后,我用"发命令:" / "再 restart:" 拖了几个 turn,turn 结尾写引导语却不跟上工具调用,被痛骂"怎么又重启了"。病根不是没记,是把"立即执行"理解成了"嘴上说发命令"。**铁律:授权 = 当 turn 一条 Bash 打出去,文字说明放在命令之后,或者干脆别写。**

## footer / 后台任务卡的计时

**不数秒。** 显示相对时长档位:`<30s / <1m / <3m / <5m / <10m`,超过 10m 后每 10 分钟一档(`10m+ / 20m+ …`)。逻辑在 `src/cards/background.ts` 的 `elapsedBucket`(导出,session 直接 `import { elapsedBucket } from './cards/background'`)。

更新只在**档位边界**(自适应 `setTimeout` 链),不是固定 tick:
- `startFooterTimer`(状态卡 / 冷启动卡)
- `startFooterStatus`(turn footer:Thinking/Writing/Working)
- `startBackgroundRefreshTick`(后台任务卡:取所有活跃任务最近的档位边界)

别改回固定 `setInterval(..., 1000)`——那是调用量大头,已删。

## 飞书 API 配额(免费版)

当前 100 万次/月(2026-06 限时,2026-07-26 官方原文核实)。收消息走 WS 事件订阅**不计入**;发消息 + Card Kit 卡片更新计入。卡片**没有本地计时组件**,任何"跳动/计时"必须服务端 push,所以用档位(极少 push)而非秒表。
