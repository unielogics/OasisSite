// The pre-hydration theme script (src/client/theme.ts, DEVIATIONS.md DV-THEME), built into its own tiny file and
// placed in <head> as a plain (parser-blocking) external script before the stylesheet, so it runs before the parser
// has created <body> and therefore before anything of the page can be painted, also when the network is slow:
//   1. decides the theme (the visitor's stored choice, else the device's prefers-color-scheme, else the design's
//      default) and exposes it as window.__oasisTheme (boot passes it to the logic as the design's theme prop);
//   2. marks <html data-oasis-theme="<theme>"> and gives <html> the theme's page background (the canvas until <body>
//      exists);
//   3. watches the parser (a MutationObserver on the document): the moment <body> is inserted it gets the background
//      the design's componentDidUpdate would set (and <html> gives its own back, the body's propagates to the canvas),
//      and the moment an element baked with the default theme (the design's wrapper `data-theme="dark"`) is inserted
//      it gets the decided theme. Mutation records are delivered at the first microtask checkpoint, before the browser
//      can render the inserted markup, so the first frame already has the decided theme. The observer disconnects once
//      the wrapper is patched, or when the parser finishes (a last sweep on readystatechange, which runs before the
//      deferred hydration bundle).
import { applyTheme, decideTheme, type ThemeConfig, type ThemeDecision } from './theme'

declare const __OASIS_THEME__: ThemeConfig

/** Runs the decision and the patching against `doc`; returns the decision (exported for the unit test). */
export function startTheme(cfg: ThemeConfig, doc: Document, win: Window): ThemeDecision {
  let storage: Storage | null = null
  try {
    storage = win.localStorage
  } catch {
    storage = null
  }
  const matchMedia = typeof win.matchMedia === 'function' ? (q: string) => win.matchMedia(q) : null
  const decision = decideTheme(cfg, storage, matchMedia)
  const theme = decision.theme
  const html = doc.documentElement
  html.setAttribute('data-oasis-theme', theme)
  const bg = cfg.background?.[theme] ?? null
  if (bg) html.style.background = bg
  ;(win as unknown as { __oasisTheme?: ThemeDecision }).__oasisTheme = decision

  let bodyDone = false
  /** true once the body has its background and an element carrying the theme attribute has been seen (and patched) */
  const sweep = (): boolean => {
    const body = doc.body
    if (!body) return false
    if (!bodyDone) {
      bodyDone = true
      applyTheme(body, body, cfg, theme)
      // the body's background now paints the canvas: <html> goes back to the stylesheet's (none)
      html.style.removeProperty('background')
      if (html.getAttribute('style') === '') html.removeAttribute('style')
    }
    applyTheme(body, null, cfg, theme)
    return !!body.querySelector(`[${cfg.attribute}]`)
  }
  if (sweep()) return decision
  const MO = (win as unknown as { MutationObserver?: typeof MutationObserver }).MutationObserver
  const mo = MO
    ? new MO(() => {
        if (sweep()) mo!.disconnect()
      })
    : null
  mo?.observe(doc, { childList: true, subtree: true })
  const done = (): void => {
    if (doc.readyState === 'loading') return
    sweep()
    mo?.disconnect()
    doc.removeEventListener('readystatechange', done)
  }
  doc.addEventListener('readystatechange', done)
  return decision
}

if (typeof __OASIS_THEME__ !== 'undefined') startTheme(__OASIS_THEME__, document, window)
