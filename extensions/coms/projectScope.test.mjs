// Run: node --experimental-strip-types --no-warnings extensions/coms/projectScope.test.mjs
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deriveProject, slugifyProjectPath, DEFAULT_PROJECT } from "./projectScope.ts";

let passed = 0;
function check(name, fn) {
	fn();
	passed++;
	console.log(`ok ${passed} - ${name}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coms-scope-"));
const projA = path.join(tmp, "Solar Power");
const projB = path.join(tmp, "nested", "Solar Power");
const plain = path.join(tmp, "no-apm-here");
for (const p of [projA, projB, path.join(projB, ".apm"), path.join(projA, ".apm"), path.join(projA, "sub", "deep"), plain]) {
	fs.mkdirSync(p, { recursive: true });
}
const outer = path.join(tmp, "Upgrades");
const inner = path.join(outer, "track-b");
for (const p of [path.join(outer, ".apm"), path.join(inner, ".apm"), path.join(inner, "sub")]) {
	fs.mkdirSync(p, { recursive: true });
}
const worktree = path.join(outer, ".apm", "worktrees", "feat-x");
for (const p of [path.join(worktree, ".apm"), path.join(worktree, "src")]) {
	fs.mkdirSync(p, { recursive: true });
}

try {
	check("project root with .apm is its own namespace", () => {
		assert.equal(deriveProject(projA), slugifyProjectPath(projA));
		assert.ok(deriveProject(projA).includes("solar-power"));
	});

	check("a nested cwd resolves to the .apm ancestor", () => {
		assert.equal(deriveProject(path.join(projA, "sub", "deep")), deriveProject(projA));
	});

	check("spaces and capitals are slugified", () => {
		assert.equal(slugifyProjectPath("/workspace/project-alpha"), "workspace-project-alpha");
	});

	check("same basename under different parents gets different namespaces", () => {
		assert.notEqual(deriveProject(projA), deriveProject(projB));
	});

	check("no .apm anywhere keeps the legacy default namespace", () => {
		assert.equal(deriveProject(plain), DEFAULT_PROJECT);
	});

	check("a path that does not exist resolves to default", () => {
		assert.equal(deriveProject(path.join(tmp, "missing-dir")), DEFAULT_PROJECT);
	});

	check("a nested .apm root beats the enclosing project", () => {
		assert.equal(deriveProject(outer), slugifyProjectPath(outer));
		assert.equal(deriveProject(inner), slugifyProjectPath(inner));
		assert.equal(deriveProject(path.join(inner, "sub")), slugifyProjectPath(inner));
		assert.notEqual(deriveProject(outer), deriveProject(inner));
	});

	check("a parallel-dispatch worktree belongs to the project that owns it", () => {
		assert.equal(deriveProject(worktree), slugifyProjectPath(outer));
		assert.equal(deriveProject(path.join(worktree, "src")), slugifyProjectPath(outer));
	});
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, 0 failed`);
