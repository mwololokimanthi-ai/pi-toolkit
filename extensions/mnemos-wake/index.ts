/**
 * Mnemos wake for pi.
 *
 * Captures the continuity packet from the Mnemos CLI at session start and
 * puts it into the session as an extension-authored custom message before the
 * user's first turn. Pi's `before_agent_start` return value is kept as a
 * fallback: it is the only surface that is guaranteed to be part of the first
 * model request, but it lands after the user message in the transcript.
 *
 * Every failure resolves to "no memory" and one non-blocking UI warning. No
 * handler may throw: this extension runs in every session.
 */

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const WAKE_CUSTOM_TYPE = "mnemos-wake";
export const CUE_CUSTOM_TYPE = "mnemos-cue";
export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_CUE_TIMEOUT_MS = 1800;

/** Set MNEMOS_WAKE_DEBUG=1 to log wake/cue decisions to /tmp/mnemos-wake-debug.log. */
const DEBUG = process.env.MNEMOS_WAKE_DEBUG === "1";
function debugLog(entry: Record<string, unknown>): void {
  if (!DEBUG) return;
  try {
    appendFileSync(
      "/tmp/mnemos-wake-debug.log",
      JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry }) + "\n",
    );
  } catch {
    /* diagnostics must never break a session */
  }
}
const MAX_STDOUT = 2 * 1024 * 1024;
const MAX_STDERR = 16 * 1024;

export type ProducerFailure =
  | "spawn-error"
  | "exit-nonzero"
  | "timeout"
  | "unparseable"
  | "missing-context"
  | "empty"
  | "hook-error"
  | "aborted";

export type ProducerResult =
  | { ok: true; packet: string }
  | { ok: false; reason: ProducerFailure; detail?: string };

export interface WakeConfig {
  command: string;
  agentId: string;
  dbPath: string;
  timeoutMs: number;
  /** Scope the cue query uses; must match the MCP server's scope. */
  personId: string;
  projectScope: string;
  /** The cue answers on a tight budget: it must not delay a prompt. */
  cueTimeoutMs: number;
}

export interface ProducerInput {
  model?: string;
  sessionId?: string;
  cwd?: string;
}

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  spawnImpl?: typeof spawn;
}

export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

export function loadConfig(baseDir: string): WakeConfig {
  const path = join(baseDir, "wake.json");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    // Fail closed: a missing or malformed deployment file must not silently
    // fall back to a different agent identity and database.
    throw new Error(`cannot read ${path}: ${String(error)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${path} is not a JSON object`);
  }
  const agentId =
    typeof raw.agentId === "string" && raw.agentId.trim()
      ? raw.agentId.trim()
      : "";
  if (!agentId) throw new Error(`${path} has no agentId`);
  const command =
    typeof raw.command === "string" && raw.command.trim()
      ? raw.command.trim()
      : "mnemos";
  const rawDb =
    typeof raw.dbPath === "string" && raw.dbPath.trim()
      ? raw.dbPath.trim()
      : `~/.mnemos/${agentId}.db`;
  const timeout =
    typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs)
      ? Math.min(Math.max(raw.timeoutMs, 250), 30000)
      : DEFAULT_TIMEOUT_MS;
  const personId =
    typeof raw.personId === "string" && raw.personId.trim()
      ? raw.personId.trim()
      : "user";
  const projectScope =
    typeof raw.projectScope === "string" && raw.projectScope.trim()
      ? raw.projectScope.trim()
      : "global";
  const cueTimeout =
    typeof raw.cueTimeoutMs === "number" && Number.isFinite(raw.cueTimeoutMs)
      ? Math.min(Math.max(raw.cueTimeoutMs, 250), 5000)
      : DEFAULT_CUE_TIMEOUT_MS;
  return {
    command,
    agentId,
    dbPath: expandHome(rawDb),
    timeoutMs: timeout,
    personId,
    projectScope,
    cueTimeoutMs: cueTimeout,
  };
}

export function producerArgs(config: WakeConfig): string[] {
  return [
    "--agent-id",
    config.agentId,
    "--db-path",
    config.dbPath,
    "hook",
    "session-start",
  ];
}

/** `mnemos hook prompt` reads one message and prints the memories that bear on it. */
export function cueArgs(config: WakeConfig): string[] {
  return [
    "--agent-id",
    config.agentId,
    "--person-id",
    config.personId,
    "--project-scope",
    config.projectScope,
    "--db-path",
    config.dbPath,
    "hook",
    "prompt",
  ];
}

