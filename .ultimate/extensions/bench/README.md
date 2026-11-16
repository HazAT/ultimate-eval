The Bench surface: the eval run in progress, the pass/N matrix of every run in `runs/`, and one run in full.

## Surface (`web.tsx`)

Bench, in the switcher, with the agent docked (a phone shows it from the title bar instead):

- Left, every finished run, newest first. Middle, the overview: the run in progress (phase, elapsed since the first
  prompt against the 30-minute budget, coordinators landed or working, the latest turns, the scratch instance's URL
  marked watch only, and cancel behind a confirmation), then the matrix, one row per commit × setup × scenario with
  pass/N, medians, features and each run.
- A run: its verdict and, when it failed, where it stood; tabs for the scorecard (acceptance, coordinators, questions
  asked, usage per model, models by role, pins), the simulated user (its decisions with Ultimate's lines between them,
  improvised ones marked), transcripts (one conversation at a time, tool calls folded), screenshots and test output.
- `live` is polled every 3 s while Bench is on screen; a run leaving it reloads the overview.
- The status line shows `Eval · run 2/4 · running` while a run is in progress (from `status`, polled every 10 s
  while the tab is visible); a click opens Bench. The position is the A/B plan's when `EVAL_PLAN` is set, else the
  `--repeat` position, and is left out for a single run.

Files: `web.tsx` (the surface), `overview.tsx`, `live.tsx`, `detail.tsx`, `transcript.tsx`, `parts.tsx`,
`types.ts` (action refs and result shapes).

## Actions

All read `runs/` only, except `cancel`.

- `overview`: every finished run (newest first, summarised), the matrix from `src/report.ts` `groups()`, and the runs
  in progress.
- `live`: the runs in progress. A run with `runs/<id>/live.json` whose runner is alive is `running`; one from an older
  runner that writes no live.json, while `/tmp/ue-run-<id>` exists, is `legacy` (no detail).
- `run {id}`: `result.json`, the simulated user's turns (without prompts), the conversations, transcript and screenshot
  names, project test output.
- `transcript {id, conversation, before?}`: up to 200 entries of one conversation, compact; an entry without a message
  (the lander's steps) carries its `data` as cut JSON.
- `screenshot {id, name}`: a PNG as a data URL.
- `status` (for other instances and agents): the runs in progress, compact, from `src/live.ts` `status()`:
  `{ runs: [{ id, scenario, commit, phase, repeat: { index, total }, plan?: { index, total }, startedAt, updatedAt }] }`,
  newest first, at most 10. Only unfinished runs whose live.json names a live runner; it reads nothing but those
  live.json files. `commit` is the Ultimate commit under test; `startedAt` (launch) and `updatedAt` are epoch ms.
  `repeat` counts within one `pnpm eval run --repeat N`; `plan` is the call's place in a script looping over several
  calls, present only when the script sets `EVAL_PLAN=i/N` for each call. Another instance reaches it with
  `POST /api/extensions/bench/actions/status` (`lib/remote.ts` `postAction`), as Ultimate's projects rail calls
  `status/status`; it is a poll action, so its calls stay out of the trace.
- `progress` (for other instances): the newest run in progress as one step, `{ label: 'run', index, total }` from its
  `plan` when set, else its `repeat`; `null` when nothing runs. Ultimate's built-in `status/status` calls it on every
  enabled extension, so another instance shows "waits on ultimate-eval · run 2/4". From `src/live.ts` `progress()`,
  as cheap as `status`, and a poll action too.
- `cancel {id}` (UI only): SIGTERM to the runner named in live.json, if it is still a `src/cli.ts run` process. The run
  ends as `cancelled` and the remaining repeats are skipped.
