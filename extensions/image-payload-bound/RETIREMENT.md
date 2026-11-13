# Retirement trigger — image-payload-bound

Written 2026-10-27 by Task 4.3 (`docs/retirement-triggers`). Documentation only: this file
changes no behaviour.

**What it is.** A per-request guard on total image bytes. Before each LLM call it re-encodes the
oldest images into smaller tiers (1400 px/500 kB, 1000 px/250 kB, 700 px/120 kB at
`extensions/image-payload-bound/index.ts:72-74`) and only then replaces the oldest with a note
naming the file; the newest image is never dropped. The budget is
`DEFAULT_BUDGET_BYTES = 20 * 1024 * 1024` (`:59`), halved by the operator through
`PI_MAX_REQUEST_IMAGE_BYTES` (`:111`) — the kill switch and the escape hatch are the same variable.
The drop loop is at `:265-296`, the toast at `:310-317`.

## Retire when

pi core bounds the **aggregate** image payload of a request itself, so no extension-side trim is
needed. Two arms; the first is mechanical:

```
P=/workspace/node-v24.21.0-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent
/usr/bin/grep -rl 'maxRequestImageBytes\|maxTotalImageBytes\|imageBudgetBytes' "$P/dist"
/usr/bin/grep -rn 'images' "$P/dist/core/provider-composer.js" | /usr/bin/grep -c 'maxBytes'
```

A hit from the first line means pi has a request-level image budget. The second reading is the
current per-image knob (`definition.inputLimits.images.resize.maxBytes`, the field
`~/.pi/agent/models.json` sets to 1000000 for `deepseek-v4-flash`): per-image bounds stay met and
change nothing, because N images under the per-image cap still sum past the edge's body limit.

Second arm, if the symbol grep comes back empty: read pi's docs for an image budget that applies to
the whole request —
`/usr/bin/grep -rn 'inputLimits' "$P/docs"` — and treat a documented per-request total as met.

**Stated limitation, so a later reader does not trust the first arm blindly:** pi's image encoder is
inside minified bundle chunks (`dist/bundle/chunks/`), not a named module, so a differently-named
implementation would read as "not met". The second arm exists to catch that. Verify the negative with
a live probe before concluding: send one request carrying more image bytes than the budget and check
whether pi trims `(image omitted …)` / `(tool image omitted …)` blocks without this extension loaded.

## Not met — measured 2026-10-27

```
$ /usr/bin/grep -rl 'maxRequestImageBytes\|maxTotalImageBytes\|imageBudgetBytes' \
    /workspace/node-v24.21.0-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent/dist
(no output)
$ ls /workspace/node-v24.21.0-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent/dist/core | /usr/bin/grep -c compact
1                      # a compaction module; no image module
```

pi 1.4.0 has no request-level image budget: the only size knob is per image
(`inputLimits.images.resize.maxBytes`), and the encoder lives in the bundle. Both arms unmet; the
extension is still the only thing bounding the aggregate.

## How to retire it

There is no harness to run — the extension ships `index.ts` only, so the probe is stated instead:
send a request whose summed image bytes exceed 20 MiB with the extension disabled and confirm pi
trims it. Then delete the directory, drop `PI_MAX_REQUEST_IMAGE_BYTES` from `~/.bashrc` if it was
set there (it is read once at process start — a new terminal, not a `/reload`, is what changes it),
`/reload` pi, and record the reason in `bili-improvement/findings/change-register.md`.
