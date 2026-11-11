/**
 * A model setup: the families a run's scratch user home gets, and which family each role runs on. Roles map to agent
 * definitions (`ultimate`, `coordinator`, `worker`, …); each gets a settings-only overlay (`addTools: []`) in the
 * scratch `~/.ultimate/agents/` that sets its family, so @ultimate and coordinators can run different models even
 * though both ship on `default`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type Family = { model: string; thinking?: string }
export type Setup = {
  name: string
  families: Record<string, Family>
  roles: Record<string, string>
}

export function readSetup(path: string): Setup {
  const setup = JSON.parse(readFileSync(path, 'utf8')) as Setup
  if (!setup.name || !setup.families?.default || !setup.roles)
    throw new Error(`${path}: a setup needs name, families.default and roles`)
  for (const [role, family] of Object.entries(setup.roles))
    if (!setup.families[family]) throw new Error(`${path}: role ${role} names unknown family ${family}`)
  return setup
}

/** The model and thinking a role is expected to run on. */
export const expected = (setup: Setup, role: string) => setup.families[setup.roles[role] ?? 'default']

export type ModelCheck = { expected: string; ran: string[]; status: 'ok' | 'mismatch' | 'not exercised' }

/**
 * Each configured role against the models its conversations actually ran (from their assistant entries): `ok`, a
 * `mismatch` (any other model), or `not exercised` (no conversation of that role ran).
 */
export function verifyModels(setup: Setup, ranByRole: Record<string, string[]>) {
  const out: Record<string, ModelCheck> = {}
  // A child whose definition we could not tell ran something we cannot check: say so rather than pass it.
  if (ranByRole.unknown?.length)
    out.unknown = { expected: '(no subagents.started record)', ran: ranByRole.unknown, status: 'mismatch' }
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
 * Seed `<userHome>/.ultimate`: settings (no onboarding, no self-update of the temporary clone), the project's trust
 * (so its lander checks apply, as when the user trusts it), the families, and one overlay per role.
 */
export function seedUserHome(userHome: string, project: string, setup: Setup) {
  const dir = join(userHome, '.ultimate')
  mkdirSync(join(dir, 'agents'), { recursive: true, mode: 0o700 })
  const json = (name: string, value: unknown) =>
    writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + '\n')
  json('settings.json', { onboarding: false, extensions: { disable: ['update'] } })
  json('trust.json', { [project]: true })
  json('model-families.json', { recent: { families: setup.families } })
  for (const [role, family] of Object.entries(setup.roles))
    writeFileSync(
      join(dir, 'agents', `${role}.md`),
      `---\nname: ${role}\nfamily: ${family}\naddTools: []\n---\n`,
    )
}
