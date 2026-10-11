import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { CompileError } from './errors'
import { parsePath, splitInterp } from './grammar'
import { parseTemplate, textOf, walkEls } from './parse'
import type { ElNode, Node } from './parse'

export interface CopyEntry {
  id: string
  page: string
  /** template: static text/attribute values of the parsed tree; source: the raw template text before parsing (markup
   *  removals, so both sides number elements identically); logic: the logic script text */
  scope: 'template' | 'logic' | 'source'
  from: string
  /** the replacement; or `toConfig`, a dotted path into site.config.json resolved at load time (contact strings); or
   *  `toFormat`, a string whose `${dotted.path}` placeholders are site.config.json strings (a link with its scheme,
   *  a sentence around a number) */
  to: string
  toConfig?: string
  toFormat?: string
  /** Exact number of occurrences that must be replaced; anything else fails the build (exit 3). */
  count: number
  /** the DEVIATIONS.md id that explains the change */
  dv: string
}

/** Every op carries `dv`, the DEVIATIONS.md id that explains it. */
export type PatchOp = { dv: string } & (
  /** `child`: the index of the text node to replace when the element holds other nodes too (default: its only text) */
  | { op: 'replace-text'; tpl: number; expectTag?: string; expect: string; with: string; child?: number }
  | { op: 'rewrite-href'; tpl: number; expectTag?: string; expect: string; to: string }
  | { op: 'set-attr'; tpl: number; expectTag?: string; name: string; expect: string | null; value: string }
  | { op: 'wrap-if'; tpl: number; expectTag?: string; expectTextStarts?: string; cond: string }
  | { op: 'remove'; tpl: number; expectTag?: string; expectTextStarts?: string }
  /** Markup spliced next to the target; `html` uses the template language. */
  | {
      op: 'insert-after' | 'insert-before'
      tpl: number
      expectTag?: string
      expectTextStarts?: string
      html: string
    }
  /** Wraps the target in markup that contains exactly one `<sc-slot></sc-slot>`; the target replaces the slot. */
  | { op: 'wrap'; tpl: number; expectTag?: string; expectTextStarts?: string; html: string }
)

/** Helmet <link>/<meta> elements the head must not carry (matched on one attribute). */
export interface HeadDrop {
  tag: string
  attr: string
  value: string
  dv: string
}

export interface PatchConfig {
  hrefMap: Record<string, string>
  hrefMapDv: string | null
  copyEntries: CopyEntry[]
  ops: PatchOp[]
  headDrops: HeadDrop[]
  /** every DEVIATIONS.md id the patches reference */
  dvIds: string[]
  /** sha256 over the raw bytes of the patch files that apply to this page. */
  sha: string
}

const guard = (ok: boolean, msg: string): void => {
  if (!ok) throw new CompileError('patch guard failed: ' + msg, 3)
}

interface JsonFile {
  map?: Record<string, string>
  dv?: string
  entries?: CopyEntry[]
  ops?: PatchOp[]
  head?: { drop?: HeadDrop[] }
}

const readJson = (file: string): { raw: string; json: JsonFile } => {
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{}'
  return { raw, json: JSON.parse(raw) as JsonFile }
}

const DV_ID = /^DV-[A-Za-z0-9._-]+$/

/**
 * Loads the patches of one page: href-map.json (shared), copy-map.json (entries filtered by page) and
 * <slug>.patch.json (ops and head drops). Every active entry must name a DEVIATIONS.md id (`dv`), and
 * `checkDeviationsListed` verifies the id has a line in design-patches/DEVIATIONS.md.
 */
