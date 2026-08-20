/**
 * LaTeX 公式渲染:agent 正文里的 $$…$$ / \[…\] / \(…\) 公式离线渲染成
 * PNG(MathJax TeX→SVG + resvg SVG→PNG),上传飞书拿 image_key,回填成卡片
 * markdown 里的 ![公式](img_key)。inline 公式同样转图 —— 图片语法在
 * Card Kit markdown 里内联渲染,公式不断文字流(选择:全部转图片,不走
 * Unicode 转写)。
 *
 * CJK 硬骨头:MathJax 自带字体没有 CJK 字形,\text{评分} 直接渲染是豆腐
 * 块。解法(stash-swap):预处理时把每个 CJK 字符换成唯一拉丁占位字母喂
 * MathJax;渲染出 SVG 后把占位字母的 <path> 原位替换成 <g translate·
 * scale(1,-1)><text>>,resvg 用系统 Noto Sans CJK 画 —— 基线对齐、
 * 无翻转(translate 继承占位位置,scale 抵消 MathJax 的 y 翻转坐标系)。
 *
 * 失败语义(no-fallback):渲染或上传失败时该公式保留原始 LaTeX 文本
 * (走既有 downgradeMathBlocksInProse 的代码块降级),并 log 暴露 ——
 * 不悄悄吞、不造假图。
 */
// mathjax-full / @resvg/resvg-js 全部延迟到首次渲染时 require(不顶层
// import):resvg 是 native .node,顶层 import 会让 bun --target=node 的
// 单文件 build 试图内联 .node asset 而拒绝 outfile 模式;Node 发布包在
// 运行时从 node_modules 正常加载,native 包走 npm deps 分发。
import { createRequire } from 'node:module'
const require_ = createRequire(import.meta.url)

import { log } from './log.ts'
import * as feishu from './feishu.ts'

// ── MathJax/resvg 懒加载单例(首次渲染时初始化) ────────────────────────
const EM = 18 // 正文 14px 放大一点,卡片里看清细节
const EX = 9
let mjx: {
  adaptor: ReturnType<typeof import('mathjax-full/js/adaptors/liteAdaptor.js')['liteAdaptor']>
  doc: ReturnType<typeof import('mathjax-full/js/mathjax.js')['mathjax']['document']>
} | null = null
function mathjaxRuntime() {
  if (mjx) return mjx
  const { liteAdaptor } = require_('mathjax-full/js/adaptors/liteAdaptor.js')
  const { RegisterHTMLHandler } = require_('mathjax-full/js/handlers/html.js')
  const { mathjax } = require_('mathjax-full/js/mathjax.js')
  const { TeX } = require_('mathjax-full/js/input/tex.js')
  const { AllPackages } = require_('mathjax-full/js/input/tex/AllPackages.js')
  const { SVG } = require_('mathjax-full/js/output/svg.js')
  const adaptor = liteAdaptor({ fontSize: EM })
  RegisterHTMLHandler(adaptor)
  const doc = mathjax.document('', { InputJax: new TeX({ packages: AllPackages }), OutputJax: new SVG({ fontCache: 'none' }) })
  mjx = { adaptor, doc }
  return mjx
}

/** 飞书卡片正文默认文字色(浅色主题 near-black,深色主题由卡片底色衬底)。 */
const INK = '#1F2329'
/** PNG 放大倍数:ex→px 后 ×3,对抗卡片图片压缩后的锯齿。 */
const SCALE = 3

/** CJK(含全角符号/假名/谚文)+ 常用非拉丁(Greek/Cyrillic 也占位换掉,
 *  MathJax 对部分 Greek 有字形、Cyrillic 没有,统一走系统字体最稳)。 */
