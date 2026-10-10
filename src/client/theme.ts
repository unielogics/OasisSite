// The page's theme before hydration (DEVIATIONS.md DV-THEME). The static HTML is baked with the design's default theme
// (dark). The visitor's device decides the theme (prefers-color-scheme: light -> light, dark or no preference -> the
// default) unless the visitor picked one with the design's own controls, which is remembered on the device
// (localStorage, `storageKey`) and wins on later visits. React 18 hydration does not reconcile attribute differences, so
// the decision is applied to the markup before hydrateRoot by a tiny external script placed right after #dc-root
// (theme.entry.ts; the CSP allows no inline script), which also sets the body background the way the design's
// componentDidUpdate does and exposes the decision as `window.__oasisTheme`; boot passes it to the logic as the design's
// theme prop (`prop`), so the first client render equals the patched DOM. The bridge then follows live changes of the
// device setting while nothing is stored, and stores the visitor's own choice (src/site/index.bridge.ts).
export interface ThemeConfig {
  storageKey: string
  attribute: string
  default: string
  values: string[]
  /** the design's data-props key that carries the theme; boot passes the decided theme as this prop */
  prop?: string | null
  /** follow the device's prefers-color-scheme until the visitor stores a choice */
  followSystem?: boolean
  /** the body background the design's componentDidUpdate sets for each theme (set before the first paint) */
  background?: Record<string, string> | null
}

export interface ThemeDecision {
  theme: string
  /** true when the visitor's stored choice decided it, false when the device setting (or the default) did */
  stored: boolean
}

export const LIGHT_QUERY = '(prefers-color-scheme: light)'

type MatchMedia = (query: string) => { matches: boolean }

/** The visitor's stored choice, when it is one of the theme values; storage errors read as "nothing stored". */
export function readStoredTheme(cfg: ThemeConfig, storage: Pick<Storage, 'getItem'> | null): string | null {
  let stored: string | null = null
  try {
    stored = storage ? storage.getItem(cfg.storageKey) : null
  } catch {
    stored = null
  }
  return stored && cfg.values.includes(stored) ? stored : null
}

/** Stores the visitor's choice; a storage that throws (private mode, blocked site data) is ignored. */
export function storeTheme(cfg: ThemeConfig, storage: Pick<Storage, 'setItem'> | null, theme: string): void {
  if (!cfg.values.includes(theme)) return
  try {
    storage?.setItem(cfg.storageKey, theme)
  } catch {
    /* not remembered on this device */
  }
}

/** The device's setting: light when it prefers light (and the design has a light theme), else the default. */
export function deviceTheme(cfg: ThemeConfig, matchMedia: MatchMedia | null): string {
  if (!cfg.followSystem || !matchMedia || !cfg.values.includes('light')) return cfg.default
  try {
    return matchMedia(LIGHT_QUERY).matches ? 'light' : cfg.default
  } catch {
    return cfg.default
  }
}

/** A stored choice wins; otherwise the device decides. */
export function decideTheme(
  cfg: ThemeConfig,
  storage: Pick<Storage, 'getItem'> | null,
  matchMedia: MatchMedia | null,
): ThemeDecision {
  const stored = readStoredTheme(cfg, storage)
  if (stored) return { theme: stored, stored: true }
  return { theme: deviceTheme(cfg, matchMedia), stored: false }
}

/**
 * Puts `theme` on every element baked with the default theme and sets the body background like the design's
 * componentDidUpdate. Returns the number of elements patched.
 */
export function applyTheme(
  root: ParentNode,
  body: { style: { background: string } } | null,
  cfg: ThemeConfig,
  theme: string,
): number {
  let n = 0
  if (theme !== cfg.default && cfg.values.includes(theme)) {
    for (const el of Array.from(root.querySelectorAll(`[${cfg.attribute}="${cfg.default}"]`))) {
      el.setAttribute(cfg.attribute, theme)
      n++
    }
  }
  const bg = cfg.background?.[theme]
  if (body && bg && body.style.background !== bg) body.style.background = bg
  return n
}

/** The stored theme applied to the markup (pages whose design reads the theme from storage itself). */
export function applyStoredTheme(
  root: ParentNode,
  cfg: ThemeConfig,
  storage: Pick<Storage, 'getItem'> | null,
): string | null {
  const stored = readStoredTheme(cfg, storage)
  if (!stored || stored === cfg.default) return null
  applyTheme(root, null, cfg, stored)
  return stored
}
