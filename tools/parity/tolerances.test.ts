import { describe, expect, it } from 'vitest'
import { pixelToleranceFor, validateTolerances } from './tolerances'

describe('tolerances', () => {
  it('accepts an empty file and scoped entries', () => {
    expect(validateTolerances({ pixels: [] })).toEqual({ pixels: [] })
    const t = validateTolerances({
      pixels: [
        {
          id: 'blur',
          page: 'operations',
          scenario: 'appointment-file',
          maxMismatched: 40,
          reason: 'backdrop-filter blur rasterises nondeterministically in software GL',
        },
      ],
    })
    expect(
      pixelToleranceFor(t, {
        page: 'operations',
        scenario: 'appointment-file',
        theme: 'dark',
        step: 'open-file',
      })?.id,
    ).toBe('blur')
    expect(
      pixelToleranceFor(t, {
        page: 'payments',
        scenario: 'appointment-file',
        theme: 'dark',
        step: 'open-file',
      }),
    ).toBeUndefined()
  })

  it('refuses entries without a real reason, a count or a scope', () => {
    expect(() =>
      validateTolerances({ pixels: [{ id: 'a', page: '*', maxMismatched: 1, reason: 'meh' }] }),
    ).toThrow(/reason/)
    expect(() =>
      validateTolerances({ pixels: [{ id: 'a', page: '*', maxMismatched: -1, reason: 'x'.repeat(30) }] }),
    ).toThrow(/maxMismatched/)
    expect(() =>
      validateTolerances({ pixels: [{ id: 'a', maxMismatched: 1, reason: 'x'.repeat(30) }] }),
    ).toThrow(/page/)
  })
})
