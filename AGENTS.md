# Agent instructions

## Working style

`ponytail` is active by default here: the smallest change that fully solves the task, no
unrequested abstraction, no speculative config, and one or two closing lines in a reply about
what was skipped and what risk remains. "stop ponytail" or "normal mode" turns it off; levels are
`lite`, `full` (default) and `ultra`. The ruleset is injected at session start — by
`.cursor/hooks.json` where that file is honoured, and by this file for harnesses that have no
hook API. The skill itself lives at
`~/.config/freebuff-desktop/account-skills/*/*/ponytail/SKILL.md`.

## Before committing or pushing to main

1. **`thermo-nuclear-code-quality-review` over the diff.** Report structural findings first —
   missed simplifications, spaghetti branching bolted onto unrelated flows, a file pushed past
   1,000 lines, thin wrappers, boundary leaks, casts that hide an invariant. Fix them, or say
   plainly why the cleaner structure is the wrong call. "The tests pass" is not an approval bar.
2. **`pstack`** when a task wants rigor before code: `skills/poteto-mode/SKILL.md` for the mode,
   `skills/why/SKILL.md` for root-cause work, `skills/interrogate/SKILL.md` for a hostile review.
   Read a sub-skill only when a task needs it.
3. **The push gate below.** Do not reach for `--no-verify` unless the user asks for it.

## The push gate

`.git/hooks/pre-push` runs the CI quality stage whenever `main` is being pushed: gate self-test,
build, bundle budget, typecheck, the Chromium suite, and the traversal long-task gate — about two
and a half minutes on this workstation, the 225-test suite being almost all of it. It blocks the
push on a non-zero exit and prints the skill reminder when it passes. Pushes to any other branch
are deliberately not gated, so iterate freely there.

Three things to know about it. It is a **local, unversioned** hook: a fresh clone does not have it
(see "Manual equivalent" below). It is a gate, not a formality — if it cannot run, it fails rather
than passing quietly, so `npm ci` first when dependencies are missing. And the suite **regenerates
evidence in `reports/`**: `verification.json`, `tcr-benchmark.json`, `differential-tokens.json`,
`differential-mutations.json`, `TCR-BENCHMARK.md` and `build.json`. Those diffs are `recordedAt`
and timing, plus the Node version — the committed records come from the pinned Node 22.23.3
runtime, so a local Node 24 run rewrites that field and every gzip byte count that follows it.
Committing a refreshed run is a deliberate act (see the "Refresh generated reports" commits);
do not let a gate run drag the files in by accident, and think twice before committing a Node 24
refresh over the Node 22 records the release pipeline attests to. To undo one: `git restore
--source=HEAD -- reports/`.

Manual equivalent of the whole gate:

```sh
npm run test:gates && npm run build && node scripts/ci-gates.mjs --budget \
  && npm run typecheck && npm test && node scripts/ci-gates.mjs --traversal
```

## Repo conventions

Acceptance criteria and the artifact each phase produces are in
[docs/ACCEPTANCE.md](docs/ACCEPTANCE.md); measurements land in `reports/` and are committed as
evidence. Dependencies come from the lockfile, and `dist/` is generated — never hand-edited.
