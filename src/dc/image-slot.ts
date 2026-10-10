// Build-time rendering of the design's <image-slot> elements (loose/image-slot.js: a fillable photo placeholder with a
// drop zone, a file picker and a ".image-slots.state.json" sidecar). The site has no photos yet, so the public build
// renders every slot as a static, styled placeholder in the design's own tokens (DEVIATIONS.md DV-IMG): the element
// keeps its tag and attributes (the DOM the design produces), its content is a declarative shadow root the HTML parser
// attaches before any script runs (no JavaScript, no picker, no drop zone, no network), and its host styles are the
// ones image-slot.js sets on `:host`, so the element's own box and computed style are unchanged. When the owner's
// photos arrive, a `src` on the slot becomes a plain <img> inside the same frame.
//
// Views the browser renders after mount (the hash routes) are not parsed by the HTML parser, which alone honours
// `shadowrootmode`, so the client renders the same markup as `<template data-shadowroot>` and a minimal custom element
// (`defineImageSlotElement`, registered by the client boot) adopts the template into a shadow root on connect; a slot
// the parser already upgraded (the prerendered home view) is left alone.
import type { CSSProperties } from 'react'

let mode: 'server' | 'client' = 'server'
/** Called by the client boot before hydration: slots rendered from now on carry `data-shadowroot` (see above). */
export function imageSlotClientMode(): void {
  mode = 'client'
}

export interface ImageSlotAttrs {
  id?: string
  shape?: string
  radius?: string
  mask?: string
  fit?: string
  placeholder?: string
  src?: string
  alt?: string
}

/** The host rules of image-slot.js, verbatim (the placeholder must not change the element's own layout). */
export const HOST_CSS =
  ':host{display:block;position:relative;font:13px/1.3 system-ui,-apple-system,sans-serif;width:100%;height:100%;aspect-ratio:3/2}'

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** border-radius for the frame, like image-slot.js `_render()`. */
export function slotRadius(a: ImageSlotAttrs): string {
  const shape = (a.shape || 'rounded').toLowerCase()
  if (shape === 'circle') return '50%'
  if (shape === 'pill') return '9999px'
  if (shape === 'rounded') {
    const n = parseFloat(a.radius ?? '')
    return (Number.isFinite(n) ? n : 12) + 'px'
  }
  return '0px'
}

const PLACEHOLDER_CSS =
  HOST_CSS +
  '.frame{position:absolute;inset:0;overflow:hidden;' +
  'background:radial-gradient(120% 70% at 85% 110%,rgba(31,182,255,.22),transparent 60%),' +
  'radial-gradient(70% 50% at 0% 0%,rgba(255,255,255,.07),transparent 60%),' +
  'linear-gradient(162deg,#11171D 0%,#07090C 48%,#030405 100%);' +
  'box-shadow:inset 0 0 0 1px rgba(255,255,255,.1);' +
  'display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:8%;color:#F2F5F7}' +
  '.frame img{position:absolute;inset:0;width:100%;height:100%;display:block}' +
  '.sheen{position:absolute;inset:0;pointer-events:none;background:linear-gradient(115deg,transparent 30%,rgba(255,255,255,.06) 42%,transparent 56%)}' +
  '.mark{font-family:"Archivo",sans-serif;font-stretch:125%;font-weight:900;font-size:clamp(18px,3.2vw,28px);line-height:.9;letter-spacing:-.02em;text-transform:uppercase;' +
  'background:linear-gradient(180deg,#FFFFFF 0%,#DCE3E9 40%,#7C8893 53%,#EEF2F5 64%,#A9B4BE 100%);-webkit-background-clip:text;background-clip:text;color:transparent}' +
  '.cap{margin-top:10px;font-family:"JetBrains Mono",monospace;font-size:10.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#8C97A1;max-width:36ch}'

/**
 * The inner HTML of a slot: a declarative shadow root with the frame. With `src`, the frame holds the photo (object-fit
 * from `fit`); without one, the branded placeholder with the design's caption.
 */
export function imageSlotHtml(a: ImageSlotAttrs, brand = 'Oasis Auto Spa'): string {
  const radius = a.mask ? '' : `border-radius:${slotRadius(a)};`
  const clip = a.mask ? `clip-path:${a.mask};` : ''
  const body = a.src
    ? `<img src="${esc(a.src)}" alt="${esc(a.alt ?? '')}" style="object-fit:${esc((a.fit || 'cover').toLowerCase() === 'contain' ? 'contain' : 'cover')}">`
    : `<div class="sheen"></div><div class="mark">${esc(brand)}</div><div class="cap">${esc(a.placeholder || 'Photo coming soon')}</div>`
  const attr = mode === 'server' ? 'shadowrootmode="open"' : 'data-shadowroot="open"'
  return (
    `<template ${attr}><style>${PLACEHOLDER_CSS}</style>` +
    `<div class="frame" part="frame" style="${radius}${clip}">${body}</div></template>`
  )
}

/** Registers the custom element that adopts a slot's template into its shadow root (client only, once). */
export function defineImageSlotElement(tag: string): void {
  if (typeof customElements === 'undefined' || typeof HTMLElement === 'undefined' || customElements.get(tag)) return
  class ImageSlotPlaceholder extends HTMLElement {
    connectedCallback(): void {
      this.__adopt()
      // React sets the markup through innerHTML after connecting the element on first render
      if (!this.shadowRoot) queueMicrotask(() => this.__adopt())
    }
    __adopt(): void {
      if (this.shadowRoot) return
      const t = this.querySelector(':scope > template[data-shadowroot], :scope > template[shadowrootmode]') as HTMLTemplateElement | null
      if (!t) return
      this.attachShadow({ mode: 'open' }).append(t.content.cloneNode(true))
      t.remove()
    }
  }
  customElements.define(tag, ImageSlotPlaceholder)
}

/** React props for the element: the design's attributes plus the shadow root markup. */
export function imageSlotProps(
  attrs: Record<string, unknown>,
  brand?: string,
): Record<string, unknown> & { dangerouslySetInnerHTML: { __html: string }; style?: CSSProperties } {
  const a: ImageSlotAttrs = {}
  for (const k of ['id', 'shape', 'radius', 'mask', 'fit', 'placeholder', 'src', 'alt'] as const) {
    const v = attrs[k]
    if (v !== undefined && v !== null) a[k] = String(v)
  }
  return { ...attrs, dangerouslySetInnerHTML: { __html: imageSlotHtml(a, brand) } }
}
