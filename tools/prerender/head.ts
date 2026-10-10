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

/**
 * The 404 page in the design's tokens (dark theme, the chrome wordmark gradient, Archivo/Hanken Grotesk/JetBrains Mono
 * from the page stylesheet, the design's button). Inline style attributes only (the CSP allows them), no script.
 */
export function notFoundDocument(o: {
  lang: string
  siteName: string
  cssHref: string | null
  homeHref: string
  logoHref?: string | null
  icons?: { rel: string; href: string; type?: string; sizes?: string }[]
}): string {
  const style = o.cssHref ? `<link rel="stylesheet" href="${esc(o.cssHref)}">` : ''
  const icons = (o.icons ?? [])
    .map(
      (i) =>
        `<link rel="${esc(i.rel)}" href="${esc(i.href)}"${i.type ? ` type="${esc(i.type)}"` : ''}${i.sizes ? ` sizes="${esc(i.sizes)}"` : ''}>`,
    )
    .join('\n')
  const logo = o.logoHref
    ? `<a href="${esc(o.homeHref)}" style="display:flex;justify-content:center;"><img src="${esc(o.logoHref)}" alt="${esc(o.siteName)}" style="height:76px;width:auto;display:block;filter:drop-shadow(0 6px 18px rgba(31,182,255,.25));"></a>`
    : ''
  return `<!DOCTYPE html>
<html lang="${esc(o.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Page not found · ${esc(o.siteName)}</title>
<meta name="robots" content="noindex">
${icons}
${style}
</head>
<body style="margin:0;background:#06080A;">
<div id="not-found" data-oa="1" data-theme="dark" style="min-height:100vh;background:var(--bg,#06080A);color:var(--ink,#F2F5F7);font-family:'Hanken Grotesk',system-ui,sans-serif;-webkit-font-smoothing:antialiased;display:flex;flex-direction:column;">
<header style="height:84px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;padding:0 14px;border-bottom:1px solid var(--line2,rgba(255,255,255,.06));"><div></div>${logo}<div></div></header>
<main style="flex:1;max-width:980px;width:100%;margin:0 auto;padding:72px 20px 80px;display:flex;flex-direction:column;align-items:center;text-align:center;">
<div style="font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:700;letter-spacing:.16em;color:var(--accentText,#1FB6FF);text-transform:uppercase;">404 · Not found</div>
<h1 style="margin:22px 0 0;font-family:'Archivo',sans-serif;font-stretch:125%;font-weight:900;font-size:clamp(38px,10.5vw,124px);line-height:.88;letter-spacing:-.03em;text-transform:uppercase;background:var(--chrome,linear-gradient(180deg,#FFFFFF 0%,#DCE3E9 40%,#7C8893 53%,#EEF2F5 64%,#A9B4BE 100%));-webkit-background-clip:text;background-clip:text;color:transparent;">Wrong<br>turn.</h1>
<p style="margin:22px 0 0;max-width:520px;font-size:17px;line-height:1.55;color:var(--ink2,#B7C0C8);">This page does not exist. The whole site lives on one page: the home, membership, the wash, tint, detailing, the experience and how to visit us.</p>
<div style="display:flex;gap:10px;margin-top:28px;flex-wrap:wrap;justify-content:center;">
<a href="${esc(o.homeHref)}" style="display:flex;align-items:center;height:58px;padding:0 24px;border-radius:17px;background:#1FB6FF;color:#00131D;font-weight:800;font-size:16.5px;text-decoration:none;box-shadow:0 12px 34px rgba(31,182,255,.38),inset 0 1px 0 rgba(255,255,255,.55);">Back to the home page</a>
<a href="${esc(o.homeHref)}#/visit" style="display:flex;align-items:center;height:58px;padding:0 22px;border-radius:17px;background:var(--btn2,rgba(255,255,255,.05));border:1px solid var(--line,rgba(255,255,255,.1));color:var(--ink,#F2F5F7);font-weight:700;font-size:16px;text-decoration:none;">Visit us</a>
</div>
</main>
</div>
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