/** Validate the CLI's documented stdout contract. */
export function parseHookOutput(stdout: string): ProducerResult {
  const text = (stdout ?? "").trim();
  if (!text) return { ok: false, reason: "empty" };
  let data: any;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: "unparseable", detail: String(error) };
  }
  const context = data?.hookSpecificOutput?.additionalContext;
  if (typeof context !== "string") {
    return { ok: false, reason: "missing-context" };
  }
  const packet = context.trim();
  if (!packet) return { ok: false, reason: "empty" };
  return { ok: true, packet };
}

/**
 * Run one `mnemos hook ...` command, bounded by a timeout, and resolve to a
 * result. This never rejects.
 */
function runHook(
  config: WakeConfig,
  args: string[],
  payload: Record<string, unknown>,
  options: RunOptions = {},
  defaultTimeoutMs: number = config.timeoutMs,
  cwd?: string,
): Promise<ProducerResult> {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const spawnImpl = options.spawnImpl ?? spawn;
  const signal = options.signal;

  return new Promise<ProducerResult>((settle) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let child: any = null;
    let timer: any = null;
    let stdout = "";
    let stderr = "";

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      try {
        signal?.removeEventListener("abort", onAbort);
      } catch {
        /* ignore */
      }
    };
    const finish = (result: ProducerResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      settle(result);
    };
    const onAbort = () => {
      aborted = true;
      try {
        child?.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish({ ok: false, reason: "aborted" });
    };

    if (signal?.aborted) {
      finish({ ok: false, reason: "aborted" });
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child?.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish({
        ok: false,
        reason: "timeout",
        detail: `no result within ${timeoutMs} ms`,
      });
    }, Math.max(1, timeoutMs));

    try {
      signal?.addEventListener("abort", onAbort, { once: true });
    } catch {
      /* ignore */
    }

    try {
      child = spawnImpl(config.command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
        cwd: cwd || undefined,
      });
    } catch (error) {
      finish({ ok: false, reason: "spawn-error", detail: String(error) });
      return;
    }

    try {
      child.stdout?.setEncoding?.("utf8");
      child.stderr?.setEncoding?.("utf8");
    } catch {
      /* ignore */
    }

    child.stdout?.on?.("data", (chunk: any) => {
      if (stdout.length >= MAX_STDOUT) return;
      stdout += String(chunk).slice(0, MAX_STDOUT - stdout.length);
    });
    child.stderr?.on?.("data", (chunk: any) => {
      if (stderr.length >= MAX_STDERR) return;
      stderr += String(chunk).slice(0, MAX_STDERR - stderr.length);
    });
    child.on?.("error", (error: any) => {
      finish({ ok: false, reason: "spawn-error", detail: String(error) });
    });
    child.on?.("close", (code: number | null, signalName: string | null) => {
      if (timedOut || aborted) return;
      if (code !== 0) {
        const said = stderr.trim().slice(0, 300);
        finish({
          ok: false,
          reason: "exit-nonzero",
          detail: `exit ${code}${signalName ? ` signal ${signalName}` : ""}${
            said ? `: ${said}` : ""
          }`,
        });
        return;
      }
      const parsed = parseHookOutput(stdout);
      // Mnemos exits 0 on every failure path and writes the diagnostic to
      // stderr. Treat a diagnostic with no packet as a failure, so a locked
      // or broken store does not look like an empty memory.
      if (!parsed.ok && parsed.reason === "empty" && stderr.trim()) {
        finish({
          ok: false,
          reason: "hook-error",
          detail: stderr.trim().slice(0, 300),
        });
        return;
      }
      finish(parsed);
    });

    try {
      child.stdin?.on?.("error", () => {
        /* EPIPE if the child exits before reading stdin */
      });
      child.stdin?.end?.(JSON.stringify(payload));
    } catch {
      /* the close handler still settles the promise */
    }
  });
}

/** `mnemos hook session-start`: the continuity packet for a new session. */
export function runProducer(
  config: WakeConfig,
  input: ProducerInput,
  options: RunOptions = {},
): Promise<ProducerResult> {
  return runHook(
    config,
    producerArgs(config),
    {
      model: input.model ?? "",
      session_id: input.sessionId ?? "",
      cwd: input.cwd ?? "",
    },
    options,
    config.timeoutMs,
    input.cwd,
  );
}

export interface CueInput extends ProducerInput {
  prompt: string;
}

