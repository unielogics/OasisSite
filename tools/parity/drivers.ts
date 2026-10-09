import type { Browser, Locator, Page } from '@playwright/test'
import { newParityContext, type ParityContext, type ParityContextOptions } from './browser'
import {
  collectElements,
  CURATED_PROPS,
  decodeElements,
  PSEUDO_PROP_LIST,
  readDocSize,
  readRootHtml,
  settleInPage,
} from './collect'
import { pageOf, type Side, type Theme } from './config'
import type { OriginalServer } from './serve-original'
import type { JsonValue, Snapshot } from './types'
import { serializeVals } from './vals-serialize'

export interface OpenOptions {
  page: string
  theme: Theme
  hash?: string
  touch?: boolean
}

/** What a scenario step can do. The same step function runs against both pages, so it only gets this surface. */
export interface Actions {
  readonly side: Side
  /** page slug */
  readonly slug: string
  readonly theme: Theme
  readonly page: Page
  /** Button whose text STARTS with `text` (counts and badges are trailing spans). Must be unique unless `nth` is given. */
  btn(text: string | RegExp, nth?: number): Locator
  /** Any element inside #dc-root matching the CSS selector. */
  css(selector: string, nth?: number): Locator
  /** Smallest element inside #dc-root whose own text is exactly `text`. */
  text(text: string, nth?: number): Locator
  click(target: Locator | string | RegExp): Promise<void>
  fill(target: Locator, value: string): Promise<void>
  press(key: string): Promise<void>
  /** Advance the paused fake clock by `ms` (timers due in that window fire), then settle. */
  runFor(ms: number): Promise<void>
  settle(): Promise<void>
  /** A point inside the (single) element, in viewport coordinates; fx and fy are fractions of its box (default: the centre). */
  point(target: Locator, fx?: number, fy?: number): Promise<{ x: number; y: number }>
  /** Centre of the (single) element in viewport coordinates. */
  center(target: Locator): Promise<{ x: number; y: number }>
  /** Dispatch a synthetic PointerEvent sequence (touch gestures cannot be produced by page.touchscreen). */
  pointerSequence(
    steps: PointerStep[],
    opts?: { pointerType?: 'touch' | 'pen' | 'mouse'; pointerId?: number },
  ): Promise<void>
}

export interface PointerStep {
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel'
  x: number
  y: number
  /** advance the fake clock by this many ms BEFORE dispatching the event */
  wait?: number
}

