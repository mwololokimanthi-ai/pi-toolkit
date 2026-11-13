/**
 * strategic-compact-suggest.ts
 *
 * Single purpose now: REPORT the compaction ladder on session_start and
 * model_select. It no longer writes anything -- see STAND-DOWN below. The
 * derivation is kept because it names every position in the ladder, and the
 * test file beside this one still asserts it.
 *
 * ---------------------------------------------------------------------------
 * THE COMPACTION LADDER
 * ---------------------------------------------------------------------------
 * bili owns context management. pi-vcc exists only to catch the case where
 * bili's own emergency line has already gone by and nothing has folded, so
 * the rule is positional and DERIVED, never hard-coded:
 *
 *   pi-vcc backstop = bili's emergency line x 1.01
 *
 * x 1.01 is the entire margin: close enough that bili is genuinely out of
 * runway, far enough that a nudge emitted at the emergency line has room to be
 * acted on. It also reproduces the number this file used to hard-code --
 * bili's 0.7125 emergency on a 750,000 judge window is 712,500, and
 * 712,500 x 1.01 = 719,625 = 0.72.
 *
 * 0.72 was nevertheless WRONG on this machine, because 750,000 was never the
 * judge window bili was actually using. ~/.config/billion-context/
 * billion-context.json sets an explicit limit for the deepseek provider, and
 * an explicit limit BECOMES the judge window (see "bili's window" below):
 *
 *   bili judge window   150,000   modelContextLimit, native 1,000,000
 *   bili nudge          112,500   nudge.maxContextLimitPct (.75) of it
 *   bili emergency      148,500   nudge.emergencyThresholdPercent (.99) of it
 *   pi-vcc backstop     150,000   <- OLD POSITION: 148,500 x 1.01 = 0.15 (RETRACTED)
 *   pi core wall        750,000   pi's compaction.reserveTokens, per model
 *
 * A provider with no override keeps the old answer exactly: the headroom path
 * gives 0.7125 x 1.01 = 0.7196, which rounds to 0.72. So qwen3.8-27b keeps
 * 141,558 and the 131,072 local models keep 94,372. The same is true of a
 * model whose baseUrl matches no bili provider -- no match means no override,
 * never a guess, because the failure that cannot be walked back is a lowered
 * limit landing on the wrong model.
 *
 * Read the ladder off bili's config, not off a remembered number: editing
 * `modelContextLimit` moves bili's nudge AND its emergency line, and moves
 * this extension's answer with them. That is the point of deriving it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BACKSTOP IS A POSITION, NOT AN EMPIRICAL RESULT
 * ---------------------------------------------------------------------------
 * Earlier versions of this extension derived the threshold from L_safe: the
 * longest prompt length at which retrieval was *demonstrated* reliable for
 * the model (deepseek-v4-flash: 128k on a strict-retrieval benchmark; the
 * research is preserved below). That derivation is moot. pi-vcc's job is not
 * to compact at a quality-optimal point; it is to sit one notch ABOVE bili's
 * emergency line, so that:
 *
 *   - bili always gets to act first, and
 *   - if bili has not brought context down by its own emergency threshold,
 *     pi-vcc still catches it before pi core's wall.
 *
 * Do NOT re-derive this number from the benchmark papers at the bottom of
 * this file. It is a position in a ladder, not a measurement.
 *
 * ---------------------------------------------------------------------------
 * WHY pi-vcc MUST NOT FIRE EARLIER (the historical failure)
 * ---------------------------------------------------------------------------
 * pi-vcc compacting before bili does not merely pre-empt bili -- it DESTROYS
 * bili's work. The client's compaction summary replaces the folded content,
 * so bili's blocks become unrecoverable:
 *
 *   [fold-reconcile] resent history drifted: N covered id(s) missing with no
 *   anchor match -- originals re-enter the wire unfolded (#1921)
 *
 * and decompress is permanently unavailable for them ("PRE-COMPACTION
 * ARCHIVE"). A previous version pinned 0.1152 (115,200), far BELOW bili's
 * 562,500 nudge point, so pi-vcc fired first every single time and bili never
 * got to act at all.
 *
 * ---------------------------------------------------------------------------
 * bili's window (the judge window)
 * ---------------------------------------------------------------------------
 * With NO explicit limit configured, bili reserves 25% of the native window
 * for output and judges itself against the remainder:
 *
 *   [v=0.1.185] [headroom] model=deepseek-v4-flash: effective window
 *   1000000 -> 750000 (reserved 250000 for max output 384000, cap 0.25)
 *
 * With `compress.modelContextLimit` set for a provider, that value IS the
 * judge window -- there is no headroom step on top of it. Verified live on
 * 2026-10-05: once the deepseek provider carried a 150,000 limit, [headroom]
 * lines stopped being emitted for it and the nudge denominator became
 * `usage=N/150000`. bili then reports its own view of the limit as
 * `[window] ... base=150000`.
 *
 * So an explicit limit LOWERS both bili's nudge and its emergency line, which
 * is exactly why a hard-coded backstop above them stops being one notch above
 * anything.
 *
 * bili resolves that limit at the DEEPEST level that sets it: a model's
 * `models.<id>.compress` beats the provider's `compress`, which beats the
 * global one -- `mergeCompress` picks `model?.[k] ?? provider?.[k] ?? global2?.[k]`,
 * and `resolveCompress` passes the request's model id in. So read the ladder
 * off the level bili reads, or the report is wrong for that one model while
 * looking right for its neighbours. Verified live on 2026-10-11: the anthropic
 * provider carries 420,000 and still logs `[window] model=claude-haiku-4-5 ...
 * base=150000`, because haiku has its own model-level 150,000; and after the
 * deepseek provider's 150,000 was left in place with a 200,000 entry added for
 * deepseek-v4-flash alone, GET /__bili/sessions reported that session's judge
 * window as 200,000 (flash: nudge 150,000, emergency 198,000, backstop 0.2).
 *
 * STAND-DOWN (2026-10-05): this extension used to OWN the
 * compactAtContextPercent key and re-assert it on every session_start and
 * model_select. It stopped writing because the position it computed lived in
 * the wrong SPACE. bili's emergency line is a position on the FOLDED wire;
 * pi-vcc's trigger compares `ctx.getContextUsage().tokens`, which is the
 * UNFOLDED client projection. On this machine bili folds a ~700,000-token
 * client payload down to a ~97,000-token wire, so a backstop of 0.15
 * (150,000, one notch above bili's 148,500 emergency) fired while the raw
 * projection was still 4.7x below what bili was already handling.
 *
 * Measured cost of that value (session 01a1091b, 2026-10-05):
 *   13:01:51Z  this extension wrote compactAtContextPercent 0.15
 *   13:13:49Z  [fold-reconcile] resent history drifted: 89 covered id(s) missing
 *   13:13:49Z  unannounced client history rewrite detected (464/939 messages)
 *   13:13:49Z  native compaction boundary: pruned ref maps to 939 ...
 *   /acp       PRE-COMPACTION ARCHIVE: 20 block(s) replaced by the client's
 *              native compaction summary (decompress unavailable) + 1
 *              compression conflict (unannounced-rewrite)
 * Nothing else on the machine changed in that window, and before the write
 * the key held 0.72 (720,000) -- a position the projection never reached.
 * bili's own prescription in that report: "Keep exactly ONE compressor per
 * conversation."
 *
 * The key is now 0, which is pi-vcc's documented off switch for its own
 * trigger ("0 or negative = disabled").
 *
 * That alone was NOT enough. pi core's own reserveTokens wall (window -
 * reserveTokens = 750,000 here) fired 13 minutes later, at 13:36:21Z, on the
 * same session: "resent history drifted: 954 covered id(s) missing" and
 * "archived 24 pre-compaction block(s)" -- /acp went from 20 archived blocks to
 * 26. So the client-side net was removed in two places: "compaction": {
 * "enabled": false } in ~/.pi/agent/settings.json kills the threshold trigger,
 * and extensions/no-native-compaction/ vetoes the "overflow" trigger, which
 * settings cannot reach. Nothing client-side folds a conversation now, and
 * overrideDefaultCompaction stays true only as a leftover of that arrangement.
 *
 * ---------------------------------------------------------------------------
 * SUPERSEDED PROVENANCE (kept for the record; no longer drives anything)
 * ---------------------------------------------------------------------------
 *  - deepseek-v4-flash (1M window): L_safe 128k = the longest length
 *    demonstrated to still sit on the retrieval plateau.
 *      (a) official DeepSeek-V4 tech report (arXiv 2606.19348) reports
 *          MRCR@1M of only ~78.7% for Flash (83.5% for Pro 0813): retrieval
 *          at the 1M window edge is far from perfect. Catalogued at
 *          benchlm.ai/benchmarks/mrcr1m.
 *      (b) independent strict-retrieval benchmark, chat-deep.ai release
 *          1.0.0 (344 paid cases; Zenodo DOI 10.5281/zenodo.21838863),
 *          Flash strict exact-match by provider-counted prompt tier:
 *            32K  66.7%  |  128K  61.1%  |  512K  41.7%  |  ~950K  27.8%
 *          Slope 32K->128K is only -5.6 pts; 128K->512K is -19.4 pts. The
 *          cliff sits between 128K and 512K, so 128K is the last
 *          demonstrated-plateau point (256K was not tested there).
 *      (c) plain single-needle NIAH stays ~100% much deeper (NEO/heyneo
 *          2026-05-01: 100% at 10K/100K/500K/900K in a 1M doc; emiluzelac
 *          DGX Spark: 127,532-token needle PASS). Why (c) is not the right
 *          anchor: an agentic session is the multi-fact/strict regime that
 *          (b) measures, not one buried needle. Why not LOWER: returning to
 *          32K buys only +5.6 pts while multiplying compactions.
 *    => L_safe 128k; threshold 0.9 * 128k = 115,200 = 0.1152 of the window.
 *  - deepseek-v4-pro (1M window): identical 61.1% at 128K in (b); Pro holds
 *    up better deeper (47.2% @512K, 44.4% @950K vs Flash 41.7%/27.8%).
 *  - qwen3.8-27b (262144 window): live NIAH on the user's 4-bit vLLM
 *    deployment, 2026-09 -- 30-cell thinking-off sweep + 36-cell
 *    thinking-on re-run of the top-of-window region: mid-context passes to
 *    192k (both tail depths 95/99% pass); at 224k the last ~5% of the
 *    context (where newest session content sits) fails 0/4; thinking-off
 *    collapses at 224k+ (0/12). => L_safe 196608. Context Arena
 *    (thinking on) 91-93% at 128K corroborates.
 *  - ling-3.0-tiny: no published post-training long-context numbers (model
 *    card table is image-only) => conservative 80%-of-window fallback.
 *  - *splash* variants (4-bit local serving of the base model): inherit the
 *    base model's L_safe; the per-deployment window cap then binds.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** bili's output-headroom cap: without an explicit limit it judges against 75% of the window. */
