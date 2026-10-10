import { describe, expect, it } from 'vitest'
import {
  AllowlistError,
  AllowlistTracker,
  applyAllowlist,
  checkAllowlistScopes,
  entryApplies,
  globToRegExp,
  masksFor,
  swapsFor,
  validateAllowlist,
  type AllowEntry,
  type UnitCtx,
} from './allowlist'
import type { Diff } from './types'

/** the dashboard fixture pages this test's entries name (design/pages.json lists the site's page only) */
const validate = (raw: unknown) => validateAllowlist(raw, ['payments', 'settings', 'operations'])

const unit: UnitCtx = { page: 'payments', scenario: 'ranges', theme: 'light', step: 'range-today' }
const base = { reason: 'a sufficiently long reason' }

const diffs: Diff[] = [
  { check: 'vals', kind: 'value', loc: 'kpis[1].sub', orig: '"12 booked"', port: '"3 booked"' },
  { check: 'dom', kind: 'text', loc: 'div[0]/span[2]/#text[0]', orig: 'WhatsApp', port: 'SMS' },
  {
    check: 'dom',
    kind: 'attr',
    loc: 'div[0]/a[1]',
    name: 'href',
    orig: 'Oasis%20Settings.dc.html',
    port: '/settings',
    tpl: '9',
  },
  { check: 'style', kind: 'rect', loc: 't9#0', name: 'rect', orig: '0,0,1,1', port: '0,0,2,1', tpl: '9' },
]

describe('globToRegExp', () => {
  it('* stays inside a segment, ** crosses segments', () => {
    expect(globToRegExp('kpis[*].sub').test('kpis[0].sub')).toBe(true)
    expect(globToRegExp('kpis[*].sub').test('kpis[0].x.sub')).toBe(false)
    expect(globToRegExp('kpis**').test('kpis[0].x.sub')).toBe(true)
    expect(globToRegExp('div[0]/*/#text[0]').test('div[0]/span/#text[0]')).toBe(true)
  })
})

describe('validateAllowlist', () => {
  const ok: AllowEntry = {
    id: 'e1',
    page: 'payments',
    kind: 'text',
    ...base,
    matcher: { loc: 'kpis[*].sub' },
  }

  it('accepts a well-formed list in either container shape', () => {
    expect(validate({ entries: [ok] })).toHaveLength(1)
    expect(validate([ok])).toHaveLength(1)
    expect(validate({ version: 1, entries: [] })).toEqual([])
  })

  it('rejects duplicate ids, bad screens, short reasons and unknown kinds', () => {
    expect(() => validate([ok, ok])).toThrow(/duplicate id/)
    expect(() => validate([{ ...ok, page: 'nope' }])).toThrow(/page must be/)
    expect(() => validate([{ ...ok, reason: 'short' }])).toThrow(/reason/)
    expect(() => validate([{ ...ok, kind: 'magic' }])).toThrow(/kind/)
  })

  it('rejects over-broad matchers', () => {
    expect(() => validate([{ ...ok, matcher: {} }])).toThrow(/over-broad/)
    expect(() => validate([{ ...ok, matcher: { loc: '**' } }])).toThrow(/bare wildcard/)
    expect(() => validate([{ ...ok, matcher: undefined }])).toThrow(/matcher is required/)
  })

  it('requires a rect or tpl for region-mask and a name for attr swaps', () => {
    expect(() => validate([{ ...ok, kind: 'region-mask', matcher: { loc: 'x' } }])).toThrow(
      /region-mask needs/,
    )
    expect(() =>
      validate([
        { id: 's', page: 'payments', kind: 'attr', ...base, swap: { find: 'a', replace: 'b', count: 1 } },
      ]),
    ).toThrow(/swap.attr/)
  })

  it('limits pre-render swaps to text and attr and forbids swap plus matcher', () => {
    expect(() =>
      validate([
        {
          id: 's',
          page: 'payments',
          kind: 'reorder',
          ...base,
          swap: { find: 'a', replace: 'b', count: 1 },
        },
      ]),
    ).toThrow(/only text and attr/)
    expect(() => validate([{ ...ok, swap: { find: 'a', replace: 'b', count: 1 } }])).toThrow(
      /must not also have/,
    )
    expect(() =>
      validate([
        { id: 's', page: 'payments', kind: 'text', ...base, swap: { find: 'a', replace: 'b', count: 0 } },
      ]),
    ).toThrow(/count/)
  })

  it('checks scope.checks against what the kind may cover and regex syntax', () => {
    expect(() => validate([{ ...ok, scope: { checks: ['pixels'] } }])).toThrow(/cannot cover/)
    expect(() => validate([{ ...ok, matcher: { orig: '(' } }])).toThrow(/regular expression/)
    expect(() => validate([{ ...ok, expect: { min: 3, max: 2 } }])).toThrow(/min > expect.max/)
  })
})