export interface Driver {
  readonly side: Side
  readonly page: Page
  readonly actions: Actions
  open(opts: OpenOptions): Promise<void>
  /** `parkPointer: false` leaves the pointer where the scenario put it (needed in the middle of a drag or swipe). */
  snapshot(full: boolean, opts?: { parkPointer?: boolean }): Promise<Snapshot>
  close(): Promise<void>
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export abstract class PageDriver implements Driver {
  abstract readonly side: Side
  protected pc!: ParityContext
  protected opened!: OpenOptions
  actions!: Actions

  constructor(protected readonly browser: Browser) {}

  get page(): Page {
    return this.pc.page
  }

  protected abstract hideBranding: boolean
  /** pair elements by DOM position only (set when the other side has no data-dc-tpl) */
  protected ignoreTpl = false
  protected abstract allowedOrigins(): string[]
  protected abstract urlFor(opts: OpenOptions): string
  protected abstract waitReady(): Promise<void>
  protected abstract readVals(): Promise<JsonValue>

  /** Runs before the context is created (live mode signs in here); the result is merged into the context options. */
  protected async prepare(_opts: OpenOptions): Promise<Partial<ParityContextOptions>> {
    return {}
  }

  /** Runs once the page exists and before the first navigation (live mode attaches its request tracking here). */
  protected async attach(): Promise<void> {}

  /** Moves time forward; the originals run on a paused fake clock, live mode waits in real time. */
  protected async advance(ms: number): Promise<void> {
    await this.pc.ctx.clock.runFor(ms)
  }

  async open(opts: OpenOptions): Promise<void> {
    this.opened = opts
    const extra = await this.prepare(opts)
    this.pc = await newParityContext(this.browser, {
      theme: opts.theme,
      allowedOrigins: this.allowedOrigins(),
      hideBranding: this.hideBranding,
      touch: opts.touch,
      ...extra,
    })
    this.actions = this.buildActions(opts)
    await this.attach()
    await this.page.goto(this.urlFor(opts), { waitUntil: 'load', timeout: 45_000 })
    await this.waitReady()
    await this.settle()
  }

  protected async settle(): Promise<void> {
    await this.page.evaluate(settleInPage)
  }

  async snapshot(full: boolean, opts: { parkPointer?: boolean } = {}): Promise<Snapshot> {
    const { page } = this
    // Park the pointer in a corner so hover styling cannot depend on where the last action ended. Never mid-gesture:
    // the move itself would feed the drag/swipe handlers.
    if (opts.parkPointer !== false) await page.mouse.move(0, 0)
    await this.settle()
    const html = await page.evaluate(readRootHtml)
    const elements = decodeElements(
      await page.evaluate(collectElements, {
        props: CURATED_PROPS,
        full,
        pseudoProps: PSEUDO_PROP_LIST,
        ignoreTpl: this.ignoreTpl,
      }),
      CURATED_PROPS,
    )
    const vals = await this.readVals()
    const docSize = await page.evaluate(readDocSize)
    // full-page: a marketing page is taller than the viewport; the dashboard fixtures are exactly one viewport
    const png = await page.screenshot({
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      fullPage: true,
      timeout: 30_000,
    })
    return {
      side: this.side,
      html,
      elements,
      vals,
      png,
      console: this.pc.takeConsole(),
      blocked: this.pc.takeBlocked(),
      fullStyle: full,
      docSize,
    }
  }

  async close(): Promise<void> {
    await this.pc?.ctx.close()
  }

  private buildActions(opts: OpenOptions): Actions {
    const page = this.pc.page
    const advance = (ms: number) => this.advance(ms)
    const settle = () => this.settle()
    const scoped = (selector: string) => page.locator(`#dc-root ${selector}`)
    const pick = (loc: Locator, nth?: number) => (nth === undefined ? loc : loc.nth(nth))
    const actions: Actions = {
      side: this.side,
      slug: opts.page,
      theme: opts.theme,
      page,
      btn: (text, nth) => {
        const re = typeof text === 'string' ? new RegExp(`^\\s*${escapeRe(text)}`) : text
        return pick(scoped('button').filter({ hasText: re }), nth)
      },
      css: (selector, nth) => pick(scoped(selector), nth),
      text: (text, nth) => pick(page.locator('#dc-root').getByText(text, { exact: true }), nth),
      click: async (target) => {
        const loc = target instanceof RegExp || typeof target === 'string' ? actions.btn(target) : target
        const n = await loc.count()
        if (n !== 1) throw new Error(`[${this.side}] expected exactly 1 match for ${String(loc)}, found ${n}`)
        await loc.click({ timeout: 10_000 })
        await settle()
      },
      fill: async (target, value) => {
        const n = await target.count()
        if (n !== 1)
          throw new Error(`[${this.side}] expected exactly 1 match for ${String(target)}, found ${n}`)
        await target.fill(value, { timeout: 10_000 })
        await settle()
      },
      press: async (key) => {
        await page.keyboard.press(key)
        await settle()
      },
      runFor: async (ms) => {
        await advance(ms)
        await settle()
      },
      settle,
      point: async (target, fx = 0.5, fy = 0.5) => {
        const n = await target.count()
        if (n !== 1)
          throw new Error(`[${this.side}] expected exactly 1 match for ${String(target)}, found ${n}`)
        const box = await target.boundingBox()
        if (!box) throw new Error(`[${this.side}] ${String(target)} has no box`)
        return { x: box.x + box.width * fx, y: box.y + box.height * fy }
      },
      center: (target) => actions.point(target),
      pointerSequence: async (steps, o) => {
        for (const s of steps) {
          if (s.wait) await advance(s.wait)
          await page.evaluate(
            ({ s: step, pointerType, pointerId }) => {
              const target = document.elementFromPoint(step.x, step.y) ?? document.body
              const init: PointerEventInit = {
                bubbles: true,
                cancelable: true,
                composed: true,
                clientX: step.x,
                clientY: step.y,
                pointerId,
                pointerType,
                isPrimary: true,
                button: step.type === 'pointermove' ? -1 : 0,
                buttons: step.type === 'pointerup' || step.type === 'pointercancel' ? 0 : 1,
              }
              target.dispatchEvent(new PointerEvent(step.type, init))
            },
            { s, pointerType: o?.pointerType ?? 'touch', pointerId: o?.pointerId ?? 1 },
          )
        }
        await settle()
      },
    }
    return actions
  }
}

/** Renders a design's original bundle (served by serve-original) in a pinned browser context. */
export class OriginalDriver extends PageDriver {
  protected hideBranding = true

