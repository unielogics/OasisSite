// intake:inventory — what the design is made of, so the compiler and the patch layer can be decided before any port
// exists. Reads design/extracted/<slug>/ for every page of design/pages.json and writes docs/intake-report.md plus a
// machine-readable design/extracted/<slug>/inventory.json.
// Usage: tsx tools/intake/inventory.ts [--pages design/pages.json] [--extracted design/extracted] [--out docs/intake-report.md]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTemplate, textOf, walkEls } from '../dc-compile/parse'
import type { ElNode, Node } from '../dc-compile/parse'
import { splitInterp, wholeBinding } from '../dc-compile/grammar'
import { loadPages } from '../dc-compile/pages'
import type { PageMetaJson, XImportInfo } from './unpack'

export interface Inventory {
  slug: string
  name: string
  route: string
  elements: number
  constructs: {
    scIf: number
    scFor: number
    textInterpolations: number
    wholeAttrBindings: number
    mixedAttrBindings: number
    eventHandlers: number
    refs: number
    complexExpressions: string[]
  }
  pseudo: Record<string, number>
  classAttrs: { static: number; bound: number }
  xImports: XImportInfo[]
  helmet: {
    sheets: { file: string; fontFace: boolean; chars: number; mediaQueries: number; fontFaces: number }[]
    links: PageMetaJson['helmetLinks']
    scripts: number
    atomics: boolean
  }
  mediaQueries: string[]
  root: {
    tag: string
    style: string | null
    width: string | null
    height: string | null
    label: string | null
  } | null
  theme: { attributeBinding: string | null; storageKey: string | null; values: string[] }
  logic: Record<string, number>
  hrefs: Record<string, string[]>
  ctas: { tag: string; tpl: number; text: string; href?: string; handler?: string }[]
  hoursLike: string[]
  unreferencedResources: number
}

