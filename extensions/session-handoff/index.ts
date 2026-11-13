/**
 * session-handoff - a deterministic brief for the session that replaces this one.
 *
 * WHY THIS EXISTS
 * A long pi session cannot be continued forever. Past ~20 MB of session .jsonl, billion-context's
 * folded message ids stop matching and 72-92% of the folded originals start travelling the wire
 * unfolded (bili-observer warns at 10 MB and 20 MB), and there is no repair path - the session has
 * to be retired. `/new` then throws away everything the next session needs in order to continue.
 *
 * The usual answer is a client-side compaction (pi-vcc), which rewrites the history and destroys
 * every bili block it covers (see extensions/no-native-compaction). This is the other half of that
 * trade: no rewrite, no model call, nothing to undo. `/handoff` reads this session's own .jsonl,
 * writes the brief - what the session was for, what was asked last, where the work stood, what was
 * run, what files were in play, what is still open - and you paste it into the new session.
 *
 * WHAT IT DOES
 * Reads ctx.sessionManager.getSessionFile() once and writes ~/.pi/agent/handoffs/<session-id>.md
 * (SESSION_HANDOFF_DIR overrides the folder). One file per session, overwritten on every refresh: a
 * brief is current state, not a snapshot to compare against. The same session always yields the same
 * brief: this is extraction, not summarisation.
 *
 * It also rolls by itself. Briefing a small session wastes the read, so the refresh only starts once
 * the .jsonl has passed 10 MB, and then only when it has grown a further 5 MB (or doubled) since the
 * last brief - a handful of refreshes per session, not one per turn, each costing one sequential read
 * of the .jsonl (~2-5 s on a 70 MB session) while the agent is idle. SESSION_HANDOFF_AUTO=0 turns it
 * off; the widget bili-observer draws reads this file's mtime, so a stalled refresh is visible there.
 *
 * The journey is the other half: one file per project at ~/.pi/agent/journeys/<slug>.md, prose the
 * agent appends with journey_append, so a new session inherits why the project is the way it is and
 * not only where the last one stopped. It is bounded - past 4000 chars the oldest segments move to an
 * archive beside it - and the brief carries the tail that remains.
 *
 * WHAT IT DOES NOT DO
 * It does not call a model, does not touch the session, and never decides what mattered. An item
 * missing from the brief is missing from the transcript, not lost on the way out. The journey is
 * written by the agent and never inferred: an unappended project has no journey section at all.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const HANDOFF_DIR =
  process.env.SESSION_HANDOFF_DIR ?? join(homedir(), ".pi", "agent", "handoffs");
const JOURNEY_DIR =
  process.env.SESSION_JOURNEY_DIR ?? join(homedir(), ".pi", "agent", "journeys");
const JOURNEY_CHARS = 4000; // how much journey stays live in the file, and travels in the brief
const AUTO_MIN_MB = 10; //     no brief at all until the session is into retire territory
const AUTO_GROWTH_MB = 5; //   refresh once the .jsonl grew this much since the last brief
const AUTO_FACTOR = 2; //      ...or doubled, whichever comes first
const OPEN_COUNT = 3; //   how many opening user messages to show
const OPEN_CHARS = 500; // and how much of each
const ASK_CHARS = 900; //   the most recent user message
const STATE_CHARS = 2400; // the last thing the assistant said
const CMD_CHARS = 220; //   per bash command
const CMD_COUNT = 4;
const FILE_COUNT = 24; //   distinct paths listed
const TOOL_COUNT = 10;
const TODO_CHARS = 1600;

interface Block {
  type?: string;
  text?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

interface Entry {
  type?: string;
  timestamp?: string;
  message?: { role?: string; toolName?: string; content?: unknown };
}

export interface Snap {
  first: string;
  last: string;
  entries: number;
  messages: number;
  user: string[];
  assistant: string[];
  bash: string[];
  files: Map<string, number>;
  tools: Map<string, number>;
  todo: string | null;
}

function blocks(content: unknown): Block[] {
  return Array.isArray(content) ? (content as Block[]) : [];
}

/** Text of a message: either a bare string or the `text` blocks of a content array. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return blocks(content)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

function clip(s: string, n: number): string {
  const t = s.trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n).trimEnd()}\n[... ${t.length - n} more characters]`;
}

function tally(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Read a session .jsonl into the handful of facts a continuation needs. Pure apart from the read. */
export function snapshot(file: string): Snap {
  const s: Snap = {
    first: "",
    last: "",
    entries: 0,
    messages: 0,
    user: [],
    assistant: [],
    bash: [],
    files: new Map(),
    tools: new Map(),
    todo: null,
  };

  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let d: Entry;
    try {
      d = JSON.parse(line) as Entry;
    } catch {
      continue; // a torn tail line is normal in a live session file
    }
    s.entries++;
    if (d.timestamp) {
      if (!s.first) s.first = d.timestamp;
      s.last = d.timestamp;
    }
    if (d.type !== "message") continue;
    const m = d.message ?? {};
    s.messages++;

    if (m.role === "user") {
      const t = textOf(m.content);
      if (t.trim()) s.user.push(t);
      continue;
    }
    if (m.role === "assistant") {
      const t = textOf(m.content);
      if (t.trim()) s.assistant.push(t);
      for (const b of blocks(m.content)) {
        if (b.type !== "toolCall" || typeof b.name !== "string") continue;
        tally(s.tools, b.name);
        const a = b.arguments ?? {};
        if (b.name === "bash" && typeof a.command === "string") s.bash.push(a.command);
        if (typeof a.path === "string") tally(s.files, a.path);
        // apply_patch carries its paths inside the patch text, not in arguments.path
        if (typeof a.patch === "string") {
          for (const mm of a.patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
            tally(s.files, mm[1].trim());
          }
        }
      }
      continue;
    }
    if (m.role === "toolResult" && m.toolName === "todo") {
      const t = textOf(m.content);
      if (t.trim()) s.todo = t; // the last todo state the old session saw
    }
  }
  return s;
}

