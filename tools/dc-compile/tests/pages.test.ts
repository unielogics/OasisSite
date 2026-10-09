/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, it } from 'vitest'
import { compilePages, runtimeCss } from '../compile'
import type { CompileAll } from '../compile'
import type { Bindings } from '../emit'
import { loadPatchConfig, applyPatches, applyCopyToTree } from '../patches'
import { parseTemplate } from '../parse'
import { loadPages } from '../pages'
import { interpret } from './reference'
import { root } from './original-runtime'
import { fixtureExtracted, tmpDir } from './helpers'
import { buildVals } from './vals'
import type { Mode } from './vals'

const { extractedDir, pagesFile } = fixtureExtracted()
const SLUGS = ['operations', 'payments', 'settings'] as const
const opts = {
  root,
  variant: 'prod' as const,
  tplIds: false,
  allowComplexExpr: false,
  extractedDir,
  pagesFile,
}
const outDir = path.join(tmpDir, 'pages-out')
afterAll(() => fs.rmSync(outDir, { recursive: true, force: true }))

const prod: CompileAll = compilePages(opts)
const parity: CompileAll = compilePages({ ...opts, variant: 'parity' })
const text = (v: string | Buffer | undefined): string => (Buffer.isBuffer(v) ? v.toString('utf8') : (v ?? ''))
const read = (...p: string[]) => fs.readFileSync(path.join(extractedDir, ...p), 'utf8')

describe('compile the three fixture pages', () => {
  it('is deterministic: compiling twice gives identical bytes', () => {
    const again = compilePages(opts)
    for (const s of SLUGS) {
      for (const [file, data] of Object.entries(prod.perPage[s]!)) {
        expect(text(again.perPage[s]![file]), `${s}/${file}`).toBe(text(data))
      }
    }
    expect(Object.keys(again.shared)).toEqual(Object.keys(prod.shared))
  })

  it('numbers elements like the runtime stamp(): tplCount equals an independent tag count', () => {
    for (const s of SLUGS) {
      const html = read(s, 'template.html')
      const tags = html
        .replace(/<style>[\s\S]*?<\/style>/g, '<style></style>')
        .match(/<[A-Za-z][A-Za-z0-9-]*/g)!.length
      expect(prod.tplCounts[s], s).toBe(tags)
    }
  })

  it('emits data-dc-tpl on every emitted element in the parity variant, numbered from the source', () => {
    for (const s of SLUGS) {
      const html = read(s, 'template.html')
      const control = (html.match(/<sc-if[\s>]/g) ?? []).length + (html.match(/<sc-for[\s>]/g) ?? []).length
      const helmetSubtree = 5 // helmet, 2 x link, 2 x style
      const tsx = text(parity.perPage[s]![`${s}.tsx`])
      const ids = [...tsx.matchAll(/data-dc-tpl="(\d+)"/g)].map((m) => Number(m[1]))
      expect(ids.length, s).toBe(parity.tplCounts[s]! - control - helmetSubtree)
      expect(new Set(ids).size, s).toBe(ids.length)
      expect(Math.max(...ids), s).toBeLessThan(parity.tplCounts[s]!)
      expect(text(prod.perPage[s]![`${s}.tsx`])).not.toContain('data-dc-tpl')
    }
  })

  it('never emits helmet, sc-* elements, raw {{ }} markers or design-file hrefs', () => {
    for (const s of SLUGS) {
      const tsx = text(prod.perPage[s]![`${s}.tsx`])
      expect(tsx).not.toMatch(/<\/?sc-/)
      expect(tsx).not.toMatch(/helmet/i)
      expect(tsx).not.toContain('{{')
      expect(tsx).not.toMatch(/\.dc\.html/)
      expect(tsx).toContain('href="/payments"')
    }
  })

  it('decides hydration from handlers and state: all three dashboard fixtures need a bundle', () => {
    for (const s of SLUGS) {
      expect(prod.metas[s]!.hydrated, s).toBe(true)
      expect(prod.metas[s]!.hydratedBecause.join(' ')).toMatch(/handler/)
    }
  })
})

