// Assembles the final HTML document of a page. The <head> order follows the probe of the original: the design's
// charset and viewport first, then the SEO slots, the helmet's links, the font preloads, the page stylesheet
// (atomics / pseudo / FULL_PAGE_CSS / helmet sheets in the runtime's order) and the JSON-LD data block. The body is
// <div id="dc-root"> with the prerendered markup, then the theme patch script, the hours script and the hydration
// bundle, all external files (no executable inline script).
import type { CompiledPageMeta } from '../dc-compile/compile'
import type { PageSeo } from './seo'

export interface DocumentInput {
  meta: CompiledPageMeta
  lang: string
  siteName: string
  seo: PageSeo
  /** viewport content; null keeps the design's own viewport meta (from head.html) */
  viewport: string | null
  /** hashed URLs */
  cssHref: string
  bundleHref: string | null
  themeHref: string | null
  hoursHref: string | null
  fontPreloads: string[]
  icons: { rel: string; href: string; type?: string; sizes?: string }[]
  jsonLd: Record<string, unknown> | null
  bodyHtml: string
  /** parity variant, static pages: the serialised renderVals, and the ready flag baked in */
  parityVals: unknown | undefined
  parityStatic: boolean
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/** JSON inside a <script> data block must not be able to close the element. */
const jsonBlock = (v: unknown): string => JSON.stringify(v).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--')

export function designViewport(meta: CompiledPageMeta): string | null {
  const m = /<meta\s+name="viewport"\s+content="([^"]*)"/i.exec(meta.headHtml)
  return m ? m[1]! : null
}

export function buildDocument(d: DocumentInput): string {
  const h: string[] = []
  h.push('<meta charset="utf-8">')
  const vp = d.viewport ?? designViewport(d.meta) ?? 'width=device-width, initial-scale=1'
  h.push(`<meta name="viewport" content="${esc(vp)}">`)
  h.push(`<title>${esc(d.seo.title)}</title>`)
  if (d.seo.description) h.push(`<meta name="description" content="${esc(d.seo.description)}">`)
  if (d.seo.noindex) h.push('<meta name="robots" content="noindex">')
  h.push(`<link rel="canonical" href="${esc(d.seo.canonical)}">`)
  h.push(`<meta property="og:type" content="website">`)
  h.push(`<meta property="og:site_name" content="${esc(d.siteName)}">`)
  h.push(`<meta property="og:title" content="${esc(d.seo.title)}">`)
  if (d.seo.description) h.push(`<meta property="og:description" content="${esc(d.seo.description)}">`)
  h.push(`<meta property="og:url" content="${esc(d.seo.canonical)}">`)
  if (d.seo.ogImage) h.push(`<meta property="og:image" content="${esc(d.seo.ogImage)}">`)
  h.push(`<meta name="twitter:card" content="${d.seo.ogImage ? 'summary_large_image' : 'summary'}">`)
  for (const i of d.icons)
    h.push(
      `<link rel="${esc(i.rel)}" href="${esc(i.href)}"${i.type ? ` type="${esc(i.type)}"` : ''}${i.sizes ? ` sizes="${esc(i.sizes)}"` : ''}>`,
    )
  for (const l of d.meta.helmetLinks) {
    const attrs = Object.entries(l.attrs)
      .map(([k, v]) => (v === '' ? ` ${esc(k)}` : ` ${esc(k)}="${esc(v)}"`))
      .join('')
    h.push(`<${l.tag}${attrs}>`)
  }
  for (const f of d.fontPreloads)
    h.push(`<link rel="preload" href="${esc(f)}" as="font" type="font/woff2" crossorigin>`)
  h.push(`<link rel="stylesheet" href="${esc(d.cssHref)}">`)
  if (d.jsonLd) h.push(`<script type="application/ld+json">${jsonBlock(d.jsonLd)}</script>`)

  const b: string[] = []
  b.push(`<div id="dc-root"${d.parityStatic ? ' data-oasis-ready="1"' : ''}>${d.bodyHtml}</div>`)
  if (d.themeHref) b.push(`<script src="${esc(d.themeHref)}"></script>`)
  if (d.parityVals !== undefined)
    b.push(`<script type="application/json" id="__oasis-vals">${jsonBlock(d.parityVals)}</script>`)
  if (d.hoursHref) b.push(`<script src="${esc(d.hoursHref)}" defer></script>`)
  if (d.bundleHref) b.push(`<script src="${esc(d.bundleHref)}" defer></script>`)

  return `<!DOCTYPE html>\n<html lang="${esc(d.lang)}">\n<head>\n${h.join('\n')}\n</head>\n<body>\n${b.join('\n')}\n</body>\n</html>\n`
}

export function notFoundDocument(o: {
  lang: string
  siteName: string
  cssHref: string | null
  homeHref: string
}): string {
  const style = o.cssHref ? `<link rel="stylesheet" href="${esc(o.cssHref)}">` : ''
  return `<!DOCTYPE html>
<html lang="${esc(o.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page not found — ${esc(o.siteName)}</title>
<meta name="robots" content="noindex">
${style}
</head>
<body>
<main id="not-found" style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h1>Page not found</h1>
<p>${esc(o.siteName)}: this page does not exist. <a href="${esc(o.homeHref)}">Back to the home page</a>.</p>
</main>
</body>
</html>
`
}

export function sitemapXml(urls: { loc: string; lastmod?: string }[]): string {
  const items = urls
    .map(
      (u) =>
        `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${esc(u.lastmod)}</lastmod>` : ''}</url>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}\n</urlset>\n`
}

export function robotsTxt(siteUrl: string): string {
  return `User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${siteUrl.replace(/\/+$/, '')}/sitemap.xml\n`
}
