import { cssToObj, kebabToCamel } from '../../src/dc/css'
import { PseudoSheet } from '../../src/dc/pseudo'
import { hostPositionStyle } from '../../src/dc/ximport'
import { CompileError } from './errors'
import { parsePath, splitInterp, wholeBinding } from './grammar'
import type { PathExpr } from './grammar'
import { CAMEL_ATTR } from './parse'
import type { ElNode, Node, TextNode } from './parse'

export interface EmitOptions {
  page: string
  /** Stamp data-dc-tpl="N" (source element index) on every emitted element. */
  tplIds: boolean
  /** Emit R(scope, "src") for expressions outside the strict grammar instead of failing. */
  allowComplexExpr: boolean
  /** Shared across the page: `style-<pseudo>` attributes become scpN classes numbered by first use. */
  pseudo?: PseudoSheet
  /**
   * x-import urls (the `from` attribute, after the intake rewrote uuids to /assets/*) -> the generated wrapper module
   * to import. Unknown urls fail the build (an import must be a bundled resource; nothing is fetched at run time).
   */
  imports?: ReadonlyMap<string, string>
  /**
   * A custom element the build renders as a static placeholder (site.config.json `imageSlots`): the element keeps its
   * tag and attributes, its content becomes a declarative shadow root built by `imageSlotProps` (src/dc/image-slot.ts).
   */
  imageSlot?: { tag: string; brand: string }
}

export interface Bindings {
  page: string
  roots: string[]
  /** Paths used as an sc-for list (loop scope shown as `list[]`). */
  lists: string[]
  /** Paths used as an sc-if condition. */
  conds: string[]
  /** Paths bound to event handlers or refs (functions / ref objects, never rendered). */
  handlers: string[]
  /** Every path the template reads, roots and loop-scoped dotted paths (`bays[].name`), digits as `[0]`. */
  paths: string[]
  /** x-import elements: url, component names and the wrapper modules they import. */
  ximports: { tpl: number; url: string; component: string; globalName: string }[]
}

const EVENT_MAP: Record<string, string> = {
  onclick: 'onClick',
  onchange: 'onChange',
  oninput: 'onInput',
  onsubmit: 'onSubmit',
  onkeydown: 'onKeyDown',
  onkeyup: 'onKeyUp',
  onkeypress: 'onKeyPress',
  onmousedown: 'onMouseDown',
  onmouseup: 'onMouseUp',
  onmouseenter: 'onMouseEnter',
  onmouseleave: 'onMouseLeave',
  onfocus: 'onFocus',
  onblur: 'onBlur',
  ondoubleclick: 'onDoubleClick',
  oncontextmenu: 'onContextMenu',
  onmousemove: 'onMouseMove',
  onmouseover: 'onMouseOver',
  onmouseout: 'onMouseOut',
  onpointerdown: 'onPointerDown',
  onpointerup: 'onPointerUp',
  onpointermove: 'onPointerMove',
  onpointerenter: 'onPointerEnter',
  onpointerleave: 'onPointerLeave',
  onpointercancel: 'onPointerCancel',
  onpointerover: 'onPointerOver',
  onpointerout: 'onPointerOut',
  ongotpointercapture: 'onGotPointerCapture',
  onlostpointercapture: 'onLostPointerCapture',
  ontouchstart: 'onTouchStart',
  ontouchend: 'onTouchEnd',
  ontouchmove: 'onTouchMove',
  ontouchcancel: 'onTouchCancel',
  ondragstart: 'onDragStart',
  ondragend: 'onDragEnd',
  ondragenter: 'onDragEnter',
  ondragleave: 'onDragLeave',
  ondragover: 'onDragOver',
  onanimationstart: 'onAnimationStart',
  onanimationend: 'onAnimationEnd',
  onanimationiteration: 'onAnimationIteration',
  ontransitionend: 'onTransitionEnd',
}

