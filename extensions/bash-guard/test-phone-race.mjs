// Integration test for bash-guard's phone/TUI approval race.
// Self-bootstrapping: copies the current bash-guard/index.ts + phone-channel/module.ts
// into a scratch dir with stub pi packages, a mock ntfy server, and a fake cloudflared.
// Run: node <extensions>/bash-guard/test-phone-race.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";

const EXT_DIR = "<extensions>";
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bg-phone-race-"));

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
	if (ok) {
		pass++;
		console.log(`  PASS ${name}`);
	} else {
		fail++;
		console.log(`  FAIL ${name} ${detail}`);
	}
}
async function waitFor(cond, ms) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (await cond()) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return await cond();
}
function withTimeout(p, ms, label) {
	return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out`)), ms))]);
}
async function postSubmit(port, code, params) {
	const body = new URLSearchParams({ code, ...params }).toString();
	const res = await fetch(`http://127.0.0.1:${port}/submit`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});
	return res.status;
}
async function portOpen(port) {
	try {
		const s = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
		return s.status === 200;
	} catch {
		return false;
	}
}

// ---------- scratch scaffolding ----------
fs.mkdirSync(path.join(ROOT, "bash-guard"), { recursive: true });
fs.mkdirSync(path.join(ROOT, "phone-channel"), { recursive: true });
fs.copyFileSync(path.join(EXT_DIR, "bash-guard/index.ts"), path.join(ROOT, "bash-guard/index.ts"));
fs.copyFileSync(path.join(EXT_DIR, "phone-channel/module.ts"), path.join(ROOT, "phone-channel/module.ts"));
fs.mkdirSync(path.join(ROOT, "node_modules"), { recursive: true });
fs.symlinkSync(path.join(EXT_DIR, "bash-guard/node_modules/shell-quote"), path.join(ROOT, "node_modules/shell-quote"));
const stubs = {
	"node_modules/@mariozechner/pi-coding-agent/package.json":
		'{"name":"@mariozechner/pi-coding-agent","version":"0.0.0-stub","type":"module","main":"index.js"}',
	"node_modules/@mariozechner/pi-coding-agent/index.js":
		'export class DynamicBorder { constructor() {} }\nexport function isToolCallEventType(name, event) { return event.toolName === name; }\n',
	"node_modules/@mariozechner/pi-tui/package.json":
		'{"name":"@mariozechner/pi-tui","version":"0.0.0-stub","type":"module","main":"index.js"}',
	"node_modules/@mariozechner/pi-tui/index.js":
		'export class Container { constructor() { this.children = []; } addChild(c) { this.children.push(c); } render() {} invalidate() {} }\nexport class Text { constructor(text) { this.text = text; } }\nexport class SelectList { constructor(items, len, opts) { this.items = items; } handleInput() {} }\n',
};
for (const [rel, content] of Object.entries(stubs)) {
	fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true });
	fs.writeFileSync(path.join(ROOT, rel), content);
}
const FAKE_CF = path.join(ROOT, "fake-cloudflared.sh");
const PORT_FILE = path.join(ROOT, "port-file");
const CONFIG_FILE = path.join(ROOT, "config.json");
fs.writeFileSync(
	FAKE_CF,
	`#!/bin/sh
# args: tunnel --url http://127.0.0.1:PORT --no-autoupdate
port=$(printf '%s' "$3" | sed 's/.*://')
echo "$port" > ${PORT_FILE}
echo "https://fake-bg-test.trycloudflare.com" >&2
exec sleep 600
`,
);
fs.chmodSync(FAKE_CF, 0o755);

const pushes = [];
const mock = http.createServer((req, res) => {
	let buf = "";
	req.on("data", (c) => (buf += c));
	req.on("end", () => {
		pushes.push({ title: req.headers["title"] || "", body: buf, at: Date.now() });
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("ok");
	});
});
await new Promise((r) => mock.listen(0, "127.0.0.1", () => r()));
fs.writeFileSync(
	CONFIG_FILE,
	JSON.stringify({
		enabled: true,
		server: `http://127.0.0.1:${mock.address().port}`,
		topic: "bg-phone-race-test",
		graceMs: 1000,
		timeoutMs: 60000,
		cloudflared: FAKE_CF,
	}),
);
process.env.PHONE_NOTIFY_CONFIG = CONFIG_FILE;

function makeCtx() {
	const theme = { fg: (_c, s) => s, bold: (s) => s, bg: (_c, s) => s };
	let currentDone = null;
	const ui = {
		theme,
		notify: () => {},
		setStatus: () => {},
		confirm: () => Promise.resolve(false),
		input: () => Promise.resolve(""),
		select: () => Promise.resolve(null),
		custom: (make) => {
			let res;
			const gate = new Promise((r) => (res = r));
			make({}, theme, {}, (v) => res(v));
			currentDone = (v) => res(v);
			return gate;
		},
	};
	return { hasUI: true, ui, resolveTui: (v) => currentDone && currentDone(v) };
}

const handlers = {};
const pi = {
	on: (name, fn) => {
		(handlers[name] ??= []).push(fn);
	},
	registerFlag: () => {},
	registerCommand: () => {},
	getFlag: () => false,
};
const ext = (await import(path.join(ROOT, "bash-guard/index.ts"))).default;
ext(pi);
let caseN = 0;
const hook = (command, ctx) => {
	const h = handlers.tool_call[handlers.tool_call.length - 1];
	return h({ toolName: "bash", toolCallId: `t${++caseN}`, input: { command } }, ctx);
};

