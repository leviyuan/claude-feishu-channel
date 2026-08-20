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
// MathJax 按 em 排版;inline 与 display 各一套字号单例:
//   inline  em=14 —— 对齐卡片正文 normal(14px),单字母小图不再撑行
//   display em=22 —— 独立成段的展示公式稍大,层级清楚
const EX_RATIO = 0.5 // MathJax 默认 ex = em/2
let mjxByEm = new Map<number, {
  adaptor: ReturnType<typeof import('mathjax-full/js/adaptors/liteAdaptor.js')['liteAdaptor']>
  doc: ReturnType<typeof import('mathjax-full/js/mathjax.js')['mathjax']['document']>
}>()
function mathjaxRuntime(em: number) {
  let rt = mjxByEm.get(em)
  if (rt) return rt
  const { liteAdaptor } = require_('mathjax-full/js/adaptors/liteAdaptor.js')
  const { RegisterHTMLHandler } = require_('mathjax-full/js/handlers/html.js')
  const { mathjax } = require_('mathjax-full/js/mathjax.js')
  const { TeX } = require_('mathjax-full/js/input/tex.js')
  const { AllPackages } = require_('mathjax-full/js/input/tex/AllPackages.js')
  const { SVG } = require_('mathjax-full/js/output/svg.js')
  const adaptor = liteAdaptor({ fontSize: em })
  RegisterHTMLHandler(adaptor)
  const doc = mathjax.document('', { InputJax: new TeX({ packages: AllPackages }), OutputJax: new SVG({ fontCache: 'none' }) })
  rt = { adaptor, doc }
  mjxByEm.set(em, rt)
  return rt
}

/** 飞书卡片正文默认文字色(浅色主题 near-black,深色主题由卡片底色衬底)。 */
const INK = '#1F2329'

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

/** TeX 源码 → PNG bytes。em 控制排版字号(display=22 展示级);fitTo 按
 *  ex→px 目标宽光栅化。返回 PNG 及其真实像素尺寸(从 IHDR 读 —— resvg
 *  实例的 width/height 属性是默认视口,不反映 fitTo 后的真实输出)。
 *  渲染失败(MathJax 报错)返回 null。 */