const STASH_RE = /[Ā-˿Ͱ-῿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/g

interface Stash { src: string; map: Array<{ ph: string; c: string }> }

function stashNonLatin(tex: string): Stash {
  const map: Array<{ ph: string; c: string }> = []
  let i = 0
  // 占位字母从 'q' 起避开常见变量名(a/b/c/e/i/n/s/x/y 是公式常客,撞车时
  // 靠 data-c 顺序消费虽正确,但少撞更稳);超过 26 个 CJK 字符用双字母。
  const src = tex.replace(STASH_RE, c => {
    const j = i++
    const ph = j < 26
      ? String.fromCharCode(0x71 + j) // q r s t u …
      : String.fromCharCode(0x61 + (j % 26)) + String.fromCharCode(0x61 + Math.floor(j / 26))
    map.push({ ph, c })
    return ph
  })
  return { src, map }
}

/** MathJax SVG 每字符一个 <path data-c="码点hex">(可带 translate)。按
 *  出现顺序把占位字母的 path 换成系统字体 <text>。MathJax 按源码顺序
 *  emit path,与 stash map 顺序天然一致。 */
function swapStashedPaths(svg: string, map: Stash['map']): string {
  const hexOf = (ch: string) => ch.charCodeAt(0).toString(16).toUpperCase()
  let idx = 0
  return svg.replace(/<path data-c="([0-9A-F]+)"([^>]*?)(?:\/>|><\/path>)/g, (m, hex: string, attrs: string) => {
    const entry = map[idx]
    if (!entry || hex !== hexOf(entry.ph[0])) return m
    idx++
    const tr = attrs.match(/transform="translate\(([^)]+)\)"/)?.[1] ?? '0,0'
    return `<g transform="translate(${tr}) scale(1,-1)"><text x="0" y="0" font-family="Noto Sans CJK SC" font-size="880">${entry.c}</text></g>`
  })
}

/** TeX 源码 → PNG bytes。渲染失败(MathJax 报错/无 TeX 特征)返回 null。 */
export function renderTeXToPNG(texSrc: string): { png: Uint8Array } | null {
  try {
    const { adaptor, doc } = mathjaxRuntime()
    const { src, map } = stashNonLatin(texSrc)
    const node = doc.convert(src, { display: true, em: EM, ex: EX, containerWidth: 80 * EM })
    let markup = adaptor.outerHTML(node)
    // liteAdaptor 输出裹一层 <mjx-container>,resvg 只要 <svg> 根。
    markup = markup.replace(/^[\s\S]*?(<svg\b)/, '$1').replace(/<\/svg>[\s\S]*$/, '</svg>')
    if (map.length) markup = swapStashedPaths(markup, map)
    const svgTag = markup.match(/<svg[^>]*>/)?.[0] ?? ''
    const wex = parseFloat(svgTag.match(/ width="([\d.]+)ex"/)?.[1] ?? '0')
    const hex_ = parseFloat(svgTag.match(/ height="([\d.]+)ex"/)?.[1] ?? '0')
    // MathJax svg 自带 style 属性,resvg 拒重复定义 → 追加而非新增。
    const colored = markup
      .replace(/(<svg\b[^>]*style="[^"]*)"/, `$1; color:${INK}"`)
      .replace(/currentColor/g, INK)
    const { Resvg } = require_('@resvg/resvg-js') as typeof import('@resvg/resvg-js')
    const resvg = new Resvg(colored, {
      font: {
        loadSystemFonts: true,
        serifFamily: 'Noto Serif CJK SC',
        sansSerifFamily: 'Noto Sans CJK SC',
      },
      fitTo: { mode: 'width', value: Math.max(1, Math.ceil(wex * EX * SCALE)) },
    })
    return { png: resvg.render().asPng() }
  } catch (e) {
    log(`math-render: TeX→PNG failed for ${texSrc.slice(0, 60)}…: ${e}`)
    return null
  }
}

// ── 公式提取与回填 ────────────────────────────────────────────────────

/** 公式片段:定位 + 原始 TeX 源。display/inline 分别记录,回填时 inline
 *  在原位、display 独立成段。 */
interface MathSpan { start: number; end: number; tex: string; display: boolean }

/** 贪心扫 $$…$$、\[…\]、\(…\)。只做定位不做改写;美元 inline($…$)不认
 *  —— 与 downgradeMathBlocksInProse 的防误伤口径一致(货币文本太多)。 */
function findMathSpans(text: string): MathSpan[] {
  const spans: MathSpan[] = []
  const push = (m: RegExpExecArray, tex: string, display: boolean) => {
    spans.push({ start: m.index, end: m.index + m[0].length, tex, display })
  }
  const displayRe = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g
  let m: RegExpExecArray | null
  while ((m = displayRe.exec(text)) !== null) {
    // $$…$$ 命中时 m[2] 是 undefined,反之亦然 —— 各自判空再 trim
    const tex = (m[1] ?? m[2] ?? '').trim()
    if (tex) push(m, tex, true)
  }
  const inlineRe = /\\\(([\s\S]+?)\\\)/g
  while ((m = inlineRe.exec(text)) !== null) {
    const tex = m[1].trim()
    if (tex) push(m, tex, false)
  }
  return spans.sort((a, b) => a.start - b.start)
}

/** image_key 缓存:同公式(按源码 hash)不重复渲染上传。turn 间共享,
 *  进程生命周期有效。上传失败的公式负缓存(短 TTL 防抖,同轮重试几次后
 *  放弃)。 */
const keyCache = new Map<string, string>()
const failedHashes = new Map<string, number>()
const FAIL_TTL_MS = 10 * 60 * 1000

function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

async function uploadTeX(tex: string): Promise<string | null> {
  const h = fnv1a(tex)
  const cached = keyCache.get(h)
  if (cached) return cached
  const failedAt = failedHashes.get(h)
  if (failedAt !== undefined) {
    if (Date.now() - failedAt < FAIL_TTL_MS) return null
    failedHashes.delete(h)
  }
  const rendered = renderTeXToPNG(tex)
  if (!rendered) { failedHashes.set(h, Date.now()); return null }
  // resvg 产 PNG bytes,直接 multipart 上传(不经临时文件)。飞书 im/v1/images
  // 收 image_type=message + 二进制;文件名带 .png 后缀供服务端嗅探。
  const tmp = `${import.meta.dir}/../../.math-tmp-${h}.png`
  try {
    await Bun.write(tmp, rendered.png)
    const key = await feishu.uploadImageKey(tmp)
    if (key) keyCache.set(h, key)
    else failedHashes.set(h, Date.now())
    return key
  } finally {
    await Bun.file(tmp).delete().catch(() => {})
  }
}

/** 把一段 assistant 文本里的公式替换成 ![公式](img_key)。渲染/上传失败
 *  的公式原样保留(后续 sanitize 降级成代码块,可见、不造假)。 */
export async function renderMathInText(text: string): Promise<string> {
  const spans = findMathSpans(text)
  if (!spans.length) return text
  let out = ''
  let last = 0
  for (const span of spans) {
    if (span.start < last) continue // 重叠(不该发生)防御
    out += text.slice(last, span.start)
    const key = await uploadTeX(span.tex)
    if (key) {
      const imgMd = `![formula](${key})`
      out += span.display ? `\n\n${imgMd}\n\n` : imgMd
    } else {
      // 失败保留原样:display 语法 $$…$$ sanitize 会转代码块,inline
      // \(…\) 会转行内 code —— 两条路都是可见降级,不吞内容。
      out += text.slice(span.start, span.end)
    }
    last = span.end
  }
  out += text.slice(last)
  return out
}

/** 同步探测:文本是否含公式(调用方决定是否走 async 渲染路径)。 */
export function hasMathSpans(text: string): boolean {
  return findMathSpans(text).length > 0
}

/** 确定性渲染(不经上传),给测试用。 */
export const __test = { findMathSpans, stashNonLatin, swapStashedPaths, renderTeXToPNG }
