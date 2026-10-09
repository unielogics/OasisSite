import { describe, expect, it } from 'vitest'
import { diffDom, hasTpl, normalizeHtml, renderTree } from './diff-dom'

const norm = (html: string, keepTpl = true) => normalizeHtml(html, keepTpl)
const diff = (a: string, b: string, keepTpl = true) => diffDom(norm(a, keepTpl), norm(b, keepTpl))

describe('normalizeHtml', () => {
  it('always strips data-sc-name and keeps data-dc-tpl only on request', () => {
    const html = '<div id="dc-root"><div class="sc-host" data-sc-name="x" data-dc-tpl="3"></div></div>'
    expect(renderTree(norm(html, true))).toContain('data-dc-tpl="3"')
    expect(renderTree(norm(html, true))).not.toContain('data-sc-name')
    expect(renderTree(norm(html, false))).not.toContain('data-dc-tpl')
  })

  it('ignores the port ready flag on #dc-root', () => {
    expect(
      diff('<div id="dc-root"><p>a</p></div>', '<div data-oasis-ready="1" id="dc-root"><p>a</p></div>'),
    ).toEqual([])
  })

  it('sorts attributes but keeps values (including style) byte for byte', () => {
    const a = norm('<div style="a: 1; b: 2" class="x" id="i"></div>')
    const b = norm('<div id="i" class="x" style="a: 1; b: 2"></div>')
    expect(a).toEqual(b)
    expect(diff('<div style="a: 1; b: 2"></div>', '<div style="a:1;b:2"></div>')).toHaveLength(1)
  })

  it('detects whether a document carries data-dc-tpl', () => {
    expect(hasTpl('<div data-dc-tpl="1"></div>')).toBe(true)
    expect(hasTpl('<div></div>')).toBe(false)
  })
})

describe('diffDom', () => {
  it('reports nothing for identical trees', () => {
    const html = '<div data-dc-tpl="1"><span class="sc-interp">a</span> <b data-dc-tpl="2">x</b></div>'
    expect(diff(html, html)).toEqual([])
  })

  it('reports a text change with its path and values', () => {
    const d = diff(
      '<div data-dc-tpl="1"><p data-dc-tpl="2">Hello</p></div>',
      '<div data-dc-tpl="1"><p data-dc-tpl="2">Hullo</p></div>',
    )
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({
      check: 'dom',
      kind: 'text',
      orig: 'Hello',
      port: 'Hullo',
      loc: 'div[0]#1/p[0]#2/#text[0]',
    })
  })

  it('reports attribute differences, including one-sided attributes', () => {
    const d = diff('<a href="/x" data-dc-tpl="1">go</a>', '<a data-dc-tpl="1" href="/y" title="t">go</a>')
    expect(d.map((x) => [x.kind, x.name, x.orig, x.port])).toEqual([
      ['attr', 'href', '/x', '/y'],
      ['attr', 'title', undefined, 't'],
    ])
    expect(d[0]!.tpl).toBe('1')
  })

  it('reports added and removed elements once, not their descendants', () => {
    const d = diff(
      '<ul data-dc-tpl="1"><li data-dc-tpl="2">a</li></ul>',
      '<ul data-dc-tpl="1"><li data-dc-tpl="2">a</li><li data-dc-tpl="3"><b>x</b><i>y</i></li></ul>',
    )
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ kind: 'element-added' })
    expect(d[0]!.port).toContain('descendants')
    const r = diff(
      '<ul data-dc-tpl="1"><li data-dc-tpl="2">a</li><li data-dc-tpl="3">b</li></ul>',
      '<ul data-dc-tpl="1"><li data-dc-tpl="2">a</li></ul>',
    )
    expect(r.map((x) => x.kind)).toEqual(['element-removed'])
  })

  it('reports a pure reordering as one reorder diff, then compares the moved nodes by identity', () => {
    const rows = (order: string[]) =>
      `<div data-dc-tpl="1">${order.map((id) => `<p data-dc-tpl="${id}">${id}</p>`).join('')}</div>`
    const d = diff(rows(['2', '3', '4']), rows(['3', '2', '4']))
    expect(d.map((x) => x.kind)).toEqual(['reorder'])
    expect(d[0]!.orig).toBe('p@2,p@3,p@4')
    expect(d[0]!.port).toBe('p@3,p@2,p@4')
  })

  it('pairs repeated templates (sc-for) by occurrence', () => {
    const list = (items: string[]) =>
      `<div data-dc-tpl="1">${items.map((t) => `<p data-dc-tpl="2">${t}</p>`).join('')}</div>`
    const d = diff(list(['a', 'b', 'c']), list(['a', 'x', 'c']))
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ kind: 'text', orig: 'b', port: 'x' })
  })

  it('treats a tag change as remove plus add', () => {
    const d = diff('<div data-dc-tpl="1"><p>a</p></div>', '<div data-dc-tpl="1"><span>a</span></div>')
    expect(d.map((x) => x.kind).sort()).toEqual(['element-added', 'element-removed'])
  })

  it('keeps whitespace text nodes significant', () => {
    expect(diff('<div>a <b>b</b></div>', '<div>a<b>b</b></div>').length).toBeGreaterThan(0)
  })

  it('compares without tpl ids by tag signature', () => {
    expect(diff('<div><p>a</p></div>', '<div><p>b</p></div>', false)).toHaveLength(1)
  })

  it('caps the number of diffs at the limit', () => {
    const many = (t: string) => `<div>${Array.from({ length: 50 }, () => `<p>${t}</p>`).join('')}</div>`
    expect(diffDom(norm(many('a'), false), norm(many('b'), false), { limit: 10 })).toHaveLength(10)
  })
})