/** Hyphenated / lowercase source attributes whose React prop name differs. Each pair yields the same DOM attribute. */
const ATTR_RENAME: Record<string, string> = {
  'stroke-width': 'strokeWidth',
  'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin',
  'stroke-dasharray': 'strokeDasharray',
  'stroke-dashoffset': 'strokeDashoffset',
  'stroke-miterlimit': 'strokeMiterlimit',
  'stroke-opacity': 'strokeOpacity',
  'fill-opacity': 'fillOpacity',
  'fill-rule': 'fillRule',
  'clip-rule': 'clipRule',
  'clip-path': 'clipPath',
  'text-anchor': 'textAnchor',
  'dominant-baseline': 'dominantBaseline',
  'font-family': 'fontFamily',
  'font-size': 'fontSize',
  'font-weight': 'fontWeight',
  'letter-spacing': 'letterSpacing',
  'stop-color': 'stopColor',
  'stop-opacity': 'stopOpacity',
  'vector-effect': 'vectorEffect',
  'shape-rendering': 'shapeRendering',
  'xlink:href': 'xlinkHref',
  'xml:lang': 'xmlLang',
  'xml:space': 'xmlSpace',
  'accept-charset': 'acceptCharset',
  'http-equiv': 'httpEquiv',
  inputmode: 'inputMode',
  tabindex: 'tabIndex',
  maxlength: 'maxLength',
  minlength: 'minLength',
  readonly: 'readOnly',
  autocomplete: 'autoComplete',
  autofocus: 'autoFocus',
  autoplay: 'autoPlay',
  playsinline: 'playsInline',
  colspan: 'colSpan',
  rowspan: 'rowSpan',
  spellcheck: 'spellCheck',
  contenteditable: 'contentEditable',
  crossorigin: 'crossOrigin',
  enterkeyhint: 'enterKeyHint',
  srcset: 'srcSet',
  datetime: 'dateTime',
  referrerpolicy: 'referrerPolicy',
  allowfullscreen: 'allowFullScreen',
  frameborder: 'frameBorder',
  novalidate: 'noValidate',
  formnovalidate: 'formNoValidate',
  usemap: 'useMap',
  hreflang: 'hrefLang',
  fetchpriority: 'fetchPriority',
}

/** Props React types as number; the DOM attribute is identical for "3" and 3. */
const NUMERIC_PROPS = new Set([
  'rows',
  'cols',
  'size',
  'span',
  'tabIndex',
  'maxLength',
  'minLength',
  'colSpan',
  'rowSpan',
])

