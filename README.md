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

夜航星同时接入 Claude Code 和 Codex 两个 agent 后端,**默认 Claude Code**。群里发 `model` 会按“账号 → 动态模型 → effort”选择,结果按群持久化；可用项以当前账号和上游实时返回为准。

使用 GLM Coding Plan 时,夜航星会从端点动态获取模型，并根据真实 turn 观测上下文窗口。`hi` 控制台会展示套餐档位、滚动窗口与月度用量；每条回复的 footer 也会带上当前窗口用量。

**1. 装包**

```bash
npm i -g @leviyuan/lodestar
```

装完得到 6 个命令:

| 命令 | 作用 |
| --- | --- |
| `lodestar-setup` | 首次配置向导 |
| `lodestar-daemon` | 启动 daemon |
| `lodestar-stop` | 停止 daemon |
| `lodestar-update` | 升级到最新版(含 Codex CLI、Claude Code 和 Claude SDK)|
| `lodestar-version` | 查看 Lodestar 和 Codex CLI 版本 |
| `lodestar-consult` | 供项目群主 Agent 查询全局身份并调用其他模型 |

**2. 跑向导**

```bash
lodestar-setup
```

手把手带你装 Claude Code、可选配 GLM Coding Plan(1M 上下文)、建飞书应用、启动 lodestar。Codex 是可选第二后端。

> Claude 订阅(Pro/Max OAuth 登录)不支持本项目,需走 API 方式(GLM Coding Plan 或自备 Anthropic API key)。

**3. 拉机器人进群**

群名 = `projects_root` 下的目录名(没建会自动建)。发条消息后由当前默认 Claude source 接管；群里发 `model` 可选择其他已配置账号、模型与 effort。

群里发这些**裸词**(不要斜杠,大小写不敏感)可以控 daemon:

| 指令 | 行为 |
| --- | --- |
| `hi` | 未运行时同一张卡动态启动并收束为控制台;运行中弹控制台 |
| `stop` / `st` | 软打断当前 turn,子进程保活,排队消息打 ❌ |
| `kill` / `kl` | 用状态卡展示关闭当前 agent 进程,resume id 落盘 |
| `restart` / `rs` | 进程存活:打断 + 放弃后台任务 + 恢复当前会话;进程已停:列出同一 cwd 的历史会话，选一个在本群创建独立分支 |
| `clear` / `cl` | 用状态卡展示杀进程并开新 thread(等价 `/clear`)|
| `compact` / `cm` | 主动触发当前 thread 的上下文压缩,完成后状态卡收束 |
| `model` / `md` | 展示账号→动态模型→effort 面板,按群持久化 |
| `reviewers` | 管理所有项目共用的评审身份与角色预设 |
| `task` | 打开基础飞书任务清单绑定/删除面板 |

**并发 worktree 群**

在项目主群发:

| 指令 | 行为 |
| --- | --- |
| `wt` / `worktree` | 列出本项目 `work/*` 分支状态(clean/dirty/merged/stale),已合并且未挂载的归档分支会折叠隐藏,卡片上可点 `删`。 |
| `wt feature-x` / `worktree feature-x` | 创建或加入同级目录/群 `<project>[feature-x]`,分支为 `work/feature-x`;重新激活已合并归档分支时会先更新到主线。 |

`删` 会先确认对应 worktree 群没有正在运行的 Codex session,再检查 worktree 没有未提交变更,然后解散群并删除 worktree 目录;分支保留,合并和分支清理由 agent 处理。

**临时会话 / 分叉 / 回退**(Codex 与 Claude)

在同一个工作目录里多开会话，并基于后端原生 fork 做语义化分叉/回退。Claude 使用 `forkSession + resumeSessionAt`，Codex 使用 app-server `thread/fork + lastTurnId`；两者都会派生新会话 id，源对话不动：

| 指令 | 行为 |
| --- | --- |
| `btw` | 开一个临时群 `<session>*MMDD-HHMM`，继承当前账号/模型/cwd 并启动干净会话 |
| `bye` | 停止并解散当前临时群(只能在带 `*MMDD-HHMM` 后缀的临时群里用) |
| `fk` / `fork` | 列出当前会话的每条用户输入(倒序)，选一条 → 从这条**之前**开临时群分叉，原会话不动 |
| `bk` / `back` | 列用户输入，选一条后才停止当前进程 → 本群改接到这条**之前**的新分支，并附观察到的文件变更记录 |

