import { clickBtn, initialScenario, themeScenario } from './common'
import type { Scenario } from './types'

const SECTIONS: Array<[id: string, label: string]> = [
  ['closures', 'Holidays & closures'],
  ['emergency', 'Emergency closing'],
  ['employees', 'Employees'],
  ['roles', 'Roles & permissions'],
  ['vip', 'VIP program'],
  ['arrival', 'Arrival & check-in'],
  ['services', 'Packages & checklists'],
  ['hours', 'Working hours'],
]

export const settingsScenarios: Scenario[] = [
  initialScenario('settings', 'Working hours section on load'),
  {
    id: 'sections',
    page: 'settings',
    title: 'visit all 8 sections through the left rail',
    tags: ['smoke'],
    steps: SECTIONS.map(([id, label]) => clickBtn(`section-${id}`, label, `open "${label}"`)),
  },
  themeScenario('settings'),
  {
    id: 'emergency-deeplink',
    page: 'settings',
    title: 'load with the #emergency hash (componentDidMount deep link)',
    hash: 'emergency',
    steps: [],
  },
]
