// Tests for session-handoff. The brief is extraction, so the assertions are about what a
// continuation needs (last ask, where the work stood, files, open threads), not formatting.
//
// The shipped .ts is imported through a rewritten copy - only the bare `typebox` specifier changes,
// because pi resolves it and bare node cannot.
//
//   node --experimental-strip-types --no-warnings handoff.test.mjs [real-session.jsonl]
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dir = mkdtempSync(join(tmpdir(), "handoff-test-"));
process.env.SESSION_HANDOFF_DIR = join(dir, "handoffs");
process.env.SESSION_JOURNEY_DIR = join(dir, "journeys");
// Outside the harness, point TYPEBOX_PATH at typebox's ESM entry; inside it,
// the bare specifier resolves normally.
const TYPEBOX = process.env.TYPEBOX_PATH || "";
const rewritten = join(dir, "handoff-real.ts");
writeFileSync(
  rewritten,
  readFileSync(join(process.cwd(), "index.ts"), "utf8").replace('from "typebox"', TYPEBOX ? `from "${TYPEBOX}"` : 'from "typebox"'),
);
const { snapshot, brief, handoffPath, journeyPath, readJourney, appendJourney, default: factory } =
  await import(rewritten);

let pass = 0;
let fail = 0;
function check(name, ok, extra = "") {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? `\n       ${extra}` : ""}`);
  }
}

const line = (o) => `${JSON.stringify(o)}\n`;
const fixture = join(dir, "01aabbcc-1111-2222-3333-444455556666.jsonl");
writeFileSync(
  fixture,
  [
    line({ type: "session", id: "01aabbcc", timestamp: "2026-10-05T10:00:00.000Z" }),
    line({
      type: "message",
      timestamp: "2026-10-05T10:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "Fix the thing" }] },
    }),
    line({
      type: "message",
      timestamp: "2026-10-05T10:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "On it." },
          { type: "toolCall", id: "c1", name: "bash", arguments: { command: "git status" } },
          {
            type: "toolCall",
            id: "c2",
            name: "apply_patch",
            arguments: { patch: "*** Begin Patch\n*** Update File: /workspace/a.ts\n@@\n+x\n*** End Patch" },
          },
        ],
      },
    }),
    line({
      type: "message",
      timestamp: "2026-10-05T10:00:03.000Z",
      message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "clean" }] },
    }),
    line({
      type: "message",
      timestamp: "2026-10-05T10:00:04.000Z",
      message: {
        role: "toolResult",
        toolName: "todo",
        content: [{ type: "text", text: "#1 [in_progress] Fix the thing" }],
      },
    }),
    line({ type: "message", timestamp: "2026-10-05T10:00:05.000Z", message: { role: "user", content: "and the other one" } }),
  ].join(""),
  "utf8",
);

console.log("A · snapshot");
const s = snapshot(fixture);
check("counts entries and messages", s.entries === 6 && s.messages === 5, `${s.entries}, ${s.messages}`);
check("keeps both user turns", s.user.length === 2 && s.user[1] === "and the other one", JSON.stringify(s.user));
check("spans first to last timestamp", s.first === "2026-10-05T10:00:00.000Z" && s.last === "2026-10-05T10:00:05.000Z");
check("tallies tool calls", s.tools.get("bash") === 1 && s.tools.get("apply_patch") === 1, JSON.stringify([...s.tools]));
check("takes the patch's path, not arguments.path", s.files.get("/workspace/a.ts") === 1, JSON.stringify([...s.files]));
check("keeps the last todo result", (s.todo ?? "").includes("in_progress"), String(s.todo));
check("ignores non-message entries", !s.user.some((u) => u.includes("01aabbcc")));

console.log("B · brief");
const text = brief(s, fixture, "/workspace");
check("names the session", text.includes("# Handoff - session 01aabbcc"), text.slice(0, 120));
check("carries the goal", text.includes("Fix the thing"));
check(
  "numbers the opening messages",
  text.includes("## How it opened (first 2 of 2 user messages)"),
  text.slice(0, 400),
);
check("carries the last ask", text.includes("## Last ask") && text.includes("and the other one"));
check("carries where it stood", text.includes("## Where the work stood") && text.includes("On it."));
check("lists the file in play", text.includes("`/workspace/a.ts` (1)"));
check("shows the tool mix", /bash 1 .*apply_patch 1/.test(text), text);
check("shows the open thread", text.includes("## Open threads") && text.includes("[in_progress]"));
check("names the session file", text.includes(fixture));

console.log("C · torn tail line");
writeFileSync(fixture, readFileSync(fixture, "utf8") + '{"type":"message","mes', "utf8");
check("a half-written last line is skipped", snapshot(fixture).messages === 5);

console.log("D · output path");
check(
  "one file per session, named by the full id",
  handoffPath("01aabbcc-1111-2222-3333-444455556666").endsWith("01aabbcc-1111-2222-3333-444455556666.md"),
);
check("path honours SESSION_HANDOFF_DIR", handoffPath("01aabbcc-1111").startsWith(dir));

console.log("E · real 22 MB session (smoke)");
const real = process.argv[2];
if (!real) {
  console.log("  skip (pass a session .jsonl to run this)");
} else {
  const t0 = Date.now();
  const r = snapshot(real);
  const ms = Date.now() - t0;
  const doc = brief(r, real, "/workspace");
  check(`read ${r.messages} messages in ${ms} ms`, r.messages > 100 && ms < 5000, `${ms} ms`);
  check("has a goal and an ask", r.user.length > 1 && r.user[0].length > 0);
  check("has files in play", r.files.size > 3, JSON.stringify([...r.files].slice(0, 5)));
  check("has a todo list", (r.todo ?? "").length > 0);
  check("brief is a page, not a transcript", doc.length > 500 && doc.length < 20000, `${doc.length} chars`);
  console.log(`\n--- brief head ---\n${doc.split("\n").slice(0, 14).join("\n")}\n---`);
}

// ── The rolling half lives in handlers, so the last two scenarios drive a fake pi ──────────
const handlers = new Map();
let tool = null;
let command = null;
factory({ on: (n, h) => handlers.set(n, h), registerCommand: (_n, o) => (command = o), registerTool: (t) => (tool = t) });
const SID2 = "01aabbcc-1111-2222-3333-444455556666";
const live = join(dir, "live.jsonl");
const notes = [];
const ctx = {
  cwd: "/workspace",
  sessionManager: { getSessionId: () => SID2, getSessionFile: () => live },
  ui: { notify: (text, level) => notes.push({ text, level }) },
};
const settle = () => handlers.get("agent_settled")({}, ctx);
const refreshes = () => notes.filter((n) => n.text.startsWith("handoff refreshed")).length;

/** A session file of about `mb` MB, in the shapes snapshot() already understands. */
const tiny = (mb) =>
  line({ type: "session", id: "01aabbcc", timestamp: "2026-10-05T10:00:00.000Z" }) +
  line({
    type: "message",
    timestamp: "2026-10-05T10:00:01.000Z",
    message: { role: "user", content: "hello" },
  }) +
  line({
    type: "session",
    id: "pad",
    timestamp: "2026-10-05T10:00:02.000Z",
    pad: "x".repeat(mb * 1_048_576),
  });

console.log("F · rolling refresh");
{
  check("registers the settled handler", typeof handlers.get("agent_settled") === "function");
  check("registers the journey tool", tool?.name === "journey_append", String(tool?.name));
  check("still registers /handoff", (command?.description ?? "").includes("handoff brief"));

  // 1 MB: below AUTO_MIN_MB, so settling never writes a brief for a session nobody would retire.
  writeFileSync(live, tiny(1));
  settle();
  check("a small session is never briefed", !existsSync(handoffPath(SID2)), handoffPath(SID2));

  // 11 MB: into retire territory, so the first settle writes it.
  writeFileSync(live, tiny(11));
  settle();
  check("an 11 MB session is briefed", existsSync(handoffPath(SID2)));
  const briefAt = () => readFileSync(handoffPath(SID2), "utf8");
  check(
    "the brief names the session file and its current size",
    briefAt().includes("live.jsonl") && briefAt().includes("11.0 MB"),
    briefAt().slice(0, 200),
  );
  check("the refresh is announced once", refreshes() === 1, JSON.stringify(notes));

  settle();
  check("an unchanged session is not re-briefed", refreshes() === 1, JSON.stringify(notes));

  writeFileSync(live, tiny(13));
  settle();
  check("2 MB of growth is still the session it describes", refreshes() === 1, JSON.stringify(notes));

  writeFileSync(live, tiny(18));
  settle();
  check("5 MB of growth re-briefs it", refreshes() === 2, JSON.stringify(notes));
  check(
    "the refresh overwrites one path instead of filling the folder",
    readdirSync(join(dir, "handoffs")).length === 1,
    JSON.stringify(readdirSync(join(dir, "handoffs"))),
  );
  check(
    "the later refresh carries the new state, not the old one",
    briefAt().includes("18.0 MB"),
    briefAt().slice(0, 200),
  );
}

console.log("G · journey");
{
  const cwd = "/workspace/project-b";
  check(
    "one file per project, not per session",
    journeyPath(cwd).endsWith("/workspace-project-b.md"),
    journeyPath(cwd),
  );
  check("a project that never appended one reads empty", readJourney(cwd) === "");

  appendJourney(cwd, "watcher", "Added the 10/20 MB size warning.", new Date("2026-10-05T12:00:00Z"));
  check(
    "appends a dated, titled segment",
    readJourney(cwd).includes("## 2026-10-05T12:00:00.000Z - watcher") &&
      readJourney(cwd).includes("10/20 MB size warning"),
    readJourney(cwd),
  );

  const withJourney = brief(snapshot(fixture), fixture, cwd);
  check(
    "the brief carries the journey",
    withJourney.includes("## How this project got here (journey)") &&
      withJourney.includes("10/20 MB size warning"),
    withJourney.slice(0, 500),
  );
  check(
    "orientation rides above the session's own opening",
    withJourney.indexOf("journey") < withJourney.indexOf("## How it opened"),
    withJourney.slice(0, 500),
  );

  for (let i = 0; i < 12; i++) {
    appendJourney(
      cwd,
      `round ${i}`,
      "y".repeat(700),
      new Date(`2026-10-05T13:${String(i).padStart(2, "0")}:00Z`),
    );
  }
  const bounded = readJourney(cwd);
  check("stays inside its budget", bounded.length <= 4200, String(bounded.length));
  check("keeps the newest segment", bounded.includes("## 2026-10-05T13:11:00.000Z - round 11"));
  check("says where the rest went", /_older segments archived to /.test(bounded), bounded.slice(0, 300));
  const archives = readdirSync(join(dir, "journeys")).filter((f) => f.includes("-archive-"));
  check(
    "the moved segments are a file, not a deletion",
    archives.length >= 1 && readFileSync(join(dir, "journeys", archives[0]), "utf8").includes("round 0"),
    JSON.stringify(archives),
  );

  const out = await tool.execute("t1", { topic: "via tool", segment: "Written through the tool." }, undefined, undefined, {
    cwd,
  });
  check(
    "the tool appends through the same file",
    out.content[0].text.includes(journeyPath(cwd)) && readJourney(cwd).includes("via tool"),
    out.content[0].text,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
