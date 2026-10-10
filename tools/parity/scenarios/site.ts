// Scenarios of "Oasis Site v2" (page slug `index`): the home view, every hash route, the menu, the theme toggle, the
// tint simulator (chips and the slider), the pricing flips, the FAQ, the booking sheet (guest and member paths up to
// the review step) and the join flow up to its checkout step. SITE_BOOKING=sms (the parity build) turns the submits
// into sms: navigations, so the sheet's done step and the join welcome step are reached by the e2e against the live
// stack (scripts/e2e-site.ts), not here.
import type { Actions } from '../drivers'
import { initialScenario } from './common'
import type { Scenario, ScenarioStep } from './types'

const click = (id: string, target: string | RegExp, title?: string): ScenarioStep => ({
  id,
  title: title ?? `click ${String(target)}`,
  run: async (a: Actions) => a.click(a.btn(target)),
})
const clickCss = (id: string, selector: string, title?: string): ScenarioStep => ({
  id,
  title: title ?? `click ${selector}`,
  run: async (a: Actions) => a.click(a.css(selector)),
})
const route = (name: string, title: string): Scenario => ({
  id: `route-${name}`,
  page: 'index',
  title,
  hash: `/${name}`,
  tags: ['smoke'],
  steps: [],
})

/**
 * The first slot button of the sheet's time step that can be picked. Playwright's hasText sees a slot as "11:30 AMOPEN"
 * (block boundaries collapsed) and a board row behind the sheet as "11:30AMOPEN" (its flap cells are separate spans):
 * the space before AM/PM tells them apart.
 */
const pickableSlot = (a: Actions) => a.css('button').filter({ hasText: /^\d+:\d\d (AM|PM)\s*(OPEN|LAST BAY)$/ }).first()

/**
 * DV-THEME: the device's color scheme flips to the other theme and back on both sides. The original ignores the device;
 * the port must too once the visitor's choice is stored (else the flip back would change its theme).
 */
const DEVICE_FLIP: ScenarioStep = {
  id: 'device-flip',
  title: 'the device switches to the other color scheme and back (a stored choice holds)',
  run: async (a) => {
    await a.page.emulateMedia({ colorScheme: a.theme === 'light' ? 'dark' : 'light' })
    await a.settle()
    await a.page.emulateMedia({ colorScheme: a.theme })
    await a.settle()
  },
}

const PRICING_SCROLL: ScenarioStep = {
  id: 'pricing-revealed',
  title: 'scroll to the pricing section and let the IntersectionObserver flip the prices',
  run: async (a) => {
    await a.page.evaluate(() => document.getElementById('pricing')?.scrollIntoView({ block: 'start' }))
    // past the board's 1.4 s flap animation too: while it runs, each side's rAF loop re-renders at instants that
    // differ by a few ms, and a cell right at its reveal boundary would differ between two otherwise equal pages
    await a.runFor(1600)
  },
}

