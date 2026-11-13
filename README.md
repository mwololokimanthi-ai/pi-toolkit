# pi-toolkit

Extensions, prompts and skills for the **pi** agent harness — the working set I use daily, extracted from the configuration repository rather than written for show.

The theme is narrow: an agent that runs unattended for hours needs *continuity*, *guards* and *measurement*. These are the pieces that provide them.

## What each piece solves

| Piece | Problem it addresses | Mechanism |
|---|---|---|
| **session-handoff** | A long session cannot be continued forever, and `/new` throws away everything the next session needs. Client-side compaction rewrites history and destroys the blocks it covers. | Reads the session's own transcript and writes a deterministic brief: goal, last request, state, files, open items. **No model call, no rewrite.** Refreshes only after 10 MB and then every +5 MB. |
| **bash-guard** | An agent with shell access will eventually run `rm -rf`, force-push, or pipe a download into `sh`. | Shell-aware parsing at the tool boundary. Interactive session: prompt with **Run / Abort**. Subagent (no UI, stdin `/dev/null`): hard-block a focused set of unrecoverable operations. Remembers aborted commands for 60 s to stop retry loops. |
| **image-payload-bound** | Image-heavy requests grow without bound and silently cost context. | Per-request byte budget; re-encodes the oldest images into smaller tiers before dropping any; the newest image is never dropped; one environment variable is both kill switch and budget. |
| **strategic-compact-suggest** | Compaction happens at the wrong time — either never, or mid-task. | Suggests *when*; never compacts on its own. The decision stays with the operator. |
| **patch-guard** | A local patch registry can silently drift out of sync after an upgrade. | At session start, verifies every registered patch is still applied; re-applies through the driver when it is not. Retired when the registry is empty — see `RETIREMENT.md`. |
| **prompt-snippets** | Re-typing the same instructions invites drift. | A typed library of snippets (`orchestrator-mode`, `ask-questions`, `verify-not-assume`, `delegate-exploration`, `diagnose-report`, `session-kickoff`). |
| **mnemos-wake** | Memory that is never loaded is not memory. | Injects the relevant memory at session start, before the first turn. |
| **coms** | Project identity leaks across sessions and themes. | Project-scoped slug and theme mapping, with tests. |

### Skills

| Skill | Use |
|---|---|
| `analyze-sessions` | Cost, tool use, error taxonomy and before/after impact across session transcripts. Turns "the agent feels slow" into a number. |
| `git-safe-workflow` | Branch, stage, commit and push without destructive shortcuts. |
| `code-review` | Structured review passes with explicit severity. |
| `debugging` | Expected / observed / error loop, one question at a time. |

### Prompts

Twenty-five templates covering the APM workflow (planner → manager → worker → handoff → recovery), plus `code-review`, `debug`, `explain`, `learn`, `retrieve`, `test`, `arch` and `autopsy`.

## Design rules

1. **Deterministic before generative.** If extraction can produce the artifact, do not call a model. `session-handoff` is the clearest case: the same transcript always yields the same brief.
2. **Guards fail closed.** An unattended process gets a block, not a prompt it cannot answer.
3. **Never rewrite what you cannot restore.** Compaction suggestions are suggestions; handoffs are additive.
4. **Label the uncertainty.** Heuristics are recorded as heuristics, with the rung or mode that produced them.
5. **Every guard has a retirement condition.** Two of these are retired and kept as reference, with the trigger documented in `RETIREMENT.md`.

## Layout

```
extensions/
  session-handoff/            deterministic session brief (test included)
  bash-guard/                 shell guard, interactive and headless modes
  image-payload-bound/        per-request image budget (retired, reference)
  patch-guard/                patch registry integrity (retired, reference)
  strategic-compact-suggest/  compaction timing advice
  prompt-snippets/            typed snippet library
  mnemos-wake/                memory injection at session start
  coms/                       project-scoped identity
prompts/                      25 reusable prompt templates
skills/                       analyze-sessions, git-safe-workflow, code-review, debugging
docs/ARCHITECTURE.md          where each hook sits in the request lifecycle
```

## Status

Reference implementations, not a packaged distribution. They target the pi extension API and are published to show the engineering, the tests and the trade-offs. Some are intentionally retired; the retirement note explains what would have to be true to bring them back.

## Tests

```console
$ node --experimental-strip-types extensions/session-handoff/handoff.test.mjs
41 passed, 0 failed

$ node extensions/coms/projectScope.test.mjs
8 passed, 0 failed
```

Outside the harness, set `TYPEBOX_PATH` to typebox's ESM entry so the handoff test can rewrite the bare import. `bash-guard/test-phone-race.mjs` needs a device-attestation harness and is kept as a regression case rather than a portable test.

## License

MIT.
