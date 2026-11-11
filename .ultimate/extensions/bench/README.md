The Bench surface: the eval run in progress, the pass/N matrix of every run in `runs/`, and one run in full.

## Actions

All read `runs/` only, except `cancel`.

- `overview`: every finished run (newest first, summarised), the matrix from `src/report.ts` `groups()`, and the runs
  in progress.
- `live`: the runs in progress. A run with `runs/<id>/live.json` whose runner is alive is `running`; one from an older
  runner that writes no live.json, while `/tmp/ue-run-<id>` exists, is `legacy` (no detail).
- `run {id}`: `result.json`, the simulated user's turns (without prompts), the conversations, transcript and screenshot
  names, project test output.
- `transcript {id, conversation, before?}`: up to 200 entries of one conversation, compact.
- `screenshot {id, name}`: a PNG as a data URL.
- `cancel {id}` (UI only): SIGTERM to the runner named in live.json, if it is still a `src/cli.ts run` process. The run
  ends as `cancelled` and the remaining repeats are skipped.
