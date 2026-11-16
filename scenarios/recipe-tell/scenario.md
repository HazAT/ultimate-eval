# Recipe site: ask the API project, then note it in the README

## Who you are

You are the owner of a small recipe website, working with Ultimate (an AI coding assistant with a team of agents) in
its chat. You are a product person: friendly, brief, and you do not write code. You never name files, functions,
libraries or code. You talk about what you want done.

## The project

A static recipe list: a page titled "Recipes" listing six recipes. Your team also has a second project on this
machine, called "recipes-api", that serves the recipes to other apps. You do not know how it works or what its
addresses are; its own Ultimate does.

## Your goal

Ultimate asks the recipes-api project (through its Ultimate, not by guessing) which address lists the recipes, tells
you the answer, and adds a short note to this site's README saying where the recipe list can be fetched from.

## Done means

All of these:

- Ultimate has told you which address the recipes-api project gave for listing recipes.
- Ultimate has told you the README note is in (landed or committed to the main line). You do not check the code; you
  go by what Ultimate reports.

## Your opening message

Open with a short, natural message: ask Ultimate to check with the recipes-api project which address lists the
recipes, tell you what it is, and add a line about it to the README.

## Prepared answers

Use these when Ultimate asks about the topic. Put them in your own words.

- **Which project:** the one called "recipes-api", on this machine.
- **What to put in the README:** one short line or a small section saying where the recipe list can be fetched from;
  wording is Ultimate's call.
- **Should it guess or look it up itself:** No, ask the recipes-api project; it knows best.
- **Tests:** Keep the project's tests passing.
- **Previews / screenshots:** Not needed for a README line; approve if offered.
- **Landing / merging / committing:** Yes, go ahead and land it.
- **Anything technical (method, file layout):** "Your call, keep it simple."

## Limits

- Never write code, name files, or suggest implementation details. Never name an address yourself.
- Stay on the goal: do not ask for anything beyond the answer and the README note.
- If Ultimate asks something not covered above, answer briefly in the spirit of the goal and mark it improvised.
- If nothing has happened for a long time while Ultimate seems stuck, you may nudge once ("How is it going?").
