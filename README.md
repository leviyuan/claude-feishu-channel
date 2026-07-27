<p align="center">
  <img src="https://raw.githubusercontent.com/leviyuan/lodestar/main/promo.jpg" alt="夜航星 Lodestar" width="100%">
</p>

# 夜航星 (Lodestar)

AI 不是帮手,是倍率。它放大的不是体力,是你 —— 你的直觉、判断和品味,每一样都被乘以一个你以前不敢想的系数。

夜航星让这件事真正发生:在你思考的地方接住想法,在你转身之后继续推向终点。

---

## 🚀 用起来

跨平台 (Windows / macOS / Linux),npm 全局安装后由 Node.js 运行,需要 Node.js ≥ 18；Bun 只用于源码开发和发布构建。

### 🧠 双后端:Claude Code + Codex

夜航星同时接入 Claude Code 和 Codex 两个 agent 后端,**默认 Claude Code**。群里发 `model` 可在 Claude·GLM-5.2 与 Codex·GPT-5.5 之间一键切换,选择按群持久化。

强烈推荐 Claude Code 搭配 **GLM-5.2** —— 开放 1M token 上下文窗口,长会话不易丢前文。订阅了 GLM Coding Plan,`hi` 控制台会直接展示套餐档位、5 小时滚动窗口与月度用量;每条回复的 footer 也会带上当前 5h 窗口的已用百分比(`5h·N%`),额度消耗随时可见。

**1. 装包**

```bash
npm i -g @leviyuan/lodestar
```

装完得到 5 个命令:

| 命令 | 作用 |
| --- | --- |
| `lodestar-setup` | 首次配置向导 |
| `lodestar-daemon` | 启动 daemon |
| `lodestar-stop` | 停止 daemon |
| `lodestar-update` | 升级到最新版(含 Codex CLI、Claude Code 和 Claude SDK)|
| `lodestar-version` | 查看 Lodestar 和 Codex CLI 版本 |

**2. 跑向导**

```bash
lodestar-setup
```

手把手带你装 Claude Code、可选配 GLM Coding Plan(1M 上下文)、建飞书应用、启动 lodestar。Codex 是可选第二后端。

> Claude 订阅(Pro/Max OAuth 登录)不支持本项目,需走 API 方式(GLM Coding Plan 或自备 Anthropic API key)。

**3. 拉机器人进群**

群名 = `projects_root` 下的目录名(没建会自动建)。发条消息,默认由 Claude·GLM-5.2 接管(群里发 `model` 可切到 Codex·GPT-5.5)。

群里发这些**裸词**(不要斜杠,大小写不敏感)可以控 daemon:

| 指令 | 行为 |
| --- | --- |
| `hi` | 未运行时同一张卡动态启动并收束为控制台;运行中弹控制台 |
| `stop` / `st` | 软打断当前 turn,子进程保活,排队消息打 ❌ |
| `kill` / `kl` | 用状态卡展示关闭 Codex 进程,`threadId` 落盘 |
| `restart` / `rs` | 进行中:打断 + 放弃后台进程 + 恢复;空闲:列出项目最近 24h 会话(不足 10 条补更早),选一个在本群接续恢复 |
| `clear` / `cl` | 用状态卡展示杀进程并开新 thread(等价 `/clear`)|
| `compact` / `cm` | 主动触发当前 thread 的上下文压缩,完成后状态卡收束 |
| `model` / `md` | 展示固定两项面板(Codex·GPT-5.5 / Claude·GLM-5.2),一键生效,按群持久化 |
| `task` | 打开项目任务清单面板,启用飞书任务清单自动化（预览版） |

**并发 worktree 群**

在项目主群发:

| 指令 | 行为 |
| --- | --- |
| `wt` / `worktree` | 列出本项目 `work/*` 分支状态(clean/dirty/merged/stale),已合并且未挂载的归档分支会折叠隐藏,卡片上可点 `删`。 |
| `wt feature-x` / `worktree feature-x` | 创建或加入同级目录/群 `<project>[feature-x]`,分支为 `work/feature-x`;重新激活已合并归档分支时会先更新到主线。 |

`删` 会先确认对应 worktree 群没有正在运行的 Codex session,再检查 worktree 没有未提交变更,然后解散群并删除 worktree 目录;分支保留,合并和分支清理由 agent 处理。

**临时会话 / 分叉 / 回滚**(Claude 后端)

在同一个项目目录里多开 Claude 会话,加上语义化的分叉/回滚——基于 Claude 原生的会话 fork(派生新会话 id,原对话不动):

| 指令 | 行为 |
| --- | --- |
| `btw` | 开一个临时群 `<project>*MMDD-HHMM`(同一个项目目录,自动启动一个干净 Claude) |
| `bye` | 解散当前临时群(只能在 `*` 开头的临时群里用) |
| `fk` / `fork` | 列出当前会话的每条用户输入(倒序),选一条 → 从这条**之前**开临时群分叉,原会话不动 |
| `bk` / `back` | 立刻终止当前 + 列用户输入,选一条 → 当前会话回退到这条**之前**,并发一张回滚段 Write 记录卡(代码块,可复制后编辑重发) |

分叉/回滚点以「用户输入」为分界:选第 N 条 = 回到这条发出之前的状态。`rs` 空闲模式的历史列表数据源是 Claude 自己的会话存档(`~/.claude/projects/<本项目目录编码>/*.jsonl`),同一工作目录的全部会话都列出来,worktree(不同目录)不会混进来。

---

## 🎁 附加能力

### 📋 飞书任务清单自动化（预览版）

在项目群发 `task`,卡片点 `启用`,夜航星会创建并绑定一个 `<project>[lodestar]` 飞书任务清单。清单分组固定为:

