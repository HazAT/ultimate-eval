/**
 * A model setup: the families a run's scratch user home gets, and which family each role runs on. Roles map to agent
 * definitions (`ultimate`, `coordinator`, `worker`, …); each gets a settings-only overlay (`addTools: []`) in the
 * scratch `~/.ultimate/agents/` that sets its family, so @ultimate and coordinators can run different models even
 * though both ship on `default`. A role may instead be `{ family, codeMode?, body? }`: `codeMode: true` becomes a
 * frontmatter line (Ultimate offers that agent only codemode), `body` the overlay's text, which Ultimate appends to the
 * definition's instructions as "User additions".
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type Family = { model: string; thinking?: string }
export type Role = string | { family: string; codeMode?: boolean; body?: string }
export type Setup = {
  name: string
  families: Record<string, Family>
  roles: Record<string, Role>
}

const familyOf = (role: Role) => (typeof role === 'string' ? role : role.family)

export function readSetup(path: string): Setup {
  const setup = JSON.parse(readFileSync(path, 'utf8')) as Setup
  if (!setup.name || !setup.families?.default || !setup.roles)
    throw new Error(`${path}: a setup needs name, families.default and roles`)
  for (const [role, value] of Object.entries(setup.roles))
    if (!setup.families[familyOf(value)])
      throw new Error(`${path}: role ${role} names unknown family ${familyOf(value)}`)
  return setup
}

/** The model and thinking a role is expected to run on. */
export const expected = (setup: Setup, role: string) =>
  setup.families[setup.roles[role] ? familyOf(setup.roles[role]) : 'default']

/** The scratch overlay that gives a role its family and the setup's extras. */
export function overlay(name: string, role: Role) {
  const extra: { codeMode?: boolean; body?: string } = typeof role === 'string' ? {} : role
  return (
    `---\nname: ${name}\nfamily: ${familyOf(role)}\n` +
    (extra.codeMode ? 'codeMode: true\n' : '') +
    `addTools: []\n---\n` +
    (extra.body ? `\n${extra.body.trim()}\n` : '')
  )
}

export type ModelCheck = {
  expected: string
  ran: string[]
  status: 'ok' | 'mismatch' | 'not exercised' | 'unverified'
}

/**
 * Each configured role against the models its conversations actually ran (from their assistant entries): `ok`, a
 * `mismatch` (any other model), or `not exercised` (no conversation of that role ran).
 */
export function verifyModels(setup: Setup, ranByRole: Record<string, string[]>) {
  const out: Record<string, ModelCheck> = {}
  // Agents made on the fly have no definition, so no role to hold them to: listed as unverified, never as ok.
  if (ranByRole.unknown?.length)
    out.unknown = { expected: '(no agent definition)', ran: ranByRole.unknown, status: 'unverified' }
  for (const role of Object.keys(setup.roles)) {
    const want = expected(setup, role)!.model
    const ran = ranByRole[role] ?? []
    out[role] = {
      expected: want,
      ran,
      status: !ran.length ? 'not exercised' : ran.every((m) => m === want) ? 'ok' : 'mismatch',
    }
  }
  return out
}

/**
 * Seed `<userHome>/.ultimate`: settings (no onboarding, no self-update of the temporary clone), the projects' trust
 * (so their lander checks apply, as when the user trusts them), the families, and one overlay per role.
 */
export function seedUserHome(userHome: string, projects: string[], setup: Setup) {
  const dir = join(userHome, '.ultimate')
  mkdirSync(join(dir, 'agents'), { recursive: true, mode: 0o700 })
  const json = (name: string, value: unknown) =>
    writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + '\n')
  json('settings.json', { onboarding: false, extensions: { disable: ['update'] } })
  json('trust.json', Object.fromEntries(projects.map((p) => [p, true])))
  json('model-families.json', { recent: { families: setup.families } })
  for (const [name, role] of Object.entries(setup.roles))
    writeFileSync(join(dir, 'agents', `${name}.md`), overlay(name, role))
}
