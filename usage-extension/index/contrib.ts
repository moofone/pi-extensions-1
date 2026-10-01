/**
 * Contributions (LANE contrib OWNS THIS FILE). Scaffold: rebuilds every contribution on every update with
 * the legacy rules (collectUsageDataLegacy step 6) and reports `reset: true`. Keep the exported API.
 */
import {
	buildScannedSessionIndex,
	classifyMiss,
	EXCLUDED_PROVIDERS,
	projectLabelFromCwd,
	resolvedToolChildIdentities,
	toolUsageMessages,
} from "../data.ts";
import type { MessageMeta, SessionMessage } from "../data.ts";
import { canonicalProvider, pricedDevinCost } from "../sources.ts";
import { compareCanonical } from "./types.ts";
import type { ContributionDelta, ContributionUpdate, CountedMessage, FileContribution, FileRecord } from "./types.ts";

export class ContributionTracker {
	private records = new Map<string, FileRecord>();

	/** Records currently tracked (read-only view, for the service). */
	get size(): number {
		return this.records.size;
	}

	update(update: ContributionUpdate): ContributionDelta {
		for (const path of update.removed) this.records.delete(path);
		for (const outcome of update.upserts) this.records.set(outcome.record.path, outcome.record);
		return { reset: true, replaced: buildContributions(this.records), appended: [], removed: [] };
	}
}

/**
 * Legacy-equivalent contributions for a full set of records: canonical order, cross-file dedupe by message
 * hash, adjacency meta in raw file order, first-assistant session starts, miss classification against the
 * cache-reporting provider set, nested tool-usage auxiliary messages. Messages are copied, never mutated.
 */
export function buildContributions(records: Map<string, FileRecord>): FileContribution[] {
	const ordered = [...records.values()].sort(compareCanonical);
	const scanned = buildScannedSessionIndex(records);
	const resolvedChildren = resolvedToolChildIdentities(records, scanned);
	const reporting = new Set<string>();
	for (const r of ordered) for (const m of r.parsed.messages) if (m.cacheRead > 0 || m.cacheWrite > 0) reporting.add(canonicalProvider(m.provider));
	const seenHashes = new Set<string>();
	const seenSessions = new Set<string>();
	const out: FileContribution[] = [];
	for (const r of ordered) {
		if (!r.parsed.sessionId) continue;
		const tool = r.parsed.toolUsages.flatMap((t) => toolUsageMessages(r.path, t, scanned, resolvedChildren));
		const raw = tool.length > 0 ? [...r.parsed.messages, ...tool] : r.parsed.messages;
		const counted: CountedMessage[] = [];
		let previousAssistant: SessionMessage | null = null;
		for (const original of raw) {
			const m: SessionMessage = { ...original, provider: canonicalProvider(original.provider) };
			if (m.source === "assistant") m.cost = pricedDevinCost(m.provider, m.model, m);
			const prev = m.source === "assistant" ? previousAssistant : null;
			if (m.source === "assistant") previousAssistant = m;
			const fp = m.input + m.output + m.cacheRead + m.cacheWrite;
			const hash = m.sourceId !== "" ? `${m.source}:${m.sourceId}:${m.timestamp}:${fp}` : `${m.source}:${m.timestamp}:${fp}`;
			if (seenHashes.has(hash)) continue;
			seenHashes.add(hash);
			const meta: MessageMeta = {
				gapMs: prev && prev.timestamp > 0 && m.timestamp > 0 ? m.timestamp - prev.timestamp : -1,
				prevCtx: prev ? prev.input + prev.cacheRead + prev.cacheWrite : 0,
				modelSwitched: prev !== null && (prev.provider !== m.provider || prev.model !== m.model),
				isSessionStart: false,
			};
			counted.push({ msg: m, meta, miss: null });
		}
		if (counted.length === 0) continue;
		const first = counted.findIndex((c) => c.msg.source === "assistant");
		if (first !== -1 && !seenSessions.has(r.parsed.sessionId)) {
			seenSessions.add(r.parsed.sessionId);
			counted[first]!.meta.isSessionStart = true;
		}
		for (const c of counted) {
			if (EXCLUDED_PROVIDERS.has(c.msg.provider)) continue;
			c.miss = classifyMiss(c.msg, c.meta, reporting);
		}
		out.push({ path: r.path, kind: r.kind, sessionId: r.parsed.sessionId, project: projectLabelFromCwd(r.parsed.cwd), counted });
	}
	return out;
}
