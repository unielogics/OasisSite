import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { DESIGN_DIR, PAGES } from './config'
import { buildBundle } from './serve-original'
import { serializeVals } from './vals-serialize'

/**
 * A stand-in for the real port, used by the self-test: it serves every page's ORIGINAL bundle at the page's clean route
 * and adds the two things the port contract requires: `#dc-root[data-oasis-ready="1"]` once the page has mounted and
 * `window.__oasisParity.getVals()` returning serializeVals(renderVals()). This proves the port-side plumbing (routes,
 * hash, ready flag, hook) independently of the build.
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
    const { html } = buildBundle(p.slug, path.join(DESIGN_DIR, p.file), [], opts.transform)
    pages.set(
      p.route,
      html.replace('<head>', () => `<head>${HOOK}`),
    )
  }
  const server = http.createServer((req, res) => {
    const html = pages.get((req.url ?? '/').split('?')[0]!.split('#')[0]!)
    if (!html) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html)
  })
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
