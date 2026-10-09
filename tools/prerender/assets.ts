// Content-hashed output: every non-HTML file lands at /assets/<name>.<hash8>.<ext>; logical references
// (/fonts/<file>, /assets/<file>, and the build's own css/js names) are rewritten to the hashed URL in CSS, JS and
// HTML. Leaves (fonts, images) are hashed first, then CSS (which references fonts), then JS, then HTML.
import crypto from 'node:crypto'
import path from 'node:path'

export const sha256 = (b: Buffer | string): string => crypto.createHash('sha256').update(b).digest('hex')

export interface Emitted {
  /** path under dist/, e.g. assets/manrope-latin.a1b2c3d4.woff2 */
  file: string
  url: string
  bytes: Buffer
  sha256: string
  logical: string
}

export class AssetStore {
  private readonly byLogical = new Map<string, Emitted>()
  readonly emitted: Emitted[] = []

  /** Registers bytes for a logical path; returns the hashed URL. Identical bytes under the same logical name dedupe. */
  add(logical: string, bytes: Buffer): string {
    const hit = this.byLogical.get(logical)
    const sum = sha256(bytes)
    if (hit) {
      if (hit.sha256 !== sum) throw new Error(`asset ${logical} registered twice with different contents`)
      return hit.url
    }
    const base = path.posix.basename(logical)
    const ext = path.posix.extname(base)
    const stem = base.slice(0, base.length - ext.length)
    const file = `assets/${stem}.${sum.slice(0, 8)}${ext}`
    const e: Emitted = { file, url: '/' + file, bytes, sha256: sum, logical }
    this.byLogical.set(logical, e)
    this.emitted.push(e)
    return e.url
  }

  url(logical: string): string | undefined {
    return this.byLogical.get(logical)?.url
  }

  /** Rewrites every registered logical path found in `text` to its hashed URL (longest first, whole tokens). */
  rewrite(text: string, where: string, allowMissing = false): { text: string; missing: string[] } {
    const missing: string[] = []
    const logicals = [...this.byLogical.keys()].sort((a, b) => b.length - a.length)
    let out = text
    for (const l of logicals) {
      const re = new RegExp(l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9._-])', 'g')
      out = out.replace(re, this.byLogical.get(l)!.url)
    }
    for (const m of out.matchAll(/\/(?:assets|fonts)\/[A-Za-z0-9._-]+/g)) {
      const ref = m[0]
      if (!/\.[0-9a-f]{8}\.[a-z0-9]+$/.test(ref) && !this.byLogical.has(ref)) missing.push(ref)
    }
    if (missing.length && !allowMissing)
      throw new Error(`${where}: unresolved asset references: ${[...new Set(missing)].join(', ')}`)
    return { text: out, missing: [...new Set(missing)] }
  }
}