describe('css, fonts and logic modules', () => {
  it('page CSS is FULL_PAGE_CSS (unless $preview) followed by the helmet sheets verbatim and in order', () => {
    const rt = runtimeCss(extractedDir)
    expect(rt.fullPage).toBe('html,body{height:100%;margin:0}#dc-root,#dc-root>.sc-host{height:100%}')
    expect(rt.atomics.startsWith('.fx{display:flex}')).toBe(true)
    expect(rt.base).toContain('.sc-placeholder{')
    for (const s of SLUGS) {
      const fonts = read(s, 'helmet.0.css')
      const global = read(s, 'helmet.1.css')
      const css = text(prod.perPage[s]![`${s}.page.css`])
      const kinds = prod.metas[s]!.cssParts.map((p) => p.kind)
      if (s === 'operations') {
        expect(css).toBe(fonts + '\n' + global)
        expect(kinds).toEqual(['helmet-fontface', 'helmet'])
      } else {
        expect(css).toBe(rt.fullPage + '\n' + fonts + '\n' + global)
        expect(kinds).toEqual(['full-page', 'helmet-fontface', 'helmet'])
      }
      expect(css.match(/@font-face/g)).toHaveLength(42)
      expect(css).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/)
      expect(prod.metas[s]!.fontFiles).toHaveLength(9)
      for (const f of prod.metas[s]!.fontFiles)
        expect(fs.existsSync(path.join(extractedDir, f.slice(1)))).toBe(true)
      expect(prod.metas[s]!.pseudoRules).toEqual([])
    }
  })

  it('the logic module is the original script byte for byte, wrapped as an ES module without eval', async () => {
    fs.mkdirSync(outDir, { recursive: true })
    for (const s of SLUGS) {
      const js = text(prod.perPage[s]![`${s}.logic.js`])
      expect(js).toContain(read(s, 'logic.original.js'))
      expect(js).not.toContain('new Function')
      expect(js).toMatch(/^import \* as React from 'react'$/m)
      expect(js).toMatch(/^export default /m)
      const file = path.join(outDir, `${s}.logic.js`)
      fs.writeFileSync(
        file,
        js.replace("'@/dc/DCLogic'", JSON.stringify(path.join(root, 'src/dc/DCLogic.ts'))),
      )
      const mod = await import(/* @vite-ignore */ file)
      expect(typeof mod.default).toBe('function')
      expect(mod.default.name).toBe('Component')
    }
  })
})

describe('bindings', () => {
  it('lists every root identifier and loop-scoped dotted path', () => {
    for (const s of SLUGS) {
      const b = JSON.parse(text(prod.perPage[s]![`${s}.bindings.json`])) as Bindings
      expect(b.page).toBe(s)
      expect(b.roots.length).toBeGreaterThan(20)
      expect(b.roots).toEqual([...b.roots].sort())
      for (const r of b.roots)
        expect(b.paths.some((p) => p === r || p.startsWith(r + '.') || p.startsWith(r + '['))).toBe(true)
      for (const l of b.lists) expect(b.paths).toContain(l)
      expect(b.paths.some((p) => p.includes('[]'))).toBe(true)
      expect(b.ximports).toEqual([])
    }
    const set = JSON.parse(text(prod.perPage.settings![`settings.bindings.json`])) as Bindings
    expect(set.lists).toContain('dr.effGroups[].rows')
  })
})

describe('compiled pages vs the original runtime rules', () => {
  const modes: Mode[] = ['truthy', 'falsy', 'empty']
  for (const s of SLUGS) {
    for (const variant of ['prod', 'parity'] as const) {
      it(`${s} (${variant}): renders without exceptions and equals the reference interpreter in all vals modes`, async () => {
        const out = (variant === 'prod' ? prod : parity).perPage[s]!
        fs.mkdirSync(outDir, { recursive: true })
        const file = path.join(outDir, `${s}.${variant}.tsx`)
        fs.writeFileSync(file, text(out[`${s}.tsx`]))
        const mod = await import(/* @vite-ignore */ file)

        const cfg = loadPatchConfig(root, s)
        const { nodes } = parseTemplate(read(s, 'template.html'))
        applyPatches(nodes, cfg, s)
        applyCopyToTree(nodes, cfg.copyEntries)
        const bindings = JSON.parse(text(out[`${s}.bindings.json`])) as Bindings

        const markups = new Set<string>()
        for (const mode of modes) {
          const vals = buildVals(bindings, mode)
          // React's server renderer writes the prop name as given; browsers lowercase it, so compare lowercased.
          const norm = (h: string) => h.replace(/ inputMode=/g, ' inputmode=')
          const ours = norm(renderToStaticMarkup(mod.default(vals, { name: s })))
          const ref = norm(renderToStaticMarkup(interpret(nodes, vals, variant === 'parity') as any))
          expect(ours.length).toBeGreaterThan(1000)
          expect(ours === ref, `${s} ${variant} ${mode}`).toBe(true)
          markups.add(ours)
        }
        expect(markups.size).toBe(3)
      })
    }
  }
})

