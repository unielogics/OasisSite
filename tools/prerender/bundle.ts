// esbuild: one IIFE per hydrated page (React 18.3.1 + the compiled template + the logic class + the import wrappers),
// plus the shared theme and hours scripts. Output is returned in memory; the build hashes and places it.
import path from 'node:path'
import { build } from 'esbuild'
import type { Variant } from '../dc-compile/compile'

export interface BundleRequest {
  root: string
  generatedDir: string
  variant: Variant
  /** per hydrated page: the entry file the build generated under generatedDir/client */
  entries: { name: string; file: string }[]
  defines?: Record<string, string>
  minify?: boolean
}

export interface BundleOutput {
  name: string
  code: string
}

export async function bundleEntries(req: BundleRequest): Promise<BundleOutput[]> {
  if (!req.entries.length) return []
  const result = await build({
    entryPoints: Object.fromEntries(req.entries.map((e) => [e.name, e.file])),
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    minify: req.minify ?? true,
    legalComments: 'none',
    sourcemap: false,
    jsx: 'automatic',
    outdir: path.join(req.root, '.generated', 'out'),
    absWorkingDir: req.root,
    alias: { '@': path.join(req.root, 'src') },
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.OASIS_PARITY': req.variant === 'parity' ? '"1"' : '""',
      ...(req.defines ?? {}),
    },
    logLevel: 'silent',
  })
  const out: BundleOutput[] = []
  for (const f of result.outputFiles) {
    const name = path.basename(f.path).replace(/\.js$/, '')
    out.push({ name, code: f.text })
  }
  if (result.warnings.length) {
    throw new Error(
      'esbuild warnings:\n' +
        result.warnings
          .map((w) => `${w.location?.file ?? ''}:${w.location?.line ?? ''} ${w.text}`)
          .join('\n'),
    )
  }
  return out
}
