import { accept as recipeAccept, FEATURES as recipeFeatures } from '../recipe-v2/accept.ts'
export type { Check, Acceptance } from '../recipe-v2/accept.ts'

export const FEATURES: Record<string, string[]> = {
  search: recipeFeatures.search!,
  favourites: recipeFeatures.favourites!,
}
export const FEATURE_WORDS: Record<string, RegExp> = {
  search: /search|filter|capital|case/i,
  favourites: /favou?rite|star|count.*reload|reload.*count/i,
}

export async function accept(url: string, shots: string, signal?: AbortSignal) {
  const result = await recipeAccept(url, shots, signal)
  const keep = new Set(['page loads with all recipes', ...FEATURES.search!, ...FEATURES.favourites!, 'no console errors'])
  return { ...result, checks: result.checks.filter((check) => keep.has(check.name)) }
}
