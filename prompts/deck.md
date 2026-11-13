---
description: Turn analysis, notes or a report into a finished Presenton deck — plan first, generate after approval
argument-hint: "[source file, topic or pasted brief] [slide count] [template]"
---
Read `~/.pi/agent/skills/presenton-deck/SKILL.md` and
`~/.pi/agent/skills/presenton-deck/DECK-PROMPT.md` first. The SKILL file holds
the environment and the driver commands; the DECK-PROMPT file holds the standard
the deck has to meet. Follow both.

Requested deck: ${@:-the material most recently discussed in this session}

Work in this order:

1. **Get the source.** If $1 names a file or an earlier document, read it. If it
   names a topic, use the notes, reports or analysis already in this session
   before inventing anything. If the source is genuinely missing, ask for it
   once — do not substitute your own summary for the user's material.
2. **Run the driver's `status` command** to confirm the Presenton app is reachable
   and to read the active model and whether image generation is on.
3. **Draft the slide plan** using the DECK-PROMPT standard: one line per slide
   (number, the claim used as the title, the supporting beats, and the slide's
   job in the argument). State the slide count, template, tone and verbosity you
   propose, and name the source sections you are cutting or merging.
4. **Stop and ask for approval.** Ask one focused question — slide count, angle,
   or which sections to keep. Do not generate before the user answers.
5. **Generate** with `presenton.py generate` once approved, using the plan in
   `--instructions-file` and the source in `--content-file`.
6. **Verify** the exported file through the driver's `verified` block, compare it
   against the approved plan, and report the Windows export path, slide count,
   byte size and `edit_url`. Say plainly what the deck gets wrong.

Pass-through requests, when the arguments ask for them instead of a new deck:

- `status` — app reachable, active model, whether image generation is on.
- `templates` — list the bundled template ids and descriptions.
- `list` — the decks already saved in Presenton.
- `outline <presentation_id>` — dump a saved deck's outline.
- `verify <path>` — inspect an exported `.pptx` and report what is in it.

Constraints:

- The deck is generated on the user's own DeepSeek key. Do not start a
  generation run without an approved plan, and do not run a second one to
  "improve" a deck the user has not asked to redo.
- Never print, copy or store the app's `AUTH_SECRET_KEY`.
- Do not promise images. Image generation is off in the app's config, so slides
  get the placeholder picture unless the user has re-enabled it, and check
  `status` rather than assuming either way.
