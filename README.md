# ultimate-eval

An end-to-end benchmark for Ultimate: it runs a real Ultimate session from the first prompt to landed work, with a
model playing the user, then scores it. It compares models and thinking levels per role, finds the weakest
orchestrator that still gets there, and catches regressions when core changes.

Daniel asked for it on 2026-11-11 (the ultimate project, branch #569313, card 594); phase 1's picks are on card 6 of
this project's #119.

## Run

```bash
pnpm install
pnpm eval run --commit <sha|main> [--setup setups/today.json] [--scenario recipe-v2] [--repeat N] [--keep]
pnpm eval report      # passes/N, median minutes and cost per commit × setup × scenario
pnpm eval rescore [id…]   # rebuild finished runs' scorecards from what they stored (new checks reach old runs)
pnpm check && pnpm test
```

`--repo` defaults to `~/Projects/ultimate`, which is only read: the run clones it with `git clone --shared`.
Runs go one after another; each spends real subscription quota (estimate: $3–15 list), so schedule them at night.

## What one run does (`src/run.ts`)

1. Clones the commit under test into `/tmp/ue-run-<id>/ultimate` (no `origin`), `pnpm install --prefer-offline`.
2. Copies the scenario's `fixture/` into a fresh git repository with one commit and **no remote**.
3. Seeds an empty user home (`setup.ts`): `onboarding: false`, self-update off, the project trusted (so its lander
   checks run), the setup's model families, and one settings-only agent overlay per role (`addTools: []`, `family:`),
   so @ultimate, coordinators and workers can run different models.
4. Starts the commit's supervisor (`bin/ultimate.ts`) on its own `ULTIMATE_HOME` and `ULTIMATE_USER_HOME`, with every
   inherited `ULTIMATE_*` variable removed. Logins are read in place through the real `HOME`, never copied.
5. The simulated user (`src/sim.ts`) talks to it over the HTTP API as the web UI does: submit to @ultimate, answer
   question cards with `questions/answer` (a multi answer as a list from ce22290 on, joined with ", " before), read
   the `/api/events` stream. It is `claude -p` on Opus 5.5 at low effort with no tools and its own short system prompt
   (about 1k tokens a call), fixed across runs and pinned by `simPromptSha`.
6. Watchdog: more than 30 minutes after the first prompt is `timeout`; 10 minutes without progress (something
   Ultimate said, a real change in its conversations, tasks or messages, or a user action; the simulated user's
   waits and stream reconnects do not count) is `hang`; a dead supervisor, or no event stream for 2 minutes (a dead
   or restart-looping core), is `crash`. Each records where it stood (`failure.stuck`) and the cost so far. Every
   API request is bounded. Ctrl+C or TERM stops the run as `cancelled` (kept in `runs/`, left out of the matrix) and
   cleans up; a second signal kills at once.
7. Collects every conversation's history and the Messages log over the API, stops the server, copies its sqlite files.
8. Runs the project's tests and the hidden acceptance spec (`scenarios/<name>/accept.ts`, Playwright, never inside the
   project) on a fresh clone of the project's `main`, with screenshots.
9. Deletes `/tmp/ue-run-<id>` and Claude Code's session folders for it under `~/.claude/projects/` (unless `--keep`).

## Results (`runs/<id>/`, gitignored)

- `result.json`: pins (`ultimateCommit`, `scenarioSha`, `setup`/`setupSha`, families, roles, sim model and
  `simPromptSha`), `pass`, `status`, `failure`, `minutes`, `features`, `acceptance`, `projectTests`, `noRemote`,
  `models` (each configured role: `ok`, `mismatch` or `not exercised`, from what its conversations' assistant
  entries ran, with each conversation's role taken from its `ultimate.agent-profile` definition in the stopped home,
  never from its display label; a mismatch fails the run; agents made on the fly have no definition and are listed as
  `unverified`), `answerShape`, `sim` (calls, cost,
  improvised answers, nudges, refused answers), and the `scorecard`: coordinators matched to features, workers per
  coordinator, plans, landings (and that nothing was pushed), timing, tokens and cost per model, cache hit rate,
  questions asked with their kinds and wait (multi-choice cards asked and answered), watchdog failures, tool errors
  and checks (below).
  - `toolErrors` counts real errors only. `toolErrorDetail` sorts every failed tool result:
    - **benign**, counted apart: `killed` is bash exit 143 (the agent stopping its own dev server); `serverNotUp`
      is a browser or screenshot `ERR_CONNECTION_REFUSED`, or curl exit 7, before the server was up;
    - **real**, each listed with conversation and entry: `dirtyWorktree` (a submit with an unresolved merge),
      `enoent`, `bashExit` (any other failed command), `unknown` (refused tool calls, script errors).
  - `checks`: hard checks, each gated. A failed `finding` is recorded, shown on the Bench and counted in the
    report's findings column, and the run still passes; a failed `pass` gate fails the run.
    - Always: **every coordinator works on a feature** (a coordinator matching no feature is an extra one).
    - From the scenario's `expect.json`, which is left out of `scenarioSha`, so adding one keeps the matrix rows:
      - `card {kind?}`: a reply-expected card, with a `kind` question when given;
      - `askedFirst`: that card came before the first `git commit` anywhere;
      - `landFailedFirst`: a landing failed on a lander check (a merge conflict does not count), and everything
        still landed;
      - `untouched {paths}`: those files are unchanged on main against the fixture commit.
- `transcripts/`: every conversation, the Messages log, the conversation list; `sim.json`: every simulated-user turn
  with its prompt and decision; `screenshots/`; `acceptance.json`; `project-tests.txt`; `home/` (sqlite, supervisor log).

A run passes when the simulated user said done with nothing busy, every acceptance check and the project's tests
pass, every coordinator landed (a lander note with a commit; ordinary notes do not count), no role ran an unexpected model, and the project still has no remote and nothing was pushed. Workers and plans are
measured, not required.

Not verified: the thinking level that ran (no API exposes it); `models` checks the model only.

## Scenarios

`scenarios/<name>/`: `scenario.md` (the card the simulated user plays: goal, done, prepared answers, limits; it never
names files or code), `fixture/` (the starting project, with its own tests and lander checks), `accept.ts` (the
hidden spec, its feature map and the words that match coordinators to features).

| Scenario | What it tests | `expect.json` |
|---|---|---|
| `recipe-v2` | three features in parallel | none |
| `recipe-v2-pick` | the same, picked from a multi card | `card multi` (finding) |
| `recipe-bug` | search and favourites built, with two planted bugs reported as symptoms | `untouched` (finding) |
| `recipe-land-fail` | recipe-v2's goal, with a stricter lander check: the site's scripts stay within 90 non-empty lines. In smoke runs on ce22290 (4/4), coordinators read the lander's checks and met them before submitting, so no landing failed; a README rule before it went the same way. It measures whether agents meet the checks up front; recovery from a failed landing gets its own scenario later (Daniel, 2026-11-14) | `landFailedFirst` (finding) |
| `recipe-ambiguous` | "make the site nicer for people with allergies"; the answers make it allergen tags plus a filter | `card`, `askedFirst` (findings) |

A variant changes only the card: `recipe-v2-pick` links `fixture` to recipe-v2's and re-exports its `accept.ts`, and
asks Ultimate to let the person tick which features to build now (a multi-choice card exercises `answerShape`). The
matrix shows per row in how many runs a multi card was asked and answered.