/**
 * `mnemos hook prompt`: the memories that may bear on one message. It is a
 * hint, never a gate: any failure resolves to no cue.
 */
export function runCue(
  config: WakeConfig,
  input: CueInput,
  options: RunOptions = {},
): Promise<ProducerResult> {
  return runHook(
    config,
    cueArgs(config),
    {
      hook_event_name: "UserPromptSubmit",
      prompt: input.prompt,
      model: input.model ?? "",
      session_id: input.sessionId ?? "",
      cwd: input.cwd ?? "",
    },
    options,
    config.cueTimeoutMs,
    input.cwd,
  );
}

/** The active branch, after compaction, when the host exposes it. */
function activeEntries(ctx: any): any[] {
  const manager = ctx?.sessionManager;
  try {
    if (typeof manager?.buildContextEntries === "function") {
      return manager.buildContextEntries();
    }
  } catch {
    /* fall through */
  }
  try {
    if (typeof manager?.getBranch === "function") return manager.getBranch();
  } catch {
    /* fall through */
  }
  return [];
}

export function hasWakePacket(ctx: any): boolean {
  return activeEntries(ctx).some(
    (entry: any) =>
      entry?.type === "custom_message" &&
      entry?.customType === WAKE_CUSTOM_TYPE,
  );
}

export interface WakeDeps {
  config?: WakeConfig;
  loadConfig?: (baseDir: string) => WakeConfig;
  runProducer?: typeof runProducer;
  runCue?: typeof runCue;
  baseDir?: string;
}

function defaultBaseDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

/**
 * Build the session-start / compaction wake behaviour. Exported so the test
 * harness can drive it with a fake host and a fake producer.
 */
