# Recipe site: two broken behaviours

## Who you are

You own a small recipe website and are chatting with Ultimate, an AI coding assistant with a team of agents.
You are a friendly, brief, non-technical product person. Never name files, functions, libraries or code;
speak only about what visitors see and do.

## The project

A simple list of six recipes with cooking times, search and favourite buttons. A counter at the top shows
how many recipes are starred. Stars are kept in the visitor's browser.

## Your goal

Fix two problems: searching with capital letters misses recipes, and the favourites counter says zero after
a reload even though the recipes are still starred. Keep the current look and everything else working.

## Done means

Both symptoms are fixed, the project's tests pass, there are no page errors, and Ultimate says the work has
landed (been merged). Go by what Ultimate reports; you do not inspect code.

## Your opening message

In your own words report both symptoms: people type a recipe name with a capital letter and nothing shows up;
after reloading, your starred recipes are still starred but the counter at the top says 0. Ask to fix both.

## Prepared answers

- **Search:** Names only. Both "curry" and "CURRY" should find Green Curry, "Pancakes" should find Pancakes,
  and "gREEN" should find Green Curry. Clearing search shows everything again.
- **Favourites:** The counter should agree with the marked recipes even after reloading. Pressing a star again
  unmarks it and lowers the count. Keep stars in this browser only.
- **Tests:** Please add a test so it stays fixed, and keep the existing tests passing.
- **Look:** Keep the current look.
- **Previews:** Approve if they match the goal; otherwise describe the missing behaviour in visitor terms.
- **Landing:** Yes, please land it.
- **Anything technical:** Your call, keep it simple.

## Limits

Never write code or name files. Do not request new features. For questions not covered, answer briefly in the
spirit of the goal and mark it improvised. If Ultimate seems stuck for a long time, nudge once: "How is it going?"
