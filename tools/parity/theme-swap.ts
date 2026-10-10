// DV-THEME on the original. The site follows the device's color scheme (and a choice stored on the device); the
// design's theme is a data-props default ("dark") that ignores both. So that a "light" run compares light with light,
// the ORIGINAL of each run is rendered with the run's theme as its data-props default: a pre-render text swap of the
// theme prop's JSON inside the raw document's data-props attribute (entity-encoded, exactly one occurrence). The dark
// runs need no swap (the design's own default). The port gets the same theme from the device setting (the harness
// emulates the run's prefers-color-scheme on both contexts) or from the seeded stored choice.
import fs from 'node:fs'
import path from 'node:path'
import type { SwapSpec } from './bundle'
import type { Theme } from './config'

interface ThemeCfg {
  prop?: string | null
}

export function themeSwaps(root: string, slug: string, theme: Theme): SwapSpec[] {
  const cfgFile = path.join(root, 'site.config.json')
  const metaFile = path.join(root, 'design', 'extracted', slug, 'meta.json')
  if (!fs.existsSync(cfgFile) || !fs.existsSync(metaFile)) return []
  const cfg = (JSON.parse(fs.readFileSync(cfgFile, 'utf8')) as { theme?: ThemeCfg | null }).theme
  const prop = cfg?.prop
  if (!prop) return []
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as {
    source?: string
    dataProps?: Record<string, { default?: unknown }> | null
  }
  const dp = meta.dataProps?.[prop]
  if (!dp || meta.source !== 'raw' || dp.default === theme) return []
  // the attribute value as the raw document writes it: JSON with every quote as &quot;
  const enc = (v: unknown) => JSON.stringify(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  return [
    {
      id: `DV-THEME-swap-${theme}`,
      kind: 'text',
      find: `${enc(prop)}:${enc(dp)}`,
      replace: `${enc(prop)}:${enc({ ...dp, default: theme })}`,
      count: 1,
      target: 'logic',
    },
  ]
}
