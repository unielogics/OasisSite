import type { Actions } from '../drivers'
import type { Scenario, ScenarioStep } from './types'

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Matches a button whose whole text is `text` (use when another button's text merely starts with it). */
export const exact = (text: string): RegExp => new RegExp(`^\\s*${escapeRe(text)}\\s*$`)

export const THEME_TOGGLE = 'button[title="Toggle theme"]'

/** A step that clicks a button found by its leading text (or an exact regex). */
export function clickBtn(id: string, target: string | RegExp, title?: string): ScenarioStep {
  return {
    id,
    title: title ?? `click ${String(target)}`,
    run: async (a: Actions) => a.click(a.btn(target)),
  }
}

export function toggleTheme(id = 'toggled'): ScenarioStep {
  return { id, title: 'toggle the theme', run: async (a) => a.click(a.css(THEME_TOGGLE)) }
}

/** `initial` scenario: nothing to do, the runner snapshots right after load. */
export function initialScenario(page: string, title: string): Scenario {
  return { id: 'initial', page, title, tags: ['smoke'], steps: [] }
}

export function themeScenario(page: string): Scenario {
  return {
    id: 'theme-toggle',
    page,
    title: 'toggle the theme from the header button',
    tags: ['smoke'],
    steps: [toggleTheme()],
  }
}
