/**
 * Element-id convention (must be unique within a card):
 *   user_input        — collapsible_panel,header "📥 收到 (N)",body 是这一轮
 *                       Codex 收到的 user wireText(多条 mid-turn 合并的就是 N>1)。
 *                       默认 expanded=false,把"自己刚才说了啥"收纳进卡片自己,
 *                       不必滚群里找原消息。
 *   tool_<i>          — one collapsible per tool call, indexed from 0
 *   plan_update_<i>   — timeline snapshot inserted where a plan update occurs
 *   goal_update_<i>   — timeline snapshot inserted where a goal update occurs
 *   context_compact_<i> — collapsible context-compaction lifecycle panel.
 *                       item/started creates it; item/completed replaces it.
 *   assistant         — completed assistant answer segment
 *   footer            — runtime footer. While the model is silent it
 *                       shows `Thinking...(Ns)` while the model is silent,
 *                       `Writing...(Ns)` while assistant text is buffered,
 *                       `Working...(Ns)` while tools/non-text work run; at
 *                       turn close it becomes the terminal status line.
 */
import { transformMarkdownProse } from '../markdown-code'

export const ELEMENTS = {
  userInput: 'user_input',
  footer: 'footer',
  /** Live task-board overview panel — 本 turn 一旦出现 Task 工具就在 footer
   *  正前建立(固定 id,后续只 replace 内容、不挪位)。默认展开、每次 Task 工具
   *  add/complete 都刷新成整个 board 的最新快照,对齐 claude cli 底部常驻 todo。
   *  独立于 tool_<i>(那是每次工具调用的过程变更记录、折叠);这个是实时总览。
   *  建立后它成为新的插入锚点 —— 后续过程元素 insert_before 它而非 footer,
   *  保证实时区永远压在 footer 正前(见 session-tools.taskLiveAnchor)。 */
  taskBoardLive: 'task_board_live',
  /** Live plan panel — codex turn/plan/updated 首次到达即建立(footer 正前,
   *  固定 id,后续只 replace 内容、不挪位),始终显示最新计划,对齐 claude 侧
   *  taskBoardLive 的常驻语义(最新状态压在卡片末尾,不被后续元素顶走)。
   *  timeline 上的 plan_update_<i> 快照与此并存。建立后与 taskBoardLive
   *  共同构成插入锚点链(见 session-tools.taskLiveAnchor)。 */
  planLive: 'plan_live',
  tool: (i: number) => `tool_${i}`,
  planUpdate: (i: number) => `plan_update_${i}`,
  goalUpdate: (i: number) => `goal_update_${i}`,
  contextCompact: (i: number) => `context_compact_${i}`,
  /** Assistant text is segmented: every completed agentMessage becomes one
   * static markdown element, so element order in the card matches Codex's
   * emission order. */
  assistant: (i: number) => `assistant_${i}`,
  /** Console (hi) card — the subscription-usage row is rendered as its
   * own element so we can replace it after the initial card lands,
   * decoupling the slow Codex account fetch from the rest of the panel's
   * synchronous data. */
  consoleCurrentModel: 'console_current_model',
  consoleProjects: 'console_projects',
  consoleHost: 'console_host',
  consoleUsage: 'console_usage',
  /** Model command card — one replaceable panel for model → effort
   * multi-step selection inside a single card. */
  modelPanel: 'model_panel',
  /** One-shot agy task card. */
  agyPrompt: 'agy_prompt',
  agyStats: 'agy_stats',
  agyResult: 'agy_result',
  agyForward: 'agy_forward',
  agyRepo: 'agy_repo',
  /** Tasklist automation panel. */
  tasklistPanel: 'tasklist_panel',
} as const