export function renderTeXToPNG(texSrc: string, em = 22, display = true): { png: Uint8Array; width: number; height: number } | null {
  try {
    const ex = em * EX_RATIO
    const { adaptor, doc } = mathjaxRuntime(em)
    const { src, map } = stashNonLatin(texSrc)
    const node = doc.convert(src, { display, em, ex, containerWidth: 80 * em })
    let markup = adaptor.outerHTML(node)
    // liteAdaptor 输出裹一层 <mjx-container>,resvg 只要 <svg> 根。
    markup = markup.replace(/^[\s\S]*?(<svg\b)/, '$1').replace(/<\/svg>[\s\S]*$/, '</svg>')
    if (map.length) markup = swapStashedPaths(markup, map)
    const svgTag = markup.match(/<svg[^>]*>/)?.[0] ?? ''
    const wex = parseFloat(svgTag.match(/ width="([\d.]+)ex"/)?.[1] ?? '0')
    // MathJax svg 自带 style 属性,resvg 拒重复定义 → 追加而非新增。
    const colored = markup
      .replace(/(<svg\b[^>]*style="[^"]*)"/, `$1; color:${INK}"`)
      .replace(/currentColor/g, INK)
    const { Resvg } = require_('@resvg/resvg-js') as typeof import('@resvg/resvg-js')
    // 超采样:按 3 倍宽出图(矢量内部光栅化密度高),渲染出的 PNG 尺寸
    // 即最终显示尺寸,3 倍宽会撑大卡片 —— resvg 的 fitTo 在光栅化时缩放,
    // 不是 CSS 缩放,所以这里超采样思路只作用于矢量精度:
    // 直接以目标宽(1x)光栅化,字号小时曲线锯齿由 resvg 亚像素抗锯齿兜。
    const targetW = Math.max(1, Math.round(wex * ex))
    const resvg = new Resvg(colored, {
      font: {
        loadSystemFonts: true,
        serifFamily: 'Noto Serif CJK SC',
        sansSerifFamily: 'Noto Sans CJK SC',
      },
      fitTo: { mode: 'width', value: targetW },
    })
    const png = resvg.render().asPng()
    // 真实输出尺寸从 PNG IHDR 读(字节 16-23:width/height big-endian uint32)
    const dv = new DataView(png.buffer, png.byteOffset, png.byteLength)
    return { png, width: dv.getUint32(16), height: dv.getUint32(20) }
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

/** 一个已渲染公式图:img 组件元素 + 在段内的锚序号(第几个公式)。 */
export interface RenderedFormulaImg {
  /** 飞书 img 组件 JSON(tag=img + crop_center + 精确 size)。调用方按
   *  锚序号紧贴对应 markdown 段后插入卡片。 */
  element: object
  /** 段内序号:本段第几个公式图,插入顺序锚。 */
  index: number
}

async function uploadTeX(tex: string): Promise<{ key: string; w: number; h: number } | null> {
  // 缓存键带字号版本前缀:字号策略改版后旧缓存(不同 em)不命中,防错尺寸
  const h_ = fnv1a('v2:' + tex)
  const cached = keyCache.get(h_)
  if (cached) return JSON.parse(cached)
  const failedAt = failedHashes.get(h_)
  if (failedAt !== undefined) {
    if (Date.now() - failedAt < FAIL_TTL_MS) return null
    failedHashes.delete(h_)
  }
  const rendered = renderTeXToPNG(tex, 22, true)
  if (!rendered) { failedHashes.set(h_, Date.now()); return null }
  const tmp = `${import.meta.dir}/../../.math-tmp-${h_}.png`
  try {
    await Bun.write(tmp, rendered.png)
    const key = await feishu.uploadImageKey(tmp)
    if (key) {
      const dims = { key, w: rendered.width, h: rendered.height }
      keyCache.set(h_, JSON.stringify(dims))
      return dims
    }
    failedHashes.set(h_, Date.now())
    return null
  } finally {
    await Bun.file(tmp).delete().catch(() => {})
  }
}

/** Unicode 转写:inline 公式(\(…\))留在文字流里。飞书 markdown 的
 *  ![alt](img_key) 会撑满卡片宽,没有可控的内联图;简单 inline 式子
 *  (单符号 / β=0.25 / N=P+F−C−R)转 Unicode 文本零突兀。转不动的
 *  (\frac/矩阵/积分)退回 display 渲染成图。 */
const GREEK: Record<string, string> = {
  alpha:'α',beta:'β',gamma:'γ',delta:'δ',epsilon:'ε',zeta:'ζ',eta:'η',theta:'θ',
  iota:'ι',kappa:'κ',lambda:'λ',mu:'μ',nu:'ν',xi:'ξ',pi:'π',rho:'ρ',sigma:'σ',
  tau:'τ',phi:'φ',chi:'χ',psi:'ψ',omega:'ω',Gamma:'Γ',Delta:'Δ',Theta:'Θ',
  Lambda:'Λ',Pi:'Π',Sigma:'Σ',Phi:'Φ',Psi:'Ψ',Omega:'Ω',
}
function unicodeMathify(tex: string): string | null {
  let s = tex
  // \text{…} → 原文(CJK/常规词直接露出)
  s = s.replace(/\\text\{([^}]*)\}/g, '$1')
  // \left \right 定界符命令先剥(留括号本体)
  s = s.replace(/\\left\s*/g, '').replace(/\\right\s*/g, '')
  // 希腊字母与运算符
  s = s.replace(/\\([A-Za-z]+)\b/g, (m, name: string) => {
    if (GREEK[name]) return GREEK[name]
    if (name === 'times') return '×'
    if (name === 'cdot') return '·'
    if (name === 'div') return '÷'
    if (name === 'pm') return '±'
    if (name === 'leq' || name === 'le') return '≤'
    if (name === 'geq' || name === 'ge') return '≥'
    if (name === 'neq' || name === 'ne') return '≠'
    if (name === 'approx') return '≈'
    if (name === 'sim') return '~'
    if (name === 'infty') return '∞'
    if (name === 'partial') return '∂'
    if (name === 'nabla') return '∇'
    if (name === 'sqrt') return '√'
    if (name === 'to') return '→'
    return m // 认不得的命令 → 整体转写失败信号
  })
  // 还有残留 TeX 命令(\frac \sum \int \begin …)→ 转写失败,提级 display 图
  if (/\\[A-Za-z]/.test(s)) return null
  // ^{…}/_{…} 平写成 ^x / _x
  s = s.replace(/\^\{([^}]+)\}/g, '^$1').replace(/_\{([^}]+)\}/g, '_$1')
  return s
}

/** 渲染一段 assistant 文本:display 公式($$…$$ / \[…\])从文本中摘出、
 *  渲染成 img 元素列表返回(调用方按序紧贴本段 markdown 后插入卡片),
 *  摘出后的文本继续走正常 sanitize;inline 公式(\(…\))Unicode 转写
 *  留在文字流,转写失败(复杂结构)的 inline 提级为 display 图。
 *  渲染/上传失败的 display 公式保留原码(可见降级,不吞内容)。 */
export async function renderMathInText(
  text: string,
): Promise<{ text: string; formulaImgs: RenderedFormulaImg[] }> {
  const spans = findMathSpans(text)
  const formulaImgs: RenderedFormulaImg[] = []
  if (!spans.length) return { text, formulaImgs }
  let out = ''
  let last = 0
  let imgIdx = 0
  for (const span of spans) {
    if (span.start < last) continue
    out += text.slice(last, span.start)
    if (span.display) {
      const dims = await uploadTeX(span.tex)
      if (dims) {
        formulaImgs.push({
          element: {
            tag: 'img',
            img_key: dims.key,
            alt: { tag: 'plain_text', content: span.tex.slice(0, 40) },
            scale_type: 'crop_center',
            size: `${dims.w}px ${dims.h}px`,
            preview: false,
          },
          index: imgIdx++,
        })
        out += '\n\n'
      } else {
        out += text.slice(span.start, span.end) // 失败保留原码
      }
    } else {
      const uni = unicodeMathify(span.tex)
      if (uni !== null) out += uni
      else {
        // inline 转不动 → 提级 display 图;上传失败保留原码(可见降级)
        const dims = await uploadTeX(span.tex)
        if (dims) {
          formulaImgs.push({
            element: {
              tag: 'img',
              img_key: dims.key,
              alt: { tag: 'plain_text', content: span.tex.slice(0, 40) },
              scale_type: 'crop_center',
              size: `${dims.w}px ${dims.h}px`,
              preview: false,
            },
            index: imgIdx++,
          })
          out += ' '
        } else {
          out += text.slice(span.start, span.end)
        }
        // 注:测试环境无真实凭据时 uploadTeX 返回 null 走原码保留;
        // 上面的 ' ' 分支只在真图落地时执行。
      }
    }
    last = span.end
  }
  out += text.slice(last)
  return { text: out.trim(), formulaImgs }
}

/** 同步探测:文本是否含公式(调用方决定是否走 async 渲染路径)。 */
export function hasMathSpans(text: string): boolean {
  return findMathSpans(text).length > 0
}

/** 确定性渲染(不经上传),给测试用。 */
export const __test = { findMathSpans, stashNonLatin, swapStashedPaths, renderTeXToPNG, unicodeMathify }
