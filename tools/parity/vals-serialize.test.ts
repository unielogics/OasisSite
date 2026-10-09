import { describe, expect, it } from 'vitest'
import { serializeVals } from './vals-serialize'

const el = (
  type: unknown,
  props: Record<string, unknown>,
  key: string | null = null,
  ref: unknown = null,
) => ({
  $$typeof: Symbol.for('react.element'),
  type,
  key,
  ref,
  props,
})

describe('serializeVals', () => {
  it('passes JSON-safe values through and keeps key order', () => {
    const v = { b: 1, a: 'x', n: null, t: true, list: [1, 'a'], o: { z: 1, y: 2 } }
    const out = serializeVals(v)
    expect(out).toEqual(v)
    expect(Object.keys(out as object)).toEqual(['b', 'a', 'n', 't', 'list', 'o'])
    expect(Object.keys((out as { o: object }).o)).toEqual(['z', 'y'])
  })

  it('replaces functions, undefined, symbols, bigint and non-finite numbers with markers', () => {
    expect(
      serializeVals({
        f: () => 1,
        g: function () {},
        u: undefined,
        s: Symbol('x'),
        b: 5n,
        n: NaN,
        i: Infinity,
        m: -Infinity,
      }),
    ).toEqual({
      f: '[fn]',
      g: '[fn]',
      u: '[undefined]',
      s: '[symbol]',
      b: '5n',
      n: 'NaN',
      i: 'Infinity',
      m: '-Infinity',
    })
  })

  it('serialises React elements structurally', () => {
    const icon = el('span', { dangerouslySetInnerHTML: { __html: '<svg/>' } })
    const out = serializeVals({
      icon,
      frag: el(Symbol.for('react.fragment'), { children: ['a', el('b', {}, 'k1')] }),
      cmp: el(() => null, {}),
      withRef: el('div', {}, null, {}),
    })
    expect(out).toEqual({
      icon: { $el: 'span', key: null, props: { dangerouslySetInnerHTML: { __html: '<svg/>' } } },
      frag: { $el: '[fragment]', key: null, props: { children: ['a', { $el: 'b', key: 'k1', props: {} }] } },
      cmp: { $el: '[component]', key: null, props: {} },
      withRef: { $el: 'div', key: null, props: {}, ref: '[ref]' },
    })
  })

  it('handles dates, maps, sets and cycles', () => {
    const cyc: Record<string, unknown> = { name: 'c' }
    cyc.self = cyc
    const shared = { v: 1 }
    expect(
      serializeVals({
        d: new Date(Date.UTC(2026, 5, 13, 14, 36)),
        m: new Map([['a', 1]]),
        s: new Set([1, 2]),
        cyc,
        again: [shared, shared],
      }),
    ).toEqual({
      d: '[date] 2026-06-13T14:36:00.000Z',
      m: { $map: [['a', 1]] },
      s: { $set: [1, 2] },
      cyc: { name: 'c', self: '[circular]' },
      again: [{ v: 1 }, { v: 1 }],
    })
  })

  it('is self-contained so the harness can inject its source into a page', () => {
    const src = serializeVals.toString()
    const rebuilt = new Function(`return (${src})`)() as typeof serializeVals
    expect(rebuilt({ a: () => 1, e: el('i', {}) })).toEqual({
      a: '[fn]',
      e: { $el: 'i', key: null, props: {} },
    })
  })
})