export function loadPatchConfig(root: string, page: string): PatchConfig {
  const dir = path.join(root, 'design-patches')
  const href = readJson(path.join(dir, 'href-map.json'))
  const copy = readJson(path.join(dir, 'copy-map.json'))
  const own = readJson(path.join(dir, `${page}.patch.json`))
  const h = crypto.createHash('sha256')
  h.update(href.raw).update('\0').update(copy.raw).update('\0').update(own.raw)
  const entries = (copy.json.entries ?? [])
    .filter((e) => e.page === page)
    .map((e) => (e.toConfig || e.toFormat ? { ...e, to: resolveCopyTo(root, e) } : e))
  const ops = own.json.ops ?? []
  const headDrops = own.json.head?.drop ?? []
  const hrefMap = href.json.map ?? {}
  const hrefMapDv = href.json.dv ?? null
  const dvIds = new Set<string>()
  const need = (dv: unknown, what: string): void => {
    guard(typeof dv === 'string' && DV_ID.test(dv), `${what}: needs a DEVIATIONS.md id (dv: "DV-...")`)
    dvIds.add(dv as string)
  }
  if (Object.keys(hrefMap).length) need(hrefMapDv, 'href-map.json')
  for (const e of entries) need(e.dv, `copy-map ${e.id}`)
  ops.forEach((op, i) => need(op.dv, `${page}.patch.json ops[${i}] (${op.op} tpl ${op.tpl})`))
  headDrops.forEach((d, i) => need(d.dv, `${page}.patch.json head.drop[${i}]`))
  return {
    hrefMap,
    hrefMapDv,
    copyEntries: entries,
    ops,
    headDrops,
    dvIds: [...dvIds].sort(),
    sha: h.digest('hex'),
  }
}

let siteConfigCache: { root: string; json: Record<string, unknown> } | null = null
/** A string from site.config.json by dotted path (copy-map `toConfig`), so a fact is never hard-coded twice. */
export function configValue(root: string, dotted: string, what: string): string {
  if (!siteConfigCache || siteConfigCache.root !== root) {
    const file = path.join(root, 'site.config.json')
    siteConfigCache = { root, json: fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>) : {} }
  }
  let cur: unknown = siteConfigCache.json
  for (const seg of dotted.split('.')) {
    if (!cur || typeof cur !== 'object') cur = undefined
    else cur = (cur as Record<string, unknown>)[seg]
  }
  guard(typeof cur === 'string' && cur.length > 0, `${what}: site.config.json has no string at ${dotted}`)
  return cur as string
}

/**
 * The replacement of a copy-map entry: `toConfig` (one site.config.json string), `toFormat` (`${dotted.path}`
 * placeholders filled from site.config.json, so "sms:${contact.smsE164}" keeps the scheme in the map and the number
 * in the config), else the literal `to`.
 */
export function resolveCopyTo(root: string, e: Pick<CopyEntry, 'id' | 'to' | 'toConfig' | 'toFormat'>): string {
  if (e.toConfig) return configValue(root, e.toConfig, `copy-map ${e.id}`)
  if (e.toFormat !== undefined) {
    guard(/\$\{[A-Za-z0-9_.]+\}/.test(e.toFormat), `copy-map ${e.id}: toFormat has no \${config.path} placeholder`)
    return e.toFormat.replace(/\$\{([A-Za-z0-9_.]+)\}/g, (_m, p: string) => configValue(root, p, `copy-map ${e.id}`))
  }
  return e.to
}

/** Every id a page's patches reference must have a `DV-...` line in DEVIATIONS.md (exit 3 otherwise). */
export function checkDeviationsListed(root: string, cfg: PatchConfig, page: string): void {
  if (!cfg.dvIds.length) return
  const file = path.join(root, 'design-patches', 'DEVIATIONS.md')
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  for (const id of cfg.dvIds) {
    guard(
      new RegExp(`\\*\\*${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*\\*`).test(text),
      `${page}: ${id} is referenced by a patch but has no "**${id}**" entry in design-patches/DEVIATIONS.md`,
    )
  }
}

/** Parses patch markup into tree nodes: every node is synthetic (tpl -1) and its text may use `{{= path }}`. */
export function parseMarkup(html: string, where: string): Node[] {
  guard(typeof html === 'string' && html.trim() !== '', `${where}: markup is empty`)
  let nodes: Node[]
  try {
    nodes = parseTemplate(html).nodes
  } catch (e) {
    throw new CompileError(`patch guard failed: ${where}: markup does not parse (${(e as Error).message})`, 3)
  }
  guard(nodes.length > 0, `${where}: markup has no content`)
  const mark = (list: Node[]): void => {
    for (const n of list) {
      if (n.kind === 'text') n.allowRaw = true
      else {
        guard(n.tag !== 'sc-helmet', `${where}: markup must not contain a helmet`)
        n.tpl = -1
        mark(n.children)
      }
    }
  }
  mark(nodes)
  return nodes
}

