#!/usr/bin/env node
/**
 * Behaviour test for strategic-compact-suggest.ts.
 *
 *   node --experimental-strip-types --no-warnings strategic-compact-suggest.test.mjs
 *
 * It imports the shipped .ts directly (Node 22.19 strips the erasable types),
 * so this tests the real file, not a copy.
 *
 * HERMETIC: everything runs against a sandbox HOME under os.tmpdir(), because
 * the handlers this test drives read the live configs. The sandbox's bili
 * config and pi-vcc config are COPIES of the live ones when they exist, so the
 * numbers asserted here are the live numbers -- but the live files are only
 * ever read. Since 2026-10-05 the extension no longer WRITES either file (it
 * only reports the ladder), and the handler section below asserts exactly that.
 *
 * Why this file is not loaded as an extension: pi's discovery accepts direct
 * files ending in .ts or .js only (dist/core/extensions/loader.js, isExtensionFile),
 * and .mjs is neither.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

// --- sandbox -------------------------------------------------------------
const realBili = join(homedir(), ".config", "billion-context", "billion-context.json");
const realVcc = join(homedir(), ".pi", "agent", "pi-vcc-config.json");

const sandbox = mkdtempSync(join(tmpdir(), "scs-test-"));
const sbBili = join(sandbox, ".config", "billion-context", "billion-context.json");
const sbVcc = join(sandbox, ".pi", "agent", "pi-vcc-config.json");
mkdirSync(join(sandbox, ".config", "billion-context"), { recursive: true });
mkdirSync(join(sandbox, ".pi", "agent"), { recursive: true });

if (existsSync(realBili)) copyFileSync(realBili, sbBili);
else
	writeFileSync(
		sbBili,
		JSON.stringify(
			{ providers: { "https://api.deepseek.com": { compress: { modelContextLimit: 150000, emergencyThresholdPercent: 0.99 } } } },
			null,
			2,
		) + "\n",
	);

if (existsSync(realVcc)) copyFileSync(realVcc, sbVcc);
else
	writeFileSync(
		sbVcc,
		JSON.stringify(
			{
				overrideDefaultCompaction: true,
				smartKeepTail: true,
				continueAfterThresholdCompact: true,
				observationalMemory: "defer",
				compactAtContextPercent: 0.72,
				debug: false,
				skipCustomTypes: ["om.enabled", "vcc-recall", "strategic-compact"],
			},
			null,
			2,
		) + "\n",
	);

// MUST precede the import: the extension resolves both paths from homedir()
// at module load.
process.env.HOME = sandbox;
const ext = await import("./strategic-compact-suggest.ts");

// --- harness -------------------------------------------------------------
let pass = 0;
let fail = 0;
const ok = (name, cond, got) => {
	if (cond) {
		pass++;
		console.log("  ok   " + name);
	} else {
		fail++;
		console.log("  FAIL " + name + "  -> got " + JSON.stringify(got));
	}
};

// The ids matter: the deepseek provider carries a model-level override for
// flash alone, so a report must resolve at the same level bili resolves at.
const ds = { contextWindow: 1000000, baseUrl: "https://api.deepseek.com", id: "deepseek-v4-flash" };
const dsPro = { contextWindow: 1000000, baseUrl: "https://api.deepseek.com", id: "deepseek-v4-pro" };
const qwen = { contextWindow: 196608, baseUrl: "https://qwen.mwololo.space/v1" };

console.log("bili's providers, read out of the sandbox config:");
const ps = ext.biliProviders();
console.log("  " + JSON.stringify(ps));
const live = JSON.parse(readFileSync(sbBili, "utf8")).providers?.["https://api.deepseek.com"]?.compress;
if (live) {
	ok("modelContextLimit read", ps[0]?.limit === live.modelContextLimit, ps[0]?.limit);
	ok("emergencyThresholdPercent read", ps[0]?.emergencyPct === live.emergencyThresholdPercent, ps[0]?.emergencyPct);
}

console.log("\npickProvider (no match must mean no override):");
ok("deepseek matches", ext.pickProvider(ps, "https://api.deepseek.com")?.url === "https://api.deepseek.com");
ok("deepseek with a /v1 path still matches", ext.pickProvider(ps, "https://api.deepseek.com/v1") !== undefined);
ok("qwen matches NOTHING (no leak)", ext.pickProvider(ps, qwen.baseUrl) === undefined);
ok("a missing baseUrl matches nothing", ext.pickProvider(ps, undefined) === undefined);

console.log("\nderiveBackstop:");
const p = ext.pickProvider(ps, ds.baseUrl);
if (p) {
	ok("deepseek backstop = 0.15", ext.deriveBackstop(1000000, p) === 0.15, ext.deriveBackstop(1000000, p));
	ok("  ... one notch above bili's emergency", ext.deriveBackstop(1000000, p) * 1000000 > p.limit * p.emergencyPct);
	ok("  ... under pi core's wall", ext.deriveBackstop(1000000, p) * 1000000 < 750000);
	ok("  ... the 150000 limit never lands on 196608", ext.deriveBackstop(196608, ext.pickProvider(ps, qwen.baseUrl)) !== 0.15);
}
ok("no override at 1M -> 0.72 (the old answer)", ext.deriveBackstop(1000000, undefined) === 0.72);
ok("no override at 196608 -> 0.72", ext.deriveBackstop(196608, undefined) === 0.72);
ok("no override at 131072 -> 0.72", ext.deriveBackstop(131072, undefined) === 0.72);
ok("CEILING holds: 0.99 of a full-window limit -> 0.74", ext.deriveBackstop(1000000, { url: "x", limit: 1000000, emergencyPct: 0.99 }) === 0.74);
ok("a pct-only override scales: 0.5 -> 0.379", ext.deriveBackstop(1000000, { url: "y", emergencyPct: 0.5 }) === 0.379);
ok("no window -> null", ext.deriveBackstop(0, p) === null);

console.log("\nresolveProvider (model level beats provider level, as bili resolves it):");
const liveDeepseek = JSON.parse(readFileSync(sbBili, "utf8")).providers?.["https://api.deepseek.com"];
const provLevel = ext.pickProvider(ps, ds.baseUrl);
const flash = ext.resolveProvider(ps, ds.baseUrl, ds.id);
const pro = ext.resolveProvider(ps, ds.baseUrl, dsPro.id);
ok("biliProviders carries the model-level map", typeof ps[0]?.models?.["deepseek-v4-flash"]?.limit === "number", ps[0]?.models);
const flashCfg = liveDeepseek?.models?.["deepseek-v4-flash"]?.compress;
if (typeof flashCfg?.modelContextLimit === "number") {
	ok("flash takes its own modelContextLimit", flash?.limit === flashCfg.modelContextLimit, flash?.limit);
	ok("  ... not the provider's", flash?.limit !== provLevel?.limit, [flash?.limit, provLevel?.limit]);
	ok("  ... and its own emergency pct", flash?.emergencyPct === flashCfg.emergencyThresholdPercent, flash?.emergencyPct);
	ok("  ... so its position differs from the provider's", ext.deriveBackstop(1000000, flash) !== ext.deriveBackstop(1000000, provLevel), [ext.deriveBackstop(1000000, flash), ext.deriveBackstop(1000000, provLevel)]);
}
ok("the pro id keeps the provider limit", pro?.limit === provLevel?.limit, pro?.limit);
ok("no model id -> provider level", ext.resolveProvider(ps, ds.baseUrl)?.limit === provLevel?.limit);
ok("an unknown model id -> provider level", ext.resolveProvider(ps, ds.baseUrl, "no-such-model")?.limit === provLevel?.limit);
ok("qwen still resolves to nothing", ext.resolveProvider(ps, qwen.baseUrl, "qwen3.8-27b") === undefined);
ok("flash's backstop clears its own emergency line", ext.deriveBackstop(1000000, flash) * 1000000 > flash.limit * flash.emergencyPct);

console.log("\ndriving the real handlers against a stub pi:");
const handlers = {};
const seen = [];
ext.default({
	on: (name, handler) => {
		handlers[name] = handler;
	},
	sendMessage: (m) => seen.push(m.content),
	registerCommand: () => {},
	registerTool: () => {},
});
const key = () => JSON.parse(readFileSync(sbVcc, "utf8")).compactAtContextPercent;
// The sandbox copies the live pi-vcc config, so the value to defend is whatever it held on entry.
const seeded = key();
// The extension context exposes the current model as ctx.model; the old test
// double stubbed a getModel() method that pi never had, which is why the real
// handler threw while this test stayed green.
const ctxFor = (model) => ({ model });

// Stand-down contract (2026-10-05): the extension REPORTS the ladder and never
// writes compactAtContextPercent again. pi-vcc's trigger stays OFF (0) so bili
// is the only thing compacting the wire. The value on entry must therefore
// survive every handler fire untouched.
await handlers.session_start({}, ctxFor(ds));
ok("session_start leaves compactAtContextPercent untouched", key() === seeded, key());
ok("nothing else in the config is dropped", (() => {
	const c = JSON.parse(readFileSync(sbVcc, "utf8"));
	return c.overrideDefaultCompaction === true && c.smartKeepTail === true && Array.isArray(c.skipCustomTypes);
})());
ok(
	`session_start reports flash's own position (${ext.deriveBackstop(1000000, flash)}), not the provider's`,
	String(seen[0]).includes(String(ext.deriveBackstop(1000000, flash))),
	seen[0],
);
ok(`  ... against flash's judge window (${flash.limit})`, String(seen[0]).includes(String(flash.limit)), seen[0]);
console.log("  visible: " + (seen[0] ?? "(silent)"));

seen.length = 0;
await handlers.session_start({}, ctxFor(ds));
ok("the report repeats (there is no write to suppress it)", seen.length === 1, seen.length);

seen.length = 0;
await handlers.model_select({ model: qwen }, ctxFor(qwen));
ok("model_select to qwen writes nothing", key() === seeded, key());
ok("  ... and names the qwen position (0.72)", String(seen[0]).includes("0.72"), seen[0]);
console.log("  visible: " + (seen[0] ?? "(silent)"));

seen.length = 0;
await handlers.model_select({ model: ds }, ctxFor(ds));
ok("model_select back to deepseek writes nothing", key() === seeded, key());

seen.length = 0;
await handlers.model_select({ model: dsPro }, ctxFor(dsPro));
ok(
	`model_select to the pro id keeps the provider level (${Math.round(provLevel.emergencyPct * provLevel.limit)} of ${provLevel.limit})`,
	String(seen[0]).includes(`${Math.round(provLevel.emergencyPct * provLevel.limit)} of a ${provLevel.limit} judge window`),
	seen[0],
);
console.log("  visible: " + (seen[0] ?? "(silent)"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail === 0) rmSync(sandbox, { recursive: true, force: true });
else console.log("sandbox kept for inspection: " + sandbox);
process.exit(fail === 0 ? 0 : 1);
