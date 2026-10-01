/**
 * Parse pool: worker_threads running `parseFileDelta` for cold rebuilds and big batches.
 * Any worker failure resolves that file as "failed" so the caller parses it in-thread instead.
 * Must load under Node's native type stripping.
 */
import { Worker } from "node:worker_threads";
import type { ParseDelta } from "./parse.ts";
import type { DiscoveredFile, ResumeState } from "./types.ts";

/** A delta, null (file vanished/unreadable), or "failed" (the pool could not do it: parse in-thread). */
export type PoolResult = ParseDelta | null | "failed";

interface Job {
	id: number;
	file: DiscoveredFile;
	previous: ResumeState | null;
	signal?: AbortSignal;
	resolve: (result: PoolResult) => void;
}

interface Slot {
	worker: Worker;
	job: Job | null;
	dead: boolean;
}

export class ParsePool {
	private slots: Slot[] = [];
	private queue: Job[] = [];
	private nextId = 1;
	private closed = false;

	private constructor(slots: Slot[]) {
		this.slots = slots;
		for (const slot of slots) this.wire(slot);
	}

	/** null when workers cannot be started at all. */
	static tryCreate(size: number, entry: URL | string = new URL("./worker.ts", import.meta.url)): ParsePool | null {
		const slots: Slot[] = [];
		try {
			for (let i = 0; i < size; i++) {
				const worker = new Worker(entry, { workerData: { role: "parse" }, stdout: true, stderr: true });
				worker.stdout.resume();
				worker.stderr.resume();
				worker.unref();
				slots.push({ worker, job: null, dead: false });
			}
		} catch {
			for (const slot of slots) void slot.worker.terminate();
			return null;
		}
		return slots.length > 0 ? new ParsePool(slots) : null;
	}

	get size(): number {
		return this.slots.length;
	}

	parse(file: DiscoveredFile, previous: ResumeState | null, signal?: AbortSignal): Promise<PoolResult> {
		if (this.closed || this.slots.every((s) => s.dead)) return Promise.resolve("failed");
		return new Promise<PoolResult>((resolve) => {
			this.queue.push({ id: this.nextId++, file, previous, signal, resolve });
			this.pump();
		});
	}

	close(): void {
		this.closed = true;
		for (const job of this.queue.splice(0)) job.resolve(null);
		for (const slot of this.slots) {
			slot.job?.resolve(null);
			slot.job = null;
			slot.dead = true;
			void slot.worker.terminate();
		}
	}

	private wire(slot: Slot): void {
		slot.worker.on("message", (message: { id: number; delta?: ParseDelta | null; error?: string }) => {
			const job = slot.job;
			if (!job || job.id !== message.id) return;
			slot.job = null;
			job.resolve(message.error !== undefined ? "failed" : (message.delta ?? null));
			this.pump();
		});
		const gone = () => {
			if (slot.dead) return;
			slot.dead = true;
			const job = slot.job;
			slot.job = null;
			job?.resolve("failed");
			if (this.slots.every((s) => s.dead)) for (const queued of this.queue.splice(0)) queued.resolve("failed");
			else this.pump();
		};
		slot.worker.on("error", gone);
		slot.worker.on("exit", gone);
	}

	private pump(): void {
		for (const slot of this.slots) {
			if (slot.dead || slot.job) continue;
			let job = this.queue.shift();
			while (job?.signal?.aborted) {
				job.resolve(null);
				job = this.queue.shift();
			}
			if (!job) return;
			slot.job = job;
			try {
				slot.worker.postMessage({ id: job.id, file: job.file, previous: job.previous });
			} catch {
				slot.job = null;
				slot.dead = true;
				job.resolve("failed");
			}
		}
	}
}
