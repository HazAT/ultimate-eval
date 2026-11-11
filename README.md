# ultimate-eval

An end-to-end benchmark for Ultimate: it runs a real Ultimate session from the first prompt to landed work, with a
model playing the user, then scores it. It compares models and thinking levels per role, finds the weakest
orchestrator that still gets there, and catches regressions when core changes.

Daniel asked for it on 2026-11-11 (the ultimate project, branch #569313, card 594). This project's own branches build
it; nobody in the ultimate project writes into it. The first phase and its rules are in the brief its @ultimate
received when the project was created.
