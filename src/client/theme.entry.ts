import { applyStoredTheme } from './theme'
import type { ThemeConfig } from './theme'

declare const __OASIS_THEME__: ThemeConfig
const root = document.getElementById('dc-root')
if (root) {
  let storage: Storage | null = null
  try {
    storage = window.localStorage
  } catch {
    storage = null
  }
  applyStoredTheme(root, __OASIS_THEME__, storage)
}
