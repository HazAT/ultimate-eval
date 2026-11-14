// The page stays light: the site's own scripts (every .js outside test/ and scripts/, without the recipe data and the
// server) add up to at most LIMIT non-empty lines.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const LIMIT = 90
const root = join(import.meta.dirname, '..')
const skip = new Set(['test', 'scripts', 'node_modules', '.git', '.ultimate'])
const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true }))
    if (entry.isDirectory()) {
      if (!skip.has(entry.name)) walk(join(dir, entry.name))
    } else if (entry.name.endsWith('.js')) files.push(relative(root, join(dir, entry.name)))
}
walk(root)
const counted = files
  .filter((path) => path !== 'recipes.js' && path !== 'serve.js')
  .map((path) => [path, readFileSync(join(root, path), 'utf8').split('\n').filter((line) => line.trim()).length])
const total = counted.reduce((n, [, lines]) => n + lines, 0)
if (total > LIMIT) {
  console.error(
    `The site's scripts have ${total} non-empty lines, over the budget of ${LIMIT} (${counted.map(([p, n]) => `${p} ${n}`).join(', ')}). Simplify until they fit.`,
  )
  process.exitCode = 1
}
