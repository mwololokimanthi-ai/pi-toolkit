#!/usr/bin/env python3
"""Before/after impact check: did a fix or standing rule actually work?

Compare error-category counts in the sessions BEFORE a change vs AFTER it.
The categories map to the standing rules / fixes applied to ~/.pi/agent:

  guard-block      bash-guard blocks (rule B: destructive commands)
  edit-mismatch    stale oldText / "Could not find the exact text" (rule C)
  bili-down        "bili tool error: fetch failed" (rule D: pre-run health check)
  observer-block   "[bili-observer] blocked: this fold starts at" (fold guard,
                   removed 2026-10-15 with commit b2938ff when upstream issue 2572
                   was closed as designed — matches are pre-removal history only)
  python-not-found bare `python` on PATH (rule F: use python3)
  gh-spawn         "spawn gh EACCES" (fix E: gh on PATH)
  eisdir           reading a directory path (rule F: list dirs first)

Examples:
  python3 impact.py --changed 2026-10-08
  python3 impact.py --changed 2026-10-08 --since 30d
  python3 impact.py --changed 2026-10-08 --cwd <pi-home>
  python3 impact.py --changed 2026-10-08 --json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import sessions as S  # noqa: E402

# Order matters: first matching category wins.
CATEGORIES = [
    ("guard-block", "rule B", [
        re.compile(r"Blocked by bash-guard"),
        re.compile(r"Blocked by user via bash-guard"),
    ]),
    ("gh-spawn", "fix E", [
        re.compile(r"spawn gh"),
        re.compile(r"gh search.*failed"),
    ]),
    ("bili-down", "rule D", [
        re.compile(r"bili tool error: fetch failed"),
    ]),
    # Historical only: the head-fold guard was deleted on 2026-10-15 (commit b2938ff, upstream
    # issue 2572 closed as designed), so nothing emits this line any more. The pattern is kept
    # so the era before the removal can still be measured against the era after it.
    ("observer-block", "guard", [
        re.compile(r"\[bili-observer\] blocked: this fold starts at"),
    ]),
    ("edit-mismatch", "rule C", [
        re.compile(r"Could not find the exact text"),
        re.compile(r"oldText not found"),
        re.compile(r"Could not find edits\["),
        re.compile(r"not unique"),
    ]),
    ("python-not-found", "rule F", [
        re.compile(r"python[0-9.]*: command not found"),
    ]),
    ("eisdir", "rule F", [
        re.compile(r"EISDIR"),
        re.compile(r"is a directory"),
    ]),
]

CONSOLIDATION_MARKER = "INERT DATA"


def classify(tool: str, text: str) -> str | None:
    if tool == "github_search":  # tool-level: one error result == one failed call
        return "gh-spawn"
    for name, _rule, pats in CATEGORIES:
        for p in pats:
            if p.search(text):
                return name
    return None


def scan(since: datetime | None, until: datetime | None,
         cwd_substrs: list[str]) -> dict:
    """Return {category: count, 'total_errors': int, 'sessions': int,
    'by_day': {YYYY-MM-DD: {category: count}}, 'earliest': datetime|None}
    for the window. earliest = oldest matching event timestamp (for window math)."""
    counts = defaultdict(int)
    by_day = defaultdict(lambda: defaultdict(int))
    sessions_seen = set()
    earliest: datetime | None = None

    for path in S.iter_session_files(include_subagents=True):
        # Cheap pre-filter: skip files that don't touch the window.
        is_sub = S.is_subagent_path(path)
        # Read pass: first detect consolidation sessions and window overlap.
        started = None
        consolidated = False
        events = []
        try:
            f = path.open("r", encoding="utf-8", errors="replace")
        except OSError:
            continue
        with f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                t = rec.get("type")
                if t == "session":
                    started = S.ts_from_iso(rec.get("timestamp")) if rec.get("timestamp") else None
                    cwd = rec.get("cwd") or ""
                elif t == "message":
                    m = rec.get("message") or {}
                    role = m.get("role")
                    mts = m.get("timestamp")
                    when = S.ts_from_ms(int(mts)) if isinstance(mts, (int, float)) else None
                    if role == "user" and not consolidated:
                        txt = S._extract_text(m.get("content"))
                        if CONSOLIDATION_MARKER in txt:
                            consolidated = True
                    if role == "toolResult" and m.get("isError") and not consolidated:
                        txt = S._extract_text(m.get("content"))
                        events.append((when, m.get("toolName") or "?", txt))
        if consolidated:
            continue
        if cwd_substrs:
            cwd_low = (cwd or "").lower()
            if not any(sub.lower() in cwd_low for sub in cwd_substrs):
                continue
        for when, tool, txt in events:
            if since and when and when < since:
                continue
            if until and when and when > until:
                continue
            if when:
                sessions_seen.add(path.name)
                if earliest is None or when < earliest:
                    earliest = when
            cat = classify(tool, txt)
            if cat is None:
                continue
            counts[cat] += 1
            counts["total_errors"] += 1
            if when:
                by_day[when.astimezone().strftime("%Y-%m-%d")][cat] += 1

    counts["sessions"] = len(sessions_seen)
    return {"counts": dict(counts), "by_day": dict(by_day), "earliest": earliest}


def verdict(before: int, after: int, after_days: float) -> str:
    if after_days < 7 or after < 3:
        return "too early to tell (short/quiet after window)"
    if after < before:
        pct = (before - after) / before * 100 if before else 0
        return f"IMPROVED ({before} -> {after}, -{pct:.0f}%)"
    if after == before:
        return "no change"
    pct = (after - before) / before * 100 if before else 0
    return f"REGRESSED ({before} -> {after}, +{pct:.0f}%)"


def main() -> int:
    p = argparse.ArgumentParser(description="Before/after impact check for fixes and standing rules.")
    p.add_argument("--changed", required=True, metavar="WHEN",
                   help="Date the change took effect (YYYY-MM-DD or ISO). Splits before/after.")
    p.add_argument("--since", metavar="WHEN",
                   help="Start of the BEFORE window (default: full history). Same formats as cost.py.")
    p.add_argument("--until", metavar="WHEN",
                   help="End of the AFTER window (default: now).")
    p.add_argument("--cwd", action="append", default=[], metavar="SUBSTR",
                   help="Restrict to sessions whose cwd contains this substring. Repeatable.")
    p.add_argument("--json", action="store_true", help="Emit JSON.")
    args = p.parse_args()

    changed = S.parse_date(args.changed)
    since = S.parse_date(args.since) if args.since else None
    until = S.parse_date(args.until) if args.until else datetime.now(timezone.utc)

    before = scan(since, changed, args.cwd)
    after = scan(changed, until, args.cwd)

    after_days = max((until - changed).total_seconds() / 86400, 0)
    before_start = since or (before["earliest"] or changed)
    before_days = max((changed - before_start).total_seconds() / 86400, 0)

    if args.json:
        print(json.dumps({
            "before": {"window_days": round(before_days, 1), **before},
            "after": {"window_days": round(after_days, 1), **after},
        }, indent=2, default=str))
        return 0

    header = f"{'category':<18} {'rule':<8} {'before':>7} {'after':>7}  verdict"
    start_lbl = f"{since.date()}" if since else f"{before_start.date()} (history start)"
    print(f"Windows: BEFORE {before_days:.1f}d ({start_lbl}..{changed.date()})  |  AFTER {after_days:.1f}d ({changed.date()}..now)  [dates are UTC]\n{header}")
    print("-" * len(header))
    cats = [c for c, _, _ in CATEGORIES]
    for cat in cats + ["total_errors"]:
        b = before["counts"].get(cat, 0)
        a = after["counts"].get(cat, 0)
        rule = dict((c, r) for c, r, _ in CATEGORIES).get(cat, "-")
        v = "-" if cat == "total_errors" else verdict(b, a, after_days)
        print(f"{cat:<18} {rule:<8} {b:>7} {a:>7}  {v}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