const HEADROOM = 0.75;

/** bili's nudge.emergencyThresholdPct when a provider's config does not override it. */
const EMERGENCY_DEFAULT = 0.95;

/** The entire margin above bili's emergency line. Reproduces 0.72 on a 750,000 judge window. */
const MARGIN = 1.01;

/** Whatever bili's config says, stay under pi core's wall (window - reserveTokens = 0.75 here). */
const CEILING = 0.74;

const BILI_CONFIG = join(homedir(), ".config", "billion-context", "billion-context.json");

/** A bili per-model compress override: `providers.<url>.models.<modelId>.compress`. */
export interface BiliModelOverride {
	/** `compress.modelContextLimit` for this model id only. */
	limit?: number;
	/** `compress.emergencyThresholdPercent` for this model id only. */
	emergencyPct?: number;
}

/** A bili per-provider compress override. bili keys these in its config by upstream URL. */
export interface BiliProvider {
	url: string;
	/** `compress.modelContextLimit` -- when set, it IS bili's judge window. */
	limit?: number;
	/** `compress.emergencyThresholdPercent` -- replaces the 0.95 default. */
	emergencyPct?: number;
	/**
	 * `models.<modelId>.compress` entries. Any model named here overrides this
	 * provider's own limit/emergencyPct for itself alone, the way bili's
	 * `mergeCompress` does it.
	 */
	models?: Record<string, BiliModelOverride>;
}

