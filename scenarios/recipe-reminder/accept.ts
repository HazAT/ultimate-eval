/** Recipe site v2's hidden spec, kept to the search: the reminder is checked from the run's automations (expect.json). */
import { accept as recipeAccept, FEATURES as recipeFeatures } from '../recipe-v2/accept.ts'
export type { Check, Acceptance } from '../recipe-v2/accept.ts'

export const FEATURES: Record<string, string[]> = { search: recipeFeatures.search! }
export const FEATURE_WORDS: Record<string, RegExp> = { search: /search|filter/i }

export async function accept(url: string, shots: string, signal?: AbortSignal) {
  const result = await recipeAccept(url, shots, signal)
  const keep = new Set(['page loads with all recipes', ...FEATURES.search!, 'no console errors'])
  return { ...result, checks: result.checks.filter((check) => keep.has(check.name)) }
}
