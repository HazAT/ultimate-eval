/** Hidden visitor-facing checks: no dependency on the implementation's classes or data model. */
import { chromium } from 'playwright-core'
import type { Page } from 'playwright-core'
import { join } from 'node:path'
import type { Acceptance, Check } from '../recipe-v2/accept.ts'
export type { Acceptance, Check } from '../recipe-v2/accept.ts'

const RECIPES: Record<string, string[]> = {
  Pancakes: ['gluten', 'dairy', 'egg'],
  'Tomato soup': [],
  'Fried rice': ['egg'],
  'Green Curry': [],
  'Banana bread': ['gluten', 'dairy', 'egg'],
  'Greek salad': ['dairy'],
}
const ALLERGENS: Record<string, RegExp> = {
  gluten: /\b(gluten|wheat)\b/i,
  // Not "milk": a page that also shows ingredients lists Green Curry's coconut milk.
  dairy: /\bdairy\b/i,
  egg: /\beggs?\b/i,
}

function expect(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

async function visibleNames(page: Page) {
  const shown: string[] = []
  for (const name of Object.keys(RECIPES)) {
    const matches = page.getByText(name, { exact: false })
    for (let i = 0; i < await matches.count(); i++) {
      if (await matches.nth(i).isVisible()) {
        shown.push(name)
        break
      }
    }
  }
  return shown
}

async function expectNames(page: Page, names: string[]) {
  const shown = await visibleNames(page)
  expect(JSON.stringify(shown.sort()) === JSON.stringify([...names].sort()), `visible: ${shown.join(', ') || 'nothing'}`)
}

/** Returns the inverse interaction, including restoring a select's original value(s). */
async function pick(page: Page, name: RegExp): Promise<() => Promise<void>> {
  const toggles = page.getByRole('checkbox', { name })
    .or(page.getByRole('switch', { name }))
    .or(page.getByRole('button', { name }))
  for (let i = 0; i < await toggles.count(); i++) {
    const control = toggles.nth(i)
    if (!await control.isVisible()) continue
    await control.click()
    return async () => { await control.click() }
  }
  const selects = page.locator('select')
  for (let i = 0; i < await selects.count(); i++) {
    const select = selects.nth(i)
    if (!await select.isVisible()) continue
    const option = select.getByRole('option', { name }).first()
    if (!await option.count()) continue
    const before = await select.evaluate((el) => Array.from((el as HTMLSelectElement).selectedOptions, (o) => o.value))
    const value = await option.getAttribute('value') ?? await option.innerText()
    await select.selectOption(value)
    return async () => { await select.selectOption(before) }
  }
  // A custom listbox can expose options instead of a native select.
  const option = page.getByRole('option', { name }).first()
  if (await option.count() && await option.isVisible()) {
    await option.click()
    return async () => { await option.click() }
  }
  throw new Error(`no allergen filter control named ${name}`)
}

async function step(checks: Check[], name: string, run: () => Promise<void>) {
  try {
    await run()
    checks.push({ name, pass: true })
  } catch (error) {
    checks.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

export async function accept(url: string, shots: string, signal?: AbortSignal): Promise<Acceptance> {
  const browser = await chromium.launch()
  const abort = () => void browser.close()
  signal?.addEventListener('abort', abort, { once: true })
  const checks: Check[] = []
  const consoleErrors: string[] = []
  const screenshots: string[] = []
  try {
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 } })
    context.on('page', (page) => {
      page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
      page.on('pageerror', (e) => consoleErrors.push(String(e)))
    })
    const page = await context.newPage()
    const shot = async (name: string) => {
      const path = join(shots, `${name}.png`)
      await page.screenshot({ path, fullPage: true }).catch(() => {})
      screenshots.push(path)
    }
    await step(checks, 'page loads with all recipes', async () => {
      const response = await page.goto(url, { waitUntil: 'networkidle' })
      expect(!!response?.ok(), `status ${response?.status()}`)
      await expectNames(page, Object.keys(RECIPES))
      await shot('list')
    })
    await step(checks, 'each recipe shows exactly its allergen tags', async () => {
      await page.goto(url, { waitUntil: 'networkidle' })
      for (const [name, expected] of Object.entries(RECIPES)) {
        // Its entry, whatever the markup: the largest box around the visible name that holds no other recipe's name.
        const text = await page.evaluate(
          ([name, all]) => {
            const holds = (el: Element, n: string) => (el as HTMLElement).innerText?.includes(n)
            const leaf = [...document.querySelectorAll('body *')].find(
              (el) => (el as HTMLElement).offsetParent !== null && [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent!.includes(name)),
            )
            if (!leaf) return undefined
            let entry = leaf
            while (entry.parentElement && entry.parentElement !== document.body && !all.some((n) => n !== name && holds(entry.parentElement!, n)))
              entry = entry.parentElement
            // Its visible text nodes, spaced: adjacent badges ("gluten" "dairy") read as words, not "glutendairy".
            const walker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT)
            const words: string[] = []
            for (let node = walker.nextNode(); node; node = walker.nextNode())
              if (node.parentElement && node.parentElement.offsetParent !== null) words.push(node.textContent ?? '')
            return words.join(' ')
          },
          [name, Object.keys(RECIPES)] as const,
        )
        expect(text !== undefined, `no visible entry for ${name}`)
        const actual = Object.entries(ALLERGENS).filter(([, pattern]) => pattern.test(text!)).map(([key]) => key)
        expect(JSON.stringify(actual.sort()) === JSON.stringify([...expected].sort()),
          `${name}: expected ${expected.join(', ') || 'none'}, got ${actual.join(', ') || 'none'}`)
      }
      await shot('tags')
    })
    await step(checks, 'allergen filter hides recipes and restores them when cleared', async () => {
      await page.goto(url, { waitUntil: 'networkidle' })
      const unpick = await pick(page, /dairy|milk/i)
      await page.waitForTimeout(400)
      await expectNames(page, ['Tomato soup', 'Fried rice', 'Green Curry'])
      await shot('avoid-dairy')
      await unpick()
      await page.waitForTimeout(400)
      await expectNames(page, Object.keys(RECIPES))
      await pick(page, /gluten|wheat/i)
      await page.waitForTimeout(400)
      await expectNames(page, ['Tomato soup', 'Fried rice', 'Green Curry', 'Greek salad'])
      await shot('avoid-gluten')
    })
  } finally {
    signal?.removeEventListener('abort', abort)
    await browser.close()
  }
  if (signal?.aborted) throw new Error('cancelled')
  checks.push({ name: 'no console errors', pass: consoleErrors.length === 0,
    ...(consoleErrors.length ? { detail: consoleErrors.slice(0, 5).join(' | ') } : {}) })
  return { checks, consoleErrors, screenshots }
}

export const FEATURES: Record<string, string[]> = {
  allergens: ['each recipe shows exactly its allergen tags', 'allergen filter hides recipes and restores them when cleared'],
}
export const FEATURE_WORDS: Record<string, RegExp> = {
  allergens: /allerg|gluten|dairy|dietary|diet/i,
}
