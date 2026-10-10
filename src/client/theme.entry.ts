// The pre-hydration theme script (src/client/theme.ts): built into its own tiny file and placed right after #dc-root,
// so it runs synchronously on the parsed markup before the hydration bundle (deferred) and before the first paint of
// the page body.
import { applyTheme, decideTheme } from './theme'
import type { ThemeConfig } from './theme'

declare const __OASIS_THEME__: ThemeConfig
let storage: Storage | null = null
try {
  storage = window.localStorage
} catch {
  storage = null
}
const matchMedia =
  typeof window.matchMedia === 'function' ? (q: string) => window.matchMedia(q) : null
const decision = decideTheme(__OASIS_THEME__, storage, matchMedia)
const root = document.getElementById('dc-root')
if (root) applyTheme(root, document.body, __OASIS_THEME__, decision.theme)
// read by boot (the logic's theme prop) so that the first client render equals the patched markup
;(window as unknown as { __oasisTheme?: typeof decision }).__oasisTheme = decision