const VOID_TAGS = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '))
const FORM_TAGS = new Set(['input', 'textarea', 'select'])
const IDENT_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const JSX_ATTR_NAME = /^[A-Za-z_$][A-Za-z0-9_$-]*$/
const UNSAFE_IN_JSX_STRING = /["&\\{}<>\n\r]/
const isSafeJsxString = (s: string): boolean =>
  !UNSAFE_IN_JSX_STRING.test(s) &&
  !s.includes(String.fromCharCode(0x2028)) &&
  !s.includes(String.fromCharCode(0x2029))

interface Loop {
  as: string
  item: string
  idx: string
  /** binding path of one element of the list, e.g. "bays[]" */
  itemPath: string | null
}

const indentOf = (n: number): string => '  '.repeat(n)

export class Emitter {
  private readonly styleNames = new Map<string, string>()
  private readonly styleDecls: string[] = []
  private readonly roots = new Set<string>()
  private readonly lists = new Set<string>()
  private readonly paths = new Set<string>()
  private readonly conds = new Set<string>()
  private readonly handlers = new Set<string>()
  private readonly ximports: Bindings['ximports'] = []
  /** wrapper module path -> import variable */
  private readonly importVars = new Map<string, string>()
  private readonly xiSpecs: string[] = []
  private used = {
    Fragment: false,
    css: false,
    I: false,
    asArray: false,
    m: false,
    NOOP: false,
    R: false,
    pc: false,
    hs: false,
    XI: false,
    IS: false,
  }
  readonly pseudo: PseudoSheet
  /** true when the first style-<pseudo> attribute was met before the helmet (sheet order in <head>) */
  pseudoBeforeHelmet = false
  private seenHelmet = false

  constructor(private readonly opts: EmitOptions) {
    this.pseudo = opts.pseudo ?? new PseudoSheet()
  }

  private fail(msg: string): never {
    throw new CompileError(`${this.opts.page}: ${msg}`)
  }

  // ---- expressions -------------------------------------------------------------------------------------------------
  private lookup(scope: Loop[], root: string): Loop | undefined {
    for (let i = scope.length - 1; i >= 0; i--) if (scope[i]!.as === root) return scope[i]
    return undefined
  }

  /** Resolves a strict-grammar path to code and records the binding. Returns null when it is not a plain path. */
  private pathCode(src: string, scope: Loop[], record = true): string | null {
    const p: PathExpr | null = parsePath(src)
    if (!p) return null
    const loop = this.lookup(scope, p.root)
    let base: string
    let bpath: string | null
    if (loop) {
      base = loop.item
      bpath = loop.itemPath
    } else if (p.root === '$index' && scope.length) {
      return scope[scope.length - 1]!.idx + (p.segs.length ? this.segCode(p.segs) : '')
    } else {
      base = `$v.${p.root}`
      bpath = p.root
      if (record) this.roots.add(p.root)
    }
    if (record && bpath !== null) {
      this.paths.add(bpath + p.segs.map((s) => (/^\d+$/.test(s) ? `[${s}]` : `.${s}`)).join(''))
    }
    return base + this.segCode(p.segs)
  }

  private segCode(segs: string[]): string {
    return segs.map((s) => (/^\d+$/.test(s) ? `?.[${s}]` : `?.${s}`)).join('')
  }

  private bindingPath(src: string, scope: Loop[]): string | null {
    const p = parsePath(src)
    if (!p) return null
    const loop = this.lookup(scope, p.root)
    const head = loop ? loop.itemPath : p.root
    if (head === null || (p.root === '$index' && !loop)) return null
    return head + p.segs.map((s) => (/^\d+$/.test(s) ? `[${s}]` : `.${s}`)).join('')
  }

  /** Expression code for a binding source. */
  private expr(src: string, scope: Loop[], where: string): string {
    const code = this.pathCode(src, scope)
    if (code !== null) return code
    if (!this.opts.allowComplexExpr) {
      this.fail(
        `${where}: expression ${JSON.stringify(src.trim())} is outside the strict grammar IDENT(.IDENT|.DIGITS)* (use --allow-complex-expr to emit a resolve() call)`,
      )
    }
    this.used.R = true
    const entries = scope.map((l) => `${JSON.stringify(l.as)}: ${l.item}, $index: ${l.idx}`)
    const sc = scope.length ? `{ ...$v, ${entries.join(', ')} }` : '$v'
    return `R(${sc}, ${JSON.stringify(src.trim())})`
  }

  // ---- styles ------------------------------------------------------------------------------------------------------
  private styleConst(obj: Record<string, string>): string {
    const keys = Object.keys(obj)
    // integer-like keys would be reordered by JS; CSS property names never are
    const canon = JSON.stringify(keys.map((k) => [k, obj[k]]))
    let name = this.styleNames.get(canon)
    if (!name) {
      name = `S${this.styleNames.size}`
      this.styleNames.set(canon, name)
      const body = keys
        .map((k) => `${IDENT_KEY.test(k) ? k : JSON.stringify(k)}: ${JSON.stringify(obj[k])}`)
        .join(', ')
      this.styleDecls.push(`const ${name} = Object.freeze({ ${body} }) as CSSProperties`)
    }
    return name
  }

  private tpl(raw: string, scope: Loop[], where: string): string {
    const parts = splitInterp(raw)
    let out = '`'
    parts.forEach((p, i) => {
      if (i & 1) {
        this.used.m = true
        out += '${m(' + this.expr(p, scope, where) + ')}'
      } else {
        out += p.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
      }
    })
    return out + '`'
  }

  /** compileAttr: whole binding -> expression, mixed -> template string, static -> JSON literal. */
  private valueCode(value: string, scope: Loop[], where: string): string {
    const whole = wholeBinding(value, where)
    if (whole !== null) return this.expr(whole, scope, where)
    if (value.includes('{{')) return this.tpl(value, scope, where)
    return JSON.stringify(value)
  }

  // ---- attributes --------------------------------------------------------------------------------------------------
  private attrs(el: ElNode, scope: Loop[]): string[] {
    const out: string[] = []
    if (this.opts.tplIds && el.tpl >= 0) out.push(`data-dc-tpl="${el.tpl}"`)
    let boundForm = false
    let hasOnChange = false
    let classIndex = -1
    let classCode: string | null = null
    let classStatic: string | null = null
    const pseudoClasses: string[] = []
    for (const { name, value } of el.attrs) {
      if (name === 'sc-name' || name === 'data-dc-tpl') continue
      let key = name
      if (key.startsWith(CAMEL_ATTR)) key = kebabToCamel(key.slice(CAMEL_ATTR.length))
      if (key === 'hint-size') continue
      const where = `<${el.tag}> tpl ${el.tpl} attribute ${name}`
      if (key.startsWith('style-')) {
        pseudoClasses.push(this.pseudoClass(key.slice(6), value))
        continue
      }
      let isEvent = false
      if (key === 'class') key = 'className'
      else if (key === 'for') key = 'htmlFor'
      else if (key.startsWith('on')) {
        if (key.length < 3) this.fail(`${where}: invalid event attribute`)
        key = EVENT_MAP[key] || 'on' + key[2]!.toUpperCase() + key.slice(3)
        isEvent = true
      } else if (ATTR_RENAME[key]) key = ATTR_RENAME[key]!
      else if (
        key.includes('-') &&
        !key.startsWith('data-') &&
        !key.startsWith('aria-') &&
        !key.startsWith('hint-')
      ) {
        this.fail(`${where}: unknown hyphenated attribute (add it to ATTR_RENAME if React renames it)`)
      }
      if (!JSX_ATTR_NAME.test(key)) this.fail(`${where}: cannot emit attribute name ${JSON.stringify(key)}`)
      if (key === 'onChange') hasOnChange = true

      const whole = wholeBinding(value, where)
      let code: string
      if (key === 'style') {
        if (whole !== null) {
          this.used.css = true
          code = `{css(${this.expr(whole, scope, where)})}`
        } else if (value.includes('{{')) {
          this.used.css = true
          code = `{css(${this.tpl(value, scope, where)})}`
        } else {
          code = `{${this.styleConst(cssToObj(value))}}`
        }
      } else if (whole !== null) {
        const e = this.expr(whole, scope, where)
        if (isEvent || key === 'ref') {
          const bp = this.bindingPath(whole, scope)
          if (bp !== null) this.handlers.add(bp)
        }
        if (key === 'value' || key === 'checked') {
          if (FORM_TAGS.has(el.tag)) boundForm = true
          code = `{${e} === undefined ? ${key === 'checked' ? 'false' : '""'} : ${e}}`
        } else code = `{${e}}`
      } else if (value.includes('{{')) {
        if (isEvent || key === 'ref') this.fail(`${where}: handlers and refs must be a whole {{ }} binding`)
        code = `{${this.tpl(value, scope, where)}}`
      } else {
        if (isEvent || key === 'ref') this.fail(`${where}: handlers and refs must be a whole {{ }} binding`)
        if (NUMERIC_PROPS.has(key) && /^\d+$/.test(value)) code = `{${value}}`
        else if (isSafeJsxString(value)) code = JSON.stringify(value)
        else code = `{${JSON.stringify(value)}}`
      }
      if (key === 'className') {
        classIndex = out.length
        if (whole === null && !value.includes('{{')) classStatic = value
        else classCode = whole !== null ? this.expr(whole, scope, where) : this.tpl(value, scope, where)
      }
      out.push(`${key}=${code}`)
    }
    if (pseudoClasses.length) {
      // runtime: props.className = [props.className, ...pseudoClasses].filter(Boolean).join(' ')
      const pcs = pseudoClasses.join(' ')
      let code: string
      if (classIndex < 0) code = `className=${JSON.stringify(pcs)}`
      else if (classStatic !== null)
        code = `className=${JSON.stringify([classStatic, pcs].filter(Boolean).join(' '))}`
      else {
        this.used.pc = true
        code = `className={pc(${classCode}, ${JSON.stringify(pcs)})}`
      }
      if (classIndex < 0) out.push(code)
      else out[classIndex] = code
    }
    if (boundForm && !hasOnChange) {
      this.used.NOOP = true
      out.push('onChange={NOOP}')
    }
    return out
  }

  private pseudoClass(pseudo: string, css: string): string {
    if (!this.seenHelmet && this.pseudo.size === 0) this.pseudoBeforeHelmet = true
    return this.pseudo.add(pseudo, css)
  }

  // ---- nodes -------------------------------------------------------------------------------------------------------
  private text(node: TextNode, scope: Loop[], ind: number): string[] {
    const v = node.value
    const pad = indentOf(ind)
    if (!v.includes('{{')) {
      if (!v.trim() && !v.includes(' ')) return []
      return [`${pad}{${JSON.stringify(v)}}`]
    }
    const parts = splitInterp(v)
    const lines: string[] = [`${pad}<>`]
    parts.forEach((p, i) => {
      if (i & 1) {
        if (node.allowRaw && p.startsWith('=')) {
          const e = this.pathCode(p.slice(1), scope)
          if (e === null) this.fail(`raw interpolation {{${p}}} must be a plain path`)
          lines.push(`${pad}  {${e}}`)
          return
        }
        const e = this.expr(p, scope, 'text')
        this.used.I = true
        lines.push(`${pad}  {I(${e}, ${JSON.stringify(p.trim())}, $h)}`)
      } else if (p !== '') {
        lines.push(`${pad}  {${JSON.stringify(p)}}`)
      }
    })
    lines.push(`${pad}</>`)
    return lines
  }

  private children(nodes: Node[], scope: Loop[], ind: number): string[] {
    const out: string[] = []
    for (const n of nodes) out.push(...this.node(n, scope, ind))
    return out
  }

  private node(n: Node, scope: Loop[], ind: number): string[] {
    if (n.kind === 'text') return this.text(n, scope, ind)
    const pad = indentOf(ind)
    switch (n.tag) {
      case 'sc-helmet':
        this.seenHelmet = true
        return []
      case 'sc-if': {
        const raw = n.attrs.find((a) => a.name === 'value')?.value ?? ''
        const whole = wholeBinding(raw, `sc-if tpl ${n.tpl}`)
        let cond: string
        if (whole !== null) {
          cond = this.expr(whole, scope, `sc-if tpl ${n.tpl}`)
          const bp = this.bindingPath(whole, scope)
          if (bp !== null) this.conds.add(bp)
        } else if (raw.includes('{{')) this.fail(`sc-if tpl ${n.tpl}: value must be a single {{ }} binding`)
        else cond = raw ? 'true' : 'false'
        const kids = this.children(n.children, scope, ind + 1)
        if (!kids.length) return [`${pad}{${cond} ? <></> : null}`]
        return [
          `${pad}{${cond} ? (`,
          `${pad}  <>`,
          ...kids.map((l) => '  ' + l),
          `${pad}  </>`,
          `${pad}) : null}`,
        ]
      }
      case 'sc-for': {
        const raw = n.attrs.find((a) => a.name === 'list')?.value ?? ''
        const as = n.attrs.find((a) => a.name === 'as')?.value || 'item'
        if (!IDENT_KEY.test(as)) this.fail(`sc-for tpl ${n.tpl}: invalid as="${as}"`)
        const whole = wholeBinding(raw, `sc-for tpl ${n.tpl}`)
        if (whole === null) this.fail(`sc-for tpl ${n.tpl}: list must be a single {{ }} binding`)
        const listCode = this.expr(whole, scope, `sc-for tpl ${n.tpl}`)
        const lp = this.bindingPath(whole, scope)
        if (lp !== null) this.lists.add(lp)
        const depth = scope.length + 1
        const loop: Loop = {
          as,
          item: `$L${depth}_${as}`,
          idx: `$I${depth}`,
          itemPath: lp === null ? null : lp + '[]',
        }
        this.used.asArray = true
        this.used.Fragment = true
        const kids = this.children(n.children, [...scope, loop], ind + 2)
        return [
          `${pad}{asArray(${listCode}, ${JSON.stringify(whole.trim())}, $h).map((${loop.item}, ${loop.idx}) => (`,
          `${pad}  <Fragment key={${loop.idx}}>`,
          ...kids,
          `${pad}  </Fragment>`,
          `${pad}))}`,
        ]
      }
      case 'x-import':
        return this.ximport(n, scope, ind)
      case this.opts.imageSlot?.tag:
        return this.imageSlot(n, scope, ind)
      case 'dc-import':
      case 'sc-else':
        return this.fail(`<${n.tag}> is not supported`)
    }
    const attrs = this.attrs(n, scope)
    const open = `<${n.tag}${attrs.length ? ' ' + attrs.join(' ') : ''}`
    const kids = this.children(n.children, scope, ind + 1)
    if (VOID_TAGS.has(n.tag)) {
      if (n.children.length) this.fail(`void element <${n.tag}> has children`)
      return [`${pad}${open} />`]
    }
    if (!kids.length) return [`${pad}${open} />`]
    return [`${pad}${open}>`, ...kids, `${pad}</${n.tag}>`]
  }

  // ---- x-import ----------------------------------------------------------------------------------------------------
  /**
   * walkXImport: the component comes from a bundled script (`from`, resolved at build time through the intake's
   * imports) or from the global scope; it renders inside <div class="sc-host-x" style=display:contents|host position>.
   */
  private ximport(n: ElNode, scope: Loop[], ind: number): string[] {
    const pad = indentOf(ind)
    const where = `x-import tpl ${n.tpl}`
    const get = (name: string) => n.attrs.find((a) => a.name === name)?.value
    const globalRaw = get('component-from-global-scope') || ''
    const exportRaw = get('component') || get('name') || ''
    const fromRaw =
      get('from') || (get('component-from-global-scope') ? '' : get('src') || get('import') || '')
    const urls = fromRaw.trim() ? fromRaw.trim().split(/\s+/) : []
    const url = urls.length ? urls[urls.length - 1]! : ''
    const urlBindable = fromRaw.includes('{{')
    const styleRaw = get('style')
    let hintSize: string | null = null
    const props: string[] = []
    for (const { name, value } of n.attrs) {
      if (name === 'sc-name' || name === 'data-dc-tpl' || name === 'style') continue
      let key = name
      if (key.startsWith(CAMEL_ATTR)) key = kebabToCamel(key.slice(CAMEL_ATTR.length))
      if (key === 'hint-size') {
        hintSize = value
        continue
      }
      if (key.startsWith('style-')) {
        this.pseudoClass(key.slice(6), value)
        continue
      }
      if (key.includes('-') && !(key.startsWith('aria-') || key.startsWith('data-'))) key = kebabToCamel(key)
      if (key === 'component' || key === 'componentFromGlobalScope' || key === 'from') continue
      const code = this.valueCode(value, scope, `${where} attribute ${name}`)
      props.push(`${IDENT_KEY.test(key) ? key : JSON.stringify(key)}: ${code}`)
    }
    // wrapper style: the positioning subset of the style attribute, else display:contents
    let wrapperStyle: string
    if (styleRaw === undefined) wrapperStyle = this.styleConst({ display: 'contents' })
    else if (styleRaw.includes('{{')) {
      this.used.hs = true
      wrapperStyle = `hs(${this.valueCode(styleRaw, scope, `${where} style`)})`
    } else wrapperStyle = this.styleConst(hostPositionStyle(styleRaw) ?? { display: 'contents' })
    const hasContent = n.children.some((c) => c.kind === 'el' || c.value.trim() !== '')
    const kids = hasContent ? this.children(n.children, scope, ind + 3) : []
    // module wrappers: every url loads (in order, like loadExternal), resolution happens against the last one
    let entryVar = 'null'
    if (!urlBindable) {
      for (const u of urls) {
        const file = this.opts.imports?.get(u)
        if (!file) {
          this.fail(
            `${where}: from=${JSON.stringify(u)} is not a bundled resource (imports.json); external modules are not supported`,
          )
        }
        let v = this.importVars.get(file)
        if (!v) {
          v = `$M${this.importVars.size}`
          this.importVars.set(file, v)
        }
        if (u === url) entryVar = `${v}.entry`
      }
    }
    const specVar = `$XI${this.xiSpecs.length}`
    this.xiSpecs.push(
      `const ${specVar}: XImportSpec = { url: ${JSON.stringify(url)}, entry: ${entryVar}, hintSize: ${JSON.stringify(hintSize)}, urlBindable: ${urlBindable} }`,
    )
    this.ximports.push({ tpl: n.tpl, url, component: exportRaw, globalName: globalRaw })
    this.used.XI = true
    const g = this.valueCode(globalRaw, scope, `${where} component-from-global-scope`)
    const e = this.valueCode(exportRaw, scope, `${where} component`)
    // runtime wrapper prop order: className, data-dc-tpl, style
    const tplAttr = this.opts.tplIds && n.tpl >= 0 ? ` data-dc-tpl="${n.tpl}"` : ''
    const open = `${pad}<div className="sc-host-x"${tplAttr} style={${wrapperStyle}}>`
    const call = `${pad}  {XI(${specVar}, ${g}, ${e}, { ${props.join(', ')} }, `
    if (!kids.length) return [open, `${call}null)}`, `${pad}</div>`]
    return [open, call, `${pad}    <>`, ...kids, `${pad}    </>,`, `${pad}  )}`, `${pad}</div>`]
  }

  // ---- image-slot ----------------------------------------------------------------------------------------------------
  /** The slot element with its attributes, plus the shadow-root placeholder markup built at render time. */
  private imageSlot(n: ElNode, scope: Loop[], ind: number): string[] {
    const pad = indentOf(ind)
    const where = `<${n.tag}> tpl ${n.tpl}`
    if (n.children.some((c) => c.kind === 'el' || c.value.trim() !== ''))
      this.fail(`${where}: an image slot with children is not supported`)
    const props: string[] = []
    if (this.opts.tplIds && n.tpl >= 0) props.push(`"data-dc-tpl": "${n.tpl}"`)
    for (const { name, value } of n.attrs) {
      if (name === 'sc-name' || name === 'data-dc-tpl') continue
      let key = name
      if (key.startsWith(CAMEL_ATTR)) key = kebabToCamel(key.slice(CAMEL_ATTR.length))
      if (key.startsWith('on') || key === 'ref') this.fail(`${where}: handlers and refs are not supported on image slots`)
      if (key === 'style') {
        this.used.css = true
        props.push(`style: css(${this.valueCode(value, scope, `${where} attribute ${name}`)})`)
        continue
      }
      props.push(`${IDENT_KEY.test(key) ? key : JSON.stringify(key)}: ${this.valueCode(value, scope, `${where} attribute ${name}`)}`)
    }
    this.used.IS = true
    return [`${pad}<${n.tag} {...IS({ ${props.join(', ')} }, ${JSON.stringify(this.opts.imageSlot!.brand)})} />`]
  }

  // ---- file --------------------------------------------------------------------------------------------------------
  emit(
    nodes: Node[],
    header: string[],
    meta: { slug: string; route: string; name: string; variant: string; tplCount: number },
  ): { tsx: string; bindings: Bindings } {
    const body = this.children(nodes, [], 3)
    const rt = ['asArray', 'css', 'I', 'm', 'NOOP', 'R', 'pc', 'hs', 'XI'].filter(
      (k) => this.used[k as keyof typeof this.used],
    )
    const lines: string[] = [...header, '/* eslint-disable */']
    const reactTypes = this.styleDecls.length ? 'CSSProperties, ReactElement' : 'ReactElement'
    // the classic JSX runtime needs React in scope; the automatic one ignores the import (tsx, vitest and esbuild differ)
    lines.push("import * as React from 'react'", this.used.Fragment ? "import { Fragment } from 'react'" : '')
    lines.push(`import type { ${reactTypes} } from 'react'`)
    if (rt.length) lines.push(`import { ${rt.join(', ')} } from '@/dc/runtime'`)
    if (this.used.XI) lines.push("import type { XImportSpec } from '@/dc/runtime'")
    if (this.used.IS) lines.push("import { imageSlotProps as IS } from '@/dc/image-slot'")
    lines.push("import type { DCRenderCtx } from '@/dc/types'")
    for (const [file, v] of this.importVars) lines.push(`import * as ${v} from ${JSON.stringify(file)}`)
    lines.push('')
    if (this.styleDecls.length) lines.push(...this.styleDecls, '')
    if (this.xiSpecs.length) lines.push(...this.xiSpecs, '')
    lines.push(`export const meta = ${JSON.stringify(meta)} as const`, '')
    lines.push(
      'export default function render($v: Record<string, any>, $h: DCRenderCtx): ReactElement {',
      '  void React',
      '  return (',
      '    <>',
      ...body,
      '    </>',
      '  )',
      '}',
      '',
    )
    return {
      tsx: lines.join('\n').replace(/\n{3,}/g, '\n\n'),
      bindings: {
        page: this.opts.page,
        roots: [...this.roots].sort(),
        lists: [...this.lists].sort(),
        conds: [...this.conds].sort(),
        handlers: [...this.handlers].sort(),
        paths: [...this.paths].sort(),
        ximports: this.ximports,
      },
    }
  }
}
