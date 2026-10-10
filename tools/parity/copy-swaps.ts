// The port's copy changes (design-patches/copy-map.json, applied by the compiler) as pre-render swaps on the ORIGINAL,
// so one file lists every wording decision and the harness never needs a second copy of it. Identity entries (a
// contact fact whose configured value equals the design's) produce no swap.
import fs from 'node:fs'
import path from 'node:path'
import { configValue } from '../dc-compile/patches'
import type { CopyEntry } from '../dc-compile/patches'
import type { SwapSpec } from './bundle'

export function copyMapSwaps(root: string, slug: string): SwapSpec[] {
  const file = path.join(root, 'design-patches', 'copy-map.json')
  if (!fs.existsSync(file)) return []
  const entries = (JSON.parse(fs.readFileSync(file, 'utf8')) as { entries?: CopyEntry[] }).entries ?? []
  const out: SwapSpec[] = []
  for (const e of entries) {
    if (e.page !== slug) continue
    const to = e.toConfig ? configValue(root, e.toConfig, `copy-map ${e.id}`) : e.to
    if (to === e.from) continue
    out.push({
      id: `${e.dv}-copy-${e.id}`,
      kind: 'text',
      find: e.from,
      replace: to,
      count: e.count,
      target: e.scope === 'source' ? 'template' : e.scope,
    })
  }
  return out
}
