# Retirement trigger — patch-guard

Written 2026-10-27 by the Manager, after Task 4.3 wrote triggers for the other eleven units and
substituted `codemode-patch-guard` for this one. Documentation only: no behaviour changes.

**What it does.** Runs at `session_start` and checks that every patch named in
`patches/reapply-all.sh` is still applied to its target file; when one is not, it runs the driver
to re-apply it. Its in-process fast path decides whether the driver runs at all.

**Retire when the registry it protects is empty**, checked with:

```
grep -oP '^PATCHES="\K[^"]*' patches/reapply-all.sh
```

When that returns nothing — every local patch has been retired because upstream absorbed it — this
extension has nothing to guard, and both it and its `CHECKS` table should be deleted together.

**Not yet met:** the same command returns eight names on 2026-10-27
(`bili-compress-floor feynman-header-off pi-agent-ide-defer pi-codemode-classify pi-deferred-tools
pi-deepseek-peak-live pi-reflag-grep-h subagent-close-vanished`), so eight patches still depend on
this guard running.

**Kill switch:** none of its own. It gates re-application, not model behaviour, and it fails open —
an unreadable patch state logs and continues rather than blocking a session.
