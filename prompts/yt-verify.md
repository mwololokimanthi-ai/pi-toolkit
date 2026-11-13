---
description: Transcribe a YouTube video, fact-check its claims against public sources, deliver PDF research files
argument-hint: "<youtube-url> [output-folder]"
---

Run the full pipeline for $1: transcript capture → deep read → fact-check → PDF deliverables.
Output folder: $2 if given, else /workspace/research/youtube (mkdir -p it).

## 1. Capture the transcript
- Try the `youtube_transcript` tool first.
- On HTTP 429 or "no impersonate target available": fall back to the OpenCLI bridge — `opencli youtube transcript "$1" -f yaml > /tmp/<slug>-transcript.yaml` (it runs through the user's real Chrome, bypassing datacenter-IP bot checks; space bridge calls 2-3s apart).
- Also build a plain-text version (python: strip [Chapter] markers, join cues) — it's faster to grep.
- Pull title + description via `curl -s https://r.jina.ai/$1` — the description often carries episode chapters and b-roll source links, which are verification gold.
- Get the video's publish date early (Jina metadata or the description) — it anchors every timeline claim.

## 2. Deep read (delegate, async)
Spawn an `acp_delegate` researcher (async, generous timeout) with a fully self-contained task:
- Read the ENTIRE yaml file, do not sample.
- Part 1: detailed chapter-by-chapter summary using the [Chapter] cues — the numbers, names, deal structures, anecdotes, not a thin overview.
- Part 2: numbered claim inventory — each claim with timestamp, category (company metrics / biography / industry event / partnership / market fact / opinion), and flag: WELL-KNOWN / OBSCURE / SUSPICIOUS / SELF-CLAIM.
- Part 3: internal-consistency checks (do repeated numbers agree? does the arithmetic work? ages, dates, growth rates).
- Tell it the transcript is Whisper output: proper nouns and numbers may be garbled (e.g. QuickMot=QuickMart) — note garbles, do not silently "fix" them.
- Write the full output to /tmp/<slug>-analysis.md.

## 3. Verify (in parallel while the delegate runs)
Web-verify every load-bearing external claim yourself with web_search (+ r.jina.ai for key pages):
- Biography → LinkedIn, press coverage.
- Company numbers → filings/IPO documents/annual reports, NOT directory sites (directories go stale).
- Named events, partnerships, sponsorships → primary press coverage with dates.
- Market rankings → at least two independent sources.
Do not accept the speaker's numbers as ground truth; a claim is VERIFIED only against an independent source. Watch for marketing superlatives ("first ever…") and ambiguous references ("the second year") — those are the usual overreach.

## 4. Synthesis
Merge the delegate's analysis with your verification:
- "Verified TRUE" table: claim → public evidence (name the source).
- "Overstated / Ambiguous" list with the specific issue.
- "Self-claims (plausible, not externally verifiable)" list.
- "Internal consistency" verdict.
- Bottom line: a one-paragraph credibility verdict.

## 5. Deliverables
Three documents, each as .md + .pdf in the output folder:
- <slug>_Transcript.md — chaptered transcript, source link, Whisper-garbling note.
- <slug>_Analysis.md — the delegate's full analysis.
- <slug>_Verification.md — the fact-check layer.
Conversion recipe (verified 2026-10-08, no system latex):
`pandoc in.md -f markdown -t html5 -s --metadata title="<nicename>" -H <(echo '<style>h1.title{display:none}</style>') -o /tmp/x.html`
then `uv run --with weasyprint python -c "import weasyprint; weasyprint.HTML(filename='/tmp/x.html').write_pdf('out.pdf')"` with a small CSS page (A4, page numbers, bordered tables, page-break-inside:avoid on rows).
Hiding `h1.title` is required — pandoc duplicates the metadata title over the document's own H1 otherwise.
Verify render by rasterizing page 1 (`gs -sDEVICE=png16m -r80 -o /tmp/check.png out.pdf`) and reading the PNG; gs cannot read /mnt/c paths (sandbox Permission denied) — page counts via a /tmp copy.
Large tool outputs get CCR-stored as 📦 placeholders — keep extractions small (grep/cut) instead of dumping big text into context.

## 6. Report
Deliver: what the video is (2 sentences), the credibility verdict, the verified-true table, the overstated list, file list with page counts. Offer follow-ups (extract a section, check a named entity).
