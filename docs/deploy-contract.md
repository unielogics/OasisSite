# Deploy contract

What `deploy/scripts/site-deploy.sh` (in the backend's deploy kit) may rely on, and what nginx must do. The site
repo owns the build; the kit owns the host.

## Build

```
pnpm install --frozen-lockfile
SITE_URL=https://oasisautospanj.com SITE_HOURS_JSON="$(curl -fsS http://127.0.0.1:<api>/api/v1/public/hours)" pnpm build
pnpm check:dist            # exit 0 or the release is refused
node scripts/assert-react.mjs --dist dist
```

Node 22 (`.nvmrc`), pnpm 10.34.6 (`packageManager`), no network needed after `pnpm install`. The build is
deterministic for the same inputs (asset hashes are content hashes; nothing is time-stamped unless the design bakes
`Date`, see docs/compiler.md). `pnpm build` takes about 20 s on the t4g.large.

Environment:

| variable          | required | meaning                                                                                                     |
| ----------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `SITE_URL`        | no       | canonical origin (default `site.config.json` `siteUrl`): canonical links, Open Graph, sitemap, robots       |
| `SITE_HOURS_JSON` | no       | body of `GET /api/v1/public/hours`; invalid or unset = committed fallback (Sunday closed) + a build warning |
| `PRERENDER_NOW`   | no       | pins `Date` during the prerender (parity builds only; never set it in production)                           |

## Output (`dist/`)

| path                          | notes                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| `index.html`                  | the `/` page; contains the marker text `Oasis Auto Spa` (`site.config.json` `marker`)                    |
| `<route>/index.html`          | every other route of `design/pages.json`, so `try_files $uri $uri/ =404` serves clean URLs               |
| `404.html`                    | `error_page 404 /404.html`                                                                               |
| `robots.txt`, `sitemap.xml`   | absolute URLs from `SITE_URL`                                                                            |
| `manifest.json`               | every file with its sha256, the pages (route, file, hydrated, bundle), the theme script hash             |
| `assets/<name>.<hash8>.<ext>` | everything else: CSS, fonts, images, JS. Immutable: `Cache-Control: public, max-age=31536000, immutable` |

Nothing else is written at the top level, there are no symlinks, and no file references `localhost`.

HTML must be served with `Cache-Control: no-cache` (it changes on every release while asset names change with
their content). Sizes to expect for the fixture configuration: HTML 35–80 KB per page, CSS ~16 KB per page,
fonts 230 KB in total, one 210–260 KB bundle per hydrated page; a static page ships no JavaScript at all except the
0.5 KB theme script when the design has a theme toggle.

## Content Security Policy

The pages work under `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'
data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self';
object-src 'none'`:

- every `<script>` with executable content is an external file under `/assets/` (`script-src 'self'`); the only
  inline `<script>` elements are data blocks (`type="application/ld+json"`), which the CSP does not execute;
- `style-src 'unsafe-inline'` is needed for the designs' inline `style=""` attributes (the stylesheet itself is a file);
- `connect-src 'self'` covers the hours fetch (`/api/v1/public/hours`, same origin);
- `img-src data:` is for images the design embeds as data URIs (none in the fixtures);
- `manifest.json` records the theme script's sha256 (`themeScript.sha256`) in case a stricter hash-based policy is
  ever wanted; it is not needed with `'self'`.

A `<link rel="preconnect">` to an external font host is kept only if the design's helmet carries it and no
`head.drop` patch removes it; it is not a request, so the CSP does not block it, and the owner decides (DV line).

## nginx expectations (from the plan; the kit owns the templates)

- `root /var/www/site/current; try_files $uri $uri.html $uri/ =404; error_page 404 /404.html;`
- `location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable"; }`
- `location = /api/v1/public/hours { proxy_pass oasis_api; proxy_cache ... 60s; proxy_set_header Cookie ""; }`
- everything else under `/api`, `/hooks`, `/dev-storage` → 404; dotfiles → 404.

`tools/parity/serve-dist.ts` mimics these rules (clean URLs, 404 page, immutable assets, no-cache HTML, the hours
endpoint with a fixture body) for the harness and for `pnpm serve:dist` on port 3301.

## Health

`curl --resolve` of `/` must return 200 with the marker text; `/nope` 404 with the 404 page; `/api/v1/public/hours`
JSON; `www` → 301 to the apex (nginx). `pnpm check:dist` is the pre-release gate: it verifies the layout above,
well-formed HTML with `<html lang>` and a `<title>`, no executable inline script, no `localhost`, every internal
link/script/stylesheet/image/font reference resolving to an emitted file, and no bundle uuid left anywhere.
