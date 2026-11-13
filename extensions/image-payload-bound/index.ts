/**
 * image-payload-bound — keep the accumulated image bytes in each provider request
 * under a fixed budget.
 *
 * Why this exists
 * ---------------
 * Pi re-sends the whole transcript on every turn, and image blocks are held as base64
 * (4/3 the raw byte size). A long-lived session that reads ~20 large page scans therefore
 * accumulates tens of megabytes of image payload, and the provider edge eventually
 * rejects the request with HTTP 413:
 *
 *   - nginx:      "413 Request Entity Too Large"
 *   - axum/text:  "Failed to buffer the request body: length limit exceeded"
 *
 * Measured on this machine (deepseek-api / deepseek-v4-flash, page scans of 1654x2338):
 * a request carrying 20 images / ~51.3 MiB of base64 succeeded once and failed other
 * times, and 21 images / ~54.2 MiB failed consistently — so the real cap sits near
 * 51-54 MiB. Pi treats that error as non-retryable and never trims anything, so the
 * session wedges permanently: every later request replays the same oversized body.
 * Images are also ~800x cheaper in tokens than in bytes (a 20 MiB request measured only
 * ~6.7k input tokens), so pi's token-based compaction never notices the growth.
 *
 * What it does
 * ------------
 * Before each LLM call, if total base64 image bytes exceed the budget, the OLDEST images
 * are first re-encoded into progressively smaller tiers (resizeImage — the same encoder
 * the read tool uses) and are only given up if downscaling is not enough. A given-up
 * image becomes a text placeholder naming the source file, so it can always be re-read.
 * The newest image is never touched, and only the request projection is shaped: the
 * transcript on disk keeps every image. Mirrors the maxRequestImageBytes policy in
 * deepseek-ai/deepseek-harness.
 *
 * Hysteresis: trimming starts only above 1.2x the budget and then aims for 0.8x, so the
 * request prefix stays byte-stable across most turns and the provider's prompt cache is
 * not invalidated every time a new image arrives.
 *
 * Learning: a provider 413 lowers the budget to 0.75x of the image payload that was
 * actually rejected and persists it per provider/model in
 * ~/.pi/agent/state/image-payload-budget.json, so the next session starts safe instead of
 * burning another rejected turn.
 *
 * Budget: 20 MiB by default (~2.5x headroom under the measured cap). Override with
 * PI_MAX_REQUEST_IMAGE_BYTES — an explicit override wins over a learned value and is never
 * overwritten by learning.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import type {
	ContextEvent,
	ContextEventResult,
	ExtensionAPI,
	MessageEndEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_BUDGET_BYTES = 20 * 1024 * 1024;
const MIN_BUDGET_BYTES = 1 * 1024 * 1024;
/** Start trimming only above this multiple of the budget, keeping the request prefix stable. */
const TRIM_TRIGGER = 1.2;
/** Once trimming, aim for this multiple of the budget. */
const TRIM_TARGET = 0.8;
/** A rejected request sets the next budget to this multiple of the payload that was rejected. */
const REJECTION_HEADROOM = 0.75;
/** Never cut more than this much in one rejection, so one flaky edge cannot collapse the budget. */
const REJECTION_MAX_CUT = 0.9;

/** Progressive downscale ladder, tried from the top. Each entry is an ImageResizeOptions. */
const ENCODE_TIERS = [
	{ maxWidth: 1400, maxHeight: 1400, maxBytes: 500_000, jpegQuality: 70 },
	{ maxWidth: 1000, maxHeight: 1000, maxBytes: 250_000, jpegQuality: 60 },
	{ maxWidth: 700, maxHeight: 700, maxBytes: 120_000, jpegQuality: 50 },
];
/** Upper bound on the re-encoded images kept in memory. */
const ENCODE_CACHE_BYTES = 48 * 1024 * 1024;

/** Substrings that identify a provider-side request-body limit rejection. */
const BODY_LIMIT_SIGNATURES = [
	"Failed to buffer the request body: length limit exceeded",
	"Request Entity Too Large",
	"request_too_large",
	"request body exceeds",
];

type Block = {
	type?: string;
	text?: string;
	data?: string;
	mimeType?: string;
	id?: string;
	arguments?: { path?: unknown };
};
type MessageLike = { role?: string; content?: string | Block[]; toolCallId?: string };

type ImageEntry = {
	messageIndex: number;
	blockIndex: number;
	key: string;
	bytes: number;
	effectiveBytes: number;
	mimeType: string;
	data: string;
	path?: string;
};

type LearnedState = Record<string, { budgetBytes?: number; rejectedBytes?: number }>;

