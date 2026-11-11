/**
 * The hidden acceptance spec of Recipe site v2. Ultimate never sees it: it runs after the session, on a fresh
 * checkout of the project's `main`. It checks behaviour through roles and visible text, never through markup Ultimate
 * chose, so any reasonable build of the three features passes.
 */
import { chromium } from 'playwright-core'
import type { Page } from 'playwright-core'
import { join } from 'node:path'

export type Check = { name: string; pass: boolean; detail?: string }
export type Acceptance = { checks: Check[]; consoleErrors: string[]; screenshots: string[] }

const NAMES = ['Pancakes', 'Tomato soup', 'Fried rice', 'Green Curry', 'Banana bread', 'Greek salad']

/** Which recipe names are visible on the page right now. */
async function visibleNames(page: Page) {
  const shown: string[] = []
  for (const name of NAMES) {
    const loc = page.getByText(name, { exact: false })
    const count = await loc.count()
    for (let i = 0; i < count; i++)
      if (await loc.nth(i).isVisible()) {
        shown.push(name)
        break
      }
  }
  return shown
}

/** Numbers shown as a leaf element's whole text ("3", "(3)", "★ 3"), outside list items: badge candidates. */
async function badgeNumbers(page: Page) {
  return page.evaluate(() => {
    const out: string[] = []
    for (const el of document.querySelectorAll('body *')) {
      if (el.children.length || el.closest('li')) continue
      const text = (el.textContent ?? '').trim()
      const style = getComputedStyle(el as HTMLElement)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      const match = /^[^\d]{0,12}?(\d+)[^\d]{0,12}$/.exec(text)
      if (match && text.length <= 20) out.push(match[1]!)
    }
    // Text like "Favourites (2)" in a heading or button with children, too.
    const body = document.body.innerText
    for (const m of body.matchAll(/favou?rites?\D{0,4}(\d+)|(\d+)\s*favou?rites?/gi)) out.push(m[1] ?? m[2]!)
    return out
  })
}

const favouriteButtons = (page: Page) =>
  page.getByRole('button', { name: /favou?rite|☆|★|♡|♥|❤|heart|star/i })