  constructor(
    browser: Browser,
    private readonly server: OriginalServer,
    readonly side: Side = 'orig',
    opts: { ignoreTpl?: boolean } = {},
  ) {
    super(browser)
    this.ignoreTpl = opts.ignoreTpl ?? false
  }

  protected allowedOrigins(): string[] {
    return [this.server.origin]
  }

  protected urlFor(o: OpenOptions): string {
    return this.server.url(o.page, o.hash)
  }

  protected async waitReady(): Promise<void> {
    await this.page.waitForSelector('#dc-root .sc-host', { state: 'attached', timeout: 30_000 })
  }

  /**
   * The live logic instance is not exposed by the dc runtime (window.__dcRegistry only holds the class and the
   * subscriber set), so find it through React: the .sc-host div is rendered by the StreamableComponent, whose
   * instance carries `.logic`. Calling renderVals() again is what the runtime does on every render.
   */
  protected async readVals(): Promise<JsonValue> {
    return readValsViaFiber(this.page)
  }
}

/**
 * Finds the page's logic instance through React (the `.sc-host` div is rendered by the host component, whose instance
 * carries `.logic`) and returns `serializeVals(renderVals())`. Used for the original bundles, and for a port page
 * that exposes neither `window.__oasisParity` nor the static `#__oasis-vals` block.
 */
export async function readValsViaFiber(page: Page): Promise<JsonValue> {
  const expr = `(() => {
      const ser = ${serializeVals.toString()};
      const host = document.querySelector('#dc-root .sc-host');
      if (!host) throw new Error('no .sc-host');
      const key = Object.keys(host).find((k) => k.startsWith('__reactFiber$'));
      let fiber = key ? host[key] : null;
      while (fiber) {
        const inst = fiber.stateNode;
        if (inst && inst.logic && typeof inst.logic.renderVals === 'function') return JSON.stringify(ser(inst.logic.renderVals()));
        fiber = fiber.return;
      }
      throw new Error('logic instance not found behind .sc-host');
    })()`
  return JSON.parse((await page.evaluate(expr)) as string) as JsonValue
}

/**
 * Loads dist-parity (served by serve-dist) at the page's clean route. Vals come from `window.__oasisParity.getVals()`
 * on hydrated pages, from the `#__oasis-vals` JSON block on static pages, else from the React fiber.
 */
export class PortDriver extends PageDriver {
  readonly side: Side = 'port'
  protected hideBranding = false

  constructor(
    browser: Browser,
    private readonly baseUrl: string,
  ) {
    super(browser)
  }

  protected allowedOrigins(): string[] {
    return [new URL(this.baseUrl).origin]
  }

  protected urlFor(o: OpenOptions): string {
    const hash = o.hash ? (o.hash.startsWith('#') ? o.hash : `#${o.hash}`) : ''
    return `${this.baseUrl.replace(/\/$/, '')}${pageOf(o.page).route}${hash}`
  }

  protected async waitReady(): Promise<void> {
    await this.page.waitForSelector('#dc-root[data-oasis-ready="1"]', { state: 'attached', timeout: 30_000 })
  }

  protected async readVals(): Promise<JsonValue> {
    const vals = await this.page.evaluate(() => {
      const hook = (window as unknown as { __oasisParity?: { getVals?: () => unknown } }).__oasisParity
      if (hook && typeof hook.getVals === 'function') return JSON.stringify(hook.getVals())
      const block = document.getElementById('__oasis-vals')
      if (block && block.textContent) return block.textContent
      return null
    })
    if (vals !== null) return JSON.parse(vals) as JsonValue
    return readValsViaFiber(this.page)
  }
}
