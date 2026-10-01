/**
 * Worker entry for the usage index. Two roles, selected by `workerData.role`:
 *   "parse" — a parse-pool worker: {id, file, previous} → {id, delta} | {id, error}
 *   "index" — hosts a UsageIndexCore (see client.ts for the message protocol).
 * Heavy modules are imported dynamically so a parse worker never loads the service graph.
 * Must load under Node's native type stripping (no pi imports, no index.ts).
 */
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { DiscoveredFile, ResumeState, UsageIndexOptions } from "./types.ts";

type Request =
	| { type: "snapshot"; id: number; nowMs: number }
	| { type: "abort"; id: number }
	| { type: "watch"; on: boolean }
	| { type: "flush"; id: number }
	| { type: "dispose"; id: number };

async function runParse(port: NonNullable<typeof parentPort>): Promise<void> {
	const ready = import("./parse.ts");
	port.on("message", async (message: { id: number; file: DiscoveredFile; previous: ResumeState | null }) => {
		try {
			const { parseFileDelta } = await ready;
			port.postMessage({ id: message.id, delta: await parseFileDelta(message.file, message.previous) });
		} catch (error) {
			port.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
		}
	});
}

async function runIndex(port: NonNullable<typeof parentPort>, options: UsageIndexOptions): Promise<void> {
	const { UsageIndexCore } = await import("./service.ts");
	const core = new UsageIndexCore(options);
	const controllers = new Map<number, AbortController>();
	port.on("message", (message: Request) => {
		switch (message.type) {
			case "snapshot": {
				const controller = new AbortController();
				controllers.set(message.id, controller);
				core
					.snapshot({
						now: new Date(message.nowMs),
						signal: controller.signal,
						onProgress: (progress) => port.postMessage({ type: "progress", id: message.id, progress }),
					})
					.then(
						(data) => port.postMessage({ type: "result", id: message.id, data }),
						(error) => port.postMessage({ type: "error", id: message.id, message: error instanceof Error ? error.message : String(error) })
					)
					.finally(() => controllers.delete(message.id));
				break;
			}
			case "abort":
				controllers.get(message.id)?.abort();
				break;
			case "watch":
				if (message.on) core.startWatching(() => port.postMessage({ type: "changed" }));
				else core.stopWatching();
				break;
			case "flush":
				void core.flush().then(() => port.postMessage({ type: "flushed", id: message.id }));
				break;
			case "dispose":
				void core.dispose().then(() => port.postMessage({ type: "disposed", id: message.id }));
				break;
		}
	});
	port.postMessage({ type: "ready" });
}

if (!isMainThread && parentPort) {
	const data = (workerData ?? {}) as { role?: string; options?: UsageIndexOptions };
	if (data.role === "parse") await runParse(parentPort);
	else if (data.role === "index") await runIndex(parentPort, data.options ?? {});
}