/** Render the brief. No model call: every line traces to something in the transcript. */
export function brief(s: Snap, file: string, cwd: string): string {
  // Real session files are named "<ISO-timestamp>_<uuid>.jsonl"; a bare "<uuid>.jsonl" also shows up.
  const base = file.replace(/\.jsonl$/, "").split(/[/\\]/).pop() ?? "?";
  const sid =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(base)?.[0] ?? base;
  const mb = (statSync(file).size / 1_048_576).toFixed(1);
  const tools = [...s.tools.entries()].sort((a, b) => b[1] - a[1]);
  const files = [...s.files.entries()].sort((a, b) => b[1] - a[1]);
  const out: string[] = [];

  out.push(`# Handoff - session ${sid}`);
  out.push("");
  out.push(
    `\`${file}\` · ${mb} MB · ${s.entries} entries · ${s.messages} messages · ` +
      `${tools.reduce((n, t) => n + t[1], 0)} tool calls`,
  );
  out.push(`${s.first || "?"} to ${s.last || "?"} · cwd ${cwd}`);
  out.push("");
  // The opening message is not always the goal: a session started from a slash command carries the
  // template body as its first user message, so the brief shows the first few rather than guessing.
  // Orientation before detail: the journey is the only part of this brief that spans sessions, and
  // the only part written by a model (the old one) rather than extracted from the transcript.
  const course = readJourney(cwd);
  if (course) {
    out.push("## How this project got here (journey)");
    out.push("");
    out.push(clip(course, JOURNEY_CHARS));
    out.push("");
    out.push(`_(appended with journey_append; file: \`${journeyPath(cwd)}\`)_`);
    out.push("");
  }
  const open = Math.min(OPEN_COUNT, s.user.length);
  out.push(`## How it opened (first ${open} of ${s.user.length} user messages)`);
  out.push("");
  if (s.user.length === 0) out.push("(no user message recorded)");
  for (let i = 0; i < open; i++) {
    out.push(`**${i + 1}.** ${clip(s.user[i], OPEN_CHARS)}`);
    out.push("");
  }
  out.push("## Last ask");
  out.push("");
  out.push(clip(s.user[s.user.length - 1] ?? "(none)", ASK_CHARS));
  out.push("");
  out.push("## Where the work stood (last assistant message)");
  out.push("");
  out.push(clip(s.assistant[s.assistant.length - 1] ?? "(none)", STATE_CHARS));

  if (s.bash.length) {
    out.push("");
    out.push(`## Last ${Math.min(CMD_COUNT, s.bash.length)} command(s) run`);
    out.push("");
    out.push("```sh");
    for (const c of s.bash.slice(-CMD_COUNT)) out.push(clip(c, CMD_CHARS));
    out.push("```");
  }

  if (files.length) {
    out.push("");
    out.push(`## Files in play (${files.length} distinct)`);
    out.push("");
    for (const [p, n] of files.slice(0, FILE_COUNT)) out.push(`- \`${p}\` (${n})`);
    if (files.length > FILE_COUNT) out.push(`- ... ${files.length - FILE_COUNT} more`);
  }

  if (tools.length) {
    out.push("");
    out.push("## Tool mix");
    out.push("");
    out.push(tools.slice(0, TOOL_COUNT).map(([n, c]) => `${n} ${c}`).join(" · "));
  }

  if (s.todo) {
    out.push("");
    out.push("## Open threads (last todo list the old session saw)");
    out.push("");
    out.push("```");
    out.push(clip(s.todo, TODO_CHARS));
    out.push("```");
  }

  out.push("");
  out.push("---");
  out.push(
    "Paste this into the new session. The old one is retired because of fold drift, not because " +
      "the work was done - if something here is stale, the session file above is the full record.",
  );
  return out.join("\n");
}

