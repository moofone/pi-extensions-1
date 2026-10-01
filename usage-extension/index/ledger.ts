/**
 * Ledger (LANE ledger OWNS THIS FILE). Scaffold: keeps contributions and runs the legacy per-message
 * aggregation at snapshot time (O(all messages) per snapshot). Keep the exported API.
 */
import { addMessagesToUsageData, computeInsights, emptyPeriodRawData, emptyUsageData, TAB_ORDER } from "../data.ts";
import type { MessageMeta, PeriodBounds, PeriodRawData, SessionMessage, TabName, TrendInfo, UsageData } from "../data.ts";
import { compareCanonical } from "./types.ts";
import type { ContributionDelta, FileContribution, LedgerStats } from "./types.ts";

/** Local-calendar period starts for `now` (identical to collectUsageDataLegacy). */
export function periodBounds(now: Date): PeriodBounds {
	const today = new Date(now);
	today.setHours(0, 0, 0, 0);
	const week = new Date(now);
	const dow = week.getDay();
	week.setDate(week.getDate() - (dow === 0 ? 6 : dow - 1));
	week.setHours(0, 0, 0, 0);
	const lastWeek = new Date(week);
	lastWeek.setDate(lastWeek.getDate() - 7);
	const last30 = new Date(today);
	last30.setDate(last30.getDate() - 29);
	return { todayMs: today.getTime(), weekStartMs: week.getTime(), lastWeekStartMs: lastWeek.getTime(), last30DaysStartMs: last30.getTime(), nowMs: now.getTime() };
}

export class UsageLedger {
	private files = new Map<string, FileContribution>();

	apply(delta: ContributionDelta): void {
		if (delta.reset) this.files.clear();
		for (const path of delta.removed) this.files.delete(path);
		for (const c of delta.replaced) this.files.set(c.path, { ...c, counted: [...c.counted] });
		for (const a of delta.appended) {
			const f = this.files.get(a.path);
			if (f) f.counted.push(...a.counted);
		}
	}

	stats(): LedgerStats {
		let countedMessages = 0;
		for (const f of this.files.values()) countedMessages += f.counted.length;
		return { files: this.files.size, countedMessages, buckets: 0 };
	}

	snapshot(now: Date): UsageData {
		const b = periodBounds(now);
		const data = emptyUsageData(b);
		const raw = Object.fromEntries(TAB_ORDER.map((t) => [t, emptyPeriodRawData()])) as Record<TabName, PeriodRawData>;
		const costByDayIdx = new Map<number, number>();
		const reporting = new Set<string>();
		for (const f of this.files.values()) for (const c of f.counted) if (c.msg.source === "assistant" && (c.msg.cacheRead > 0 || c.msg.cacheWrite > 0)) reporting.add(c.msg.provider);
		for (const f of [...this.files.values()].sort(compareCanonical)) {
			const messages: SessionMessage[] = f.counted.map((c) => c.msg);
			const meta: MessageMeta[] = f.counted.map((c) => c.meta);
			addMessagesToUsageData(data, f.sessionId, f.project, messages, meta, b.todayMs, b.weekStartMs, b.lastWeekStartMs, b.last30DaysStartMs, raw, costByDayIdx, reporting);
		}
		let last7 = 0;
		let prior28 = 0;
		for (const [idx, c] of costByDayIdx) {
			if (idx >= -6) last7 += c;
			else if (idx >= -34) prior28 += c;
		}
		const trend: TrendInfo | null = prior28 > 0 ? { last7Cost: last7, priorWeeklyPace: prior28 / 4 } : null;
		for (const period of TAB_ORDER) data[period].insights = computeInsights(raw[period], trend);
		return data;
	}
}
