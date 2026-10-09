// Pre-hydration theme patch. The static HTML is baked with the design's default theme; a visitor who stored another
// theme would see the default until the bundle runs and, worse, React 18 hydration does not reconcile attribute
// differences, so the data-theme attribute must already carry the stored value before hydrateRoot. This module is
// built into its own tiny script placed right after #dc-root (it runs before the first paint of the page body).
export interface ThemeConfig {
  storageKey: string
  attribute: string
  default: string
  values: string[]
}

export function applyStoredTheme(
  root: ParentNode,
  cfg: ThemeConfig,
  storage: Pick<Storage, 'getItem'> | null,
): string | null {
  let stored: string | null = null
  try {
    stored = storage ? storage.getItem(cfg.storageKey) : null
  } catch {
    stored = null
  }
  if (!stored || stored === cfg.default || !cfg.values.includes(stored)) return null
  for (const el of Array.from(root.querySelectorAll(`[${cfg.attribute}="${cfg.default}"]`)))
    el.setAttribute(cfg.attribute, stored)
  return stored
}