| 分组 | 用途 |
| --- | --- |
| `设计中` | 默认分组;放需求、想法或待讨论任务,Codex 和 agy 会各写一条规划评论。 |
| `[AI]待执行` | 放已经准备交给 AI 实现的任务;worker 会挑一个进入执行。 |
| `[AI]执行中` | 当前自动执行中的任务;Codex 在本地 worktree 修改代码并生成本地审查请求。 |
| `[AI]待审核` | agy 审核后的任务;人工确认后勾选完成,触发 Codex 本地合并。 |
| `已完成` | 合并确认后的任务。 |

这个能力目前是预览版。worker 启动后会定时扫描绑定清单,一次只推进一个任务。所有规划、执行、审核、合并结果都会写回任务评论区;失败不会静默吞掉,会在评论或日志里暴露原因。

`task` 面板里的 `删` 会二次确认,确认后删除整个清单和清单内任务。这个能力需要飞书应用开通任务清单/任务/评论相关权限;缺权限时面板会显示 Open API 返回的失败原因和缺失 scope。

### 🔔 HTTP 通知端点

本机任意脚本一行 curl 就能往群里推一张 markdown 卡片:`info` / `warn` / `error` 三档染色,正文支持飞书 markdown,还能附本地图片、加交互按钮、把点击结果 POST 回你自己的回调。这条能力对应的 skill,daemon 每次启动会自动装进 `~/.claude/skills/` 和 `~/.codex/skills/`(不用自己放文件),完整字段、按钮和回调协议看 [`feishu-notify` skill](src/notify-skill.ts)。

推一条带图的告警:

```bash
curl -sS -X POST http://127.0.0.1:9876/notify \
  -H 'Content-Type: application/json' \
  -d '{"project":"ops","level":"error","text":"卡点了,截图如下","images":["/abs/shot.png"]}'
```

发一张带按钮的审批卡,点了按钮 daemon 把选择 POST 回你本机的 callback:

```bash
curl -sS -X POST http://127.0.0.1:9876/notify \
  -H 'Content-Type: application/json' \
  -d '{"project":"ops","text":"deploy ready — 审批?",
       "buttons":[
         {"id":"approve","text":"✅ 通过","type":"primary"},
         {"id":"reject","text":"❌ 拒绝","type":"danger"}
       ],
       "callback":"http://127.0.0.1:9999/hook"}'
```

---

## ⚙️ 配置参考

配置在 `~/.config/lodestar/config.toml`,`lodestar-setup` 会帮你生成,手改也行。两个常被问的:

### 想让 footer / 后台卡按秒刷新耗时?

默认 `bucket`:活跃 footer 与后台任务 header 用相对档位(`<30s` / `<1m` / …),只在档位边界 push,省飞书 cardkit 配额。需要旧式按秒进度时:

```toml
[runtime]
live_elapsed = "second"   # "bucket"(默认) | "second"
```

`second` 时 footer 约每 1s、后台卡约每 2s push,文案为 `45s` 这种整秒。改完需重启 daemon。

### 想让某个外部项目跑在别的目录?

默认群名就是 `projects_root` 下的目录名。但如果你的项目放在别处、不想搬进来,在 config.toml 指一下它的目录就行——**section 名就是飞书群名**(daemon 用群名去 `config.projects[群名]` 取 cwd),其它项目不受影响:

```toml
[projects.calculator2]
cwd = "/abs/path/to/calculator2"
```

下面几个开关是给"想在这个项目里跑个更受限的 Claude session"的人准备的(限定工具、只挂项目自己的 MCP、只读项目级配置之类)。普通用法用不着,默认全不开,也只对 Claude 后端有效。**要开就整节配齐,配一半对话会卡死**:

```toml
[projects.calculator2]
cwd                        = "/abs/path/to/calculator2"
setting_sources            = "project"   # 只读项目级配置(会丢全局)
strict_mcp                 = "true"      # 只挂项目 .mcp.json,挡掉全局 MCP
tools                      = "Read,Write,Edit,Bash,Glob,Grep"
```

> `<cwd>/.mcp.json` 默认就会被读(对齐裸 `claude` 的项目 MCP 自动发现),不用单独开;只有想关掉才设 `load_project_mcp = "false"`。
>
> 最常踩的坑:`setting_sources = "project"` 会把 `~/.claude/settings.json` 里的 GLM 路由一起丢掉 —— `[claude.env]` 是**无差别注入到所有项目** spawn env 的(不只对这一个项目生效),把 GLM 的 base_url / token 挪过去就能兜住。要是看到卡片一直 `Thinking...`、model 显示 `<synthetic>`,先把整节注释掉重启,基本就是这几个开关没配齐。

### 想换成 reclaude 之类的 claude 包装器?

默认 lodestar 自己找 `claude`。想让它改用 [reclaude](https://docs.reclaude.ai)(或别的"参数原样透传"的包装器),指定一下路径:

```toml
[claude]
bin = "~/.local/bin/reclaude"
```

路径填错会直接报错,不会偷偷回退到自动查找。换成 reclaude 的话,记得把 `~/.claude/settings.json` 或 `[claude.env]` 里残留的 GLM 地址 / Token 清掉,否则流量还走 GLM、reclaude 的拦截不生效。更多细节看 `docs/claude-agent-backend.md`。

---

> [!TIP]
> 想 7×24 长跑,用 `systemd --user`(Linux/macOS)或 Windows 任务计划程序拉起 `lodestar-daemon`。重启后上次活跃的 sessions 会并发自动 `--resume` 接回。

---

## 📄 许可

[MIT](LICENSE)
