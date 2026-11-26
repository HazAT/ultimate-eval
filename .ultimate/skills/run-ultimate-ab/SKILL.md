---
name: run-ultimate-ab
description: Run an A/B that Ultimate's @ultimate asks for (two commits of ~/Projects/ultimate, scenarios, repeat) with `pnpm eval ab`, keep the request open with an automation, and report the result. Use whenever an A/B or "compare commit X against Y" request arrives.
---

# Run an Ultimate A/B

Daniel's standing decision: run these at once, without asking (memory `ultimate-ab-requests`).

1. **Nothing else runs:** `pgrep -af '^node src/cli.ts'` and `systemctl --user list-units 'ue-*'` show nothing active. If something does, say so in your answer and start once it ends.
2. **Reuse a baseline** only when an earlier run on the base commit matches the eval commit, scenario sha, setup sha and sim prompt sha (`pins` in its `result.json`). Otherwise run both arms.
3. **Start**, from `~/Projects/ultimate-eval`:
   ```bash
   pnpm eval ab --base <sha> --head <sha> --scenario <name> [--scenario …] --repeat N [--setup setups/X.json] --name <label>
   ```
   It resolves both shas, starts the user unit `ue-ab-<label>` (survives host restarts) and returns. Inside the unit both commits pass preflight first (stream, agents and overlays, models, logins; no model calls); a failure ends the batch before anything is spent and the record says why.
4. **In the same turn**, create an automation that fires when `systemctl --user is-active ue-ab-<label>` is no longer `active`, subscribed to you. Never grep the log: the command line carries every word. Your answer in this turn is interim ("started, N runs, ~M min"), so the request stays open.
5. **When it fires**, read `runs/ab-<label>.json` (`pnpm eval ab --status <label>` prints it). `complete: true` with `error` means it stopped early (preflight, cancel); not complete means the unit died: read the log tail.
   Then read each run's `runs/<id>/result.json`.
6. **Report**, answering the request:
   - run ids per arm, pass/N, median minutes and cost;
   - each failure with `failure.reason` and `failure.stuck`;
   - board routing (pending replies, duplicates), `scorecard.watchdog`, real tool errors (`scorecard.toolErrorDetail.real`);
   - what the scenario did not exercise (models `not exercised`, features without a coordinator).

   Advisory only; it never blocks their lander. Anything fishy beyond the request goes to Daniel first (`ask-before-reporting-anomalies`).

Before a single paid run outside a batch: `pnpm eval preflight --commit <sha> [--setup FILE]`.
