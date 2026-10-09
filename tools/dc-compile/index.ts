import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compilePages } from './compile'
import type { Variant } from './compile'
import { CompileError } from './errors'

const USAGE = `usage: tsx tools/dc-compile/index.ts [--page <slug>|all] [--check] [--variant=prod|parity] [--emit-tpl-ids]
         [--out <dir>] [--pages <file>] [--extracted <dir>] [--allow-complex-expr]
exit codes: 0 ok, 1 --check mismatch, 2 grammar / unknown attribute / unsupported construct, 3 patch guard failed`

export function writeOutputs(outDir: string, files: [string, string | Buffer][]): void {
  for (const [file, data] of files) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, data)
  }
  void outDir
}

function main(argv: string[]): number {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  let page = 'all'
  let check = false
  let variant: Variant = 'prod'
  let tplIds = false
  let out = '.generated'
  let pagesFile: string | undefined
  let extractedDir: string | undefined
  let allowComplexExpr = false
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i]!
    let inline: string | undefined
    const eq = a.indexOf('=')
    if (a.startsWith('--') && eq > 0) {
      inline = a.slice(eq + 1)
      a = a.slice(0, eq)
    }
    const val = () => inline ?? argv[++i]
    switch (a) {
      case '--page':
        page = val() ?? ''
        break
      case '--check':
        check = true
        break
      case '--variant': {
        const v = val()
        if (v !== 'prod' && v !== 'parity')
          throw new CompileError(`--variant must be prod or parity, got ${v}`)
        variant = v
        break
      }
      case '--emit-tpl-ids':
        tplIds = true
        break
      case '--out':
        out = val() ?? ''
        break
      case '--pages':
        pagesFile = val()
        break
      case '--extracted':
        extractedDir = val()
        break
      case '--allow-complex-expr':
        allowComplexExpr = true
        break
      case '--help':
      case '-h':
        console.log(USAGE)
        return 0
      default:
        throw new CompileError(`unknown argument ${a}\n${USAGE}`)
    }
  }
  const outDir = path.resolve(root, out)
  const all = compilePages(
    {
      root,
      variant,
      tplIds,
      allowComplexExpr,
      pagesFile,
      extractedDir: extractedDir ? path.resolve(root, extractedDir) : undefined,
    },
    page === 'all' ? undefined : [page],
  )
  const files: [string, string | Buffer][] = []
  for (const p of all.pages)
    for (const [rel, data] of Object.entries(all.perPage[p.slug]!)) files.push([path.join(outDir, rel), data])
  for (const [rel, data] of Object.entries(all.shared)) files.push([path.join(outDir, rel), data])

  if (check) {
    const bad: string[] = []
    for (const [file, data] of files) {
      const want = Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (!fs.existsSync(file)) bad.push(`missing  ${path.relative(root, file)}`)
      else if (!fs.readFileSync(file).equals(want)) bad.push(`differs  ${path.relative(root, file)}`)
    }
    if (bad.length) {
      console.error(`dc:check FAILED (run \`pnpm dc:compile\` first):\n  ${bad.join('\n  ')}`)
      return 1
    }
    console.log(`dc:check OK (${files.length} files, variant ${variant})`)
    return 0
  }
  writeOutputs(outDir, files)
  const hydrated = all.pages.filter((p) => all.metas[p.slug]!.hydrated).map((p) => p.slug)
  console.log(
    `dc:compile wrote ${files.length} files (variant ${variant}${tplIds || variant === 'parity' ? ', tpl ids' : ''}) -> ${path.relative(root, outDir) || '.'}; hydrated: ${hydrated.join(', ') || 'none'}`,
  )
  return 0
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (e) {
  if (e instanceof CompileError) {
    console.error(`dc-compile: ${e.message}`)
    process.exitCode = e.exit
  } else throw e
}
