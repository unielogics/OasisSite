/* eslint-disable @typescript-eslint/no-explicit-any */
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { original } from '../../tools/dc-compile/tests/original-runtime'
import { asArray, css, cssToObj, I, kebabToCamel, m, NOOP, R, resolve, resetWarnings } from './runtime'

const html = (n: unknown) => renderToStaticMarkup(createElement(Fragment, null, n as any))

describe('I() (text interpolation)', () => {
  beforeEach(() => resetWarnings())

  it('wraps strings, numbers, empty strings and zero in span.sc-interp', () => {
    expect(html(I('a'))).toBe('<span class="sc-interp">a</span>')
    expect(html(I(''))).toBe('<span class="sc-interp"></span>')
    expect(html(I(0))).toBe('<span class="sc-interp">0</span>')
    expect(html(I(12.5))).toBe('<span class="sc-interp">12.5</span>')
    expect(html(I(NaN))).toBe('<span class="sc-interp">NaN</span>')
    expect(html(I({ toString: () => 'obj' }))).toBe('<span class="sc-interp">obj</span>')
  })

  it('renders nothing for null and booleans', () => {
    for (const v of [null, true, false]) expect(I(v)).toBeNull()
  })

  it('renders React elements and arrays through a Fragment without a span', () => {
    expect(html(I(createElement('b', null, 'x')))).toBe('<b>x</b>')
    expect(html(I([createElement('i', { key: 1 }, 'a'), createElement('i', { key: 2 }, 'b')]))).toBe(
      '<i>a</i><i>b</i>',
    )
    expect(html(I([]))).toBe('')
  })

  it('renders nothing for undefined and warns once per binding, in dev', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = { name: 'Oasis Test' }
    expect(I(undefined, 'a.b', ctx)).toBeNull()
    expect(I(undefined, 'a.b', ctx)).toBeNull()
    expect(I(undefined, 'c', ctx)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0]![0]).toBe('[oasis] Oasis Test: {{ a.b }} never resolved — rendered as empty')
    warn.mockRestore()
  })

  it('stays silent in production builds', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv('NODE_ENV', 'production')
    I(undefined, 'x', { name: 'P' })
    vi.unstubAllEnvs()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('asArray / css / m / NOOP', () => {
  it('asArray passes arrays through and maps everything else to []', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resetWarnings()
    const a = [1]
    expect(asArray(a)).toBe(a)
    expect(asArray(undefined)).toEqual([])
    expect(asArray(null)).toEqual([])
    expect(warn).not.toHaveBeenCalled()
    expect(asArray('abc', 'l', { name: 'N' })).toEqual([])
    expect(asArray({}, 'l', { name: 'N' })).toEqual([])
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('css() parses strings and passes objects, null and undefined straight through', () => {
    expect(css('color: red; margin-top:2px')).toEqual({ color: 'red', marginTop: '2px' })
    const o = { color: 'red' }
    expect(css(o)).toBe(o)
    expect(css(undefined)).toBeUndefined()
    expect(css(null)).toBeNull()
  })

  it('m() is String(x ?? "")', () => {
    expect([m(null), m(undefined), m(0), m(false), m('a'), m(1.5)]).toEqual([
      '',
      '',
      '0',
      'false',
      'a',
      '1.5',
    ])
  })

  it('NOOP does nothing', () => {
    expect(NOOP()).toBeUndefined()
  })
})

describe('ports of the original runtime helpers', () => {
  it('cssToObj and kebabToCamel behave like the original', () => {
    const corpus = [
      '',
      'a:b',
      ' color : red ;; margin:0 ',
      '-webkit-font-smoothing:antialiased;-webkit-user-select:none',
      '--x-y:1px; --Z:2',
      'background:url(data:image/png;base64,AAA);color:red',
      'bad;also bad;ok:1',
      'a:1;a:2;b:3;a:4',
      "font-family:'Bricolage Grotesque',sans-serif",
      'transition:width 1s linear;grid-template-columns:repeat(4,1fr)',
    ]
    for (const c of corpus) {
      expect(Object.entries(cssToObj(c)), c).toEqual(Object.entries(original.cssToObj(c)))
    }
    for (const k of ['a-b', '-webkit-x', 'on-pointer-down', '--x', 'x', 'a-1', 'a--b', 'view-box']) {
      expect(kebabToCamel(k)).toBe(original.kebabToCamel(k))
    }
  })

  it('resolve() matches the original resolver on a corpus of expressions', () => {
    const vals = {
      a: { b: [{ c: 5 }, 'x'], n: 0, s: '', u: undefined, nul: null },
      t: true,
      f: false,
      k: 'b',
      n: 7,
      s: 'str',
      list: [1, 2],
    }
    const exprs = [
      'a',
      'a.b',
      'a.b.0',
      'a.b.0.c',
      'a.b.1',
      'a.n',
      'a.s',
      'a.u',
      'a.nul',
      'a.x.y.z',
      't',
      'f',
      '!t',
      '!f',
      '!a.b',
      '!!n',
      'n === 7',
      'n === 8',
      'n !== 7',
      'n == 7',
      "s === 'str'",
      's === "str"',
      "s != 'str'",
      '(t)',
      '((n))',
      '(n === 7)',
      'true',
      'false',
      'null',
      'undefined',
      '1',
      '-2',
      '3.5',
      "'lit'",
      '"lit"',
      'a[k]',
      'a.b[0]',
      'a.b[0].c',
      'a[k][1]',
      'list.length',
      'a.b[1 + 1]',
      '',
      '   ',
      'a.',
      '.a',
      'a..b',
      '1a',
      'a b',
      'n === a.n',
      '!a.n',
      'a.b === a.b',
      "'a' === 'a'",
      'a.b.0 === a.b.0',
      '(!t)',
      'a.n === 0',
      'n!==7',
      'n!=7',
      'x === undefined',
      'a.u === undefined',
    ]
    for (const e of exprs) {
      expect(resolve(vals, e), e).toEqual(original.resolve(vals, e))
      expect(R(vals, e)).toEqual(original.resolve(vals, e))
    }
  })
})
