/**
 * Project namespace resolution for coms.
 *
 * A coms name is only unique inside one project namespace. Registering every
 * session in a single namespace called "default" makes `manager` a machine-wide
 * name, so two APM projects running at once fight over it: the second session is
 * renamed, every worker still addresses `manager`, and the wake-up lands in the
 * other project's session.
 *
 * The namespace is therefore derived from the project directory: the nearest
 * ancestor of the session's cwd that holds a `.apm` directory. Sessions outside
 * any APM project keep the old "default" namespace.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const DEFAULT_PROJECT = "default";

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		// Unreadable state resolves to "not a project", so a broken path keeps the
		// caller in the fallback namespace instead of failing session start.
		return false;
	}
}

const WORKTREE_INFIX = `${path.sep}.apm${path.sep}worktrees${path.sep}`;

/**
 * True for a parallel-dispatch worktree root, e.g. `<root>/.apm/worktrees/feat-x`.
 * When the project tracks `.apm`, every worktree carries its own copy of it, and
 * stopping at that copy would give the Worker a namespace of its own. Its
 * `coms_send("manager")` would then resolve to nobody and the report would never
 * reach the Manager. The worktree belongs to the project that owns it.
 */
function isWorktreeCopy(dir: string): boolean {
	return `${dir}${path.sep}`.includes(WORKTREE_INFIX);
}

function findProjectRoot(cwd: string): string | null {
	let dir = path.resolve(cwd);
	for (;;) {
		if (isDirectory(path.join(dir, ".apm")) && !isWorktreeCopy(dir)) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export function slugifyProjectPath(root: string): string {
	const slug = path
		.resolve(root)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug.length > 0 ? slug : DEFAULT_PROJECT;
}

export function deriveProject(cwd: string): string {
	const root = findProjectRoot(cwd || process.cwd());
	return root ? slugifyProjectPath(root) : DEFAULT_PROJECT;
}