export const siteScenarios: Scenario[] = [
  initialScenario('index', 'the home view on load'),
  // the run's theme is the device's color scheme on both sides (the original is rendered with it, DV-THEME): the toggle
  // goes from the device theme to the other one, and the port stores that choice
  {
    id: 'theme-toggle',
    page: 'index',
    title: 'toggle the theme from the header (from the device theme to the other), then the device flips',
    tags: ['smoke'],
    steps: [clickCss('toggled', 'button[aria-label="Theme"]'), DEVICE_FLIP],
  },
  {
    id: 'stored-choice',
    page: 'index',
    title: 'a theme stored on the device (the opposite of the device setting) wins on load and over device changes',
    storedTheme: 'other',
    steps: [DEVICE_FLIP, clickCss('toggled', 'button[aria-label="Theme"]', 'toggle back to the device theme')],
  },
  {
    id: 'menu',
    page: 'index',
    title: 'open the menu, switch the appearance, close it',
    steps: [
      clickCss('open', 'button[aria-label="Menu"]', 'open the menu'),
      click('light', /^\s*Light\s*$/, 'Appearance: Light'),
      click('dark', /^\s*Dark\s*$/, 'Appearance: Dark'),
      clickCss('closed', 'button[aria-label="Close"]', 'close the menu'),
    ],
  },
  route('membership', 'the membership comparison'),
  route('wash', 'the wash page'),
  route('tint', 'the tint simulator'),
  route('detailing', 'the detailing page'),
  route('experience', 'the experience page'),
  route('visit', 'the visit page (address, hours)'),
  route('join', 'the join flow, step 1'),
  {
    id: 'tint-sim',
    page: 'index',
    title: 'tint simulator: shade, film and vehicle chips, then the slider',
    hash: '/tint',
    steps: [
      click('vlt-35', /^\s*35%/, 'VLT 35%'),
      click('film-carbon', /^\s*Carbon\s*$/, 'Carbon film'),
      click('veh-suv', 'SUV / Crossover'),
      {
        id: 'slider',
        title: 'drag the split line to 70%',
        keepPointer: true,
        run: async (a) => {
          const glass = a.css('div[style*="ew-resize"]')
          const from = await a.point(glass, 0.52, 0.5)
          const to = await a.point(glass, 0.7, 0.5)
          await a.pointerSequence(
            [
              { type: 'pointerdown', x: from.x, y: from.y },
              { type: 'pointermove', x: (from.x + to.x) / 2, y: to.y, wait: 30 },
              { type: 'pointermove', x: to.x, y: to.y, wait: 30 },
              { type: 'pointerup', x: to.x, y: to.y, wait: 30 },
            ],
            { pointerType: 'mouse' },
          )
        },
      },
    ],
  },
  { id: 'scroll-pricing', page: 'index', title: 'the pricing flips after scrolling to them', steps: [PRICING_SCROLL] },
  {
    id: 'faq',
    page: 'index',
    title: 'open another FAQ entry, then close it',
    steps: [
      click('open-second', 'Is the guest booking fee refundable?'),
      click('close-second', 'Is the guest booking fee refundable?', 'close it again'),
    ],
  },
  {
    id: 'sheet-guest',
    page: 'index',
    title: 'booking sheet as a guest: NEXT OPEN -> who -> wash + add-on -> review -> terms',
    steps: [
      click('who', /^\s*Book it\s*$/, 'Book it (NEXT OPEN)'),
      click('svc', 'Continue as guest'),
      click('addon', 'Hand wax', 'add Hand wax'),
      click('wash-exterior', 'Exterior Hand Wash', 'switch to the exterior wash'),
      click('review', 'Review booking'),
      click('ack', /^\s*I understand the \$25 booking fee/, 'accept the fee terms'),
      clickCss('back-time', 'button[aria-label="Back"]', 'back to the time step'),
    ],
  },
  {
    id: 'sheet-member',
    page: 'index',
    title: 'booking sheet as a member: menu -> Book a time -> phone -> wash -> time -> slot -> review',
    steps: [
      clickCss('menu', 'button[aria-label="Menu"]', 'open the menu'),
      click('who', /^\s*Book a time\s*$/),
      {
        id: 'phone-error',
        title: 'Continue with a short number',
        run: async (a) => {
          await a.fill(a.css('input[placeholder="Mobile number"]'), '201')
          await a.click(a.btn(/^\s*Continue\s*$/))
        },
      },
      {
        id: 'svc',
        title: 'Continue with a full number',
        run: async (a) => {
          await a.fill(a.css('input[placeholder="Mobile number"]'), '2015551234')
          await a.click(a.btn(/^\s*Continue\s*$/))
        },
      },
      click('time', 'Choose a time'),
      {
        id: 'day-2',
        title: 'the first day chip after today',
        run: async (a) => a.click(a.css('button').filter({ hasText: /^\s*(MON|TUE|WED|THU|FRI|SAT)\d+$/ }).first()),
      },
      { id: 'slot', title: 'pick the first open slot', run: async (a) => a.click(pickableSlot(a)) },
      click('review', /^\s*Review · /),
    ],
  },
  {
    id: 'join-flow',
    page: 'index',
    title: 'join: Gold -> vehicles -> details -> checkout step with the terms accepted',
    hash: '/join',
    steps: [
      click('gold', /^\s*Gold/, 'choose Gold'),
      click('vehicles', /^\s*Continue\s*$/),
      {
        id: 'vehicle-error',
        title: 'Continue without a vehicle',
        run: async (a) => a.click(a.btn(/^\s*Continue\s*$/)),
      },
      {
        id: 'details',
        title: 'add a vehicle and continue',
        run: async (a) => {
          await a.fill(a.css('input[placeholder="Year, make, model"]'), '2022 Tesla Model 3')
          await a.fill(a.css('input[placeholder="Plate"]'), 'abc123')
          await a.click(a.btn(/^\s*Continue\s*$/))
        },
      },
      {
        id: 'checkout',
        title: 'name, mobile, e-mail and continue',
        run: async (a) => {
          await a.fill(a.css('input[placeholder="Full name"]'), 'Jamie Rivera')
          await a.fill(a.css('input[placeholder="Mobile number"]'), '2015551234')
          await a.fill(a.css('input[placeholder="Email (for receipts)"]'), 'jamie@example.com')
          await a.click(a.btn(/^\s*Continue\s*$/))
        },
      },
      click('agree', /^\s*I agree to be billed/, 'accept the terms'),
      clickCss('back', 'button[aria-label="Back"]', 'back to the details step'),
    ],
  },
]