function escapeHtmlEntities(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 降级 prose 里的外链图片 ![alt](url) 为纯文本标记。url 捕获到 `)` 前
 *  (含空格也完整保留,trim 首尾空白)——Card Kit 把 ![alt](url) 解析成
 *  image 并拿 url 当 img_key,外链 URL 会被服务端拒(ErrCode 200570),
 *  导致整张卡 create / 元素 update 失败;降级既不触发 image 解析,又保留
 *  原图地址。已上传的合法 image_key(img_v2_… 等飞书 key 格式)除外 ——
 *  那是 math-render 回填的公式图,原样保留让卡片渲染成图。 */
const FEISHU_IMG_KEY_RE = /^img_v[12]_[A-Za-z0-9]+$|^img_[a-z0-9_.-]+$/i
function downgradeExternalImagesInProse(s: string): string {
  return s.replace(
    /!\[([^\]]*)\]\(([^)]*)\)/g,
    (m, alt: string, url: string) => {
      const u = url.trim()
      if (FEISHU_IMG_KEY_RE.test(u)) return m
      return alt.trim() ? `🖼️ ${alt.trim()} (${u})` : `🖼️ ${u}`
    },
  )
}

/** 把不可信文本(用户消息 / LLM 正文 / 工具输出 / SDK 结构化字段)规范化成
 *  Card Kit markdown 元素可安全渲染的 content:代码块与行内 code 字面保留,
 *  只清洗其外 prose —— 转义 & < >(防被 CardKit 当 HTML 结构吞)+ 降级外链
 *  图片。代码主动构造的飞书标签(<font> 等)经此函数会被转义;需保留标签做
 *  彩色的场景(如 notify opts.text)用 downgradeExternalImagesForCardKit。
 *  保留 **粗体** / [文字](url) / 列表 / 代码块等合法 markdown。 */
export function sanitizeMarkdownForCardKit(text: string): string {
  return transformMarkdownProse(text, s => downgradeMathBlocksInProse(downgradeExternalImagesInProse(escapeHtmlEntities(s))))
}

/** 飞书卡片 markdown 不渲染 LaTeX($$…$$ / \\[…\\] / \\(…\\) / $…$ 以及
 *  \\text{}/\\frac{}{}{} 这类裸命令)——原样透传会得到夹着反斜杠命令的乱码
 *  正文。降级成代码块:公式至少等宽完整可读,不再和正文混排。
 *  $…$ inline 需带数学特征(\\ 命令或 ^ _ =)才降级 —— 「$5 和 $10」这类
 *  普通美元文本不误伤。 */
function downgradeMathBlocksInProse(s: string): string {
  return s
    // \[ … \] 与 $$ … $$(display math)→ 代码块
    .replace(/\\\[([\s\S]*?)\\\]/g, (_m, body: string) => `\n\`\`\`\n${body.trim()}\n\`\`\`\n`)
    .replace(/\$\$([\s\S]*?)\$\$/g, (_m, body: string) => `\n\`\`\`\n${body.trim()}\n\`\`\`\n`)
    // \( … \)(inline math)→ 行内 code;\(…\) 定界符无歧义,直接降级
    .replace(/\\\(([\s\S]*?)\\\)/g, (_m, body: string) => `\`${body.trim()}\``)
    // $…$ 仅在含数学特征(反斜杠命令 / ^ / _ / =)时降级,防美元金额误伤
    .replace(/\$([^$\n]+)\$/g, (m, body: string) =>
      /\\|\^|_|=/.test(body) ? `\`${body.trim()}\`` : m)
}

/** 只降级外链图片、不转义 HTML —— 给 notify 这种调用方用:opts.text 里想用
 *  <font color='...'> 做彩色强调(Card Kit 支持的合法标签,不执行脚本)。卡
 *  失败的根因是外链图片(img_key 被拒),不是 HTML 标签,故只防图片、保留
 *  <font> 等标签;代码块与行内 code 仍字面保留。 */
export function downgradeExternalImagesForCardKit(text: string): string {
  return transformMarkdownProse(text, downgradeExternalImagesInProse)
}
