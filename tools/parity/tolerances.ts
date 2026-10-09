import fs from 'node:fs'
import type { Theme } from './config'

/**
 * Last-resort pixel tolerances (e.g. a backdrop-filter region that rasterises nondeterministically). Every entry needs a
 * reason and a scope; there is no global default and none may be added silently (see docs/parity.md).
 */
export interface PixelTolerance {
  id: string
  page: string
  scenario?: string
  theme?: Theme
  step?: string
  maxMismatched: number
  reason: string
}

export interface Tolerances {
  pixels: PixelTolerance[]
}

export function validateTolerances(raw: unknown): Tolerances {
  const t = raw as Partial<Tolerances> | null
  const pixels = t?.pixels ?? []
  if (!Array.isArray(pixels)) throw new Error('tolerances.pixels must be an array')
  const ids = new Set<string>()
  for (const p of pixels) {
    if (!p.id || ids.has(p.id)) throw new Error(`tolerance ${p.id ?? '(no id)'}: missing or duplicate id`)
    ids.add(p.id)
    if (!Number.isInteger(p.maxMismatched) || p.maxMismatched < 0)
      throw new Error(`tolerance ${p.id}: maxMismatched must be an integer >= 0`)
    if (typeof p.reason !== 'string' || p.reason.trim().length < 20)
      throw new Error(`tolerance ${p.id}: a real reason (20+ chars) is required`)
    if (!p.page) throw new Error(`tolerance ${p.id}: page is required (use "*" for all)`)
  }
  return { pixels }
}

export function loadTolerances(file: string): Tolerances {
  if (!fs.existsSync(file)) return { pixels: [] }
  return validateTolerances(JSON.parse(fs.readFileSync(file, 'utf8')))
}

export function pixelToleranceFor(
  t: Tolerances,
  u: { page: string; scenario: string; theme: Theme; step: string },
): PixelTolerance | undefined {
  return t.pixels.find(
    (p) =>
      (p.page === '*' || p.page === u.page) &&
      (p.scenario === undefined || p.scenario === u.scenario) &&
      (p.theme === undefined || p.theme === u.theme) &&
      (p.step === undefined || p.step === u.step),
  )
}
