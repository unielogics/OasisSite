// Personal links (DEVIATIONS.md DV-LINK; backend design docs/design/ai-assistant-and-phone-identity.md section 5).
//
// A text from the shop carries https://oasisautospanj.com/#/c|m|p|pin|v/<token>: the token rides in the FRAGMENT,
// which a browser never sends to a server, never puts in a Referer and a link preview never sees. This module takes it
// out of the address bar before the page hydrates (the bridge module imports it, so the capture runs while the bundle is
// evaluated, before boot() calls hydrateRoot), keeps it in memory only (never storage, never the DOM, never a log) and
// hands it to the bridge, which sends it in exactly one place: the body of POST /api/v1/public/links/exchange.
//
// history.replaceState swaps the current entry for the same URL without the fragment, so neither the address bar nor
// the history list keeps the token. A second link opened in the same tab is a fragment navigation (no reload): the
// `hashchange` listener installed here runs before the design's own (registered later, in componentDidMount), scrubs
// that entry too and passes the new token on.

export type LinkPath = 'c' | 'm' | 'p' | 'pin' | 'v'

export interface CapturedLink {
  /** the route letter(s) of the fragment: c calendar / book again, m membership, p payment, pin PIN, v verify */
  path: LinkPath
  /** the token, as found (the server decides whether it is valid) */
  token: string
}

/** `#/<path>/<token>` with an optional trailing slash; a token is URL-safe text of at most 256 characters. */
const LINK_RE = /^#\/?(c|m|p|pin|v)\/([A-Za-z0-9_~.-]{1,256})\/?$/

/** The link a fragment carries, or null (an ordinary hash route like #/membership is not a link). */
export function parseLinkFragment(hash: string | null | undefined): CapturedLink | null {
  if (!hash) return null
  const m = LINK_RE.exec(hash)
  if (!m) return null
  return { path: m[1] as LinkPath, token: m[2]! }
}

/** True when the fragment looks like a personal link at all (even a malformed one): it is scrubbed either way. */
const LINKISH_RE = /^#\/?(c|m|p|pin|v)\//

interface WinLike {
  location: { hash: string; pathname: string; search: string }
  history: { state: unknown; replaceState(data: unknown, unused: string, url?: string | null): void }
  addEventListener(type: 'hashchange', fn: () => void): void
  removeEventListener(type: 'hashchange', fn: () => void): void
}

/** Removes the fragment from the address bar and the current history entry (same document, nothing reloads). */
export function scrubLocation(win: WinLike): void {
  try {
    win.history.replaceState(win.history.state, '', win.location.pathname + win.location.search)
  } catch {
    // a sandboxed document without history: assigning an empty hash still drops the token from the address bar
    try {
      win.location.hash = ''
    } catch {
      /* nothing else to do */
    }
  }
}

let pending: CapturedLink | null = null
let installedOn: WinLike | null = null
let onHash: (() => void) | null = null
const listeners = new Set<(l: CapturedLink) => void>()

/** Scrubs a link fragment of the current URL; returns the link it carried (null for none or a malformed one). */
function captureFrom(win: WinLike): CapturedLink | null {
  const hash = win.location.hash
  if (!hash || !LINKISH_RE.test(hash)) return null
  const link = parseLinkFragment(hash)
  scrubLocation(win)
  return link
}

/**
 * Captures the link of the current URL (scrubbing it) and listens for later ones in the same tab. Idempotent per
 * window. A link nobody has taken yet waits in memory for the bridge (`takeLink`); one arriving while the bridge
 * listens goes straight to it (`onLink`).
 */
export function installLinkCapture(win: WinLike | null = typeof window !== 'undefined' ? (window as unknown as WinLike) : null): void {
  // the prerender (Node, maybe without a full window shim) and any non-browser host: nothing to capture
  if (!win || installedOn === win || !win.location || !win.history || typeof win.addEventListener !== 'function') return
  if (installedOn && onHash) installedOn.removeEventListener('hashchange', onHash)
  installedOn = win
  const first = captureFrom(win)
  if (first) pending = first
  onHash = () => {
    const l = captureFrom(win)
    if (!l) return
    if (listeners.size) for (const fn of listeners) fn(l)
    else pending = l
  }
  win.addEventListener('hashchange', onHash)
}

/** The link captured before anyone listened (once: it is forgotten here when taken). */
export function takeLink(): CapturedLink | null {
  const l = pending
  pending = null
  return l
}

/** Later links of the same tab; returns the unsubscribe function. */
export function onLink(fn: (l: CapturedLink) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Tests: forget the window, the listeners and any pending link. */
export function resetLinkCapture(): void {
  if (installedOn && onHash) installedOn.removeEventListener('hashchange', onHash)
  installedOn = null
  onHash = null
  pending = null
  listeners.clear()
}
