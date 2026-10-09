import { clickBtn, exact, initialScenario, themeScenario } from './common'
import type { Actions } from '../drivers'
import type { Scenario } from './types'

const TABS: Array<[id: string, label: string]> = [
  ['checklist', 'Checklist'],
  ['add-ons', 'Add-ons'],
  ['photos', 'Photos'],
  ['messages', 'Messages'],
  ['payments', 'Payments'],
  ['membership', 'Membership'],
  ['history', 'History'],
  ['overview', 'Overview'],
]

const FIRST_CARD = 'Marcus Webb'
const OPEN_BAY = '[data-drop="bay:2"]'

const cardCenter = (a: Actions) => a.center(a.btn(FIRST_CARD))
// the open bay is taller than what is left of the viewport, so aim at its upper part (elementFromPoint needs a visible point)
const bayCenter = (a: Actions) => a.point(a.css(OPEN_BAY), 0.5, 0.25)

export const operationsScenarios: Scenario[] = [
  initialScenario('operations', 'Command Center timeline at the frozen 10:36 AM'),
  {
    id: 'view-tabs',
    page: 'operations',
    title: 'the four view tabs',
    tags: ['smoke'],
    steps: [
      clickBtn('view-bay-board', 'Bay Board'),
      clickBtn('view-staff', 'Staff'),
      clickBtn('view-calendar', 'Calendar'),
      clickBtn('view-timeline', 'Timeline'),
    ],
  },
  {
    id: 'range-tabs',
    page: 'operations',
    title: 'the four range tabs',
    steps: [
      clickBtn('range-today', exact('Today')),
      clickBtn('range-tomorrow', 'Tomorrow'),
      clickBtn('range-week', 'Week'),
      clickBtn('range-next-24h', 'Next 24h'),
    ],
  },
  {
    id: 'appointment-file',
    page: 'operations',
    title: 'open the first appointment file and each of its 8 tabs',
    tags: ['smoke'],
    steps: [
      clickBtn('open-file', 'Marcus Webb', 'open the first appointment card'),
      ...TABS.map(([id, label]) => clickBtn(`tab-${id}`, label, `open the ${label} tab`)),
    ],
  },
  {
    id: 'new-appointment',
    page: 'operations',
    title: 'open and close the New Appointment panel, then the Walk-in variant',
    steps: [
      clickBtn('open-new', 'New Appointment'),
      clickBtn('cancel-new', exact('Cancel')),
      clickBtn('open-walkin', 'Walk-in'),
    ],
  },
  {
    id: 'touch-long-press-drag',
    page: 'operations',
    writes: true,
    title: 'touch: long-press (380 ms) a timeline card, drag it onto the open bay, drop, wait out the toast',
    touch: true,
    tags: ['gesture'],
    steps: [
      {
        id: 'press-armed',
        title: 'finger down, then 400 ms: the drag has begun (ghost, drop cues)',
        keepPointer: true,
        run: async (a) => {
          const c = await cardCenter(a)
          await a.pointerSequence([{ type: 'pointerdown', ...c }])
          await a.runFor(400)
        },
      },
      {
        id: 'over-open-bay',
        title: 'drag over the open bay',
        keepPointer: true,
        run: async (a) => {
          const t = await bayCenter(a)
          await a.pointerSequence([
            { type: 'pointermove', x: t.x - 120, y: t.y - 80 },
            { type: 'pointermove', ...t },
          ])
        },
      },
      {
        id: 'drop',
        title: 'lift: the job is assigned to the bay',
        run: async (a) => a.pointerSequence([{ type: 'pointerup', ...(await bayCenter(a)) }]),
      },
      { id: 'toast-expired', title: 'the toast lives 3200 ms', run: async (a) => a.runFor(3300) },
    ],
  },
  {
    id: 'touch-swipe-advance',
    page: 'operations',
    writes: true,
    title: 'touch: swipe a timeline card right past 90 px to advance it',
    touch: true,
    tags: ['gesture'],
    steps: [
      {
        id: 'swiping',
        title: 'finger down and 70 px to the right: the card follows the finger',
        keepPointer: true,
        run: async (a) => {
          const c = await cardCenter(a)
          await a.pointerSequence([
            { type: 'pointerdown', ...c },
            { type: 'pointermove', x: c.x + 20, y: c.y },
            { type: 'pointermove', x: c.x + 70, y: c.y },
          ])
        },
      },
      {
        id: 'swipe-commit',
        title: 'past 90 px and lift: the appointment advances',
        run: async (a) => {
          const c = await cardCenter(a)
          await a.pointerSequence([
            { type: 'pointermove', x: c.x + 140, y: c.y },
            { type: 'pointerup', x: c.x + 140, y: c.y },
          ])
        },
      },
    ],
  },
  {
    id: 'mouse-drag-to-bay',
    page: 'operations',
    writes: true,
    title: 'mouse: drag a timeline card (6 px threshold) onto the open bay and drop',
    tags: ['gesture'],
    steps: [
      {
        id: 'dragging',
        title: 'button down and move: the drag has begun',
        keepPointer: true,
        run: async (a) => {
          const c = await cardCenter(a)
          await a.page.mouse.move(c.x, c.y)
          await a.page.mouse.down()
          await a.page.mouse.move(c.x + 12, c.y + 12, { steps: 3 })
          await a.settle()
        },
      },
      {
        id: 'over-open-bay',
        title: 'over the open bay',
        keepPointer: true,
        run: async (a) => {
          const t = await bayCenter(a)
          await a.page.mouse.move(t.x, t.y, { steps: 6 })
          await a.settle()
        },
      },
      {
        id: 'drop',
        title: 'release: assigned to the bay',
        run: async (a) => {
          await a.page.mouse.up()
          await a.settle()
        },
      },
    ],
  },
  themeScenario('operations'),
]
