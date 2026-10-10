import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { DESIGN_DIR, PAGES, ROOT } from './config'
import { PLACEHOLDER_SIZE, transparentPng } from '../prerender/placeholder'
import { copyMapSwaps } from './copy-swaps'
import { buildBundle } from './serve-original'
import { serializeVals } from './vals-serialize'

/**
 * A stand-in for the real port, used by the self-test: it serves every page's ORIGINAL bundle at the page's clean route
 * and adds the two things the port contract requires: `#dc-root[data-oasis-ready="1"]` once the page has mounted and
 * `window.__oasisParity.getVals()` returning serializeVals(renderVals()). This proves the port-side plumbing (routes,
 * hash, ready flag, hook) independently of the build. Like every dry-run port it carries the owner's copy decisions
 * (design-patches/copy-map.json) as pre-render swaps, since the baseline renders with them (docs/parity.md), and like
 * the port it renders the stored or the device's theme (DV-THEME; the baseline is rendered with the run's theme).
 */
const HOOK = `<script>(function () {
  var ser = ${serializeVals.toString()};
  window.__oasisParity = {
    getVals: function () {
      var host = document.querySelector('#dc-root .sc-host');
      var key = host && Object.keys(host).find(function (k) { return k.indexOf('__reactFiber$') === 0; });
      var fiber = key ? host[key] : null;
      while (fiber) {
        var inst = fiber.stateNode;
        if (inst && inst.logic && typeof inst.logic.renderVals === 'function') return ser(inst.logic.renderVals());
        fiber = fiber.return;
      }
      throw new Error('logic instance not found');
    }
  };
  function mark() {
    var root = document.getElementById('dc-root');
    if (root && root.querySelector('.sc-host')) { root.setAttribute('data-oasis-ready', '1'); return true; }
    return false;
  }
  function hideBadge() {
    if (document.querySelector('style[data-mock-port]')) return;
    var parent = document.head || document.documentElement;
    if (!parent) return;
    var s = document.createElement('style');
    s.setAttribute('data-mock-port', '1');
    s.textContent = '#__claude_design_branding{display:none!important}';
    parent.appendChild(s);
  }
  hideBadge();
  // DV-THEME: like the port, render the theme stored on the device, else the device's color scheme (the design's
  // data-props default is rewritten when the parser is done, before the dc runtime boots from it)
  document.addEventListener('readystatechange', function () {
    if (document.readyState !== 'interactive') return;
    var el = document.querySelector('script[data-dc-script]');
    if (!el) return;
    try {
      var props = JSON.parse(el.getAttribute('data-props') || 'null');
      if (!props || !props.theme) return;
      var stored = null;
      try { stored = localStorage.getItem('oasis-theme'); } catch (e) {}
      props.theme.default = stored === 'light' || stored === 'dark' ? stored : (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
      el.setAttribute('data-props', JSON.stringify(props));
    } catch (e) {}
  });
  new MutationObserver(function (_m, obs) { hideBadge(); if (mark()) obs.disconnect(); }).observe(document, { childList: true, subtree: true });
})();</script>`

export interface MockPort {
  url: string
  close(): Promise<void>
}

export async function startMockPort(
  opts: { port?: number; transform?: (slug: string, template: string) => string } = {},
): Promise<MockPort> {
  const pages = new Map<string, string>()
  for (const p of PAGES) {
    const { html } = buildBundle(p.slug, path.join(DESIGN_DIR, p.file), copyMapSwaps(ROOT, p.slug), opts.transform)
    pages.set(
      p.route,
      html.replace('<head>', () => `<head>${HOOK}`),
    )
  }
  // a raw document's relative references (./support.js, ./image-slot.js, assets/<file>) resolve against the route
  const looseDir = path.join(DESIGN_DIR, 'original', 'loose')
  const MIME: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.json': 'application/json' }
  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0]!.split('#')[0]!
    const html = pages.get(pathname)
    if (html) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html)
      return
    }
    const rel = pathname.replace(/^\/+/, '')
    if (rel && !rel.includes('..')) {
      const file = path.join(looseDir, rel)
      if ((!rel.includes('/') || rel.startsWith('assets/')) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'content-type': MIME[path.extname(rel)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(fs.readFileSync(file))
        return
      }
      if (rel.startsWith('assets/') && rel.endsWith('.png')) {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }).end(transparentPng(PLACEHOLDER_SIZE, PLACEHOLDER_SIZE))
        return
      }
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
  })
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