/** Replace `from` by `to`, requiring exactly `count` occurrences. Returns the new text. */
export function applyCopy(text: string, entries: CopyEntry[], scope: 'template' | 'logic' | 'source'): string {
  for (const e of entries) {
    if (e.scope !== scope) continue
    const n = text.split(e.from).length - 1
    guard(
      n === e.count,
      `copy-map ${e.id} (${scope}): expected ${e.count} occurrence(s) of ${JSON.stringify(e.from)}, found ${n}`,
    )
    text = text.split(e.from).join(e.to)
  }
  return text
}

/** Applies the page patch ops and the href map to the parsed tree (tplIds already assigned, so ops use source ids). */
export function applyPatches(nodes: Node[], cfg: PatchConfig, screen: string): Node[] {
  const byTpl = new Map<number, { el: ElNode; parent: ElNode | null }>()
  walkEls(nodes, (el, parent) => byTpl.set(el.tpl, { el, parent }))
  const siblings = (parent: ElNode | null): Node[] => (parent ? parent.children : nodes)

  for (const op of cfg.ops) {
    const hit = byTpl.get(op.tpl)
    guard(!!hit, `${screen}: ${op.op} targets tpl ${op.tpl} which does not exist`)
    const { el, parent } = hit!
    const where = `${screen} ${op.op} tpl ${op.tpl}`
    if (op.expectTag !== undefined)
      guard(el.tag === op.expectTag, `${where}: expected <${op.expectTag}>, found <${el.tag}>`)
    switch (op.op) {
      case 'replace-text': {
        if (op.child === undefined)
          guard(
            el.children.length === 1 && el.children[0]!.kind === 'text',
            `${where}: element must hold a single text node`,
          )
        else
          guard(
            Number.isInteger(op.child) && el.children[op.child]?.kind === 'text',
            `${where}: child ${op.child} must be a text node`,
          )
        const t = el.children[op.child ?? 0] as Extract<Node, { kind: 'text' }>
        guard(
          t.value === op.expect,
          `${where}: expected text ${JSON.stringify(op.expect)}, found ${JSON.stringify(t.value)}`,
        )
        t.value = op.with
        t.allowRaw = true
        break
      }
      case 'rewrite-href': {
        const a = el.attrs.find((x) => x.name === 'href')
        guard(
          !!a && a.value === op.expect,
          `${where}: expected href ${JSON.stringify(op.expect)}, found ${JSON.stringify(a?.value)}`,
        )
        a!.value = op.to
        break
      }
      case 'set-attr': {
        const a = el.attrs.find((x) => x.name === op.name)
        guard(
          (a?.value ?? null) === op.expect,
          `${where}: expected ${op.name}=${JSON.stringify(op.expect)}, found ${JSON.stringify(a?.value ?? null)}`,
        )
        if (a) a.value = op.value
        else el.attrs.push({ name: op.name, value: op.value })
        break
      }
      case 'wrap-if': {
        if (op.expectTextStarts !== undefined) {
          guard(
            textOf(el.children).trimStart().startsWith(op.expectTextStarts),
            `${where}: text does not start with ${JSON.stringify(op.expectTextStarts)}`,
          )
        }
        guard(!!parsePath(op.cond), `${where}: cond ${JSON.stringify(op.cond)} must be a plain path`)
        const list = siblings(parent)
        const i = list.indexOf(el)
        const wrapper: ElNode = {
          kind: 'el',
          tag: 'sc-if',
          tpl: -1,
          attrs: [{ name: 'value', value: `{{ ${op.cond} }}` }],
          children: [el],
        }
        list[i] = wrapper
        break
      }
      case 'insert-after':
      case 'insert-before': {
        if (op.expectTextStarts !== undefined) {
          guard(
            textOf(el.children).trimStart().startsWith(op.expectTextStarts),
            `${where}: text does not start with ${JSON.stringify(op.expectTextStarts)}`,
          )
        }
        guard(typeof op.html === 'string', `${where}: needs html`)
        const list = siblings(parent)
        const i = list.indexOf(el)
        list.splice(op.op === 'insert-after' ? i + 1 : i, 0, ...parseMarkup(op.html, where))
        break
      }
      case 'wrap': {
        if (op.expectTextStarts !== undefined) {
          guard(
            textOf(el.children).trimStart().startsWith(op.expectTextStarts),
            `${where}: text does not start with ${JSON.stringify(op.expectTextStarts)}`,
          )
        }
        guard(typeof op.html === 'string', `${where}: needs html`)
        const wrapped = parseMarkup(op.html, where)
        let slots = 0
        let slotParent: ElNode | null = null
        let slotIndex = -1
        const find = (list: Node[], owner: ElNode | null): void => {
          list.forEach((n, idx) => {
            if (n.kind !== 'el') return
            if (n.tag === 'sc-slot') {
              slots++
              slotParent = owner
              slotIndex = idx
            } else find(n.children, n)
          })
        }
        find(wrapped, null)
        guard(slots === 1, `${where}: wrap markup needs exactly one <sc-slot></sc-slot>, found ${slots}`)
        const holder: Node[] = slotParent ? (slotParent as ElNode).children : wrapped
        holder[slotIndex] = el
        const list = siblings(parent)
        list.splice(list.indexOf(el), 1, ...wrapped)
        break
      }
      case 'remove': {
        if (op.expectTextStarts !== undefined) {
          guard(
            textOf(el.children).trimStart().startsWith(op.expectTextStarts),
            `${where}: text does not start with ${JSON.stringify(op.expectTextStarts)}`,
          )
        }
        const list = siblings(parent)
        list.splice(list.indexOf(el), 1)
        break
      }
    }
  }

  // Cross-page navigation: hrefs are .dc.html file names in the designs and routes in the port.
  walkEls(nodes, (el) => {
    for (const a of el.attrs) {
      if (a.name !== 'href') continue
      if (Object.prototype.hasOwnProperty.call(cfg.hrefMap, a.value)) {
        a.value = cfg.hrefMap[a.value]!
      } else {
        guard(
          !/\.dc\.html/i.test(a.value),
          `${screen}: href ${JSON.stringify(a.value)} points at a design file but is not in href-map.json`,
        )
      }
    }
  })
  return nodes
}