try {
	// ---------- Case 1: phone APPROVE wins the race ----------
	console.log("\n[1] phone approve → command allowed");
	const ctx1 = makeCtx();
	const p1 = hook("dd if=/dev/zero of=/tmp/bg-test-scratch-1 bs=1M count=1", ctx1);
	check("push arrived for flagged command", await waitFor(() => pushes.length >= 1, 8000), `pushes=${pushes.length}`);
	const push1 = pushes[pushes.length - 1];
	const code1 = push1.body.match(/Code: ([0-9A-F]{6})/)?.[1];
	const port1 = Number(fs.readFileSync(PORT_FILE, "utf8").trim());
	check("push body has the command", push1.body.includes("dd if=/dev/zero of=/tmp/bg-test-scratch-1"));
	check("push body has risk reasons", /risk/i.test(push1.body) && push1.body.includes("•"));
	check("push body has Approve option", push1.body.includes("1. Approve \u2014 run it"));
	check("push body has Deny option", push1.body.includes("2. Deny \u2014 block it"));
	check("push body has working dir", push1.body.includes("Working dir:"));
	check("push title is ASCII header-safe", push1.title.length > 0 && [...push1.title].every((c) => c.codePointAt(0) <= 0xff), push1.title);
	const sub1 = await postSubmit(port1, code1, { sel: "1" });
	check("submit accepted (200)", sub1 === 200, String(sub1));
	const r1 = await withTimeout(p1, 10000, "hook-after-phone-approve");
	check("hook allows after phone approve (undefined)", r1 === undefined, JSON.stringify(r1));
	check("channel torn down after phone answer", !(await waitFor(() => portOpen(port1), 5000)));

	// ---------- Case 2: phone DENY wins the race ----------
	console.log("\n[2] phone deny → command blocked");
	const ctx2 = makeCtx();
	const p2 = hook("dd if=/dev/zero of=/tmp/bg-test-scratch-2 bs=1M count=1", ctx2);
	check("push arrived (case 2)", await waitFor(() => pushes.length >= 2, 8000), `pushes=${pushes.length}`);
	const push2 = pushes[pushes.length - 1];
	const code2 = push2.body.match(/Code: ([0-9A-F]{6})/)?.[1];
	const port2 = Number(fs.readFileSync(PORT_FILE, "utf8").trim());
	const sub2 = await postSubmit(port2, code2, { sel: "2", note: "too risky" });
	check("submit accepted (case 2)", sub2 === 200, String(sub2));
	const r2 = await withTimeout(p2, 10000, "hook-after-phone-deny");
	check("hook blocks after phone deny", r2 && r2.block === true, JSON.stringify(r2));
	check("block reason names the phone", r2?.reason?.includes("phone") ?? false, r2?.reason);
	check("block reason carries the user note", r2?.reason?.includes("too risky") ?? false, r2?.reason);
	check("channel torn down (case 2)", !(await waitFor(() => portOpen(port2), 5000)));

	// ---------- Case 3: TUI answer wins → phone channel cancelled ----------
	console.log("\n[3] TUI answer wins → channel cancelled, no second push");
	const before = pushes.length;
	const ctx3 = makeCtx();
	const p3 = hook("dd if=/dev/zero of=/tmp/bg-test-scratch-3 bs=1M count=1", ctx3);
	check("push arrived (case 3)", await waitFor(() => pushes.length >= before + 1, 8000), `pushes=${pushes.length}`);
	const port3 = Number(fs.readFileSync(PORT_FILE, "utf8").trim());
	await new Promise((r) => setTimeout(r, 300));
	ctx3.resolveTui("run");
	const r3 = await withTimeout(p3, 10000, "hook-after-tui-run");
	check("hook allows after TUI run", r3 === undefined, JSON.stringify(r3));
	check("channel cancelled after TUI answer", !(await waitFor(() => portOpen(port3), 5000)));
	await new Promise((r) => setTimeout(r, 1500));
	check("no late push after TUI answer", pushes.length === before + 1, `pushes=${pushes.length}`);

	// ---------- Case 4: non-dangerous command → no gate, no push ----------
	console.log("\n[4] non-dangerous command passes through without a channel");
	const before4 = pushes.length;
	const ctx4 = makeCtx();
	const t0 = Date.now();
	const r4 = await withTimeout(hook("ls -la /tmp", ctx4), 3000, "non-dangerous hook");
	const fast = Date.now() - t0 < 2500;
	check("non-dangerous resolves immediately", r4 === undefined && fast, `r=${JSON.stringify(r4)} ms=${Date.now() - t0}`);
	await new Promise((r) => setTimeout(r, 1600)); // grace would have pushed by now if a channel had armed
	check("no push for non-dangerous command", pushes.length === before4, `pushes=${pushes.length}`);

	// ---------- Case 5: recently-aborted command re-blocks without a new push ----------
	console.log("\n[5] recently-aborted command re-blocks without a new channel");
	const before5 = pushes.length;
	const ctx5 = makeCtx();
	const r5 = await withTimeout(hook("dd if=/dev/zero of=/tmp/bg-test-scratch-2 bs=1M count=1", ctx5), 3000, "recently-aborted hook");
	check("recently aborted re-blocked", r5?.block === true, JSON.stringify(r5));
	check("no new push for recently-aborted", pushes.length === before5, `pushes=${pushes.length}`);
} finally {
	mock.close();
	try {
		execFileSync("pkill", ["-f", path.join(ROOT, "fake-cloudflared")], { stdio: "ignore" });
	} catch {
		// nothing left to kill
	}
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
