import { describe, expect, it } from 'vitest'
import { fakeSheetDoc, original } from '../../tools/dc-compile/tests/original-runtime'
import { importantify, PseudoSheet, pseudoRule, scanUnquotedUrl, stripComments } from './pseudo'

const corpus = [
  'color:red',
  'color: red; background: blue;',
  'color:red !important;x:1',
  'color:red!important',
  'background:url(data:image/png;base64,AA;BB) no-repeat; color:red',
  'background:url("a;b.png"); content:";"',
  "content:'\\';'; color:red",
  '/* c */ color: red /* d */; x:1',
  'transform:translate(1px, 2px);filter:drop-shadow(0 0 1px rgba(0,0,0,.5))',
  '',
  ';;',
  'a:1;;b:2;',
  "font-family:'A B', sans-serif",
  'content:"url(x)"; background:url( x.png )',
  'url(a)',
  'xurl(a):1',
]

describe('pseudo sheet ports', () => {
  it('stripComments, importantify and scanUnquotedUrl match the original runtime on a corpus', () => {
    for (const css of corpus) {
      expect(stripComments(css), css).toBe(original.stripComments(css))
      expect(importantify(css), css).toBe(original.importantify(css))
      for (let i = 0; i < css.length; i++)
        expect(scanUnquotedUrl(css, i), `${css}@${i}`).toBe(original.scanUnquotedUrl(css, i))
    }
  })

  it('PseudoSheet numbers, caches and writes rules exactly like createPseudoSheet', () => {
    const { doc, rules } = fakeSheetDoc()
    const theirs = original.createPseudoSheet(doc)
    const ours = new PseudoSheet()
    const pairs: [string, string][] = [
      ['hover', 'color:red'],
      ['hover', 'color:red'],
      ['focus', 'outline:none'],
      ['before', 'content:"x"'],
      ['after', 'content:"y";color:red'],
      ['hover', 'color:blue'],
      ['active', 'x:1 !important'],
    ]
    for (const [p, c] of pairs) expect(ours.add(p, c)).toBe(theirs(p, c))
    expect(ours.rules()).toEqual(rules)
    expect(ours.size).toBe(6)
    expect(pseudoRule('scpz', 'hover', 'a:1')).toBe('.scpz:hover{a:1 !important}')
  })
})
