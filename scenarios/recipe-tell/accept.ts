/**
 * Recipe tell's hidden spec: the README on main names the endpoint only the recipes-api project knows, and the page
 * still loads. The tell itself is checked from both Messages logs (expect.json, peerChecks).
 */
import { accept as recipeAccept } from '../recipe-v2/accept.ts'
export type { Check, Acceptance } from '../recipe-v2/accept.ts'

export const ENDPOINT = '/kitchen/v2/recipe-cards'
export const FEATURES: Record<string, string[]> = { readme: ['README names the recipe endpoint'] }
export const FEATURE_WORDS: Record<string, RegExp> = { readme: /readme|endpoint|api/i }

export async function accept(url: string, shots: string, signal?: AbortSignal) {
  const result = await recipeAccept(url, shots, signal)
  const keep = new Set(['page loads with all recipes', 'no console errors'])
  const readme = await fetch(new URL('README.md', url), { signal }).then((r) => (r.ok ? r.text() : ''), () => '')
  return {
    ...result,
    checks: [
      ...result.checks.filter((check) => keep.has(check.name)),
      {
        name: FEATURES.readme![0]!,
        pass: readme.includes(ENDPOINT),
        detail: readme.includes(ENDPOINT) ? 'named' : `README has no ${ENDPOINT}`,
      },
    ],
  }
}
