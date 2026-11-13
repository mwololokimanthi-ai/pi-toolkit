/**
 * patch-guard — puts the local patches back after an update replaces a package.
 *
 * WHY THIS EXISTS
 *   Every patch in ~/.pi/agent/patches/ edits code INSIDE an installed package, so
 *   any update to that package discards it silently. Nothing throws and nothing
 *   warns: the tool keeps working, the local behaviour is simply gone. pi-agent-ide
 *   lost its patch exactly this way — its two bundles were the only files on disk
 *   newer than the install timestamp, and nothing anywhere said so.
 *
 * WHY THERE IS NO INSTALL HOOK (measured, not assumed)
 *   The intended trigger was a `scripts.postinstall` in ~/.pi/agent/npm/package.json —
 *   the one file pi never rewrites, since ensureNpmProject only writes it when it is
 *   absent (dist/core/package-manager.js:1710-1719). npm 10.9.3 runs a root
 *   postinstall for a bare `npm install --prefix <dir>` but NOT when any package is
 *   named: `npm install <spec> --prefix <dir>` skips the root project's install
 *   scripts entirely, and it does so even when the tree is already up to date. pi's
 *   install path always names one (getNpmInstallArgs, dist/core/package-manager.js:1505-1525,
 *   called with [source.spec] at :1528-1530), so that hook can never fire for a pi
 *   update and was dropped. A session is the only reliable trigger.
 *
 * A second, smaller job lives here: `session_start` also checks the guardrails that no
 * patch can restore, because they are configuration rather than bytes in a package — a
 * re-armed client-side compaction trigger, or the loss of the extension that vetoes one.
 * Those are reported, never repaired: the setting is the user's to change.
 *
 * HOW IT WORKS
 *   `session_start` reads the patched files (a few ms, in-process) and, only if
 *   one looks pristine, runs patches/reapply-all.sh once. That script is the
 *   authority: it asks each patch's own reapply tool for its status, applies what is
 *   missing, and re-checks. The checks below are just a fast path so the common case
 *   costs nothing and never spawns a process; anything they cannot read falls
 *   through to the script.
 *
 * Testing: PI_AGENT_DIR relocates the whole thing, matching reapply-all.sh.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENT_DIR = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const DRIVER = join(AGENT_DIR, "patches", "reapply-all.sh");
const NPM_NM = join(AGENT_DIR, "npm", "node_modules");

/** Reads a file, or null when it is missing or unreadable. */
function slurp(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/**
 * A patch's "was this lost?" test. Each returns false when the package is not
 * installed at all — then there is nothing to guard — and true only when the file
 * is present and looks pristine.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A finite number, or null for anything else (including a numeric string). */
function number(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Parses a JSON file, or null when it is missing, unreadable or not an object. */
function json(path: string): Record<string, unknown> | null {
	const text = slurp(path);
	if (text === null) return null;
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** The deferred-tools list file, which is also this patch's only marker. */
const DEFERRED_MARKER = "deferred-tools.json";

/** pi core's pristine `_getToolExposure`, before `pi-deferred-tools/` rewrites it. */
const PRISTINE_EXPOSURE =
	'_getToolExposure(name){return this._toolDefinitions.get(name)?.definition.exposure??"direct"}';

/** The installed pi core, found the way the patch driver finds it: a `node-*` tree
 *  under $HOME (newest name first), then the tree the running process came from.
 *  Null when neither holds an installed core, because then there is nothing to guard. */
function piCoreDir(): string | null {
	const trees: string[] = [];
	try {
		const home = homedir();
		for (const name of readdirSync(home)
			.filter((entry) => /^node-v\d/.test(entry))
			.sort()
			.reverse()) {
			trees.push(join(home, name));
		}
	} catch {
		// An unreadable home falls through to the running process below.
	}
	trees.push(dirname(dirname(process.execPath)));
	for (const tree of trees) {
		const core = join(tree, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
		if (slurp(join(core, "dist", "core", "agent-session.js")) !== null) return core;
	}
	return null;
}

/** Every `.js` bundle chunk of an installed pi core; empty when the directory is absent. */
function bundleChunks(core: string): string[] {
	const dir = join(core, "dist", "bundle", "chunks");
	try {
		return readdirSync(dir)
			.filter((name) => name.endsWith(".js"))
			.map((name) => join(dir, name));
	} catch {
		return [];
	}
}

/**
 * Conditions no patch can restore, because they live in configuration rather than in a
 * package's bytes. A breach is the state this machine must not drift back into: a
 * client-side compaction trigger that is armed again, or the loss of the extension that
 * vetoes one.
 *
 * Why this matters more than speed: a client fold starts inside bili's ALREADY-FOLDED
 * range, so its rewrite archives bili's own blocks (measured 2026-10-05: 20 blocks at
 * 13:13:49Z from pi-vcc at compactAtContextPercent 0.15, then 24 more at 13:36:21Z from
 * pi core's reserveTokens wall). The question is therefore never "is compaction fast"
 * but "can a client start one at all".
 */
const GUARDRAILS: { guardrail: string; breach: () => string | null }[] = [
	{
		// The veto itself. Its session_before_compact handler cancels every automatic
		// reason and lets only "manual" through, so while it is loaded no client trigger
		// can rewrite anything. Losing it is the one breach that turns every other
		// entry below into a live threat.
		guardrail: "no-native-compaction-present",
		breach: () => {
			const text = slurp(
				join(AGENT_DIR, "extensions", "no-native-compaction", "index.ts"),
			);
			if (text !== null) return null;
			return "extensions/no-native-compaction/ is gone, so nothing vetoes an automatic client-side compaction";
		},
	},
	{
		// pi core's threshold trigger. shouldCompact() honours this flag, and it is off.
		guardrail: "pi-core-threshold",
		breach: () => {
			const settings = json(join(AGENT_DIR, "settings.json"));
			const compaction = settings?.["compaction"];
			if (!isRecord(compaction) || compaction["enabled"] !== true) return null;
			return "settings.json has compaction.enabled true, so pi core's threshold trigger is armed again";
		},
	},
	{
		// pi-vcc's own backstop fold, which is 0 in pi-vcc-config.json.
		guardrail: "pi-vcc-backstop",
		breach: () => {
			const config = json(join(AGENT_DIR, "pi-vcc-config.json"));
			const percent = number(config?.["compactAtContextPercent"]);
			if (percent === null || percent <= 0) return null;
			return `pi-vcc-config.json has compactAtContextPercent ${percent}, so the pi-vcc backstop fold is armed again`;
		},
	},
	{
		// observational-memory's own threshold. It fires on turn_end and calls
		// ctx.compact() itself, never through pi core's shouldCompact(), so the veto
		// above is the only thing between it and a rewrite. Expected to report: the
		// configured 0.25 is armed, and zeroing it or setting passive true is the
		// user's call, not this guard's.
		guardrail: "observational-memory-threshold",
		breach: () => {
			const settings = json(join(AGENT_DIR, "settings.json"));
			const memory = settings?.["observational-memory"];
			if (!isRecord(memory) || memory["passive"] === true) return null;
			const percent = number(memory["compactAtContextPercent"]);
			const tokens = number(memory["compactAtContextTokens"]);
			if (percent !== null && percent > 0) {
				return `observational-memory has compactAtContextPercent ${percent} (settings.json) and calls ctx.compact() directly, so only no-native-compaction stands between it and a client fold`;
			}
			if (tokens !== null && tokens > 0) {
				return `observational-memory has compactAtContextTokens ${tokens} (settings.json) and calls ctx.compact() directly, so only no-native-compaction stands between it and a client fold`;
			}
			return null;
		},
	},
];

/** What each guardrail has to say, in order. A read that throws reports itself, so a
 *  broken config file cannot hide behind silence. */
export function guardrailBreaches(): string[] {
	const out: string[] = [];
	for (const guardrail of GUARDRAILS) {
		try {
			const breach = guardrail.breach();
			if (breach !== null) out.push(breach);
		} catch {
			out.push(`${guardrail.guardrail} could not be read`);
		}
	}
	return out;
}

const CHECKS: { patch: string; lost: () => boolean }[] = [
	{
		// The patch flips one registration in each bundle from exposure:"direct" to
		// exposure:"deferred". Reversing that one string in each installed file
		// reproduces the published package byte-for-byte, so a present
		// `exposure:"deferred"` is the patch and its absence is pristine.
		//
		// ANCHORS, NOT FILENAMES. The bundler renumbers dist/entry-*.js on every
		// release — 0.8.1 holds them in entry-33/entry-79, 0.8.4 in entry-35/entry-81
		// — and a newer release keeps the old names on disk as unrelated re-export
		// stubs. Keyed by name, this check read "deferred absent" out of a 152-byte
		// stub forever and reported the patch lost on every session even after the
		// driver had restored it (measured 2026-10-26). Each anchor below carries its
		// tool name, so neither can match the shared editing helper's
		// `{name:e.name,exposure:"direct"}`.
		patch: "pi-agent-ide-defer",
		lost: () => {
			const dir = join(NPM_NM, "pi-agent-ide", "dist");
			let files: string[];
			try {
				files = readdirSync(dir).filter((name) => /^entry-\d+\.js$/.test(name));
			} catch {
				return false; // package absent: nothing to guard
			}
			const anchors = [
				[
					'{name:"select",label:"select",exposure:"deferred"',
					'{name:"select",label:"select",exposure:"direct"',
				],
				[
					'{name:"diff",exposure:"deferred"',
					'{name:"diff",exposure:"direct"',
				],
			] as const;
			let patched = 0;
			let pristine = 0;
			let sawTool = false;
			for (const name of files) {
				const text = slurp(join(dir, name));
				if (text === null) continue;
				if (text.includes('name:"select"') || text.includes('name:"diff"')) sawTool = true;
				for (const [want, dont] of anchors) {
					if (text.includes(want)) patched += 1;
					else if (text.includes(dont)) pristine += 1;
				}
			}
			// Neither tool anywhere in the bundle: a later release renamed the layout,
			// or this patch was retired. Stay quiet rather than alarm every session.
			return sawTool ? pristine > 0 || patched < anchors.length : false;
		},
	},
	{
		// The patch replaces the TypeSafe endpoint with classifier.dev's in the
		// runtime JS; client.js is where the endpoint is defined.
		patch: "pi-codemode-classify",
		lost: () => {
			const client = slurp(join(NPM_NM, "@boozedog", "pi-codemode", "dist", "jev", "client.js"));
			if (client === null) return false;
			return !client.includes("classifier.dev/v1/systemone");
		},
	},
	{
		// This patch replaces two files wholesale, so the patched copy kept in the
		// patch directory must equal the installed file — the same comparison its
		// own reapply.py --check makes.
		patch: "pi-deepseek-peak-live",
		lost: () => {
			for (const rel of ["extensions/deepseek-peak.ts", "scripts/selfcheck.ts"]) {
				const installed = slurp(join(NPM_NM, "pi-deepseek-peak", rel));
				if (installed === null) return false;
				const patched = slurp(join(AGENT_DIR, "patches", "pi-deepseek-peak-live", rel));
				if (patched === null) return false;
				if (installed !== patched) return true;
			}
			return false;
		},
	},
	{
		// The patch adds this helper to the vendored plugin's entry module; the
		// pristine file does not contain the name at all.
		patch: "subagent-close-vanished",
		lost: () => {
			const index = slurp(
				join(AGENT_DIR, "extensions", "interactive-subagents", "pi-extension", "subagents", "index.ts"),
			);
			if (index === null) return false;
			return !index.includes("closeSurfaceQuietly");
		},
	},
	{
		// The patch gates the package's only setHeader call on
		// FEYNMAN_CODING_AGENT_DIR, which an ordinary pi does not set; a pristine
		// research-tools.ts does not contain the gate at all.
		patch: "feynman-header-off",
		lost: () => {
			const text = slurp(join(NPM_NM, "@companion-ai", "feynman", "extensions", "research-tools.ts"));
			if (text === null) return false;
			return !text.includes("process.env.FEYNMAN_CODING_AGENT_DIR");
		},
	},
	{
		// src/grep.ts carries the whole patch: -h leaves the no-argument
		// pass-through set, gains a rename to rg's -I, and --no-filename points
		// at -I too; the function then pushes rg's -N so a tty gets no line
		// numbers unless -n asked for them. A pristine file still maps
		// --no-filename back to -h, the clearest single marker of a lost patch.
		patch: "pi-reflag-grep-h",
		lost: () => {
			const text = slurp(
				join(NPM_NM, "@piotr-oles", "pi-reflag", "src", "grep.ts"),
			);
			if (text === null) return false;
			const pristineMarker = '["--no-filename", { kind: "rename", to: "-h" }]';
			if (text.includes(pristineMarker)) return true;
			if (!text.includes('["-h", { kind: "rename", to: "-I" }]')) return true;
			return !text.includes('translated.push("-N")');
		},
	},
		// bili-agent-providers-client was retired on 2026-10-10: billion-context
		// 0.1.191 implements both of its client edits upstream (the loopback-host
		// skip-and-warn rule and the body-carrying refusal), so this probe read
		// MIXED forever and the guard reported a superseded patch as lost.
		// See README section I.
	{
		// The patch makes _getToolExposure consult ~/.pi/agent/deferred-tools.json, so a
		// listed tool is declared to no one while staying reachable through codemode and
		// tool_search. The pristine method never mentions that file, so the string is the
		// marker. Both copies are patched: the CLI runs the bundled chunk and the library
		// entry runs the unbundled module. Every chunk is scanned rather than the single
		// name the release ships, so a renumbered chunk is reported instead of read as
		// "nothing to guard"; the list is checked too, because the patch without it does
		// nothing at all.
		patch: "pi-deferred-tools",
		lost: () => {
			const core = piCoreDir();
			if (core === null) return false;
			const unbundled = slurp(join(core, "dist", "core", "agent-session.js"));
			if (unbundled !== null && !unbundled.includes(DEFERRED_MARKER)) return true;
			let patched = 0;
			let pristine = 0;
			for (const chunk of bundleChunks(core)) {
				const text = slurp(chunk);
				if (text === null) continue;
				if (text.includes(DEFERRED_MARKER)) patched += 1;
				if (text.includes(PRISTINE_EXPOSURE)) pristine += 1;
			}
			if (patched + pristine > 0 && (patched !== 1 || pristine !== 0)) return true;
			const list = json(join(AGENT_DIR, "deferred-tools.json"));
			const tools = list?.tools;
			return !Array.isArray(tools) || tools.length === 0;
		},
	},
	{
		// The patch inserts the elision helpers into the vendored billion-context
		// bundle and lets the existing reasoning drop run for strict-echo
		// upstreams. A pristine dist/index.js has no `biliElideClosedCompress`
		// at all, so that name is the marker.
		patch: "bili-compress-floor",
		lost: () => {
			const text = slurp(join(NPM_NM, "billion-context", "dist", "index.js"));
			if (text === null) return false;
			return !text.includes("function biliElideClosedCompress(");
		},
	},
	{
		// The patch bounds bili's preflight fold campaign by wall clock and then
		// lets the request forward for upstream arbitration. A pristine
		// dist/index.js has neither the constant nor the deadline expression, so
		// the constant name is the marker.
		patch: "bili-preflight-deadline",
		lost: () => {
			const text = slurp(join(NPM_NM, "billion-context", "dist", "index.js"));
			if (text === null) return false; // package absent: nothing to guard
			return !text.includes("const PREFLIGHT_WALL_CLOCK_MS=");
		},
	},
	{
		// The patch replaces liveInterop()'s "lowest-numbered live socket" pick
		// with a probe of the Windows session each socket serves, so a socket
		// answering from Session 0 -- the one a scheduled task gets when it
		// boots the distribution -- is skipped instead of handed to the driver.
		// A pristine src/wsl-interop.ts contains neither helper name.
		patch: "pi-agent-computer-use-interop",
		lost: () => {
			const text = slurp(join(NPM_NM, "pi-agent-computer-use", "src", "wsl-interop.ts"));
			if (text === null) return false; // package absent: nothing to guard
			return !text.includes("servesInteractiveSession");
		},
	},
	{
		// Node refuses to strip TypeScript for files under node_modules, so the
		// patched launch() stages the worker outside it first. A pristine
		// src/web-browser.ts never mentions prepareRemoteWorker.
		patch: "pi-agent-computer-use-web-worker",
		lost: () => {
			const text = slurp(join(NPM_NM, "pi-agent-computer-use", "src", "web-browser.ts"));
			if (text === null) return false; // package absent: nothing to guard
			return !text.includes("prepareRemoteWorker");
		},
	},
];

/** Names of the patches that look lost. A read that throws is treated as lost, so
 *  an unreadable tree still reaches the script rather than failing silently. */
export function unapplied(): string[] {
	const out: string[] = [];
	for (const check of CHECKS) {
		try {
			if (check.lost()) out.push(check.patch);
		} catch {
			out.push(check.patch);
		}
	}
	return out;
}

export type Report = { restored: string[]; failed: string[] };

/** Reads the driver's per-patch verdicts out of its `  <name>  RESTORED|FAILED` lines. */
export function parseReport(output: string): Report {
	const restored: string[] = [];
	const failed: string[] = [];
	for (const line of output.split("\n")) {
		const match = /^\s{2}(\S+)\s+(RESTORED|FAILED)\s*$/.exec(line);
		if (match === null) continue;
		(match[2] === "RESTORED" ? restored : failed).push(match[1]);
	}
	return { restored, failed };
}

function driverExists(): boolean {
	try {
		return statSync(DRIVER).isFile();
	} catch {
		return false;
	}
}

function buildNotice(missing: string[], output: string): string {
	const lines = [
		"## ⚠ the local patches are missing from the installed packages",
		"",
		`Not applied: ${missing.join(", ")}. An update replaced the package and silently`,
		"dropped the local change — nothing errors, the behaviour is just gone. Tell the",
		"user this once, then carry on.",
		"",
		`- Restore them: \`sh ${DRIVER}\``,
		"- Then **fully quit and restart pi**. `/reload` is not enough: pi caches an",
		"  installed package's ES modules.",
	];
	if (output !== "") {
		lines.push("", "Last attempt:", "```", output.slice(-1500), "```");
	}
	return lines.join("\n");
}

export default function patchGuard(pi: ExtensionAPI) {
	let stillMissing: string[] = [];
	let lastOutput = "";

	pi.on("session_start", async (_event, ctx) => {
		const breached = guardrailBreaches();
		if (breached.length > 0) {
			ctx.ui.notify(`patch-guard: ${breached.join("; ")}`, "warning");
		}
		if (unapplied().length === 0) return;
		if (!driverExists()) return;

		const result = spawnSync("sh", [DRIVER], { encoding: "utf8", timeout: 120_000 });
		const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		const report = parseReport(output);
		lastOutput = output.trim();
		stillMissing = unapplied();

		if (report.failed.length > 0) {
			ctx.ui.notify(
				`patch-guard: ${report.failed.join(", ")} could not be re-applied after an update. Run: sh ${DRIVER}`,
				"error",
			);
			return;
		}
		if (report.restored.length > 0) {
			ctx.ui.notify(
				`patch-guard: an update had replaced ${report.restored.length} local patch(es) — restored ${report.restored.join(", ")}. Fully quit and restart pi: /reload does not re-read an installed package.`,
				"warning",
			);
			return;
		}
		// The script found nothing to do, so the fast path was wrong about it.
		stillMissing = [];
	});

	pi.on("before_agent_start", (event) => {
		if (stillMissing.length === 0) return;
		event.systemPromptOptions.sections.patch_guard = buildNotice(stillMissing, lastOutput);
	});
}