/** Applies fn to the static parts of an interpolated string, leaving every {{ expr }} untouched. */
const mapStatic = (value: string, fn: (s: string) => string): string =>
  splitInterp(value)
    .map((p, i) => (i & 1 ? `{{${p}}}` : fn(p)))
    .join('')

/**
 * Applies the copy map to static text and static attribute values (static parts of interpolated strings
 * included; bound values are logic output and are handled by the logic-scope entries).
 */
export function applyCopyToTree(nodes: Node[], entries: CopyEntry[]): void {
  const tpl = entries.filter((e) => e.scope === 'template')
  if (!tpl.length) return
  const strings: { get(): string; set(v: string): void }[] = []
  const visit = (list: Node[]) => {
    for (const n of list) {
      if (n.kind === 'text') {
        strings.push({ get: () => n.value, set: (v) => (n.value = v) })
      } else {
        for (const a of n.attrs) {
          if (!a.name.startsWith('sc-camel-on-') && a.name !== 'style') {
            strings.push({ get: () => a.value, set: (v) => (a.value = v) })
          }
        }
        visit(n.children)
      }
    }
  }
  visit(nodes)
  for (const e of tpl) {
    let total = 0
    for (const s of strings) mapStatic(s.get(), (p) => ((total += p.split(e.from).length - 1), p))
    guard(
      total === e.count,
      `copy-map ${e.id} (template): expected ${e.count} occurrence(s) of ${JSON.stringify(e.from)}, found ${total}`,
    )
    for (const s of strings) s.set(mapStatic(s.get(), (p) => p.split(e.from).join(e.to)))
  }
}
