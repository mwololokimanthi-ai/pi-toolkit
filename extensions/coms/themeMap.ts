/**
 * themeMap.ts — Per-extension default theme assignments
 *
 * Themes live in .pi/agent/themes/ and are mapped by extension filename (no extension).
 * Each extension calls applyExtensionTheme(import.meta.url, ctx) in its session_start
 * hook to automatically load its designated theme on boot.
 *
 * Available themes (.pi/agent/themes/):
 *   catppuccin-mocha · cyberpunk · dracula · everforest · gruvbox
 *   midnight-ocean   · nord      · ocean-breeze · rose-pine
 *   synthwave        · tokyo-night
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { basename, dirname } from "path";
import { fileURLToPath } from "url";

// ── Theme assignments ──────────────────────────────────────────────────────
//
// Key   = extension filename without extension (matches extensions/<key>.ts)
// Value = theme name from .pi/themes/<value>.json
//
export const THEME_MAP: Record<string, string> = {
	"agent-chain":        "midnight-ocean",   // deep sequential pipeline
	"agent-team":         "dracula",          // rich orchestration palette
	"coms":               "synthwave",        // auto-loads in every session, so it must match the saved theme
	"coms-net":           "ocean-breeze",     // peer-to-peer messaging, cross-boundary
	"cross-agent":        "ocean-breeze",     // cross-boundary, connecting
	"damage-control":     "gruvbox",          // grounded, earthy safety
	"minimal":            "synthwave",        // synthwave by default now!
	"pi-pi":              "rose-pine",        // warm creative meta-agent
	"pure-focus":         "everforest",       // calm, distraction-free
	"purpose-gate":       "tokyo-night",      // intentional, sharp focus
	"session-replay":     "catppuccin-mocha", // soft, reflective history
	"subagent-widget":    "cyberpunk",        // multi-agent futuristic
	"system-select":      "catppuccin-mocha", // soft selection UI
	"theme-cycler":       "synthwave",        // neon, it's a theme tool
	"tilldone":           "everforest",       // task-focused calm
	"tool-counter":       "synthwave",        // techy metrics
	"tool-counter-widget":"synthwave",        // same family
};

// ── Helpers ───────────────────────────────────────────────────────────────

/** Derive the extension name (e.g. "minimal", or "coms" for coms/index.ts) from its import.meta.url. */
function extensionName(fileUrl: string): string {
	const filePath = fileUrl.startsWith("file://") ? fileURLToPath(fileUrl) : fileUrl;
	const stem = basename(filePath).replace(/\.[^.]+$/, "");
	// Folder extensions load as <dir>/index.ts, so their identity is the folder name -
	// which is what THEME_MAP is keyed by ("coms", not "index").
	if (stem === "index") return basename(dirname(filePath));
	return stem;
}

// ── Theme ──────────────────────────────────────────────────────────────────

/**
 * Apply the mapped theme for an extension on session boot.
 *
 * @param fileUrl   Pass `import.meta.url` from the calling extension file.
 * @param ctx       The ExtensionContext from the session_start handler.
 * @returns         true if the theme was applied successfully, false otherwise.
 *
 * The theme is applied in-memory for this session only, so it never overwrites the
 * `theme` setting in settings.json - only /settings changes your saved theme.
 */
export function applyExtensionTheme(fileUrl: string, ctx: ExtensionContext): boolean {
	if (!ctx.hasUI) return false;

	const name = extensionName(fileUrl);
	
	// If there are multiple extensions stacked in 'ipi', they each fire session_start
	// and try to apply their own mapped theme. The LAST one to fire wins.
	// Since system-select is last in the ipi alias array, it was setting 'catppuccin-mocha'.
	
	// We want to skip theme application for all secondary extensions if they are stacked,
	// so the primary extension (first in the array) dictates the theme.
	const primaryExt = primaryExtensionName();
	if (primaryExt && primaryExt !== name) {
		return true; // Pretend we succeeded, but don't overwrite the primary theme
	}

	const themeName = THEME_MAP[name];
	if (!themeName) return false; // Unmapped extension: leave the user's saved theme alone.

	// Apply the Theme *instance*, not its name. setTheme("<name>") writes that name into
	// settings.json (settingsManager.setTheme), whereas an instance only themes the current
	// session - interactive-mode routes it to setThemeInstance, which never persists.
	const theme = ctx.ui.getTheme(themeName);
	if (!theme) return false; // Mapped theme isn't installed: leave the saved theme alone.

	return ctx.ui.setTheme(theme).success;
}
// ── Title ──────────────────────────────────────────────────────────────────

/**
 * Read process.argv to find the first -e / --extension flag value.
 *
 * When Pi is launched as:
 *   pi -e extensions/subagent-widget.ts -e extensions/pure-focus.ts
 *
 * process.argv contains those paths verbatim. Every stacked extension calls
 * this and gets the same answer ("subagent-widget"), so all setTitle calls
 * are idempotent — no shared state or deduplication needed.
 *
 * Returns null if no -e flag is present (e.g. plain `pi` with no extensions).
 */
function primaryExtensionName(): string | null {
	const argv = process.argv;
	for (let i = 0; i < argv.length - 1; i++) {
		if (argv[i] === "-e" || argv[i] === "--extension") {
			return extensionName(argv[i + 1]);
		}
	}
	return null;
}

/**
 * Set the terminal title to "π - <first-extension-name>" on session boot.
 * Reads the title from process.argv so all stacked extensions agree on the
 * same value — no coordination or shared state required.
 *
 * Deferred 150 ms to fire after Pi's own startup title-set.
 */
function applyExtensionTitle(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const name = primaryExtensionName();
	if (!name) return;
	setTimeout(() => ctx.ui.setTitle(`π - ${name}`), 150);
}

// ── Combined default ───────────────────────────────────────────────────────

/**
 * Apply both the mapped theme AND the terminal title for an extension.
 * Drop-in replacement for applyExtensionTheme — call this in every session_start.
 *
 * Usage:
 *   import { applyExtensionDefaults } from "./themeMap.ts";
 *
 *   pi.on("session_start", async (_event, ctx) => {
 *     applyExtensionDefaults(import.meta.url, ctx);
 *     // ... rest of handler
 *   });
 */
export function applyExtensionDefaults(fileUrl: string, ctx: ExtensionContext): void {
	applyExtensionTheme(fileUrl, ctx);
	applyExtensionTitle(ctx);
}
