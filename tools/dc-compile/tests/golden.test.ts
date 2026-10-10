/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CompileError } from '../errors'
import { applyCopy, applyCopyToTree, applyPatches, resolveCopyTo } from '../patches'
import type { PatchConfig } from '../patches'
import { parseTemplate } from '../parse'
import { Emitter } from '../emit'
import { cssToObj } from '../../../src/dc/css'
import { bodyOf, compileSnippet, fixtureExtracted, referenceMarkup, renderSnippet, tmpDir } from './helpers'
import { root } from './original-runtime'

beforeAll(() => {
  // React warns about controlled inputs while the reference interpreter renders; the markup is what counts.
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterAll(() => {
  for (const d of fs.readdirSync(tmpDir))
    if (d.startsWith('s')) fs.rmSync(path.join(tmpDir, d), { recursive: true, force: true })
})

/** Both sides must produce the same markup: compiled snippet vs the original runtime's rules. */
async function same(html: string, vals: Record<string, unknown>, tplIds = false) {
  const ours = await renderSnippet(html, vals, { tplIds })
  expect(ours).toBe(referenceMarkup(html, vals, tplIds).html)
  return ours
}

describe('text nodes', () => {
  it('drops only newline-only whitespace without a space, keeps everything else verbatim', () => {
    const { tsx } = compileSnippet('<div>\n</div><div> </div><div>\n  </div><div>a  b\n</div>')
    const body = bodyOf(tsx)
    expect(body).toContain('<div />')
    expect(body).toContain('{" "}')
    expect(body).toContain('{"\\n  "}')
    expect(body).toContain('{"a  b\\n"}')
  })

  it('emits static text as JSON string literals, never JSX text', () => {
    const { tsx } = compileSnippet('<p>He said "hi" {not a binding} &amp; <b>left</b>\\ —  </p>')
    expect(bodyOf(tsx)).toContain('{"He said \\"hi\\" {not a binding} & "}')
    expect(bodyOf(tsx)).not.toMatch(/^\s*He said/m)
  })

  it('keeps adjacent text nodes apart when a comment sat between them', () => {
    const { tsx } = compileSnippet('<p>a<!-- c -->b</p>')
    expect(bodyOf(tsx)).toContain('{"a"}\n  {"b"}')
  })

  it('splits interpolated text into static strings and I() calls inside a fragment', () => {
    const { tsx, bindings } = compileSnippet('<span>Total {{ a.b.0 }} due {{ c }}.</span>')
    expect(bodyOf(tsx)).toBe(
      [
        '<span>',
        '  <>',
        '    {"Total "}',
        '    {I($v.a?.b?.[0], "a.b.0", $h)}',
        '    {" due "}',
        '    {I($v.c, "c", $h)}',
        '    {"."}',
        '  </>',
        '</span>',
      ].join('\n'),
    )
    expect(bindings.roots).toEqual(['a', 'c'])
    expect(bindings.paths).toEqual(['a.b[0]', 'c'])
  })
})

describe('sc-interp rules (the runtime walkText semantics)', () => {
  const html = '<div>[{{ v }}]</div>'
  const cases: [string, unknown, string][] = [
    ['string', 'x', '<div>[<span class="sc-interp">x</span>]</div>'],
    ['empty string is still wrapped', '', '<div>[<span class="sc-interp"></span>]</div>'],
    ['zero is still wrapped', 0, '<div>[<span class="sc-interp">0</span>]</div>'],
    ['undefined renders nothing', undefined, '<div>[]</div>'],
    ['null renders nothing', null, '<div>[]</div>'],
    ['true renders nothing', true, '<div>[]</div>'],
    ['false renders nothing', false, '<div>[]</div>'],
  ]
  for (const [name, v, out] of cases) {
    it(name, async () => {
      expect(await same(html, { v })).toBe(out)
    })
  }
})

describe('attributes', () => {
  it('skips sc-name, data-dc-tpl and hint-*, passes data-* and ids through', async () => {
    const html =
      '<div sc-name="x" data-dc-tpl="9" hint-size="1,2" data-drop="{{ d }}" id="oa" title="t&amp;t"></div>'
    const { tsx } = compileSnippet(html)
    expect(bodyOf(tsx)).toBe('<div data-drop={$v.d} id="oa" title={"t&t"} />')
    expect(await same(html, { d: 'bay:2' })).toBe('<div data-drop="bay:2" id="oa" title="t&amp;t"></div>')
  })

  it('decodes sc-camel-* with kebabToCamel and maps events', () => {
    const { tsx } = compileSnippet(
      '<svg sc-camel-view-box="0 0 24 24"><path stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M0 0"></path></svg>' +
        '<button sc-camel-on-click="{{ a }}" sc-camel-on-pointer-down="{{ b }}" sc-camel-on-context-menu="{{ c }}" onkeydown="{{ d }}" ondoubleclick="{{ e }}" sc-camel-on-pointer-up="{{ f }}"></button>' +
        '<input sc-camel-on-input="{{ g }}" inputmode="decimal" rows="4">',
    )
    const body = bodyOf(tsx)
    expect(body).toContain('<svg viewBox="0 0 24 24">')
    expect(body).toContain('strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M0 0"')
    expect(body).toContain(
      '<button onClick={$v.a} onPointerDown={$v.b} onContextMenu={$v.c} onKeyDown={$v.d} onDoubleClick={$v.e} onPointerUp={$v.f} />',
    )
    expect(body).toContain('<input onInput={$v.g} inputMode="decimal" rows={4} />')
  })

  it('records handlers, refs and conditions in the bindings', () => {
    const { bindings } = compileSnippet(
      '<sc-for list="{{ l }}" as="x"><button sc-camel-on-click="{{ x.go }}" ref="{{ x.r }}"></button><sc-if value="{{ x.on }}">a</sc-if></sc-for>',
    )
    expect(bindings.handlers).toEqual(['l[].go', 'l[].r'])
    expect(bindings.conds).toEqual(['l[].on'])
    expect(bindings.lists).toEqual(['l'])
  })

  it('gives bound value/checked an undefined default and a NOOP onChange when there is none', async () => {
    const { tsx } = compileSnippet(
      '<input value="{{ q }}" sc-camel-on-input="{{ i }}"><input value="{{ q }}" sc-camel-on-change="{{ c }}"><input type="checkbox" checked="{{ k }}">',
    )
    const body = bodyOf(tsx)
    expect(body).toContain('<input value={$v.q === undefined ? "" : $v.q} onInput={$v.i} onChange={NOOP} />')
    expect(body).toContain('<input value={$v.q === undefined ? "" : $v.q} onChange={$v.c} />')
    expect(body).toContain('type="checkbox" checked={$v.k === undefined ? false : $v.k} onChange={NOOP}')
    const html = '<input value="{{ q }}" sc-camel-on-input="{{ i }}">'
    expect(await same(html, {})).toBe('<input value=""/>')
    expect(await same(html, { q: 'abc' })).toBe('<input value="abc"/>')
  })

  it('keeps a whole binding raw and joins mixed attributes with String(x ?? "")', async () => {
    const html = '<a title="{{ t }}" href="/x?a={{ a }}&amp;b={{ b }}" data-n="{{ n }}"></a>'
    expect(await same(html, { t: 'T', a: 1, b: null, n: 0 })).toBe(
      '<a title="T" href="/x?a=1&amp;b=" data-n="0"></a>',
    )
    expect(await same(html, { t: undefined })).toBe('<a href="/x?a=&amp;b="></a>')
  })

  it('escapes backticks, backslashes and ${ in mixed attribute templates', () => {
    const { tsx } = compileSnippet('<a title="a`b\\c${x}{{ v }}"></a>')
    expect(bodyOf(tsx)).toContain('title={`a\\`b\\\\c\\${x}${m($v.v)}`}')
  })

  it('fails the build for unknown hyphenated attributes, string handlers and unbundled x-imports', () => {
    expect(() => compileSnippet('<div foo-bar="1"></div>')).toThrow(CompileError)
    expect(() => compileSnippet('<div onclick="alert(1)"></div>')).toThrow(/whole/)
    expect(() => compileSnippet('<div ref="x"></div>')).toThrow(/whole/)
    expect(() => compileSnippet('<x-import from="a"></x-import>')).toThrow(/not a bundled resource/)
    expect(() => compileSnippet('<dc-import name="Other"></dc-import>')).toThrow(/not supported/)
  })

  it('passes hint-* attributes other than hint-size through like the runtime', () => {
    const { tsx } = compileSnippet('<div hint-size="1,2" hint-role="x"></div>')
    expect(bodyOf(tsx)).toBe('<div hint-role="x" />')
  })

  it('rejects a mixed multi-binding that the runtime would misparse as one expression', () => {
    expect(() => compileSnippet('<div title="{{a}}">x</div><sc-if value="{{a}} {{b}}"></sc-if>')).toThrow(
      /misparses/,
    )
  })
})

describe('style attribute', () => {
  it('hoists static styles as frozen objects with source key order, camelCases vendor props, dedupes', () => {
    const { tsx } = compileSnippet(
      '<div style="-webkit-font-smoothing:antialiased;height:100vh;color:red;height:50px;"></div><span style="-webkit-font-smoothing:antialiased;height:100vh;color:red;height:50px;"></span>',
    )
    expect(tsx).toContain(
      'const S0 = Object.freeze({ WebkitFontSmoothing: "antialiased", height: "50px", color: "red" }) as CSSProperties',
    )
    expect(tsx.match(/const S\d+ =/g)).toHaveLength(1)
    expect(bodyOf(tsx)).toBe('<div style={S0} />\n<span style={S0} />')
  })

  it('matches cssToObj for odd declarations (colons in values, empty parts, whitespace)', async () => {
    const css =
      " background : url(data:image/png;base64,AAA) ; ;color:red;; font-family:'A B',sans-serif ;bad"
    const html = `<div style="${css.replace(/"/g, '&quot;')}"></div>`
    const { tsx } = compileSnippet(html)
    const m = tsx.match(/const S0 = Object\.freeze\((.*)\) as CSSProperties/)
    expect(m).not.toBeNull()
    expect(Object.entries(new Function(`return (${m![1]})`)())).toEqual(Object.entries(cssToObj(css)))
  })

  it('wraps whole-value bindings in css() and mixed values in css(template) with String(x ?? "")', async () => {
    const { tsx } = compileSnippet(
      '<div style="{{ s }}"></div><div style="color:{{ c }};width:{{ w }}"></div>',
    )
    expect(bodyOf(tsx)).toBe(
      '<div style={css($v.s)} />\n<div style={css(`color:${m($v.c)};width:${m($v.w)}`)} />',
    )
    const html = '<div style="{{ s }}"></div><div style="color:{{ c }};width:{{ w }}"></div>'
    expect(await same(html, { s: 'color:red;margin:0', c: 'blue', w: undefined })).toBe(
      '<div style="color:red;margin:0"></div><div style="color:blue"></div>',
    )
    expect(await same(html, { s: { color: 'green', zIndex: 3 }, c: 0, w: '1px' })).toBe(
      '<div style="color:green;z-index:3"></div><div style="color:0;width:1px"></div>',
    )
    expect(await same(html, {})).toBe('<div></div><div></div>')
  })

  it('keeps the key order of a style object returned from vals', async () => {
    const html = '<div style="{{ s }}"></div>'
    expect(await same(html, { s: { zIndex: 1, color: 'red', background: 'blue' } })).toBe(
      '<div style="z-index:1;color:red;background:blue"></div>',
    )
  })
})

describe('sc-if and sc-for', () => {
  it('uses JS truthiness: [] and "0" are truthy', async () => {
    const html = '<sc-if value="{{ v }}">yes</sc-if>'
    for (const [v, out] of [
      [[], 'yes'],
      ['0', 'yes'],
      [0, ''],
      ['', ''],
      [null, ''],
      [undefined, ''],
      [1, 'yes'],
      [{}, 'yes'],
    ] as const) {
      expect(await same(html, { v })).toBe(out)
    }
  })

  it('renders non-arrays as empty lists', async () => {
    const html = '<sc-for list="{{ l }}" as="x"><i>{{ x }}</i></sc-for>'
    for (const l of [undefined, null, 'abc', 5, {}]) expect(await same(html, { l })).toBe('')
    expect(await same(html, { l: ['a', 'b'] })).toBe(
      '<i><span class="sc-interp">a</span></i><i><span class="sc-interp">b</span></i>',
    )
  })

  it('mangles loop variables per depth and resolves shadowed as-names to the innermost loop', async () => {
    const html =
      '<sc-for list="{{ rows }}" as="a"><b>{{ a.name }}</b><sc-for list="{{ a.kids }}" as="a"><i>{{ a.name }}</i></sc-for><u>{{ a.name }}</u></sc-for>'
    const { tsx, bindings } = compileSnippet(html)
    expect(tsx).toContain('$L1_a')
    expect(tsx).toContain('$L2_a')
    expect(bindings.lists).toEqual(['rows', 'rows[].kids'])
    expect(bindings.paths).toEqual(['rows', 'rows[].kids', 'rows[].kids[].name', 'rows[].name'])
    const vals = {
      rows: [
        { name: 'R1', kids: [{ name: 'K1a' }, { name: 'K1b' }] },
        { name: 'R2', kids: [] },
      ],
    }
    const out = await same(html, vals)
    expect(out.replace(/<span class="sc-interp">|<\/span>/g, '')).toBe(
      '<b>R1</b><i>K1a</i><i>K1b</i><u>R1</u><b>R2</b><u>R2</u>',
    )
  })

  it('does not let a loop variable shadow a root val of the same name outside the loop', async () => {
    const html = '<sc-for list="{{ l }}" as="k"><p>{{ k }}</p></sc-for><q>{{ k }}</q>'
    expect(await same(html, { l: ['x'], k: 'ROOT' })).toBe(
      '<p><span class="sc-interp">x</span></p><q><span class="sc-interp">ROOT</span></q>',
    )
  })

  it('treats a loop var named like a val as the loop item and supports $index', async () => {
    const html = '<sc-for list="{{ l }}" as="v"><p>{{ v.n }}{{ $index }}</p></sc-for>'
    expect(await same(html, { l: [{ n: 'a' }, { n: 'b' }], v: { n: 'ROOT' } })).toBe(
      '<p><span class="sc-interp">a</span><span class="sc-interp">0</span></p><p><span class="sc-interp">b</span><span class="sc-interp">1</span></p>',
    )
  })

  it('nests sc-if inside sc-for inside sc-if', async () => {
    const html =
      '<sc-if value="{{ on }}"><sc-for list="{{ l }}" as="x"><sc-if value="{{ x.ok }}"><s>{{ x.t }}</s></sc-if></sc-for></sc-if>'
    expect(
      await same(html, {
        on: true,
        l: [
          { ok: true, t: 'a' },
          { ok: false, t: 'b' },
          { ok: 1, t: 'c' },
        ],
      }),
    ).toBe('<s><span class="sc-interp">a</span></s><s><span class="sc-interp">c</span></s>')
    expect(await same(html, { on: false, l: [{ ok: true, t: 'a' }] })).toBe('')
  })
})

describe('expression grammar', () => {
  it('accepts IDENT(.IDENT|.DIGITS)* and emits optional chaining', () => {
    const { tsx } = compileSnippet('<i>{{ $x_1.a0.12.b }}</i>')
    expect(tsx).toContain('I($v.$x_1?.a0?.[12]?.b,')
  })

  for (const bad of [
    'a === b',
    '!a',
    'a[0]',
    "'lit'",
    '(a)',
    'a.b()',
    'true',
    'a.0b',
    '1.5',
    'a..b',
    'a-b',
    'a ? b : c',
  ]) {
    it(`fails the build (exit 2) for {{ ${bad} }}`, () => {
      for (const html of [
        `<i>{{ ${bad} }}</i>`,
        `<sc-if value="{{ ${bad} }}">x</sc-if>`,
        `<div title="{{ ${bad} }}"></div>`,
      ]) {
        try {
          compileSnippet(html)
          throw new Error('expected a CompileError')
        } catch (e) {
          expect(e).toBeInstanceOf(CompileError)
          expect((e as CompileError).exit).toBe(2)
        }
      }
    })
  }

  it('--allow-complex-expr emits resolve() calls that match the original resolver, loop scope included', async () => {
    const html =
      '<sc-for list="{{ l }}" as="x"><i data-x="{{ x.n === 2 }}">{{ !x.off }}|{{ x.n !== 1 }}|{{ \'s\' }}|{{ l.0.n }}|{{ x.o[k] }}</i></sc-for>'
    const vals = {
      l: [
        { n: 1, off: false, o: { a: 'A' } },
        { n: 2, off: 1, o: { a: 'B' } },
      ],
      k: 'a',
    }
    const ours = await renderSnippet(html, vals, { allowComplexExpr: true })
    expect(ours).toBe(referenceMarkup(html, vals).html)
    expect(ours).toContain('data-x="true"')
    expect(compileSnippet('<i>{{ a === b }}</i>', { allowComplexExpr: true }).tsx).toContain(
      'R($v, "a === b")',
    )
  })
})

describe('tpl ids', () => {
  const html =
    '<helmet><link rel="x"><style>a{}</style></helmet>\n<div><sc-if value="{{ a }}"><p>x</p></sc-if><sc-for list="{{ l }}" as="i"><span><b>1</b></span></sc-for></div><i></i>'

  it('numbers every element pre-order, sc-if/sc-for/sc-helmet and the helmet children included', () => {
    const { nodes, tplCount } = parseTemplate(html)
    const seen: [string, number][] = []
    const visit = (ns: typeof nodes) =>
      ns.forEach((n) => {
        if (n.kind === 'el') {
          seen.push([n.tag, n.tpl])
          visit(n.children)
        }
      })
    visit(nodes)
    expect(seen).toEqual([
      ['sc-helmet', 0],
      ['link', 1],
      ['style', 2],
      ['div', 3],
      ['sc-if', 4],
      ['p', 5],
      ['sc-for', 6],
      ['span', 7],
      ['b', 8],
      ['i', 9],
    ])
    expect(tplCount).toBe(10)
  })

  it('emits data-dc-tpl first on every emitted element when asked, and matches the reference runtime', async () => {
    const { tsx } = compileSnippet(html, { tplIds: true })
    expect(bodyOf(tsx)).toContain('<div data-dc-tpl="3">')
    expect(bodyOf(tsx)).toContain('<p data-dc-tpl="5">')
    expect(bodyOf(tsx)).toContain('<i data-dc-tpl="9" />')
    expect(await same(html, { a: true, l: [1, 2] }, true)).toBe(
      '<div data-dc-tpl="3"><p data-dc-tpl="5">x</p><span data-dc-tpl="7"><b data-dc-tpl="8">1</b></span><span data-dc-tpl="7"><b data-dc-tpl="8">1</b></span></div><i data-dc-tpl="9"></i>',
    )
  })

  it('uses the same parse as the runtime: helmet is renamed, camelCase attributes are encoded', () => {
    const { nodes } = parseTemplate('<helmet></helmet><svg viewBox="0 0 1 1"></svg>')
    expect((nodes[0] as any).tag).toBe('sc-helmet')
    expect((nodes[1] as any).attrs[0].name).toBe('sc-camel-view-box')
  })
})

describe('helmet', () => {
  it('is never emitted, and neither are its children', () => {
    const { tsx } = compileSnippet('<helmet><style>a{}</style></helmet><div></div>')
    expect(tsx).not.toContain('helmet')
    expect(tsx).not.toContain('style>')
    expect(bodyOf(tsx)).toBe('<div />')
  })
})

describe('patch layer', () => {
  const cfg = (over: Partial<PatchConfig>): PatchConfig => ({
    hrefMap: {},
    hrefMapDv: null,
    copyEntries: [],
    ops: [],
    headDrops: [],
    dvIds: [],
    sha: '',
    ...over,
  })
  const fresh = (html: string) => parseTemplate(html).nodes
  const emit = (nodes: ReturnType<typeof fresh>) =>
    new Emitter({ page: 't', tplIds: false, allowComplexExpr: false }).emit(nodes, [], {
      slug: 't',
      route: '/t',
      name: 'T',
      variant: 'prod',
      tplCount: 0,
    }).tsx

  it('rewrites design hrefs through the href map, including the #emergency variant', () => {
    const nodes = fresh(
      '<a href="Oasis%20Settings.dc.html">a</a><a href="Oasis%20Settings.dc.html#emergency">b</a><a href="https://x.test/">c</a>',
    )
    applyPatches(
      nodes,
      cfg({
        hrefMap: {
          'Oasis%20Settings.dc.html': '/settings',
          'Oasis%20Settings.dc.html#emergency': '/settings#emergency',
        },
      }),
      't',
    )
    const tsx = emit(nodes)
    expect(tsx).toContain('<a href="/settings">')
    expect(tsx).toContain('<a href="/settings#emergency">')
    expect(tsx).toContain('<a href="https://x.test/">')
  })

  it('refuses a design-file href that is not in the map (exit 3)', () => {
    try {
      applyPatches(fresh('<a href="Oasis%20Other.dc.html">a</a>'), cfg({}), 't')
      throw new Error('expected failure')
    } catch (e) {
      expect(e).toBeInstanceOf(CompileError)
      expect((e as CompileError).exit).toBe(3)
    }
  })

  it('applies ops by source tpl id and fails the build when a guard does not match', () => {
    const html = '<div><span>Rafael M.</span><a href="x.dc.html">go</a></div>'
    const nodes = fresh(html)
    applyPatches(
      nodes,
      cfg({
        hrefMap: { 'x.dc.html': '/x' },
        ops: [
          {
            op: 'wrap-if',
            tpl: 1,
            expectTag: 'span',
            expectTextStarts: 'Rafael',
            cond: 'me.isAdmin',
            dv: 'DV-T1',
          },
          {
            op: 'replace-text',
            tpl: 1,
            expectTag: 'span',
            expect: 'Rafael M.',
            with: '{{= me.name }}',
            dv: 'DV-T1',
          },
        ],
      }),
      't',
    )
    const tsx = emit(nodes)
    expect(tsx).toContain('{$v.me?.isAdmin ? (')
    expect(tsx).toContain('{$v.me?.name}')
    expect(tsx).not.toContain('sc-interp')
    const bad = (op: any) => () =>
      applyPatches(fresh(html), cfg({ hrefMap: { 'x.dc.html': '/x' }, ops: [op] }), 't')
    for (const op of [
      { op: 'replace-text', tpl: 1, expect: 'Someone else', with: 'x' },
      { op: 'replace-text', tpl: 99, expect: 'x', with: 'x' },
      { op: 'wrap-if', tpl: 1, expectTag: 'div', cond: 'a' },
      { op: 'rewrite-href', tpl: 2, expect: 'nope.dc.html', to: '/y' },
      { op: 'wrap-if', tpl: 1, cond: 'a b' },
    ]) {
      try {
        bad(op)()
        throw new Error('expected failure for ' + JSON.stringify(op))
      } catch (e) {
        expect(e).toBeInstanceOf(CompileError)
        expect((e as CompileError).exit).toBe(3)
      }
    }
  })

  it('raw {{= }} interpolation is only legal in patch-supplied text', () => {
    expect(() => compileSnippet('<i>{{= a }}</i>')).toThrow(CompileError)
  })

  it('copy-map replaces static text and attributes with an exact-count guard', () => {
    const nodes = fresh('<p title="WhatsApp">via WhatsApp</p><p>{{ WhatsApp }} WhatsApp</p>')
    const entry = {
      id: 'c1',
      page: 't',
      scope: 'template' as const,
      from: 'WhatsApp',
      to: 'SMS',
      count: 3,
      dv: 'DV-T2',
    }
    applyCopyToTree(nodes, [entry])
    const tsx = emit(nodes)
    expect(tsx).toContain('title="SMS"')
    expect(tsx).toContain('{"via SMS"}')
    expect(tsx).toContain('{" SMS"}')
    expect(tsx).toContain('$v.WhatsApp')
    expect(() => applyCopyToTree(fresh('<p>WhatsApp</p>'), [{ ...entry, count: 2 }])).toThrow(/expected 2/)
    expect(applyCopy('a WhatsApp b', [{ ...entry, scope: 'logic', count: 1 }], 'logic')).toBe('a SMS b')
    expect(() => applyCopy('x', [{ ...entry, scope: 'logic', count: 1 }], 'logic')).toThrow(CompileError)
  })

  it('copy-map replacements come from site.config.json: toConfig (one string) and toFormat (placeholders)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-copy-to-'))
    fs.writeFileSync(
      path.join(dir, 'site.config.json'),
      JSON.stringify({ contact: { smsE164: '+18623885827', smsDisplay: '862-388-5827', phoneE164: '+12015986304' } }),
    )
    const e = { id: 'c', to: '' }
    expect(resolveCopyTo(dir, { ...e, toConfig: 'contact.smsDisplay' })).toBe('862-388-5827')
    expect(resolveCopyTo(dir, { ...e, toFormat: 'sms:${contact.smsE164}' })).toBe('sms:+18623885827')
    expect(resolveCopyTo(dir, { ...e, toFormat: 'Text ${contact.smsDisplay} or call ${contact.phoneE164}' })).toBe(
      'Text 862-388-5827 or call +12015986304',
    )
    expect(resolveCopyTo(dir, { ...e, to: 'literal' })).toBe('literal')
    expect(() => resolveCopyTo(dir, { ...e, toFormat: 'sms:${contact.nope}' })).toThrow(/no string at contact.nope/)
    expect(() => resolveCopyTo(dir, { ...e, toFormat: 'no placeholder' })).toThrow(/no \$\{config.path\} placeholder/)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('determinism', () => {
  it('compiles the same input to identical bytes', () => {
    const { extractedDir } = fixtureExtracted()
    const html = fs.readFileSync(path.join(extractedDir, 'payments/template.html'), 'utf8')
    const a = compileSnippet(html)
    const b = compileSnippet(html)
    expect(a.tsx).toBe(b.tsx)
    expect(JSON.stringify(a.bindings)).toBe(JSON.stringify(b.bindings))
  })
})

describe('style-<pseudo> attributes (createPseudoSheet)', () => {
  it('numbers scpN classes by first use in walk order, caches identical pairs and appends to the class', async () => {
    const html =
      '<div class="a" style-hover="color:red"><span style-hover="color:red"></span><i style-focus="outline:none" style-hover="x:1 !important" class="{{ c }}"></i></div>' +
      '<b style-before="content:\'*\'"></b><u style-active="color:blue"></u>'
    const { tsx, pseudo } = compileSnippet(html)
    const body = bodyOf(tsx)
    expect(body).toContain('<div className="a scp0">')
    expect(body).toContain('<span className="scp0" />')
    expect(body).toContain('className={pc($v.c, "scp1 scp2")}')
    expect(body).toContain('<b className="scp3" />')
    expect(body).toContain('<u className="scp4" />')
    const ref = referenceMarkup(html, { c: 'z' })
    expect(await renderSnippet(html, { c: 'z' })).toBe(ref.html)
    expect(pseudo.rules()).toEqual(ref.rules)
    expect(pseudo.rules()).toEqual([
      '.scp0:hover{color:red !important}',
      '.scp1:focus{outline:none !important}',
      '.scp2:hover{x:1 !important}',
      ".scp3::before{content:'*'}",
      '.scp4:active{color:blue !important}',
    ])
    expect(await renderSnippet(html, { c: '' })).toBe(referenceMarkup(html, { c: '' }).html)
    expect(await renderSnippet(html, {})).toBe(referenceMarkup(html, {}).html)
  })

  it('uses base-36 class numbers past 36 rules, like the runtime', () => {
    const html = Array.from({ length: 40 }, (_, i) => `<i style-hover="w:${i}px"></i>`).join('')
    const { pseudo } = compileSnippet(html)
    const ref = referenceMarkup(html, {})
    expect(pseudo.rules()).toEqual(ref.rules)
    expect(pseudo.rules()[36]).toBe('.scp10:hover{w:36px !important}')
  })
})

describe('x-import', () => {
  const wrapper = (body: string) =>
    "import * as React from 'react'\nimport { runImport } from '@/dc/ximport'\nexport const entry = runImport('/assets/widget.js', React, function (React, module, exports, require) {\n" +
    body +
    '\n})\n'
  const WIDGET =
    "module.exports = { Hello: function (p) { return React.createElement('b', { 'data-k': p.kind, className: p.class }, p.greeting, p.children) } };\n" +
    "window.GlobalWidget = function (p) { return React.createElement('u', null, p.label) };"
  const imports = new Map([['/assets/widget.js', './imports/widget.js']])
  const entryFor = async () => {
    const mod = await import(/* @vite-ignore */ path.join(tmpDir, 'xi-entry.mjs'))
    return mod.entry
  }
  beforeAll(() => {
    // the prerender shims provide window; the import scripts assign globals to it
    ;(globalThis as any).window ??= globalThis
    fs.mkdirSync(tmpDir, { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, 'xi-entry.mjs'),
      wrapper(WIDGET).replace("'@/dc/ximport'", JSON.stringify(path.join(root, 'src/dc/ximport.ts'))),
    )
  })

  it('renders the component inside div.sc-host-x with display:contents, props and children like walkXImport', async () => {
    const html =
      '<x-import from="/assets/widget.js" component="Hello" greeting="{{ g }}" data-kind="{{ k }}" kind="static" class="c" hint-size="1,2" style-hover="color:red"><i>{{ g }}</i> tail</x-import>'
    const entry = await entryFor()
    const ref = referenceMarkup(html, { g: 'hi', k: 'k' }, false, new Map([['/assets/widget.js', entry]]))
    const ours = await renderSnippet(
      html,
      { g: 'hi', k: 'k' },
      { imports },
      { 'imports/widget.js': wrapper(WIDGET) },
    )
    expect(ours).toBe(ref.html)
    expect(ours).toBe(
      '<div class="sc-host-x" style="display:contents"><b data-k="static" class="c">hi<i><span class="sc-interp">hi</span></i> tail</b></div>',
    )
    expect(ref.rules).toEqual(['.scp0:hover{color:red !important}'])
  })

  it('keeps only the positioning part of the style attribute on the wrapper, stamps the tpl id in parity', async () => {
    const html =
      '<x-import from="/assets/widget.js" component="Hello" greeting="x" style="position:absolute;color:red;top:{{ t }}"></x-import>'
    const entry = await entryFor()
    const ours = await renderSnippet(
      html,
      { t: '4px' },
      { imports, tplIds: true },
      { 'imports/widget.js': wrapper(WIDGET) },
    )
    expect(ours).toBe(referenceMarkup(html, { t: '4px' }, true, new Map([['/assets/widget.js', entry]])).html)
    expect(ours).toBe(
      '<div class="sc-host-x" data-dc-tpl="0" style="position:absolute;top:4px"><b>x</b></div>',
    )
  })

  it('renders the runtime placeholder for a missing export, a bindable from, and resolves window globals', async () => {
    const entry = await entryFor()
    const refImports = new Map([['/assets/widget.js', entry]])
    const files = { 'imports/widget.js': wrapper(WIDGET) }
    for (const html of [
      '<x-import from="/assets/widget.js" component="Nope" hint-size="10px,20px"></x-import>',
      '<x-import from="/assets/widget.js" component="Hello {{ x }}"></x-import>',
      '<x-import from="/assets/widget.js" component-from-global-scope="GlobalWidget" label="L"></x-import>',
      '<x-import component-from-global-scope="GlobalWidget" label="G"></x-import>',
      '<x-import component-from-global-scope="my-element" label="G"></x-import>',
    ]) {
      const ours = await renderSnippet(html, { x: 1 }, { imports }, files)
      expect(ours, html).toBe(referenceMarkup(html, { x: 1 }, false, refImports).html)
    }
    const missing = await renderSnippet(
      '<x-import from="/assets/widget.js" component="Nope" hint-size="10px,20px"></x-import>',
      {},
      { imports },
      files,
    )
    expect(missing).toContain('class="sc-placeholder"')
    expect(missing).toContain('Nope: no export named &quot;Nope&quot;')
    expect(missing).toContain('width:10px;height:20px')
    const bindable = compileSnippet('<x-import from="{{ u }}" component="Hello"></x-import>', { imports })
    expect(bindable.tsx).toContain('urlBindable: true')
    expect(
      await renderSnippet('<x-import from="{{ u }}" component="Hello"></x-import>', {}, { imports }, files),
    ).toContain('module URLs are resolved at parse time')
  })

  it('expands the self-closing form and records the bindings', () => {
    const { tsx, bindings } = compileSnippet(
      '<p><x-import from="/assets/widget.js" component="Hello" greeting="{{ g }}"/><s>after</s></p>',
      { imports },
    )
    expect(bodyOf(tsx)).toContain('<s>\n    {"after"}\n  </s>')
    expect(bindings.ximports).toEqual([
      { tpl: 1, url: '/assets/widget.js', component: 'Hello', globalName: '' },
    ])
    expect(bindings.roots).toEqual(['g'])
    expect(tsx).toContain('import * as $M0 from "./imports/widget.js"')
  })
})