function envBudget(): number | undefined {
	const raw = process.env.PI_MAX_REQUEST_IMAGE_BYTES;
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

function modelKey(model: { provider?: unknown; id?: unknown } | undefined): string {
	return `${String(model?.provider ?? "unknown")}/${String(model?.id ?? "unknown")}`;
}

function budgetFile(): string {
	return join(homedir(), ".pi", "agent", "state", "image-payload-budget.json");
}

function readLearned(): LearnedState {
	try {
		return JSON.parse(readFileSync(budgetFile(), "utf8")) as LearnedState;
	} catch {
		return {};
	}
}

function learnBudget(key: string, budgetBytes: number, rejectedBytes: number): void {
	try {
		const state = readLearned();
		state[key] = { budgetBytes, rejectedBytes };
		const file = budgetFile();
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
	} catch {
		// Best effort: never break a session over budget bookkeeping.
	}
}

function mib(bytes: number): string {
	return (bytes / (1024 * 1024)).toFixed(1);
}

function placeholderFor(image: ImageEntry, budgetBytes: number): string {
	const source = image.path
		? `Re-read ${image.path} to view it again.`
		: "Re-read the source file to view it again.";
	return (
		`[image omitted from this request: ${image.mimeType}, ${Math.round(image.bytes / 1024)} KB — ` +
		`the session image payload exceeded the ${mib(budgetBytes)} MiB request budget. ${source}]`
	);
}

export default function (pi: ExtensionAPI) {
	let budgetBytes = DEFAULT_BUDGET_BYTES;
	let key = "unknown/unknown";
	let droppedLastRequest = 0;
	let downscaledLastRequest = 0;
	let lastRequestBytes = 0;
	let pendingNote: Record<string, unknown> | undefined;
	const encodeCache = new Map<string, { data: string; mimeType: string }>();
	let encodeCacheBytes = 0;

	function syncModel(ctx: { model?: { provider?: unknown; id?: unknown } }): void {
		const nextKey = modelKey(ctx.model);
		if (nextKey === key) return;
		key = nextKey;
		budgetBytes = envBudget() ?? readLearned()[key]?.budgetBytes ?? DEFAULT_BUDGET_BYTES;
	}

	async function encodeTier(
		image: ImageEntry,
		tierIndex: number,
		tier: (typeof ENCODE_TIERS)[number],
	): Promise<{ data: string; mimeType: string; bytes: number } | null> {
		const cacheKey = `${image.key}#${tierIndex}`;
		const cached = encodeCache.get(cacheKey);
		if (cached) {
			const bytes = Buffer.byteLength(cached.data);
			return bytes < image.bytes ? { ...cached, bytes } : null;
		}
		const result = await resizeImage(Buffer.from(image.data, "base64"), image.mimeType, tier);
		if (!result) return null;
		const bytes = Buffer.byteLength(result.data);
		if (bytes >= image.bytes) return null;

		encodeCache.set(cacheKey, { data: result.data, mimeType: result.mimeType });
		encodeCacheBytes += bytes;
		while (encodeCacheBytes > ENCODE_CACHE_BYTES && encodeCache.size > 1) {
			const oldestKey = encodeCache.keys().next().value as string;
			const oldest = encodeCache.get(oldestKey);
			if (oldest) encodeCacheBytes -= Buffer.byteLength(oldest.data);
			encodeCache.delete(oldestKey);
		}
		return { data: result.data, mimeType: result.mimeType, bytes };
	}

	pi.on("session_start", (_event: SessionStartEvent, ctx) => {
		key = modelKey(ctx.model);
		budgetBytes = envBudget() ?? readLearned()[key]?.budgetBytes ?? DEFAULT_BUDGET_BYTES;
		droppedLastRequest = 0;
		downscaledLastRequest = 0;
		lastRequestBytes = 0;
		pendingNote = undefined;
	});

	pi.on("context", async (event: ContextEvent, ctx): Promise<ContextEventResult | undefined> => {
		syncModel(ctx);
		const messages = event.messages as MessageLike[];

		// A tool that took a `path` (read) records the image's source file; the tool result
		// carries the matching toolCallId, so a placeholder can name the file to re-read.
		const paths = new Map<string, string>();
		for (const message of messages) {
			if (!Array.isArray(message?.content)) continue;
			for (const block of message.content) {
				if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
				const path = block.arguments?.path;
				if (typeof path === "string") paths.set(block.id, path);
			}
		}

		const images: ImageEntry[] = [];
		let totalBytes = 0;
		for (const [messageIndex, message] of messages.entries()) {
			const content = message?.content;
			if (!Array.isArray(content)) continue;
			for (const [blockIndex, block] of content.entries()) {
				if (block?.type !== "image" || typeof block.data !== "string") continue;
				const bytes = Buffer.byteLength(block.data);
				const toolCallId = message.toolCallId;
				images.push({
					messageIndex,
					blockIndex,
					key: typeof toolCallId === "string" ? `${toolCallId}#${blockIndex}` : `${messageIndex}:${blockIndex}`,
					bytes,
					effectiveBytes: bytes,
					mimeType: block.mimeType ?? "image",
					data: block.data,
					path: typeof toolCallId === "string" ? paths.get(toolCallId) : undefined,
				});
				totalBytes += bytes;
			}
		}
		lastRequestBytes = totalBytes;
		if (images.length === 0) return;

		// Hysteresis: between the budget and the trigger, leave the request byte-identical to
		// the previous one so the provider's prompt cache keeps matching.
		if (totalBytes <= budgetBytes * TRIM_TRIGGER || images.length === 1) {
			droppedLastRequest = 0;
			downscaledLastRequest = 0;
			return;
		}

		const targetBytes = Math.max(MIN_BUDGET_BYTES, Math.floor(budgetBytes * TRIM_TARGET));
		const overrides = new Map<string, Block>();
		let projected = totalBytes;
		let downscaled = 0;
		let dropped = 0;

		// 1. Re-encode the oldest images into smaller tiers before giving any of them up.
		for (let index = 0; index < images.length - 1 && projected > targetBytes; index++) {
			const image = images[index];
			for (const [tierIndex, tier] of ENCODE_TIERS.entries()) {
				const smaller = await encodeTier(image, tierIndex, tier);
				if (!smaller) continue;
				overrides.set(`${image.messageIndex}:${image.blockIndex}`, {
					type: "image",
					data: smaller.data,
					mimeType: smaller.mimeType,
				});
				projected -= image.bytes - smaller.bytes;
				image.effectiveBytes = smaller.bytes;
				downscaled++;
				break;
			}
		}

		// 2. Only if that was not enough, replace the oldest images with a note naming the file.
		for (let index = 0; index < images.length - 1 && projected > targetBytes; index++) {
			const image = images[index];
			overrides.set(`${image.messageIndex}:${image.blockIndex}`, {
				type: "text",
				text: placeholderFor(image, budgetBytes),
			});
			projected -= image.effectiveBytes;
			dropped++;
		}

		if (downscaled === 0 && dropped === 0) return;

		const trimmed = messages.map((message, messageIndex) => {
			const content = message?.content;
			if (!Array.isArray(content)) return message;
			if (!content.some((_, blockIndex) => overrides.has(`${messageIndex}:${blockIndex}`))) return message;
			return {
				...message,
				content: content.map((block, blockIndex) => overrides.get(`${messageIndex}:${blockIndex}`) ?? block),
			};
		}) as ContextEventResult["messages"];

		lastRequestBytes = projected;

		if (downscaled > downscaledLastRequest || dropped > droppedLastRequest) {
			ctx.ui.notify(
				`Image payload ${mib(totalBytes)} MiB exceeds the ${mib(budgetBytes)} MiB request budget: ` +
					`downscaled ${downscaled} and replaced ${dropped} of the oldest image(s) (newest kept).`,
				"warning",
			);
			// Durable, model-invisible record of why an image is missing from this request.
			pendingNote = { event: "trim", totalBytes, budgetBytes, targetBytes, downscaled, dropped };
		}
		droppedLastRequest = dropped;
		downscaledLastRequest = downscaled;

		return { messages: trimmed };
	});

	pi.on("message_end", (event: MessageEndEvent, ctx) => {
		syncModel(ctx);
		const message = event.message as MessageLike & { stopReason?: string; errorMessage?: string };

		if (pendingNote) {
			pi.appendEntry("image-payload-bound", pendingNote);
			pendingNote = undefined;
		}

		if (message?.role !== "assistant" || message.stopReason !== "error") return;
		const errorText = message.errorMessage ?? "";
		if (!BODY_LIMIT_SIGNATURES.some((signature) => errorText.includes(signature))) return;

		// Learn from the payload that was actually rejected instead of blind halving, so the
		// next session starts below the edge's cap instead of burning another rejected turn.
		const rejectedBytes = lastRequestBytes;
		const learned =
			rejectedBytes > 0 ? Math.floor(rejectedBytes * REJECTION_HEADROOM) : Math.floor(budgetBytes / 2);
		const previous = budgetBytes;
		budgetBytes = Math.max(MIN_BUDGET_BYTES, Math.min(learned, Math.floor(budgetBytes * REJECTION_MAX_CUT)));
		droppedLastRequest = 0;
		downscaledLastRequest = 0;

		const persisted = envBudget() === undefined && rejectedBytes > 0;
		if (persisted) learnBudget(key, budgetBytes, rejectedBytes);
		pi.appendEntry("image-payload-bound", {
			event: "body-limit",
			rejectedBytes,
			previousBudget: previous,
			budgetBytes,
			persisted,
			error: errorText.trim(),
		});
		ctx.ui.notify(
			`Provider rejected the request body (${errorText.trim()}). Lowered the image-payload ` +
				`budget from ${mib(previous)} MiB to ${mib(budgetBytes)} MiB` +
				`${persisted ? ` and saved it for ${key}` : ""}; ` +
				`the next request will drop more of the oldest images.`,
			"error",
		);
	});
}