/** One file per project: the folder is the project, the session is incidental. */
export function journeyPath(cwd: string): string {
  const slug = cwd.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";
  return join(JOURNEY_DIR, `${slug}.md`);
}

export function readJourney(cwd: string): string {
  const p = journeyPath(cwd);
  return existsSync(p) ? readFileSync(p, "utf8").trim() : "";
}

/**
 * Append one dated segment, then keep the file under JOURNEY_CHARS by moving its oldest segments
 * into an archive beside it. Structural, like everything else here: no model, no rewrite of what
 * stays, and nothing deleted - an archive is a file the next reader can open.
 */
export function appendJourney(
  cwd: string,
  topic: string,
  segment: string,
  at = new Date(),
): { path: string; chars: number; archived: number; archive: string | null } {
  const path = journeyPath(cwd);
  mkdirSync(JOURNEY_DIR, { recursive: true });
  if (!existsSync(path)) writeFileSync(path, `# Journey - ${cwd}\n`);
  appendFileSync(path, `\n## ${at.toISOString()} - ${topic.trim()}\n\n${segment.trim()}\n`);

  const text = readFileSync(path, "utf8");
  if (text.length <= JOURNEY_CHARS) {
    return { path, chars: text.length, archived: 0, archive: null };
  }
  // Segments begin at "\n## "; parts[0] is the header plus any note from an earlier trim.
  const parts = text.split(/\n## /);
  const keep: string[] = [];
  let size = parts[0].length + 1;
  for (let i = parts.length - 1; i >= 1; i--) {
    const seg = `\n## ${parts[i]}`;
    if (size + seg.length > JOURNEY_CHARS && keep.length > 0) break;
    keep.unshift(seg);
    size += seg.length;
  }
  const moved = parts.slice(1, parts.length - keep.length);
  if (moved.length === 0) return { path, chars: text.length, archived: 0, archive: null };

  const stamp = at.toISOString().replace(/[:.]/g, "-");
  const archive = path.replace(/\.md$/, `-archive-${stamp}.md`);
  appendFileSync(archive, `# Journey archive - ${cwd}\n${moved.map((s) => `\n## ${s}`).join("")}`);
  const head = parts[0].split("\n_older segments")[0].trimEnd();
  const kept = `${head}\n_older segments archived to ${archive}_\n${keep.join("")}\n`;
  writeFileSync(path, `${kept}\n`);
  return { path, chars: kept.length, archived: moved.length, archive };
}

/** One brief per session, overwritten: a brief is current state, not a snapshot to compare against. */
export function handoffPath(sessionId: string): string {
  return join(HANDOFF_DIR, `${sessionId}.md`);
}

interface Briefed {
  path: string;
  chars: number;
  bytes: number;
}

function sessionFileOf(c: {
  sessionManager?: { getSessionFile?: () => string | undefined };
}): string | null {
  let file: string | undefined;
  try {
    file = c.sessionManager?.getSessionFile?.();
  } catch {
    file = undefined;
  }
  return file && existsSync(file) ? file : null;
}

/** The session's directory; the context owns it, process.cwd() is the fallback. */
function dirOf(c: { cwd?: string }): string {
  return c.cwd ?? process.cwd();
}

function writeBrief(file: string, sessionId: string, cwd: string): Briefed {
  const text = brief(snapshot(file), file, cwd);
  mkdirSync(HANDOFF_DIR, { recursive: true });
  const path = handoffPath(sessionId);
  writeFileSync(path, text);
  return { path, chars: text.length, bytes: statSync(file).size };
}

export default function (pi: ExtensionAPI) {
  // The last brief this process wrote, so the next refresh can tell growth from noise. pi runs one
  // session per process, so module state here is per-session state.
  let briefed: { bytes: number; at: number } | null = null;

  pi.registerCommand("handoff", {
    description: "Write a handoff brief for the next session (no model call, no history rewrite)",
    handler: async (_args, c) => {
      const file = sessionFileOf(c);
      if (!file) {
        c.ui.notify("handoff: this session has no file on disk yet - nothing to read.", "warning");
        return;
      }
      try {
        const r = writeBrief(file, c.sessionManager.getSessionId(), dirOf(c));
        briefed = { bytes: r.bytes, at: Date.now() };
        c.ui.notify(
          `handoff written to ${r.path} (${r.chars} chars) - paste it into the new session`,
          "info",
        );
      } catch (e) {
        c.ui.notify(`handoff failed: ${String(e)}`, "error");
      }
    },
  });

  // The rolling half. A session is briefed only once it is into retire territory, and then only when
  // it has grown enough to make the last brief misleading - so a long session gets a handful of
  // refreshes rather than one per turn, and never a rewrite of anything.
  pi.on("agent_settled", (_event, c) => {
    if (process.env.SESSION_HANDOFF_AUTO === "0") return;
    const file = sessionFileOf(c);
    if (!file) return;
    try {
      const bytes = statSync(file).size;
      const mb = bytes / 1_048_576;
      if (mb < AUTO_MIN_MB) return;
      if (
        briefed &&
        mb - briefed.bytes / 1_048_576 < AUTO_GROWTH_MB &&
        bytes < briefed.bytes * AUTO_FACTOR
      ) {
        return; // still the session the last brief describes
      }
      const r = writeBrief(file, c.sessionManager.getSessionId(), dirOf(c));
      briefed = { bytes: r.bytes, at: Date.now() };
      c.ui.notify(
        `handoff refreshed - ${mb.toFixed(1)} MB session, brief at ${r.path} (${r.chars} chars)`,
        "info",
      );
    } catch (e) {
      c.ui.notify(`handoff refresh failed: ${String(e)}`, "error");
    }
  });

  // The journey is written by the agent, never inferred - this tool is the only way in.
  pi.registerTool({
    name: "journey_append",
    label: "journey append",
    description:
      "Append a short dated segment to this project's journey file - the durable, cross-session " +
      "narrative of what the project is and how it got here, which every later handoff brief " +
      "carries. Use it when something would be expensive to rediscover: a decision and its reason, " +
      "a pivot, a constraint, a dead end not worth repeating. A few sentences, not a transcript.",
    parameters: Type.Object({
      topic: Type.String({ description: "Short topic line, e.g. 'cache: bili vs pi-vcc verdict'" }),
      segment: Type.String({
        description: "What changed or was decided, and why - a few sentences of plain prose",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      // The runtime context carries cwd (types.d.ts:221); the tool-facing type does not expose it.
      const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
      try {
        const r = appendJourney(cwd, params.topic, params.segment);
        const moved = r.archive ? `, oldest segment(s) archived to ${r.archive}` : "";
        return {
          content: [
            { type: "text" as const, text: `journey: ${r.path} (${r.chars} chars${moved})` },
          ],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `journey_append failed: ${String(e)}` }] };
      }
    },
  });
}
