import fs from 'node:fs'
import path from 'node:path'
import { CompileError } from './errors'

/** One entry of design/pages.json. `file` is relative to design/. */
export interface PageSpec {
  slug: string
  route: string
  file: string
  name: string
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/
const ROUTE = /^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/

export function validatePages(raw: unknown, where = 'pages.json'): PageSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new CompileError(`${where}: expected a non-empty array`)
  const slugs = new Set<string>()
  const routes = new Set<string>()
  const out: PageSpec[] = []
  raw.forEach((p, i) => {
    const e = p as Partial<PageSpec> | null
    const bad = (msg: string): never => {
      throw new CompileError(`${where}[${i}]: ${msg}`)
    }
    if (!e || typeof e !== 'object') bad('not an object')
    for (const k of ['slug', 'route', 'file', 'name'] as const)
      if (typeof e![k] !== 'string' || !e![k]) bad(`${k} must be a non-empty string`)
    if (!SLUG.test(e!.slug!)) bad(`slug ${JSON.stringify(e!.slug)} must be kebab-case`)
    if (!ROUTE.test(e!.route!)) bad(`route ${JSON.stringify(e!.route)} must be "/" or /kebab/segments`)
    if (slugs.has(e!.slug!)) bad(`duplicate slug ${e!.slug}`)
    if (routes.has(e!.route!)) bad(`duplicate route ${e!.route}`)
    if (path.isAbsolute(e!.file!) || e!.file!.split('/').includes('..'))
      bad('file must be relative to design/')
    slugs.add(e!.slug!)
    routes.add(e!.route!)
    out.push({ slug: e!.slug!, route: e!.route!, file: e!.file!, name: e!.name! })
  })
  return out
}

/** Reads design/pages.json (or another list) and resolves `file` against design/. */
export function loadPages(
  root: string,
  file = 'design/pages.json',
): { pages: PageSpec[]; designDir: string } {
  const abs = path.resolve(root, file)
  if (!fs.existsSync(abs)) throw new CompileError(`${file}: not found`)
  const pages = validatePages(JSON.parse(fs.readFileSync(abs, 'utf8')), file)
  return { pages, designDir: path.join(root, 'design') }
}

/** dist path of a route: "/" -> index.html, "/about" -> about/index.html */
export function routeFile(route: string): string {
  return route === '/' ? 'index.html' : `${route.replace(/^\//, '')}/index.html`
}