分叉/回退点以「用户输入」为分界：选第 N 条 = 回到这条发出之前的对话状态，选中的输入本身不包含。临时群和源群共享同一个 cwd；`fk`/`bk` **只改变对话历史，不复制或回滚磁盘文件**，Shell/MCP 等外部副作用也不会被撤销。需要文件隔离时使用 `wt`。

`rs` 的历史发现由后端自己负责：Claude 读取同 cwd 的 transcript，Codex 调用 app-server `thread/list(cwd=...)`；不会扫描/复制 Codex rollout，也不会维护第二套会话索引。选择历史会话时创建独立 fork，避免两个群共同写同一个 thread。

选择后原 `rs` 卡会原位更新，保留所选历史的后端、时间、摘要和源会话，并显示当前群的新分支状态。Codex 会直接显示新 thread；Claude 在首条输入前显示“已准备”，该 fork intent 会持久化，daemon 重启或进程退出后仍会继续同一分支。

---

## 🎁 附加能力

### 🧠 多模型咨询与评审

daemon 会为每个 Token Source 目录中的每个模型生成一个 `max` 默认身份。项目群发 `reviewers` 可把任意底层模型预设为正确性、架构、安全、测试或可维护性审查员;这些身份由所有项目共用。

主 Agent 每次发起咨询前都必须通过 `lodestar-consult identities --json` 重新获取实时身份,再创建 `question` / `review` / `critique` run。选中多个身份时必须把全部 `--identity` 合并进同一个 run，由 daemon 在该 run 内并发 fan-out；禁止一身份一个 run 后台串行。`--cross-review` 会在首轮全部成功后进行且仅进行一轮交叉复核。任何指定身份失败都会保留在报告和卡片中,不会替换模型。

Reviewer 的文件系统保持只读，但网络完全开放：Codex 可使用 live Web Search 和只读沙箱内的出站网络，Claude/GLM/DeepSeek 可使用 WebSearch/WebFetch。reviewer 仍不会继承主 Agent 的 consult capability。

`lodestar-consult` 只能在 Lodestar 管理的主 Agent 进程内使用。daemon 为当前 Session 注入短期 capability，reviewer 子进程会强制移除它,避免递归调用。daemon 每次启动都会先主动安装/更新裸 `lodestar-consult` 命令，再把它与 `feishu-notify` 的 canonical Skill 同步到 Codex、Claude standalone 目录及一个 Claude SDK 本地插件；因此排除 user settings/env 的 GLM/DeepSeek 主会话也能发现两项 Skill。源码运行与 npm 发布安装使用同一条命令契约。

本机 API 闭环为 `GET /consult/identities` 查身份、`POST /consult/runs` 建 run、`GET /consult/runs/<id>` 查结果、`DELETE /consult/runs/<id>` 取消。四个端点都要求当前主 Agent 的 Bearer capability，不接受项目名/cwd 猜测路由。

### 📋 基础飞书任务清单

在项目群发 `task`,卡片点 `启用`,夜航星会创建并绑定一个 `<project>[lodestar]` 飞书任务清单。`task` 面板里的 `删` 会二次确认,确认后删除整个清单和清单内任务。该能力不运行自动规划、执行、审核或合并 worker。

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

配置文件 `~/.config/lodestar/config.toml`,改完重启 daemon 生效。

```toml
[runtime]
live_elapsed = "second"   # footer/后台卡刷新粒度:bucket(默认,按档位省配额) | second(整秒)

[projects.calculator2]            # section 名 = 飞书群名(= projects_root 下目录名);整节仅 Claude 后端生效
cwd             = "/abs/path/to/calculator2"   # 不填则用 projects_root/<群名>
setting_sources = "project"   # 只读项目级配置,丢全局 GLM 路由
strict_mcp      = "true"      # 只挂项目 .mcp.json
tools           = "Read,Write,Edit,Bash,Glob,Grep"

[claude]
bin = "~/.local/bin/reclaude"   # 换 claude 包装器;路径错直接报错,不回退
```

> `setting_sources="project"` 会丢掉 `~/.claude/settings.json` 的 GLM 路由,要保留把凭据挪到 `[token_source.glm]`。换 `bin` 后清掉 `settings.json` / `[claude.env]` 残留的 GLM 地址,否则流量仍走 GLM。细节见 `docs/claude-agent-backend.md`。

---

> [!TIP]
> 想 7×24 长跑,Linux 使用 `systemd --user`,macOS 使用 `launchd`,Windows 使用任务计划程序拉起 `lodestar-daemon`。重启后上次活跃的 sessions 会并发自动恢复。

---

## 📄 许可

[MIT](LICENSE)
