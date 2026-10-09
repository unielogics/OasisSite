import fs from 'node:fs'
import path from 'node:path'
import { createElement, Fragment, createRef } from 'react'
import { describe, expect, it } from 'vitest'
import { serializeVals } from './serialize'

const root = path.resolve(__dirname, '..', '..')
const body = (s: string) => s.slice(s.indexOf('export function serializeVals'))

describe('serializeVals (the parity harness contract)', () => {
  it('is identical to the harness serializer in tools/parity/vals-serialize.ts', () => {
    const port = fs.readFileSync(path.join(root, 'src/dc/serialize.ts'), 'utf8')
    const harness = fs.readFileSync(path.join(root, 'tools/parity/vals-serialize.ts'), 'utf8')
    expect(body(port)).toBe(body(harness))
  })

  it('turns functions into "[fn]", undefined into "[undefined]" and keeps scalars', () => {
    expect(
      serializeVals({ a: () => 1, b: 'x', c: 2, d: true, e: null, f: [1, () => 2], u: undefined, n: NaN }),
    ).toEqual({
      a: '[fn]',
      b: 'x',
      c: 2,
      d: true,
      e: null,
      f: [1, '[fn]'],
      u: '[undefined]',
      n: 'NaN',
    })
  })

  it('keeps style-object key order', () => {
    const out = serializeVals({ s: { zIndex: 1, color: 'red', background: 'blue' } }) as { s: object }
    expect(JSON.stringify(out.s)).toBe('{"zIndex":1,"color":"red","background":"blue"}')
  })

  it('serialises React elements to {$el, key, props} with children inside props', () => {
    const el = createElement(
      'span',
      { className: 'a', key: 'k', onClick: () => {} },
      'hi',
      createElement('b', null, 'x'),
    )
    expect(serializeVals({ el })).toEqual({
      el: {
        $el: 'span',
        key: 'k',
        props: {
          className: 'a',
          onClick: '[fn]',
          children: ['hi', { $el: 'b', key: null, props: { children: 'x' } }],
        },
      },
    })
    expect(serializeVals(createElement(Fragment, null, 'a'))).toEqual({
      $el: '[fragment]',
      key: null,
      props: { children: 'a' },
    })
    expect(serializeVals(createElement('span', { dangerouslySetInnerHTML: { __html: '<svg/>' } }))).toEqual({
      $el: 'span',
      key: null,
      props: { dangerouslySetInnerHTML: { __html: '<svg/>' } },
    })
    function Cmp() {
      return null
    }
    expect((serializeVals(createElement(Cmp)) as { $el: string }).$el).toBe('[component]')
  })

  it('keeps createRef objects as plain objects and serialises dates, maps, sets, symbols and cycles', () => {
    const cyc: Record<string, unknown> = { a: 1 }
    cyc.self = cyc
    expect(
      serializeVals({
        ref: createRef(),
        d: new Date('2026-06-13T14:36:00Z'),
        m: new Map([['k', 1]]),
        s: new Set([1]),
        sym: Symbol('x'),
        cyc,
        shared: [cyc.a, cyc.a],
      }),
    ).toEqual({
      ref: { current: null },
      d: '[date] 2026-06-13T14:36:00.000Z',
      m: { $map: [['k', 1]] },
      s: { $set: [1] },
      sym: '[symbol]',
      cyc: { a: 1, self: '[circular]' },
      shared: [1, 1],
    })
  })

  it('is JSON.stringify-safe for a nested renderVals-like object', () => {
    const vals = {
      rows: [{ label: 'a', onClick: () => {}, style: { color: 'red' }, icon: createElement('i') }],
    }
    expect(() => JSON.stringify(serializeVals(vals))).not.toThrow()
  })
})
