# ultimate-eval

An end-to-end benchmark for Ultimate: it runs a real Ultimate session from the first prompt to landed work, with a
model playing the user, then scores it. It compares models and thinking levels per role, finds the weakest
orchestrator that still gets there, and catches regressions when core changes.

Daniel asked for it on 2026-11-11 (the ultimate project, branch #569313, card 594); phase 1's picks are on card 6 of
this project's #119.

## Run

```bash
pnpm install
pnpm eval run --commit <sha|main> [--setup setups/today.json] [--scenario recipe-v2] [--repeat N] [--keep] [--export]
pnpm eval report [--from results]   # passes/N, median minutes and cost per commit × setup × scenario × eval commit
pnpm eval export      # results/<id>.json: the cleaned-up, published result of each finished run (only when asked)
pnpm eval rescore [id…]   # rebuild finished runs' scorecards from what they stored (new checks reach old runs)
pnpm check && pnpm test
```

`--repo` defaults to `~/Projects/ultimate`, which is only read: the run clones it with `git clone --shared`.
Runs go one after another; each spends real subscription quota, about $2–3 a run, or about $0.5 for a reminder or
tell run. A/Bs that Ultimate's @ultimate requests run at once, not scheduled for later (Daniel, card 91).
A matrix row holds the runs of one Ultimate commit × setup × scenario made by one harness (eval commit and simulated
user's prompt sha), so its medians never mix harness versions.
A script looping over several calls (an A/B) sets `EVAL_PLAN=i/N` on each, so Bench's `status` and the status line
show the overall position (`run 2/4`) rather than the repeat within one call.

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
   waits and stream reconnects do not count) is `hang`, unless an automation an agent created has a scheduled fire
   still ahead (a reminder everyone waits for; the 30-minute budget still bounds it); a dead supervisor, or no event stream for 2 minutes (a dead
   or restart-looping core), is `crash`. Each records where it stood (`failure.stuck`) and the cost so far. Every
   API request is bounded. Ctrl+C or TERM stops the run as `cancelled` (kept in `runs/`, left out of the matrix) and
   cleans up; a second signal kills at once.
7. Collects every conversation's history and the Messages log over the API, stops the server, copies its sqlite files.
8. Runs the project's tests and the hidden acceptance spec (`scenarios/<name>/accept.ts`, Playwright, never inside the
   project) on a fresh clone of the project's `main`, with screenshots.
9. Deletes `/tmp/ue-run-<id>` and Claude Code's session folders for it under `~/.claude/projects/` (unless `--keep`).

## Local results (`runs/<id>/`, gitignored)

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
      - `untouched {paths}`: those files are unchanged on main against the fixture commit;
      - `reminder`: an automation was created, it fired, and the user heard from Ultimate after its first fire (a
        message to the user, or an @ultimate answer). Automations come from the stopped home's `ultimate.automations`
        ledger, dream's built-in ones left out; `scorecard.automations` counts them in every run.
    - Always, as findings, from the Messages log at the end: **every reply-expected message answered** (none left
      sent, delivered or failed) and **no message sent twice** (same sender, recipient and text).
- `transcripts/`: every conversation, the Messages log, the conversation list; `sim.json`: every simulated-user turn
  with its prompt and decision; `screenshots/`; `acceptance.json`; `project-tests.txt`; `home/` (sqlite, supervisor log).

A run passes when the simulated user said done with nothing busy, every acceptance check and the project's tests
pass, every coordinator landed (a lander note with a commit; ordinary notes do not count), no role ran an unexpected model, and the project still has no remote and nothing was pushed. Workers and plans are
measured, not required.

Not verified: the thinking level that ran (no API exposes it); `models` checks the model only.

## Published results (`results/<id>.json`, tracked)

Nothing reaches `results/` on its own: `pnpm eval export`, or `pnpm eval run --export` at the end of its runs, writes
one cleaned-up file per finished run in `runs/`; cancelled and still-running runs are skipped. A plain `pnpm eval run`
(a smoke or verification run) stays in the gitignored `runs/`, so it never lands in the tracked folder by accident. Each field is copied by name (`src/export.ts`, an allowlist):

- pins: Ultimate and eval commits, scenario and setup with their shas, families, roles, sim model, effort and prompt sha;
- `pass`, `status`, `minutes`, `startupSec`, total `costUsd`, and on failure its `reason`, `atMin` and where it
  stood as counts only (busy conversations, open questions, minutes since progress);
- features, acceptance checks, hard checks (name, pass, gate), project tests, `allLanded`, `noRemote`, models per role;
- scorecard numbers: coordinators started and landed, workers, plans, landings and pushes, timing, tokens and cost
  per model, cache hit rate, questions (asked, cards, multi asked and answered, wait seconds), watchdog failures and
  retries, tool errors by category; the simulated user's calls, cost, improvised answers, nudges and refusals.

Everything else stays in `runs/`: transcripts, `sim.json`, question texts, conversation titles and intents, check and
failure details, the main log, screenshots and the home. Before writing anything, the export scans its output and
refuses every file if one contains `@`, `/home/`, a word starting with `tail`, `.ts.net`, `127.0.0.1`, `localhost` or
an email-like string. `pnpm eval report --from results` rebuilds the matrix from the published files.

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
| `recipe-reminder` | search only, plus "remind me in about 2 minutes to try it": an automation fires and its answer reaches the user | `reminder` (pass) |
| `recipe-ambiguous` | "make the site nicer for people with allergies"; the answers make it allergen tags plus a filter | `card`, `askedFirst` (findings) |

Every fixture's `index.html` declares an inline icon (`<link rel="icon" href="data:,">`): without it the browser's
`/favicon.ico` request was a console 404, and agents started extra coordinators to fix it. The accept specs launch new
headless Chromium (`channel: 'chromium'`), which makes that request like the agents' browser does. The fix changed
every scenario's sha on 2026-11-15, so rows from before it sit in their own matrix rows.

A variant changes only the card: `recipe-v2-pick` links `fixture` to recipe-v2's and re-exports its `accept.ts`, and
asks Ultimate to let the person tick which features to build now (a multi-choice card exercises `answerShape`). The
matrix shows per row in how many runs a multi card was asked and answered.
