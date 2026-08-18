# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

夜航星 Lodestar —— 一个 Bun daemon,把飞书群消息桥接到无头 agent 后端。运行时关系:**一个飞书群 = 一个 `Session` = 一个选定 provider 的 agent 进程**,每轮对话由一张流式 Feishu Card Kit 卡片承载。默认后端是 Claude Code(走 GLM-5.2),可用群内裸词 `model` 切到 Codex(GPT)。

更细的代码事实在 `AGENTS.md`(根 / `src/` / `src/cards/` / `scripts/` / `docs/` 各一份,deepinit 维护)—— 本文件只放 high-level 架构和不显然的约定,不重复文件级清单。

## 常用命令

```bash
# 源码开发:daemon 永远跑源码,不跑 dist
bun daemon.ts                      # 等价 npm run start / bun run start

# 构建(发布前;--target=node 出 Node 可执行文件到 dist/)
bun run build                      # 全量;单入口如 bun run build:daemon

# 测试
bun test                           # 全量
bun test src/session.test.ts       # 单文件
bun test src/cards/                # 目录

# 真实飞书群 smoke(需要有效 ~/.config/lodestar/config.toml)
bun scripts/smoke.ts "<group name>"
bun scripts/test-all.ts "<group name>"
```

项目**没有 tsconfig** —— `bunx tsc` 会打 help。验证导入链(改了 cards barrel / 新导出 / daemon 依赖链)用 `bun build daemon.ts --target=bun`;`bun run build` 只覆盖 CLI,不验证 daemon 导入链。

## 架构

**入口**: `cli.ts`(npm 分发入口:无 `config.toml` → 触发 `setup` 向导;有 → lazy import `daemon.ts`)→ `daemon.ts`(薄主入口:Lark `WSClient` + 事件分发 + 裸词控制命令 + debug socket)。业务全部下沉到 `src/`。

**`Session`(`src/session.ts`,~155KB)**: 一个群的状态机,持有当前 agent 进程、入站消息缓冲、turn/card 流式状态。命令和业务面板拆到 `session-*.ts` helpers:`session-commands`(裸词路由)、`session-worktree`(`wt`)、`session-agy`、`session-tasklist`、`session-model`、`session-compact`、`session-temp`(`fk`/`bk`/`btw`/`bye`)、`session-multimsg`(`>>>`/`<<<` 多条合并)等。`Session` 的非 `private` 字段是 package-internal 约定,只由这些 helper 访问。

**统一后端接口(`src/agent-process.ts` 的 `AgentProcess`)**,两类实现:
- `CodexProcess`: spawn `codex app-server --listen stdio://`,走 JSON-RPC。
- `ClaudeAgentProcess`(默认): `@anthropic-ai/claude-agent-sdk` 的 `query({ prompt: AsyncIterable })` streaming-input 长驻进程;`permissionMode: default` + `canUseTool` 回调(`AskUserQuestion` 经 canUseTool 下发、host 拦下渲染卡片并回填 answers,其余工具秒放——复刻旧 bypassPermissions 的「不弹审批」语义)。

默认 provider 是 Claude/GLM;`model` 是固定二元选项(effort 锁死),选择按 session+provider 持久化到 XDG data。

**Card Kit**: `src/cardkit.ts` 封装 Feishu Card Kit v1(per-card sequence、Promise queue、流式限流、写失败回调),所有生产卡片写操作必须过它的队列。`src/cards.ts` 是模板 barrel,`src/cards/` 下是 schema 2.0 模板(turn / console / worktree / agy / task / background / temp / tool)。

**飞书 API(`src/feishu.ts`)**: Lark client、tenant token 缓存、群名/会话映射,以及 session/chat/resume/model/alive/tasklist 等 runtime map 的持久化。Task v2 由 `feishu-task.ts` re-export。

**Token Source(`src/token-source*.ts`)**: agent 凭据/额度来源的声明式抽象层。每个 source 是自包含模块(`token-source-<name>.ts`),import 即 `registerTokenSourceFactory` 登记。**加新 source = 新建模块 + `token-source-builtins.ts` 加一行 import,不改枚举。**

**runtime state 全在 XDG(不入仓库)**: 配置 `~/.config/lodestar/config.toml`,日志和 runtime map `~/.local/share/lodestar/`。新状态文件在 `src/paths.ts` 定义常量并落 `DATA_DIR`/`CONFIG_DIR`;凭据只放 `config.toml`。

**runtime = Bun;发布包 = Node ≥ 18**(`bun build --target=node`)。

## 关键约定

- **正文完整段 `addElement`,footer 状态 `replaceElement`** —— 不走 Card Kit `/content` 打字流。
- **`card.action.trigger` 3 秒内换卡** 必须 `return { card: { type: "raw", data: newCard } }`,不要 return 裸 JSON 或 `{ card: newCard }`,也不要在 ACK 前调 `message.patch`(会和 ACK 竞态)。⚠️ 不要用 `/interactive/v1/card/update` 回调 token 端点:legacy,对 schema-2.0 卡返回 code=0 但渲染空白。
- **不静默兜底**: API/传输/卡片失败要 log 并向用户暴露(MISS / `—` / 红字),不要悄悄换通道、换卡片或返回假数据。
- **Git 操作收口**: `wt` 的 worktree 逻辑集中在 `src/worktree.ts`,`agy` 的 CLI/Git 快照集中在 `src/agy-task.ts`,不在 `session.ts` 散写 `git` shell。
- **群内裸词命令**(大小写不敏感,不加斜杠): `hi`、`stop`/`st`、`kill`/`kl`、`restart`/`rs`、`clear`/`cl`、`compact`/`cm`、`model`/`md`、`task`、`wt`/`worktree`、`btw`、`bye`、`fk`/`fork`、`bk`/`back`;外加 `agy <prompt>`、`>>>`/`<<<` 多条合并。在 `Session.runCommand` 里作保留字处理。
- **通用改动必须全 provider 生效(硬性)**: 聊天列表预览、卡片渲染、footer、任务板、后台卡这类 session 层通用能力,改动必须同时覆盖 Claude 和 Codex 两个后端——**通用型修改只改一个 provider = 未完成,不许交付**。实现上通用逻辑只落在 session 层统一入口(`p.on(...)` 事件面 / `session-tools` / `cards/*` 模板),两个进程实现 emit 同一套事件进来,不在一侧进程里另写渲染分支。新增/变更事件时必须同步 `src/agent-process.ts` 的 `AgentProcessEventMap`(统一契约,两侧实际 emit 面都要在此声明,契约落后 = 缺口)。两后端固有能力差异(如 codex plan 面板、claude `task_progress`)除外,但差异用 provider 分支隔离在进程实现层,不渗进 session 层。

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