describe('typecheck of the compiler output', () => {
  it(
    'compiles cleanly under the project tsconfig (strict), prod and parity variants',
    { timeout: 180_000 },
    () => {
      const cfg = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile)
      const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root)
      const options: ts.CompilerOptions = {
        ...parsed.options,
        noEmit: true,
        incremental: false,
        tsBuildInfoFile: undefined,
      }
      const virtual = new Map<string, string>()
      for (const s of SLUGS) {
        for (const [name, v] of [
          ['prod', prod],
          ['parity', parity],
        ] as const) {
          for (const f of [`${s}.tsx`, `${s}.logic.d.ts`])
            virtual.set(path.join(root, '.virtual', name, f), text(v.perPage[s]![f]))
        }
      }
      const host = ts.createCompilerHost(options)
      const { fileExists, readFile, getSourceFile } = host
      host.fileExists = (f) => virtual.has(f) || fileExists.call(host, f)
      host.readFile = (f) => virtual.get(f) ?? readFile.call(host, f)
      host.getSourceFile = (f, lang, onErr, create) =>
        virtual.has(f)
          ? ts.createSourceFile(f, virtual.get(f)!, lang)
          : getSourceFile.call(host, f, lang, onErr, create)
      const program = ts.createProgram([...virtual.keys()], options, host)
      const diags = ts.getPreEmitDiagnostics(program).map((d) => {
        const pos = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null
        return `${d.file ? path.relative(root, d.file.fileName) : ''}${pos ? `:${pos.line + 1}` : ''} ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`
      })
      expect(diags).toEqual([])
    },
  )
})

describe('CLI', () => {
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'tools/dc-compile/index.ts',
        '--pages',
        pagesFile,
        '--extracted',
        path.relative(root, extractedDir),
        ...args,
      ],
      {
        cwd: root,
        encoding: 'utf8',
      },
    )

  it('writes the page files and --check passes on them, exit 0', () => {
    const dir = path.join(outDir, 'cli')
    const w = run('--out', path.relative(root, dir))
    expect(w.status, w.stderr).toBe(0)
    expect(w.stdout).toContain('hydrated: operations, payments, settings')
    const r = run('--check', '--out', path.relative(root, dir))
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('dc:check OK')
  })

  it('--check exits 1 when an output is missing', () => {
    const dir = path.join(outDir, 'empty')
    fs.mkdirSync(dir, { recursive: true })
    const r = run('--page', 'payments', '--check', '--out', path.relative(root, dir))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('missing')
  })

  it('exits 2 for bad arguments and unknown pages', () => {
    expect(run('--page', 'nope').status).toBe(2)
    expect(run('--variant=staging').status).toBe(2)
    expect(run('--bogus').status).toBe(2)
  })

  it('--out with --variant=parity writes the data-dc-tpl variant into that directory only', () => {
    const dir = path.join(outDir, 'parity-out')
    const r = run('--page', 'settings', '--variant=parity', '--out', path.relative(root, dir))
    expect(r.status, r.stderr).toBe(0)
    expect(fs.readFileSync(path.join(dir, 'settings.tsx'), 'utf8')).toMatch(/data-dc-tpl="5"/)
    expect(fs.existsSync(path.join(dir, 'operations.tsx'))).toBe(false)
  })
})

describe('pages.json', () => {
  it('validates slugs, routes and uniqueness', () => {
    expect(loadPages(root, pagesFile).pages.map((p) => p.slug)).toEqual([
      'operations',
      'payments',
      'settings',
    ])
    const bad = path.join(outDir, 'bad-pages.json')
    fs.mkdirSync(outDir, { recursive: true })
    for (const [json, msg] of [
      ['[]', /non-empty/],
      ['[{"slug":"A","route":"/","file":"x","name":"n"}]', /kebab-case/],
      ['[{"slug":"a","route":"nope","file":"x","name":"n"}]', /route/],
      [
        '[{"slug":"a","route":"/","file":"x","name":"n"},{"slug":"a","route":"/b","file":"x","name":"n"}]',
        /duplicate slug/,
      ],
      ['[{"slug":"a","route":"/","file":"../x","name":"n"}]', /relative/],
    ] as const) {
      fs.writeFileSync(bad, json)
      expect(() => loadPages(root, path.relative(root, bad))).toThrow(msg)
    }
  })
})