const readJson = (path: string): Record<string, unknown> | null => {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
	} catch {
		// missing or unparseable -> null
	}
	return null;
};

/** One `compress` block -> the two knobs that move the ladder, or undefined when it sets neither. */
const readCompress = (compress: unknown): { limit?: number; emergencyPct?: number } | undefined => {
	if (!compress || typeof compress !== "object") return undefined;
	const block = compress as Record<string, unknown>;
	const limit = typeof block.modelContextLimit === "number" ? block.modelContextLimit : undefined;
	const emergencyPct =
		typeof block.emergencyThresholdPercent === "number" ? block.emergencyThresholdPercent : undefined;
	if (limit === undefined && emergencyPct === undefined) return undefined;
	return { limit, emergencyPct };
};

/** Every bili provider override that moves the judge window or its emergency line. */
export const biliProviders = (): BiliProvider[] => {
	const providers = readJson(BILI_CONFIG)?.providers;
	if (!providers || typeof providers !== "object") return [];
	const out: BiliProvider[] = [];
	type RawEntry = { compress?: Record<string, unknown>; models?: Record<string, { compress?: Record<string, unknown> }> };
	for (const [url, entry] of Object.entries(providers as Record<string, RawEntry>)) {
		const models: Record<string, BiliModelOverride> = {};
		for (const [modelId, model] of Object.entries(entry?.models ?? {})) {
			const override = readCompress(model?.compress);
			if (override) models[modelId] = override;
		}
		const own = readCompress(entry?.compress);
		// A provider that only tunes one model still moves the ladder for that model.
		if (!own && Object.keys(models).length === 0) continue;
		out.push({
			url,
			limit: own?.limit,
			emergencyPct: own?.emergencyPct,
			...(Object.keys(models).length > 0 ? { models } : {}),
		});
	}
	return out;
};

