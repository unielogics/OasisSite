import { PAGES, THEMES, type Theme } from '../config'
import { initialScenario } from './common'
import { operationsScenarios } from './operations'
import { paymentsScenarios } from './payments'
import { settingsScenarios } from './settings'
import type { Scenario } from './types'

/** Scenario modules by page slug. A page of design/pages.json without a module gets the automatic `initial` only. */
const MODULES: Record<string, readonly Scenario[]> = {
  operations: operationsScenarios,
  payments: paymentsScenarios,
  settings: settingsScenarios,
}

export const ALL_SCENARIOS: readonly Scenario[] = PAGES.flatMap((p) =>
  MODULES[p.slug] ? MODULES[p.slug]! : [initialScenario(p.slug, `${p.name} on load`)],
)

export function validateScenarios(list: readonly Scenario[]): void {
  const seen = new Set<string>()
  const slugs = new Set(PAGES.map((p) => p.slug))
  for (const s of list) {
    if (!slugs.has(s.page)) throw new Error(`scenario ${s.id}: unknown page ${s.page} (design/pages.json)`)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(s.id)) throw new Error(`scenario id "${s.id}" must be kebab-case`)
    const key = `${s.page}/${s.id}`
    if (seen.has(key)) throw new Error(`duplicate scenario ${key}`)
    seen.add(key)
    const steps = new Set<string>(['initial'])
    for (const st of s.steps) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(st.id))
        throw new Error(`${key}: step id "${st.id}" must be kebab-case`)
      if (steps.has(st.id)) throw new Error(`${key}: duplicate step id "${st.id}"`)
      steps.add(st.id)
    }
  }
}

export interface ScenarioFilter {
  page?: string
  scenario?: string
  tag?: string
}

export function selectScenarios(
  filter: ScenarioFilter = {},
  list: readonly Scenario[] = ALL_SCENARIOS,
): Scenario[] {
  return list.filter(
    (s) =>
      (!filter.page || s.page === filter.page) &&
      (!filter.scenario || s.id === filter.scenario) &&
      (!filter.tag || (s.tags ?? []).includes(filter.tag)),
  )
}

export function themesOf(s: Scenario, only?: Theme): readonly Theme[] {
  const themes = s.themes ?? THEMES
  return only ? themes.filter((t) => t === only) : themes
}
