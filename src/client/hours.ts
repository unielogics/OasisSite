// Live hours: fetches GET /api/v1/public/hours (same origin, 3 s timeout, no credentials) and re-applies the
// formatted strings to the [data-hours] nodes the build baked. Any failure leaves the baked strings in place.
import { applyHours, formatHours, validatePublicHours } from '../hours/format'
import type { HoursLabels } from '../hours/format'

export interface HoursOptions {
  endpoint: string
  timeoutMs: number
  labels?: Partial<HoursLabels>
  fetchImpl?: typeof fetch
}

export async function refreshHours(root: ParentNode, opts: HoursOptions): Promise<number> {
  if (!root.querySelector('[data-hours],[data-hours-attr]')) return 0
  const f = opts.fetchImpl ?? fetch
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs)
  try {
    const res = await f(opts.endpoint, {
      signal: ctl.signal,
      credentials: 'omit',
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return 0
    const data = validatePublicHours(await res.json())
    return applyHours(root, formatHours(data, opts.labels))
  } catch {
    return 0
  } finally {
    clearTimeout(timer)
  }
}