describe('applyAllowlist', () => {
  const entries = validate([
    { id: 'kpi', page: 'payments', kind: 'text', ...base, matcher: { loc: 'kpis[*].sub' } },
    { id: 'sms', page: '*', kind: 'text', ...base, matcher: { orig: '^WhatsApp$', port: '^SMS$' } },
    { id: 'href', page: 'payments', kind: 'attr', ...base, matcher: { name: 'href', tpl: '9' } },
  ])

  it('allows matching diffs and leaves the rest', () => {
    const r = applyAllowlist(diffs, entries, unit)
    expect(r.allowed.map((d) => [d.loc, d.allowedBy])).toEqual([
      ['kpis[1].sub', 'kpi'],
      ['div[0]/span[2]/#text[0]', 'sms'],
      ['div[0]/a[1]', 'href'],
    ])
    expect(r.remaining.map((d) => d.kind)).toEqual(['rect'])
    expect(Object.fromEntries(r.counts)).toEqual({ kpi: 1, sms: 1, href: 1 })
  })

  it('regex matchers see both the JSON text and the plain string of a vals diff', () => {
    const e = validate([
      {
        id: 'q',
        page: 'payments',
        kind: 'text',
        ...base,
        matcher: { orig: '^12 booked$', port: '^"3 booked"$' },
      },
    ])
    expect(applyAllowlist(diffs.slice(0, 1), e, unit).allowed).toHaveLength(1)
  })

  it('does not let a text entry excuse an attr diff or a style diff', () => {
    const e = validate(
      [{ id: 'wide', page: 'payments', kind: 'text', ...base, matcher: { loc: '**' } }].map((x) => ({
        ...x,
        matcher: { loc: 'div**' },
      })),
    )
    const r = applyAllowlist(diffs, e, unit)
    expect(r.allowed.map((d) => d.kind)).toEqual(['text'])
  })

  it('honours screen and scope', () => {
    const scoped = validate([
      { id: 'a', page: 'settings', kind: 'text', ...base, matcher: { loc: 'kpis[*].sub' } },
      {
        id: 'b',
        page: 'payments',
        kind: 'text',
        ...base,
        matcher: { loc: 'kpis[*].sub' },
        scope: { scenarios: ['filters'] },
      },
      {
        id: 'c',
        page: 'payments',
        kind: 'text',
        ...base,
        matcher: { loc: 'kpis[*].sub' },
        scope: { steps: ['range-*'], themes: ['light'] },
      },
    ])
    expect(scoped.map((e) => entryApplies(e, unit))).toEqual([false, false, true])
    expect(applyAllowlist(diffs, scoped, unit).allowed).toHaveLength(1)
    expect(applyAllowlist(diffs, scoped, { ...unit, theme: 'dark' }).allowed).toHaveLength(0)
  })

  it('counts a diff for every matching entry but allows it once', () => {
    const two = validate([
      { id: 'one', page: 'payments', kind: 'text', ...base, matcher: { loc: 'kpis[*].sub' } },
      { id: 'two', page: 'payments', kind: 'text', ...base, matcher: { orig: 'booked' } },
    ])
    const r = applyAllowlist(diffs.slice(0, 1), two, unit)
    expect(r.allowed).toHaveLength(1)
    expect(Object.fromEntries(r.counts)).toEqual({ one: 1, two: 1 })
  })

  it('reorder entries also excuse the rect diffs of the moved elements', () => {
    const e = validate([
      { id: 'ro', page: 'payments', kind: 'reorder', ...base, matcher: { tpl: '9' } },
    ])
    const r = applyAllowlist(diffs, e, unit)
    expect(r.allowed.map((d) => d.kind)).toEqual(['rect'])
  })
})

describe('computed-style entries (live mode)', () => {
  const entry: AllowEntry = {
    id: 'cs',
    page: '*',
    kind: 'computed-style',
    ...base,
    expect: { min: 0 },
    matcher: { loc: ['body', 'root>div[0]'], name: '--*' },
  }

  it('is accepted, and limited to the style check', () => {
    expect(() => validate([entry])).not.toThrow()
    expect(() => validate([{ ...entry, scope: { checks: ['dom'] } }])).toThrow(
      /cannot cover check "dom"/,
    )
  })

  it('excuses a computed property on the named element and nothing else', () => {
    const styleDiffs: Diff[] = [
      { check: 'style', kind: 'style', loc: 'root>div[0]', name: '--bg', orig: '#fff', port: '#000' },
      { check: 'style', kind: 'style', loc: 'root>div[0]', name: 'color', orig: 'red', port: 'blue' },
      { check: 'style', kind: 'style', loc: 'root>div[0]>div[1]', name: '--bg', orig: '#fff', port: '#000' },
      { check: 'style', kind: 'rect', loc: 'root>div[0]', name: 'rect', orig: '0,0,1,1', port: '0,0,2,1' },
    ]
    const r = applyAllowlist(styleDiffs, [entry], unit)
    expect(r.allowed.map((d) => d.name)).toEqual(['--bg'])
    expect(r.remaining).toHaveLength(3)
  })
})

