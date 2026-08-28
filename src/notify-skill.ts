/**
 * Auto-install the `feishu-notify` Skill through the shared managed-Skill
 * pipeline: Codex/Claude standalone locations plus the daemon-owned Claude
 * SDK plugin used when GLM/DeepSeek deliberately exclude user settings.
 *
 * Why daemon writes these files:
 *
 * Skills are discovered from `~/.codex/skills/<name>/SKILL.md` and
 * `~/.claude/skills/<name>/SKILL.md` at startup. So the only way to
 * "ship with the daemon" without making the user run `cp` is to have
 * the daemon write the files itself.
 *
 * Idempotent: re-runs on every daemon boot, per location. If the
 * on-disk content matches what we'd write, no I/O. If different (daemon
 * upgraded with a new skill body, or the user hand-edited it), overwrite
 * with the daemon's canonical version. The user's edits are not
 * preserved by design — daemon owns this skill, version-locked.
 *
 * Reasonable opt-out: setting `LODESTAR_DISABLE_SKILL_SYNC=1` skips
 * the sync, for users who want to maintain the skill content
 * themselves.
 */

import { config } from './config'
import { syncManagedSkill } from './managed-skills'

export const NOTIFY_SKILL_NAME = 'feishu-notify'

export function notifySkillBody(port: number): string {
  const description = `Push a one-shot notification card to a Feishu (Lark) group via the local lodestar daemon's HTTP endpoint. Auto-trigger whenever the user asks to "通知飞书", "推送到飞书", "推到飞书群", "飞书推送", "发到飞书", "脚本跑完通知我", "进程完成发个消息", "send to feishu", "feishu notify", "lodestar notify", "post to lark group", or wants any local script / cron / long-running process to ping a Feishu group (build done, deploy finished, trade filled, monitor alert, error caught). Encodes the call shape — POST http://127.0.0.1:${port}/notify with \`{project, text, level}\` — so consumers do not have to re-derive it. Also covers interactive buttons: add \`buttons\` and either pledge a loopback \`callback\` URL (daemon POSTs the click back) or omit it and poll \`GET /notify/result/NOTIFY_ID\`; all on localhost.`
  return `---
name: ${NOTIFY_SKILL_NAME}
description: ${JSON.stringify(description)}
---

# feishu-notify

Push a one-shot card into a Feishu (Lark) group via the local lodestar
daemon. The daemon binds each group to a project name (= group name);
once the daemon has seen at least one inbound message in that group,
\`POST /notify\` with the project name routes a card to it.

## Endpoint

\`POST http://127.0.0.1:${port}/notify\` (loopback only)

Body (JSON):

| field | required | meaning |
|---|---|---|
| \`project\` | ✅ | Feishu group name (= session name = working-directory name) |
| \`text\` | ✅ | Feishu schema-2.0 markdown — \`**bold**\`, \`\` \`code\` \`\`, \`[link](url)\`, \`<font color='red'>…</font>\` |
| \`title\` |   | Card header, defaults to \`project\` |
| \`level\` |   | \`info\` (blue, default) / \`warn\` (yellow) / \`error\` (red) |
| \`images\` |   | Array of local image paths \`["/abs/a.png"]\` — uploaded to Feishu and embedded above the text (failed uploads surface inline in red, never dropped silently) |
| \`buttons\` |   | Array of \`{id, text, type?}\` — renders one button per row (vertical stack, any count). \`id\`: \`^[A-Za-z0-9_-]{1,64}$\`, unique. \`text\`: ≤ 64 chars (a short phrase is fine — each button owns its full row). \`type\`: \`default\` / \`primary\` / \`danger\` (default \`default\`). |
| \`callback\` |   | Optional loopback HTTP URL (e.g. \`http://127.0.0.1:9999/hook\`) — **push mode**: on tap the daemon POSTs the choice here. Must be \`http://\` on \`127.0.0.1\` / \`localhost\` / \`::1\`. Omit for **pull mode** (see below). |

Response: \`200 {ok, chat_id, message_id, notify_id?}\` (notify_id returned
only when buttons are present) / \`400\` bad params / \`404\` group not
bound / \`502\` Feishu API rejected.

\`GET /notify/result/<notify_id>\` — pull a button card's verdict with no
callback server: \`{notify_id, project, message_id, resolved, button?,
resolved_at?, resolved_by?}\`. \`resolved:false\` while pending. \`404\` on
unknown notify_id.

## Usage — one-shot

\`\`\`bash
curl -fsS -X POST http://127.0.0.1:${port}/notify \\
  -H 'content-type: application/json' \\
  -d '{"project":"ops","text":"✅ deploy done","level":"info"}'
\`\`\`

For automation that needs both success and failure paths:

\`\`\`bash
my-build-script.sh \\
  && curl -fsS -X POST http://127.0.0.1:${port}/notify -H 'content-type: application/json' \\
       -d '{"project":"ops","text":"✅ build ok"}' \\
  || curl -fsS -X POST http://127.0.0.1:${port}/notify -H 'content-type: application/json' \\
       -d '{"project":"ops","level":"error","text":"❌ build FAILED"}'
\`\`\`

## Usage — interactive buttons (push)

Add \`buttons\` and pledge a loopback \`callback\` URL you listen on. When
anyone taps a button in Feishu, the daemon POSTs the choice back to
that URL; the caller acks 2xx and the card freezes on the choice.

\`\`\`bash
curl -fsS -X POST http://127.0.0.1:${port}/notify \\
  -H 'content-type: application/json' \\
  -d '{"project":"ops","text":"deploy ready — approve?",
       "buttons":[
         {"id":"approve","text":"✅ 通过","type":"primary"},
         {"id":"reject","text":"❌ 拒绝","type":"danger"}
       ],
       "callback":"http://127.0.0.1:9999/hook"}'
\`\`\`

The callback is a local POST with this body (respond \`2xx\` within ~2.5s
or the click surfaces a 回调失败 toast and stays retryable):

\`\`\`json
{
 "notify_id": "nf_...",
 "message_id": "om_...",
 "chat_id": "oc_...",
 "project": "ops",
 "button": {"id":"approve","text":"✅ 通过","type":"primary"},
 "operator": {"open_id":"ou_..."},
 "timestamp": 1700000000
}
\`\`\`

The 2xx response body is OPTIONAL, but if you return one the daemon
renders it on the final card as the caller's reply — turning the ack
into a two-way channel. Return JSON \`{"text":"…"}\` (or \`{"reply"}\` /
\`{"message"}\`) or plain text; capped at 500 chars; Feishu markdown
allowed. Empty body ⇒ just the standard "反馈已送达" marker.

\`\`\`
→ 200 {"text":"已发布 **v1.2.3** · 提交 abc123"}
\`\`\`
renders as a new line under "✅ 已选择:… · 反馈已送达".

Minimal local receiver (Python, stdlib only):

\`\`\`python
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("content-length","0"))
        body = self.rfile.read(n)
        print("clicked:", body.decode())   # parse JSON → act on button.id
        self.send_response(200); self.end_headers(); self.wfile.write(b"ok")
HTTPServer(("127.0.0.1", 9999), H).serve_forever()
\`\`\`

Notes (push):
- The whole loop is localhost: \`/notify\` in, callback POST out. The
  callback URL must be loopback — non-loopback is rejected with \`400\`.
- Callback must return 2xx within ~2.5s or the click surfaces a 回调失败
  marker and stays retryable.
- Card feedback is two-phase, both phases drawn via message.patch on the
  original card after a toast ACK. The click ACKs as a toast instantly
  ("⏳ 已选择:X · 推送中…"); the card then flips to \`⏳ 已选择:X · 推送中…\`
  (Phase 1) and to \`✅ … · 反馈已送达\` / \`⚠️ … · 回调失败:…\` once the push
  resolves (Phase 2). The ACK is a toast (not an inline card) because an
  inline card ACK silently swallows any follow-up card update; and the
  callback-token endpoint \`/interactive/v1/card/update\` is a legacy path
  that draws schema-2.0 cards blank. message.patch is safe here because
  it runs AFTER the ACK (the documented footgun is patch BEFORE ACK,
  which races the ACK response). A fast second click during the push is
  blocked ("处理中…"); a failed push stays retryable.

## Usage — interactive buttons (pull, no callback server)

Skip \`callback\`. The card still ships with buttons; on tap the daemon
freezes it on the choice and records the verdict. You read the result
with a plain GET — ideal for a stateless one-line curl script that has
no HTTP server.

\`\`\`bash
# 1. send the card (no callback), keep the notify_id
NID=$(curl -fsS -X POST http://127.0.0.1:${port}/notify \\
  -H 'content-type: application/json' \\
  -d '{"project":"ops","text":"approve deploy?",
       "buttons":[{"id":"yes","text":"✅"},{"id":"no","text":"❌"}]}' \\
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["notify_id"])')

# 2. poll until someone taps (resolved:true)
curl -sS http://127.0.0.1:${port}/notify/result/$NID
# → {"notify_id":"nf_…","project":"ops","message_id":"om_…",
#    "resolved":false}
# …after a tap…
# → {"notify_id":"nf_…","project":"ops","message_id":"om_…",
#    "resolved":true,
#    "button":{"id":"yes","text":"✅","type":"default"},
#    "resolved_at":1783242381786,"resolved_by":"ou_…"}
\`\`\`

Notes:
- A second tap on an already-resolved card is idempotent (\"已处理过\"),
  so two members clicking at once records a single verdict.
- Registrations survive a daemon restart (persisted to
  \`~/.local/share/lodestar/notify-callbacks.json\`, pruned after 7 days).

## Notes

- The group must have received at least one message after the daemon
  started (the daemon learns chat_id → name binding from inbound
  events). If you see \`404\` send any message in the group and retry.
- This skill is auto-installed by the lodestar daemon on every boot.
  Hand-edits will be overwritten — set
  \`LODESTAR_DISABLE_SKILL_SYNC=1\` and restart the daemon if you want
  to maintain the file yourself.
`
}

export function ensureFeishuNotifySkill(): void {
  syncManagedSkill({ name: NOTIFY_SKILL_NAME, body: notifySkillBody(config.notify.port) })
}
