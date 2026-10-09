import { describe, expect, it } from 'vitest'
import { diffVals, floatNoise } from './diff-vals'

describe('diffVals', () => {
  it('returns nothing for equal values', () => {
    const v = { a: 1, b: [1, { c: 'x' }], s: { color: 'red', padding: '4px' }, f: '[fn]' }
    expect(diffVals(v, JSON.parse(JSON.stringify(v)))).toEqual([])
  })

  it('reports value changes with JSON paths', () => {
    const d = diffVals({ kpis: [{ sub: '12 booked' }] }, { kpis: [{ sub: '3 booked' }] })
    expect(d).toEqual([
      { check: 'vals', kind: 'value', loc: 'kpis[0].sub', orig: '"12 booked"', port: '"3 booked"' },
    ])
  })

  it('treats object key order as significant (style objects)', () => {
    const d = diffVals(
      { style: { padding: '1px', color: 'red' } },
      { style: { color: 'red', padding: '1px' } },
    )
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({
      kind: 'reorder',
      loc: 'style',
      name: 'keys',
      orig: 'padding,color',
      port: 'color,padding',
    })
  })

  it('reports keys and array items present on one side only', () => {
    const d = diffVals({ a: 1, list: [1, 2, 3] }, { a: 1, extra: true, list: [1, 2] })
    expect(d.map((x) => [x.loc, x.orig, x.port])).toEqual([
      ['list[2]', '3', undefined],
      ['extra', undefined, 'true'],
    ])
  })

  it('distinguishes types', () => {
    expect(diffVals({ n: 1 }, { n: '1' })).toHaveLength(1)
    expect(diffVals({ n: null }, { n: 0 })).toHaveLength(1)
    expect(diffVals([], {})).toHaveLength(1)
  })

  it('clips very long values', () => {
    const d = diffVals({ t: 'a'.repeat(1000) }, { t: 'b' })
    expect(d[0]!.orig!.length).toBeLessThan(260)
  })

  describe('float noise (live mode only)', () => {
    const opts = { floatNoise: { relative: 1e-12 } }

    it('is off by default', () => {
      expect(diffVals({ w: '35.342997615581005%' }, { w: '35.34299761558102%' })).toHaveLength(1)
    })

    it('forgives last-digit differences between long computed decimals of the same unit', () => {
      const seen: string[] = []
      const d = diffVals(
        { a: { w: '35.342997615581005%' }, h: '1.96794534944824%' },
        { a: { w: '35.34299761558102%' }, h: '1.9679453494482395%' },
        { ...opts, onForgiven: (loc) => seen.push(loc) },
      )
      expect(d).toEqual([])
      expect(seen).toEqual(['a.w', 'h'])
    })

    it('does not forgive a real difference, a different unit, or a short typed value', () => {
      expect(diffVals({ w: '35.342997615581005%' }, { w: '35.342997715581005%' }, opts)).toHaveLength(1)
      expect(diffVals({ w: '35.342997615581005%' }, { w: '35.342997615581005px' }, opts)).toHaveLength(1)
      expect(diffVals({ w: '58.3px' }, { w: '58.4px' }, opts)).toHaveLength(1)
      expect(diffVals({ w: '12.5%' }, { w: '12.5000000001%' }, opts)).toHaveLength(1)
      expect(diffVals({ n: 1.0000000000001 }, { n: 1 }, opts)).toHaveLength(1)
    })

    it('floatNoise needs two long decimals', () => {
      expect(floatNoise('0.5275263235635457%', '0.5275263235635458%', 1e-12)).toBe(true)
      expect(floatNoise('0.5%', '0.6%', 1e-12)).toBe(false)
      expect(floatNoise('abc', 'abd', 1e-12)).toBe(false)
    })
  })
})