const LOGIC_PROBES: [string, RegExp][] = [
  ['localStorage', /\blocalStorage\b/g],
  ['sessionStorage', /\bsessionStorage\b/g],
  ['matchMedia', /\bmatchMedia\b/g],
  ['new Date', /\bnew Date\b/g],
  ['Date.now', /\bDate\.now\b/g],
  ['location', /\blocation\b/g],
  ['innerWidth/innerHeight', /\binner(Width|Height)\b/g],
  ['fetch', /\bfetch\s*\(/g],
  ['setTimeout', /\bsetTimeout\b/g],
  ['setInterval', /\bsetInterval\b/g],
  ['requestAnimationFrame', /\brequestAnimationFrame\b/g],
  ['document.', /\bdocument\./g],
  ['window.', /\bwindow\./g],
  ['navigator', /\bnavigator\b/g],
  ['addEventListener', /\baddEventListener\b/g],
  ['setState', /\bsetState\s*\(/g],
  ['componentDidMount', /\bcomponentDidMount\b/g],
  ['React.createElement', /\bReact\.createElement\b/g],
  ['Math.random', /\bMath\.random\b/g],
]

const TIME_RE = /\b(1[0-2]|0?[1-9])(:[0-5]\d)?\s?(AM|PM|am|pm)\b/
const DAY_RE = /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(day|nesday|rsday|urday|s)?\b/
const HOURS_WORD_RE = /\b(hours|open|closed|close|opens|closes)\b/i

export function inventoryOf(extractedDir: string, slug: string): Inventory {
  const dir = path.join(extractedDir, slug)
  const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8')
  const meta = JSON.parse(read('meta.json')) as PageMetaJson
  const xImports = JSON.parse(read('imports.json')) as XImportInfo[]
  const refs = JSON.parse(read('refs.json')) as { unreferenced: string[] }
  const template = read('template.html')
  const logic = read('logic.original.js')
  const { nodes, tplCount } = parseTemplate(template)

  const inv: Inventory = {
    slug,
    name: meta.name,
    route: meta.route,
    elements: tplCount,
    constructs: {
      scIf: 0,
      scFor: 0,
      textInterpolations: 0,
      wholeAttrBindings: 0,
      mixedAttrBindings: 0,
      eventHandlers: 0,
      refs: 0,
      complexExpressions: [],
    },
    pseudo: {},
    classAttrs: { static: 0, bound: 0 },
    xImports,
    helmet: { sheets: [], links: meta.helmetLinks, scripts: meta.helmetScripts, atomics: meta.helmetAtomics },
    mediaQueries: [],
    root: null,
    theme: { attributeBinding: null, storageKey: null, values: [] },
    logic: {},
    hrefs: {},
    ctas: [],
    hoursLike: [],
    unreferencedResources: refs.unreferenced.length,
  }
  const STRICT = /^[A-Za-z_$][A-Za-z0-9_$]*(\.([A-Za-z_$][A-Za-z0-9_$]*|\d+))*$/
  const noteExpr = (e: string) => {
    const t = e.trim()
    if (!STRICT.test(t) && !inv.constructs.complexExpressions.includes(t))
      inv.constructs.complexExpressions.push(t)
  }
  const hoursLike = new Set<string>()
  const noteText = (t: string) => {
    const s = t.replace(/\s+/g, ' ').trim()
    if (!s || s.length > 120) return
    if (TIME_RE.test(s) || (DAY_RE.test(s) && HOURS_WORD_RE.test(s)) || /\bclosed\b/i.test(s))
      hoursLike.add(s)
  }

  let afterHelmet: ElNode | null = null
  let seenHelmet = false
  const visit = (list: Node[]) => {
    for (const n of list) {
      if (n.kind === 'text') {
        const parts = splitInterp(n.value)
        for (let i = 1; i < parts.length; i += 2) {
          inv.constructs.textInterpolations++
          noteExpr(parts[i]!)
        }
        for (let i = 0; i < parts.length; i += 2) noteText(parts[i]!)
        continue
      }
      if (n.tag === 'sc-helmet') {
        seenHelmet = true
        continue
      }
      if (!afterHelmet && n.tag !== 'sc-if' && n.tag !== 'sc-for' && (seenHelmet || list === nodes))
        afterHelmet = n
      if (n.tag === 'sc-if') {
        inv.constructs.scIf++
        const w = wholeBinding(n.attrs.find((a) => a.name === 'value')?.value ?? '', 'sc-if')
        if (w !== null) noteExpr(w)
      } else if (n.tag === 'sc-for') {
        inv.constructs.scFor++
        const w = wholeBinding(n.attrs.find((a) => a.name === 'list')?.value ?? '', 'sc-for')
        if (w !== null) noteExpr(w)
      }
      for (const a of n.attrs) {
        const key = a.name.startsWith('sc-camel-')
          ? a.name.slice(9).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
          : a.name
        if (key.startsWith('style-')) inv.pseudo[key.slice(6)] = (inv.pseudo[key.slice(6)] ?? 0) + 1
        let whole: string | null = null
        try {
          whole = wholeBinding(a.value, key)
        } catch {
          whole = null
        }
        if (whole !== null) {
          inv.constructs.wholeAttrBindings++
          noteExpr(whole)
        } else if (a.value.includes('{{')) {
          inv.constructs.mixedAttrBindings++
          const parts = splitInterp(a.value)
          for (let i = 1; i < parts.length; i += 2) noteExpr(parts[i]!)
        }
        if (key === 'class') {
          if (a.value.includes('{{')) inv.classAttrs.bound++
          else inv.classAttrs.static++
        }
        if (/^on[A-Za-z]/.test(key) && n.tag !== 'x-import') inv.constructs.eventHandlers++
        if (key === 'ref') inv.constructs.refs++
        if (key === 'data-theme' && whole !== null) inv.theme.attributeBinding = whole.trim()
        if (key === 'href' && !a.value.includes('{{')) {
          const scheme =
            /^[a-z][a-z0-9+.-]*:/i.exec(a.value)?.[0].toLowerCase() ??
            (a.value.startsWith('#')
              ? '#'
              : /\.dc\.html/i.test(a.value)
                ? '.dc.html'
                : a.value.startsWith('/')
                  ? '/'
                  : 'relative')
          ;(inv.hrefs[scheme] ??= []).push(a.value)
        }
        if (key !== 'style' && !key.startsWith('style-') && !key.startsWith('on'))
          noteText(a.value.replace(/\{\{[\s\S]*?\}\}/g, ''))
      }
      if (n.tag === 'a' || n.tag === 'button') {
        const text = textOf(n.children).replace(/\s+/g, ' ').trim()
        const href = n.attrs.find((a) => a.name === 'href')?.value
        const handler = n.attrs.find((a) => /^(sc-camel-)?on/.test(a.name))?.value
        if (text || href)
          inv.ctas.push({
            tag: n.tag,
            tpl: n.tpl,
            text: text.slice(0, 60),
            ...(href ? { href } : {}),
            ...(handler ? { handler: handler.trim() } : {}),
          })
      }
      visit(n.children)
    }
  }
  visit(nodes)
  inv.hoursLike = [...hoursLike].slice(0, 60)
  inv.ctas = inv.ctas.slice(0, 80)
  for (const k of Object.keys(inv.hrefs)) inv.hrefs[k] = [...new Set(inv.hrefs[k])]

  if (afterHelmet) {
    const el: ElNode = afterHelmet
    const style = el.attrs.find((a) => a.name === 'style')?.value ?? null
    const pick = (prop: string) =>
      style?.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`))?.[1]?.trim() ?? null
    inv.root = {
      tag: el.tag,
      style,
      width: pick('width'),
      height: pick('height'),
      label: el.attrs.find((a) => a.name === 'data-screen-label')?.value ?? null,
    }
  }
  for (const h of meta.helmets) {
    const css = read(h.file)
    inv.helmet.sheets.push({
      file: h.file,
      fontFace: h.fontFace,
      chars: h.chars,
      mediaQueries: (css.match(/@media\b/g) ?? []).length,
      fontFaces: (css.match(/@font-face\b/g) ?? []).length,
    })
    for (const m of css.matchAll(/@media\s*([^{]+)\{/g)) inv.mediaQueries.push(m[1]!.trim())
  }
  for (const [name, re] of LOGIC_PROBES) {
    const n = (logic.match(re) ?? []).length
    if (n) inv.logic[name] = n
  }
  const storageKeys = [...logic.matchAll(/localStorage\.(?:getItem|setItem)\(\s*['"]([^'"]+)['"]/g)].map(
    (m) => m[1]!,
  )
  const themeKey = storageKeys.find((k) => /theme/i.test(k)) ?? null
  inv.theme.storageKey = themeKey
  if (themeKey) {
    const values = new Set<string>()
    for (const m of logic.matchAll(/['"](light|dark)['"]/g)) values.add(m[1]!)
    inv.theme.values = [...values].sort()
  }
  walkEls(nodes, () => {})
  return inv
}

export function renderReport(invs: Inventory[], extractedDir: string): string {
  const L: string[] = []
  L.push(
    '# Intake report',
    '',
    `Generated by \`pnpm intake:inventory\` from \`${extractedDir}\`. Regenerate after every intake; do not edit.`,
    '',
  )
  const row = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`
  L.push(
    '## Pages',
    '',
    row([
      'slug',
      'route',
      'name',
      'elements',
      'sc-if',
      'sc-for',
      '{{ }} text',
      'whole attr',
      'mixed attr',
      'handlers',
      'refs',
      'x-import',
      'style-*',
      'class=',
      '@media',
    ]),
    row(Array(15).fill('---')),
  )
  for (const i of invs) {
    L.push(
      row([
        i.slug,
        i.route,
        i.name,
        i.elements,
        i.constructs.scIf,
        i.constructs.scFor,
        i.constructs.textInterpolations,
        i.constructs.wholeAttrBindings,
        i.constructs.mixedAttrBindings,
        i.constructs.eventHandlers,
        i.constructs.refs,
        i.xImports.length,
        Object.values(i.pseudo).reduce((a, b) => a + b, 0),
        i.classAttrs.static + i.classAttrs.bound,
        i.mediaQueries.length,
      ]),
    )
  }
  for (const i of invs) {
    L.push('', `## ${i.slug} (${i.name}, route \`${i.route}\`)`, '')
    L.push(
      `- Root wrapper: ${i.root ? `\`<${i.root.tag}>\` width ${i.root.width ?? '(none)'}, height ${i.root.height ?? '(none)'}${i.root.label ? `, label "${i.root.label}"` : ''}` : 'not found'}`,
    )
    L.push(`  - style: \`${i.root?.style ?? ''}\``)
    L.push(
      `- Theme: ${i.theme.attributeBinding ? `\`data-theme="{{ ${i.theme.attributeBinding} }}"\`` : 'no data-theme binding'}${i.theme.storageKey ? `, localStorage key \`${i.theme.storageKey}\` (values ${i.theme.values.join('/') || '?'})` : ', no theme in localStorage'}`,
    )
    L.push(
      `- Expressions outside the strict grammar: ${i.constructs.complexExpressions.length ? i.constructs.complexExpressions.map((e) => `\`${e}\``).join(', ') : 'none'}`,
    )
    L.push(
      `- \`style-<pseudo>\` attributes: ${
        Object.keys(i.pseudo).length
          ? Object.entries(i.pseudo)
              .map(([k, v]) => `${k} x${v}`)
              .join(', ')
          : 'none'
      }`,
    )
    L.push(`- \`class=\`: ${i.classAttrs.static} static, ${i.classAttrs.bound} bound`)
    L.push(
      `- Helmet: ${i.helmet.sheets.map((s) => `${s.file} (${s.fontFace ? `${s.fontFaces} @font-face` : 'global'}, ${s.chars} chars, ${s.mediaQueries} @media)`).join('; ') || 'none'}; links: ${
        i.helmet.links
          .map(
            (l) =>
              `<${l.tag} ${Object.entries(l.attrs)
                .map(([k, v]) => `${k}="${v}"`)
                .join(' ')}>`,
          )
          .join(' ') || 'none'
      }; scripts: ${i.helmet.scripts}; data-dc-atomics: ${i.helmet.atomics}`,
    )
    L.push(
      `- @media queries: ${i.mediaQueries.length ? i.mediaQueries.map((m) => `\`${m}\``).join(', ') : 'none (fixed-width design)'}`,
    )
    L.push(
      `- x-import: ${i.xImports.length ? i.xImports.map((x) => `tpl ${x.tpl} from [${x.from.join(' ')}] component "${x.component || x.globalName}"${x.unresolved.length ? ` UNRESOLVED ${x.unresolved.join(' ')}` : ''}`).join('; ') : 'none'}`,
    )
    L.push(
      `- Logic uses: ${
        Object.entries(i.logic)
          .map(([k, v]) => `${k} x${v}`)
          .join(', ') || 'nothing notable'
      }`,
    )
    L.push(
      `- hrefs by scheme: ${
        Object.entries(i.hrefs)
          .map(([k, v]) => `${k} (${v.length}): ${v.map((h) => `\`${h}\``).join(', ')}`)
          .join('; ') || 'none'
      }`,
    )
    L.push(`- Unreferenced bundle resources: ${i.unreferencedResources}`)
    L.push(
      '',
      '### CTAs (anchors and buttons)',
      '',
      row(['tag', 'tpl', 'text', 'href', 'handler']),
      row(Array(5).fill('---')),
    )
    for (const c of i.ctas)
      L.push(
        row([
          c.tag,
          c.tpl,
          c.text.replace(/\|/g, '\\|') || '(no text)',
          c.href ? `\`${c.href}\`` : '',
          c.handler ? `\`${c.handler.replace(/\|/g, '\\|')}\`` : '',
        ]),
      )
    L.push('', '### Hours-like text', '')
    if (i.hoursLike.length) for (const h of i.hoursLike) L.push(`- ${h.replace(/\|/g, '\\|')}`)
    else L.push('- none')
  }
  return L.join('\n') + '\n'
}

function main(argv: string[]): number {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  let pagesFile = 'design/pages.json'
  let extracted = 'design/extracted'
  let out = 'docs/intake-report.md'
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const eq = a.indexOf('=')
    const key = eq > 0 ? a.slice(0, eq) : a
    const val = () => (eq > 0 ? a.slice(eq + 1) : argv[++i]) ?? ''
    if (key === '--pages') pagesFile = val()
    else if (key === '--extracted') extracted = val()
    else if (key === '--out') out = val()
    else {
      console.error(`unknown argument ${a}`)
      return 2
    }
  }
  const { pages } = loadPages(root, pagesFile)
  const dir = path.resolve(root, extracted)
  const invs = pages.map((p) => inventoryOf(dir, p.slug))
  for (const inv of invs)
    fs.writeFileSync(path.join(dir, inv.slug, 'inventory.json'), JSON.stringify(inv, null, 2) + '\n')
  fs.mkdirSync(path.dirname(path.resolve(root, out)), { recursive: true })
  fs.writeFileSync(path.resolve(root, out), renderReport(invs, path.relative(root, dir)))
  console.log(`inventory: ${invs.length} page(s) -> ${out}`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