async function step(checks: Check[], name: string, run: () => Promise<string | void>) {
  try {
    const detail = await run()
    checks.push({ name, pass: true, ...(detail ? { detail } : {}) })
  } catch (error) {
    checks.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

function expect(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

/** Run every check against the site served at `url`; screenshots go to `shots`. */
export async function accept(url: string, shots: string): Promise<Acceptance> {
  const browser = await chromium.launch()
  const consoleErrors: string[] = []
  const screenshots: string[] = []
  const checks: Check[] = []
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } })
  context.on('page', (page) => {
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
    page.on('pageerror', (e) => consoleErrors.push(String(e)))
  })
  const shot = async (page: Page, name: string) => {
    const path = join(shots, `${name}.png`)
    await page.screenshot({ path, fullPage: true }).catch(() => {})
    screenshots.push(path)
  }
  const page = await context.newPage()
  try {
    await step(checks, 'page loads with all recipes', async () => {
      const response = await page.goto(url, { waitUntil: 'networkidle' })
      expect(!!response?.ok(), `status ${response?.status()}`)
      const shown = await visibleNames(page)
      expect(shown.length === NAMES.length, `visible: ${shown.join(', ')}`)
      await shot(page, 'list')
    })

    await step(checks, 'search filters by name, ignoring case', async () => {
      await page.goto(url, { waitUntil: 'networkidle' })
      const box = page.getByRole('searchbox').or(page.getByRole('textbox')).first()
      expect((await box.count()) > 0, 'no search box')
      for (const query of ['CURRY', 'curry', 'gREEN']) {
        await box.fill(query)
        await page.waitForTimeout(400)
        const shown = await visibleNames(page)
        expect(
          shown.length === 1 && shown[0] === 'Green Curry',
          `"${query}" shows: ${shown.join(', ') || 'nothing'}`,
        )
      }
      await box.fill('pan')
      await page.waitForTimeout(400)
      const pan = await visibleNames(page)
      expect(pan.length === 1 && pan[0] === 'Pancakes', `"pan" shows: ${pan.join(', ')}`)
      await shot(page, 'search')
      await box.fill('')
      await page.waitForTimeout(400)
      const all = await visibleNames(page)
      expect(all.length === NAMES.length, `cleared shows: ${all.join(', ')}`)
    })

    let detailUrl = ''
    await step(checks, 'clicking a recipe opens its page at its own address', async () => {
      await page.goto(url, { waitUntil: 'networkidle' })
      const before = page.url()
      await page.getByText('Tomato soup').first().click()
      await page.waitForTimeout(800)
      detailUrl = page.url()
      expect(detailUrl !== before, 'the address did not change')
      const text = await page.locator('body').innerText()
      for (const part of ['Stock', 'Onion', '35', 'blend'])
        expect(text.includes(part), `the recipe page lacks "${part}"`)
      expect(!text.includes('Pancakes') || !text.includes('Fried rice'), 'still shows the whole list')
      await shot(page, 'detail')
      return detailUrl
    })

    await step(checks, 'a recipe address survives reload and opens directly', async () => {
      expect(!!detailUrl, 'no recipe address from the previous check')
      await page.reload({ waitUntil: 'networkidle' })
      expect((await page.locator('body').innerText()).includes('Stock'), 'reload lost the recipe')
      const fresh = await context.newPage()
      const response = await fresh.goto(detailUrl, { waitUntil: 'networkidle' })
      expect(!!response?.ok(), `direct open: status ${response?.status()}`)
      expect((await fresh.locator('body').innerText()).includes('Stock'), 'direct open lacks the recipe')
      // A second recipe's own page shows its own content.
      await fresh.goto(url, { waitUntil: 'networkidle' })
      await fresh.getByText('Banana bread').first().click()
      await fresh.waitForTimeout(800)
      const other = await fresh.locator('body').innerText()
      expect(other.includes('Bananas') && !other.includes('Stock'), 'Banana bread page shows the wrong recipe')
      await fresh.close()
    })

    await step(checks, 'a recipe page links back to the list', async () => {
      expect(!!detailUrl, 'no recipe address')
      await page.goto(detailUrl, { waitUntil: 'networkidle' })
      const back = page
        .getByRole('link', { name: /back|all recipes|recipes|list|home/i })
        .or(page.getByRole('button', { name: /back|all recipes|list|home/i }))
        .first()
      expect((await back.count()) > 0, 'no back link or button')
      await back.click()
      await page.waitForTimeout(800)
      const shown = await visibleNames(page)
      expect(shown.length === NAMES.length, `back shows: ${shown.join(', ')}`)
    })

    await step(checks, 'favourites toggle, count in a badge and survive reload', async () => {
      await page.goto(url, { waitUntil: 'networkidle' })
      await page.evaluate(() => localStorage.clear())
      await page.reload({ waitUntil: 'networkidle' })
      const buttons = favouriteButtons(page)
      expect((await buttons.count()) >= 2, `${await buttons.count()} favourite buttons`)
      const before = await badgeNumbers(page)
      await buttons.nth(0).click()
      await buttons.nth(1).click()
      await page.waitForTimeout(400)
      const two = await badgeNumbers(page)
      expect(two.includes('2'), `no badge reads 2 (before: ${before.join(',')}; now: ${two.join(',')})`)
      await shot(page, 'favourites')
      const stored = await page.evaluate(() => Object.keys(localStorage).length)
      expect(stored > 0, 'nothing in localStorage')
      await page.reload({ waitUntil: 'networkidle' })
      const reloaded = await badgeNumbers(page)
      expect(reloaded.includes('2'), `after reload no badge reads 2 (${reloaded.join(',')})`)
      await favouriteButtons(page).nth(0).click()
      await page.waitForTimeout(400)
      const one = await badgeNumbers(page)
      expect(one.includes('1') && !one.includes('2'), `unmarking left: ${one.join(',')}`)
    })
  } finally {
    await browser.close()
  }
  checks.push({
    name: 'no console errors',
    pass: consoleErrors.length === 0,
    ...(consoleErrors.length ? { detail: consoleErrors.slice(0, 5).join(' | ') } : {}),
  })
  return { checks, consoleErrors, screenshots }
}

/** Which acceptance checks belong to which feature, for the scorecard. */
export const FEATURES: Record<string, string[]> = {
  search: ['search filters by name, ignoring case'],
  detail: [
    'clicking a recipe opens its page at its own address',
    'a recipe address survives reload and opens directly',
    'a recipe page links back to the list',
  ],
  favourites: ['favourites toggle, count in a badge and survive reload'],
}

/** Words that tie a coordinator's title or intent to a feature. */
export const FEATURE_WORDS: Record<string, RegExp> = {
  search: /search|filter/i,
  detail: /detail|recipe page|route|routing|page per recipe|recipe view/i,
  favourites: /favou?rite/i,
}