export function createWakeExtension(pi: any, deps: WakeDeps = {}) {
  let config: WakeConfig | undefined = deps.config;
  let configError = "";
  if (!config) {
    try {
      config = (deps.loadConfig ?? loadConfig)(deps.baseDir ?? defaultBaseDir());
    } catch (error) {
      configError = String(error);
    }
  }
  const run = deps.runProducer ?? runProducer;
  const runCueHook = deps.runCue ?? runCue;

  let disposed = false;
  let delivered = false;
  let firstRunStarted = false;
  let warned = false;
  let pending: Promise<ProducerResult> | null = null;
  let abort: AbortController | null = null;
  let generation = 0;
  // One cue per distinct user message, so a retried run cannot inject twice.
  const cuedPrompts = new Set<string>();

  const warn = (ctx: any, result: ProducerResult) => {
    if (warned || result.ok) return;
    // An empty packet is the documented "nothing to contribute" path, not a
    // failure. Warning on it would make a healthy empty memory noisy.
    if (result.reason === "empty" || result.reason === "aborted") return;
    warned = true;
    const label: Record<string, string> = {
      "spawn-error": "mnemos could not be started",
      "exit-nonzero": "mnemos exited with an error",
      timeout: "mnemos did not answer in time",
      unparseable: "mnemos returned unreadable output",
      "missing-context": "mnemos returned no context field",
      "hook-error": "mnemos reported an error",
    };
    const detail = result.detail ? ` (${result.detail})` : "";
    try {
      ctx?.ui?.notify?.(
        `Mnemos wake skipped: ${label[result.reason] ?? result.reason}${detail}`,
        "warning",
      );
    } catch {
      /* the warning itself must never break the session */
    }
  };

  const append = (ctx: any, packet: string) => {
    if (disposed || delivered) return;
    delivered = true;
    try {
      pi.sendMessage({
        customType: WAKE_CUSTOM_TYPE,
        content: packet,
        display: false,
      });
    } catch (error) {
      delivered = false;
      warn(ctx, {
        ok: false,
        reason: "spawn-error",
        detail: `sendMessage failed: ${String(error)}`,
      });
    }
  };

  const start = (ctx: any) => {
    if (disposed) return;
    if (!config) {
      if (!warned) {
        warned = true;
        try {
          ctx?.ui?.notify?.(
            `Mnemos wake skipped: ${configError || "no configuration"}`,
            "warning",
          );
        } catch {
          /* the warning itself must never break the session */
        }
      }
      return;
    }
    try {
      abort?.abort();
    } catch {
      /* ignore */
    }
    const controller = new AbortController();
    abort = controller;
    const current = ++generation;
    firstRunStarted = false;
    try {
      pending = run(
        config,
        {
          model: ctx?.model?.id ?? ctx?.model?.modelId ?? "",
          sessionId: ctx?.sessionManager?.getSessionId?.() ?? "",
          cwd: ctx?.cwd ?? "",
        },
        { signal: controller.signal },
      );
    } catch (error) {
      warn(ctx, { ok: false, reason: "spawn-error", detail: String(error) });
      return;
    }
    pending
      .then((result) => {
        if (disposed || current !== generation || delivered) return;
        if (!result.ok) {
          warn(ctx, result);
          return;
        }
        let idle = true;
        try {
          idle = ctx?.isIdle ? ctx.isIdle() : true;
        } catch {
          idle = true;
        }
        // Append only while the first run has not started and the agent is
        // idle. Otherwise before_agent_start carries it into the request.
        if (!firstRunStarted && idle) append(ctx, result.packet);
      })
      .catch(() => {
        /* runProducer resolves; this is belt-and-braces */
      });
  };

  pi.on("session_start", async (event: any, ctx: any) => {
    try {
      // A reload rebuilds this extension instance; the session already has
      // whatever packet it had. Appending again would duplicate it.
      if (event?.reason === "reload") return;
      // Resume, fork, --continue, and a startup over an existing transcript
      // already carry a packet in their active context.
      if (hasWakePacket(ctx)) {
        delivered = true;
        return;
      }
      delivered = false;
      warned = false;
      start(ctx);
    } catch {
      /* never fail a session */
    }
  });

  const cueFor = async (event: any, ctx: any): Promise<string> => {
    if (!config || disposed) return "";
    if (event?.messageType !== "user") return "";
    const prompt = typeof event?.prompt === "string" ? event.prompt.trim() : "";
    // Short prompts ("yes", "go ahead") carry nothing to look up.
    if (prompt.length < 12) return "";
    if (cuedPrompts.has(prompt)) return "";
    if (cuedPrompts.size >= 100) cuedPrompts.clear();
    cuedPrompts.add(prompt);
    const started = Date.now();
    try {
      const result = await runCueHook(
        config,
        {
          prompt,
          model: ctx?.model?.id ?? ctx?.model?.modelId ?? "",
          sessionId: ctx?.sessionManager?.getSessionId?.() ?? "",
          cwd: ctx?.cwd ?? "",
        },
        { timeoutMs: config.cueTimeoutMs },
      );
      debugLog({
        event: "cue",
        prompt_len: prompt.length,
        ok: result.ok,
        reason: result.ok ? null : result.reason,
        block_len: result.ok ? result.packet.length : 0,
        ms: Date.now() - started,
      });
      return result.ok ? result.packet : "";
    } catch (error) {
      debugLog({ event: "cue", threw: String(error), ms: Date.now() - started });
      return "";
    }
  };

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    try {
      if (disposed) return undefined;
      if (!delivered) {
        firstRunStarted = true;
        const waiting = pending;
        if (waiting) {
          const result = await waiting;
          if (disposed) return undefined;
          if (!delivered && result.ok) {
            delivered = true;
            return {
              message: {
                customType: WAKE_CUSTOM_TYPE,
                content: result.packet,
                display: false,
              },
            };
          }
          // No packet (empty store, failed hook): warn once, then still let the
          // cue answer this message. An empty wake must not disable per-message
          // memory for the whole session.
          if (!delivered) warn(ctx, result);
        }
      }
      // The wake is already in context; this turn gets its own memory cue.
      const block = await cueFor(event, ctx);
      if (!block) return undefined;
      return {
        message: {
          customType: CUE_CUSTOM_TYPE,
          content: block,
          display: false,
        },
      };
    } catch {
      return undefined;
    }
  });

  pi.on("session_compact", async (_event: any, ctx: any) => {
    try {
      if (disposed) return;
      // If compaction kept the packet in the active tail, re-injecting would
      // show it twice.
      if (hasWakePacket(ctx)) {
        delivered = true;
        return;
      }
      delivered = false;
      warned = false;
      start(ctx);
    } catch {
      /* never fail a session */
    }
  });

  pi.on("session_shutdown", async () => {
    disposed = true;
    try {
      abort?.abort();
    } catch {
      /* ignore */
    }
  });

  return {
    config,
    // Exposed for tests and diagnostics.
    state: () => ({ disposed, delivered, firstRunStarted, warned }),
  };
}

export default function (pi: ExtensionAPI) {
  createWakeExtension(pi);
}
