import { describe, expect, it } from 'vitest'
import { diffConsole, normalizeConsole } from './diff-console'

describe('normalizeConsole', () => {
  it('removes ports, blob ids and uuids', () => {
    expect(
      normalizeConsole({
        type: 'error',
        text: 'Failed http://127.0.0.1:3100/x blob:http://a/1234-5 id 6e26ff20-2ee8-4766-8c6f-85f6ecbe789c',
      }),
    ).toBe('error: Failed <origin>/x blob:<id> id <uuid>')
  })

  it('reduces both wordings of an unresolved binding to the same key', () => {
    const a = normalizeConsole({
      type: 'warning',
      text: '[dc-runtime] {{ kpis.0.sub }} never resolved in <x>',
    })
    const b = normalizeConsole({ type: 'warning', text: '[oasis] settings: {{ kpis.0.sub }} never resolved' })
    expect(a).toBe(b)
  })
})

describe('diffConsole', () => {
  const none = { orig: [], port: [] }
  it('is silent when both sides log the same', () => {
    const m = [{ type: 'warning', text: 'x' }]
    expect(diffConsole(m, m, none, ['warning: x']).diffs).toEqual([])
  })

  it('reports a warning only the port emits, and counts multiplicity', () => {
    const d = diffConsole(
      [],
      [
        { type: 'error', text: 'boom' },
        { type: 'error', text: 'boom' },
      ],
      none,
      [],
    )
    expect(d.diffs).toEqual([{ check: 'console', kind: 'console', loc: 'error: boom', orig: '0', port: '2' }])
  })

  it('reports blocked requests per side', () => {
    const d = diffConsole([], [], { orig: [], port: ['https://fonts.gstatic.com/x.woff2'] }, [])
    expect(d.diffs[0]!.loc).toContain('blocked request')
  })

  it('flags original warnings that are not in the baseline (drift) even when the port matches', () => {
    const m = [{ type: 'warning', text: 'new thing' }]
    const d = diffConsole(m, m, none, [])
    expect(d.diffs).toEqual([
      {
        check: 'console',
        kind: 'console',
        loc: 'warning: new thing',
        name: 'baseline-drift',
        orig: '1',
        port: 'not in baseline',
      },
    ])
  })
})