/** `https://api.deepseek.com/v1` -> `api.deepseek.com`. */
const hostOf = (url?: string): string => (url ?? "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();

/**
 * Which override governs this model. bili keys its providers by upstream URL
 * and pi's runtime model always carries `baseUrl` (required on pi-ai's
 * BaseModel), so the host is the join key.
 *
 * NO MATCH MEANS NO OVERRIDE, deliberately. A lowered `modelContextLimit`
 * leaking onto an unrelated model is the one unrecoverable failure available
 * here: on a 196,608 window a stray 150,000 limit would put the backstop at
 * 0.15 and pi-vcc would fold constantly. Falling through to the headroom path
 * instead leaves such a model at 0.72 -- what it had before this was derived.
 */
export const pickProvider = (providers: BiliProvider[], baseUrl?: string): BiliProvider | undefined => {
	const host = hostOf(baseUrl);
	if (!host) return undefined;
	return providers.find((p) => {
		const pHost = hostOf(p.url);
		return pHost !== "" && (pHost === host || pHost.endsWith(host) || host.endsWith(pHost));
	});
};

/**
 * The override that governs one model: its own `models.<id>.compress` entry
 * first, else the provider level. bili resolves the same way, so a model-level
 * entry moves bili's ladder and must move this report with it.
 *
 * No model id, or no entry for it, means the provider level stands -- the same
 * no-match-means-no-override rule pickProvider applies to hosts.
 */
export const resolveProvider = (
	providers: BiliProvider[],
	baseUrl?: string,
	modelId?: string,
): BiliProvider | undefined => {
	const provider = pickProvider(providers, baseUrl);
	if (!provider) return undefined;
	const model = modelId ? provider.models?.[modelId] : undefined;
	if (!model) return provider;
	return {
		url: provider.url,
		limit: model.limit ?? provider.limit,
		emergencyPct: model.emergencyPct ?? provider.emergencyPct,
	};
};

/**
 * The backstop: bili's emergency line x MARGIN, as a fraction of the model's
 * window. Rounded to 3 decimals so the written value is stable across runs
 * (0.15 on a 150,000 judge window; 0.72 on an unconfigured 1M window).
 */
export const deriveBackstop = (windowTokens: number, provider?: BiliProvider): number | null => {
	if (!(windowTokens > 0)) return null;
	const judge = provider?.limit && provider.limit > 0 ? provider.limit : HEADROOM * windowTokens;
	const emergency = (provider?.emergencyPct ?? EMERGENCY_DEFAULT) * judge;
	return Number(Math.min(CEILING, (emergency * MARGIN) / windowTokens).toFixed(3));
};

export default function piVccBackstop(pi: ExtensionAPI) {
	const sendVisible = (text: string) => {
		pi.sendMessage({ customType: "strategic-compact", content: text, display: true }, { deliverAs: "steer" });
	};

	/**
	 * Report the ladder for this model. Writes nothing: pi-vcc's own trigger is
	 * OFF by design (see STAND-DOWN in the header), so bili is the only thing
	 * compacting the wire.
	 */
	const report = (model: { contextWindow?: number; baseUrl?: string; id?: string } | undefined) => {
		const windowTokens = model?.contextWindow ?? 0;
		const provider = resolveProvider(biliProviders(), model?.baseUrl, model?.id);
		const percent = deriveBackstop(windowTokens, provider);
		if (percent === null) return;
		const judge = provider?.limit && provider.limit > 0 ? provider.limit : HEADROOM * windowTokens;
		const emergency = (provider?.emergencyPct ?? EMERGENCY_DEFAULT) * judge;
		sendVisible(
			`[pi-vcc backstop] trigger OFF (compactAtContextPercent 0). bili's emergency line is ` +
				`${Math.round(emergency)} of a ${Math.round(judge)} judge window; the retracted backstop position ` +
				`was ${percent}. No client-side net is armed: pi core's threshold trigger is off ` +
				`("compaction.enabled": false) and its overflow trigger is vetoed by ` +
				`extensions/no-native-compaction/. bili is the only compressor left.`,
		);
	};

	pi.on("session_start", (_event, ctx) => {
		// ctx.model, not ctx.getModel(): the extension context exposes the current
		// model as a property, and calling a missing method threw before the report.
		report(ctx.model);
	});

	pi.on("model_select", (event, ctx) => {
		report(event?.model ?? ctx.model);
	});
}
