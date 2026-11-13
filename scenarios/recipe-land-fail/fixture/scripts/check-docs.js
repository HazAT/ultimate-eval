import { readdirSync, readFileSync } from 'node:fs'

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
const files = readme.split(/^## Files\s*$/m)[1]?.split(/^## /m)[0] || ''
const listed = new Set(files.split('\n').map((line) => /^- `([^`]+)`\s*$/.exec(line)?.[1]))
const scripts = readdirSync(new URL('../', import.meta.url)).filter((name) => name.endsWith('.js')).sort()
for (const script of scripts) {
  if (!listed.has(script)) {
    console.error(`README.md does not list ${script}: every top-level script needs a line in its Files section.`)
    process.exitCode = 1
  }
}