describe('AllowlistTracker', () => {
  const entries = validate([
    { id: 'used', page: 'payments', kind: 'text', ...base, matcher: { loc: 'a' } },
    { id: 'limited', page: 'payments', kind: 'text', ...base, matcher: { loc: 'b' }, expect: { max: 1 } },
    { id: 'wild', page: 'payments', kind: 'text', ...base, matcher: { loc: 'c' }, expect: { min: 0 } },
  ])

  it('flags entries below min, above max and never matched', () => {
    const t = new AllowlistTracker(entries)
    expect(
      t.record(
        'u1',
        new Map([
          ['used', 0],
          ['limited', 2],
          ['wild', 0],
        ]),
      ),
    ).toEqual([
      expect.stringContaining('used: matched 0 (< min 1)'),
      expect.stringContaining('limited: matched 2 (> max 1)'),
    ])
    const problems = t.finish()
    expect(problems.some((p) => p.includes('used: never matched anything'))).toBe(true)
    expect(problems.some((p) => p.startsWith('wild'))).toBe(true)
  })

  it('does not call an entry stale when it was never in scope', () => {
    const t = new AllowlistTracker(entries)
    expect(t.record('u1', new Map())).toEqual([])
    expect(t.finish()).toEqual([])
  })

  it('is clean when every applicable entry matched', () => {
    const t = new AllowlistTracker(entries)
    expect(
      t.record(
        'u1',
        new Map([
          ['used', 3],
          ['limited', 1],
          ['wild', 0],
        ]),
      ),
    ).toEqual([])
  })
})

describe('swapsFor and masksFor', () => {
  const entries = validate([
    {
      id: 't',
      page: 'payments',
      kind: 'text',
      ...base,
      swap: { find: 'WhatsApp', replace: 'SMS', count: 2 },
    },
    {
      id: 'a',
      page: '*',
      kind: 'attr',
      ...base,
      swap: { find: '.dc.html', replace: '', count: 3, attr: 'href' },
    },
    {
      id: 'm',
      page: 'payments',
      kind: 'region-mask',
      ...base,
      matcher: { rect: { x: 1, y: 2, w: 3, h: 4 } },
    },
  ])
  it('selects swaps by screen and ignores diff-side entries', () => {
    expect(swapsFor(entries, 'payments').map((s) => s.id)).toEqual(['t', 'a'])
    expect(swapsFor(entries, 'settings').map((s) => s.id)).toEqual(['a'])
  })
  it('swap entries never apply to diffs; masks are found by scope', () => {
    expect(entryApplies(entries[0]!, unit)).toBe(false)
    expect(masksFor(entries, unit).map((e) => e.id)).toEqual(['m'])
    expect(masksFor(entries, { ...unit, page: 'settings' })).toEqual([])
  })
  it('refuses to apply a non text/attr kind before render', () => {
    const bad = {
      id: 'r',
      page: 'payments',
      kind: 'reorder',
      reason: 'x'.repeat(12),
      swap: { find: 'a', replace: 'b', count: 1 },
    } as AllowEntry
    expect(() => swapsFor([bad], 'payments')).toThrow(AllowlistError)
  })
})

describe('checkAllowlistScopes', () => {
  const catalogue = [
    { id: 'ranges', page: 'payments' as const, steps: [{ id: 'range-today' }, { id: 'range-7d' }] },
    { id: 'sections', page: 'settings' as const, steps: [{ id: 'section-vip' }] },
  ]
  const mk = (scope: object, page = 'payments') =>
    validate([{ id: 'e', page, kind: 'text', ...base, matcher: { loc: 'a' }, scope }])

  it('accepts scopes that name real scenarios and steps', () => {
    expect(checkAllowlistScopes(mk({ scenarios: ['ranges'], steps: ['range-*'] }), catalogue)).toEqual([])
    expect(checkAllowlistScopes(mk({ steps: ['initial'] }), catalogue)).toEqual([])
    expect(checkAllowlistScopes(mk({ scenarios: ['sections'] }, '*'), catalogue)).toEqual([])
  })

  it('reports typos that would make an entry silently inert', () => {
    expect(checkAllowlistScopes(mk({ scenarios: ['rangez'] }), catalogue)).toEqual([
      'e: scope.scenarios "rangez" matches no scenario on payments',
    ])
    expect(checkAllowlistScopes(mk({ scenarios: ['sections'] }), catalogue)).toHaveLength(1)
    expect(checkAllowlistScopes(mk({ scenarios: ['ranges'], steps: ['section-vip'] }), catalogue)).toEqual([
      'e: scope.steps "section-vip" matches no step of the scenarios in scope',
    ])
  })
})
