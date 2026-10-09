import { describe, expect, it } from 'vitest'
import { diffElements } from './diff-style'
import type { ElementSnap } from './types'

const el = (key: string, over: Partial<ElementSnap> = {}): ElementSnap => ({
  key,
  tag: 'div',
  tpl: key.startsWith('t') ? key.slice(1).split('#')[0]! : null,
  path: `dc-root/${key}`,
  rect: [0, 0, 100, 20],
  scroll: [100, 20, 100, 20, 0, 0],
  cs: { display: 'block', color: 'rgb(0, 0, 0)' },
  ...over,
})

describe('diffElements', () => {
  it('is silent for identical snapshots', () => {
    expect(diffElements([el('t1#0'), el('t2#0')], [el('t1#0'), el('t2#0')])).toEqual([])
  })

  it('reports a 1 px rect change with zero tolerance', () => {
    const d = diffElements([el('t1#0')], [el('t1#0', { rect: [0, 0, 100, 21] })])
    expect(d).toEqual([
      {
        check: 'style',
        kind: 'rect',
        loc: 't1#0',
        name: 'rect',
        orig: '0,0,100,20',
        port: '0,0,100,21',
        tpl: '1',
      },
    ])
    expect(diffElements([el('t1#0')], [el('t1#0', { rect: [0, 0, 100, 20.015625] })])).toHaveLength(1)
  })

  it('reports computed style differences per property', () => {
    const d = diffElements([el('t1#0')], [el('t1#0', { cs: { display: 'flex', color: 'rgb(0, 0, 0)' } })])
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ kind: 'style', name: 'display', orig: 'block', port: 'flex' })
  })

  it('reports scroll metrics, pseudo-element style and form control state', () => {
    const base = el('t1#0', {
      pseudo: { '::before': { content: '"x"' } },
      ctl: { value: 'a', checked: false },
    })
    const other = el('t1#0', {
      scroll: [100, 40, 100, 20, 0, 0],
      pseudo: { '::before': { content: '"y"' } },
      ctl: { value: 'b', checked: false },
    })
    const d = diffElements([base], [other])
    expect(d.map((x) => `${x.kind}:${x.name}`).sort()).toEqual([
      'rect:scroll',
      'style:::before content',
      'value:control',
    ])
  })

  it('reports elements that exist on only one side', () => {
    const d = diffElements([el('t1#0'), el('t2#0')], [el('t1#0'), el('t3#0')])
    expect(d.map((x) => [x.kind, x.loc])).toEqual([
      ['element-removed', 't2#0'],
      ['element-added', 't3#0'],
    ])
  })
})
