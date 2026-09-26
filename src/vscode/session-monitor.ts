import { EventEmitter } from "node:events";
import { type FSWatcher, watch } from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentSession, AgentStatus } from "../types.js";
import { readWorkspaceTarget, type StorageRoot, storageRoots, type WorkspaceTarget } from "./storage.js";

/**
 * VS Code journals every chat session to `<workspaceStorage>/<hash>/chatSessions/<id>.jsonl`
 * as an append-only stream of patches:
 *
 *   {"kind":0,"v":{...}}                                  full snapshot, first line
 *   {"kind":2,"k":["requests"],"v":[{...}]}               a turn STARTED (append)
 *   {"kind":2,"k":["requests",N,"response"],"v":[...]}    streamed response parts
 *   {"kind":1,"k":["requests",N,"result"],"v":{...}}      turn N FINISHED
 *   {"kind":1,"k":["requests",N,"elapsedMs"],"v":1234}    turn N duration
 *
 * kind 1 sets a value, kind 2 appends to an array. Tailing the file therefore gives
 * a live running/finished signal without needing anything installed inside VS Code.
 */

/** Matches the record header without parsing megabyte-sized response payloads. */
const HEAD = /^\{"kind":(\d+)(?:,"k":(\[[^\]]*\]))?/;
const SCALAR_V = /"v":(\d+)\}\s*$/;

/**
 * Session journals reach tens of megabytes. Only the tail matters, because a turn's
 * `result` always follows its `response` parts, so the newest turn's state is always
 * near the end of the file.
 */
const TAIL_BYTES = 128 * 1024;
/** Close the descriptor for a session that has gone quiet, rather than holding it forever. */
const HANDLE_IDLE_MS = 90_000;

/** Workspaces that have never had a chat at all are checked rarely. */
const ABSENT_SWEEP_MS = 5 * 60_000;
/** Watched directories only need a safety-net sweep, since events do the real work. */
const RECONCILE_MS = 5 * 60_000;
/** A directory we failed to watch falls back to frequent sweeping. */
const FALLBACK_SWEEP_MS = 30_000;
/** Coalesces the burst of events a streaming response produces. */
const WATCH_DEBOUNCE_MS = 120;

interface Journal {
	file: string;
	sessionId: string;
	storageHash: string;
	hashDir: string;
	flavor: string;
	offset: number;
	mtimeMs: number;
	/** Guards against the watcher and the backstop poll reading the same journal at once. */
	busy: boolean;
	handle: FileHandle | undefined;
	/** Set when the read started mid-file, so the leading partial line is discarded. */
	skipPartial: boolean;
	decoder: StringDecoder;
	partial: string;
	turns: number;
	/** Highest request index observed; unknown when the tail contained no request records. */
	latestIndex: number | undefined;
	/** Highest request index that has a `result`. A turn is live while this trails latestIndex. */
	completedIndex: number | undefined;
	errored: boolean;
	lastPrompt: string | undefined;
	startedAt: number | undefined;
	finishedAt: number | undefined;
	elapsedMs: number | undefined;
	lastActivity: number;
}

export interface SessionMonitorOptions {
	/** How often to look for new/removed session files. */
	scanIntervalMs?: number;
	/** How often to check tracked files for growth. */
	pollIntervalMs?: number;
	/** Ignore session files untouched for longer than this. */
	maxAgeMs?: number;
	/** Overrides the workspaceStorage locations; used by the test harness. */
	roots?: StorageRoot[];
}

export interface IoStats {
	tracked: number;
	openHandles: number;
	watchers: number;
	fileOpens: number;
	bytesRead: number;
	statCalls: number;
	dirReads: number;
}

function firstLine(text: unknown): string | undefined {
	if (typeof text !== "string") return undefined;
	const line = text.replace(/\s+/g, " ").trim();
	return line.length ? line : undefined;
}

function recordHead(line: string): { kind: number; k: (string | number)[] } | undefined {
	const m = HEAD.exec(line);
	if (m?.[1]) {
		try {
			return { kind: Number(m[1]), k: m[2] ? (JSON.parse(m[2]) as (string | number)[]) : [] };
		} catch {
			// Fall through to the tolerant path below.
		}
	}
	try {
		const o = JSON.parse(line) as { kind?: unknown; k?: unknown };
		if (typeof o.kind !== "number") return undefined;
		return { kind: o.kind, k: Array.isArray(o.k) ? (o.k as (string | number)[]) : [] };
	} catch {
		return undefined;
	}
}

export class SessionMonitor extends EventEmitter {
	readonly #journals = new Map<string, Journal>();
	readonly #dirMtimes = new Map<string, number>();
	readonly #checked = new Map<string, number>();
	readonly #absent = new Set<string>();
	readonly #watchers = new Map<string, FSWatcher>();
	readonly #pending = new Set<string>();
	readonly #rootMtimes = new Map<string, number>();
	readonly #rootHashes = new Map<string, string[]>();
	readonly #workspaces = new Map<string, WorkspaceTarget>();
	readonly #opts: Required<SessionMonitorOptions>;
	readonly #io = { fileOpens: 0, bytesRead: 0, statCalls: 0, dirReads: 0 };
	#timers: NodeJS.Timeout[] = [];
	#flushTimer: NodeJS.Timeout | undefined;
	#scanning = false;
	#polling = false;
	#flushing = false;

	public constructor(options: SessionMonitorOptions = {}) {
		super();
		this.#opts = {
			scanIntervalMs: options.scanIntervalMs ?? 30_000,
			// Watchers drive updates; this is only a backstop for missed events.
			pollIntervalMs: options.pollIntervalMs ?? 5_000,
			maxAgeMs: options.maxAgeMs ?? 12 * 60 * 60 * 1000,
			roots: options.roots ?? storageRoots()
		};
	}

	public async start(): Promise<void> {
		await this.scan();
		await this.poll();
		this.#timers.push(setInterval(() => void this.scan(), this.#opts.scanIntervalMs));
		this.#timers.push(setInterval(() => void this.poll(), this.#opts.pollIntervalMs));
	}

	public stop(): void {
		this.#timers.forEach(clearInterval);
		this.#timers = [];
		if (this.#flushTimer) clearTimeout(this.#flushTimer);
		this.#flushTimer = undefined;
		for (const chatDir of [...this.#watchers.keys()]) this.#unwatch(chatDir);
		for (const j of this.#journals.values()) this.#closeHandle(j);
	}

	public sessions(): AgentSession[] {
		return [...this.#journals.values()].map((j) => this.#toSession(j));
	}

	public stats(): IoStats {
		return {
			tracked: this.#journals.size,
			openHandles: [...this.#journals.values()].filter((j) => j.handle !== undefined).length,
			watchers: this.#watchers.size,
			...this.#io
		};
	}

	// --- watching --------------------------------------------------------------

	#watch(chatDir: string): void {
		if (this.#watchers.has(chatDir)) return;
		try {
			const watcher = watch(chatDir, (_event, filename) => this.#onDirEvent(chatDir, filename));
			watcher.on("error", () => this.#unwatch(chatDir));
			this.#watchers.set(chatDir, watcher);
		} catch {
			// Left to the fallback sweep cadence.
		}
	}

	#unwatch(chatDir: string): void {
		const watcher = this.#watchers.get(chatDir);
		this.#watchers.delete(chatDir);
		watcher?.close();
	}

	#onDirEvent(chatDir: string, filename: string | Buffer | null): void {
		const name = typeof filename === "string" ? filename : filename?.toString();
		if (!name) {
			// No filename: force the next sweep to re-enumerate this directory.
			this.#dirMtimes.delete(chatDir);
			this.#checked.delete(chatDir);
			return;
		}
		if (!name.endsWith(".jsonl")) return;
		this.#pending.add(path.join(chatDir, name));
		this.#flushTimer ??= setTimeout(() => {
			this.#flushTimer = undefined;
			void this.#flush();
		}, WATCH_DEBOUNCE_MS);
	}

	async #flush(): Promise<void> {
		if (this.#flushing) return;
		this.#flushing = true;
		try {
			const files = [...this.#pending];
			this.#pending.clear();
			let changed = false;
			for (const file of files) {
				const journal = this.#journals.get(file) ?? (await this.#adopt(file));
				if (journal) changed = (await this.#tail(journal)) || changed;
			}
			if (changed) this.emit("update", this.sessions());
		} finally {
			this.#flushing = false;
		}
	}

	/** A file that just emitted an event is live by definition, so the age filter does not apply. */
	async #adopt(file: string): Promise<Journal | undefined> {
		this.#io.statCalls++;
		const st = await fsp.stat(file).catch(() => undefined);
		if (!st?.isFile()) return undefined;

		const hashDir = path.dirname(path.dirname(file));
		const root = this.#opts.roots.find((r) => hashDir.startsWith(r.dir + path.sep));
		const journal = this.#createJournal(file, hashDir, root?.flavor ?? "stable", st.mtimeMs);
		this.#journals.set(file, journal);
		return journal;
	}

	#createJournal(file: string, hashDir: string, flavor: string, mtimeMs: number): Journal {
		return {
			file,
			sessionId: path.basename(file, ".jsonl"),
			storageHash: path.basename(hashDir),
			hashDir,
			flavor,
			offset: 0,
			mtimeMs: 0,
			busy: false,
			handle: undefined,
			skipPartial: false,
			decoder: new StringDecoder("utf8"),
			partial: "",
			turns: 0,
			latestIndex: undefined,
			completedIndex: undefined,
			errored: false,
			lastPrompt: undefined,
			startedAt: undefined,
			finishedAt: undefined,
			elapsedMs: undefined,
			lastActivity: mtimeMs
		};
	}

	// --- discovery -------------------------------------------------------------

	private async scan(): Promise<void> {
		if (this.#scanning) return;
		this.#scanning = true;
		try {
			const now = Date.now();
			const inspected = new Set<string>();
			const found = new Set<string>();

			for (const root of this.#opts.roots) {
				for (const hash of await this.#hashesIn(root.dir)) {
					const hashDir = path.join(root.dir, hash);
					const chatDir = path.join(hashDir, "chatSessions");
					if (!this.#due(chatDir, now)) continue;

					this.#io.statCalls++;
					const dir = await fsp.stat(chatDir).catch(() => undefined);
					if (!dir?.isDirectory()) {
						this.#absent.add(chatDir);
						this.#unwatch(chatDir);
						inspected.add(chatDir);
						continue;
					}
					this.#absent.delete(chatDir);
					this.#watch(chatDir);

					// The directory mtime only moves when a session file is added or removed.
					if (this.#dirMtimes.get(chatDir) === dir.mtimeMs) continue;
					this.#dirMtimes.set(chatDir, dir.mtimeMs);

					inspected.add(chatDir);
					this.#io.dirReads++;
					const files = await fsp.readdir(chatDir).catch(() => [] as string[]);
					for (const name of files) {
						if (!name.endsWith(".jsonl")) continue;
						const full = path.join(chatDir, name);
						found.add(full);
						if (this.#journals.has(full)) continue;
						this.#io.statCalls++;
						const st = await fsp.stat(full).catch(() => undefined);
						if (!st || now - st.mtimeMs > this.#opts.maxAgeMs) continue;
						this.#journals.set(full, this.#createJournal(full, hashDir, root.flavor, st.mtimeMs));
					}
				}
			}

			for (const [file, journal] of [...this.#journals]) {
				const removed = inspected.has(path.dirname(file)) && !found.has(file);
				const stale = now - journal.lastActivity > this.#opts.maxAgeMs;
				if (!removed && !stale) continue;
				this.#closeHandle(journal);
				this.#journals.delete(file);
			}
		} finally {
			this.#scanning = false;
		}
	}

	/** Watched directories need only a safety-net sweep; unwatched ones carry the load. */
	#due(chatDir: string, now: number): boolean {
		const interval = this.#absent.has(chatDir)
			? ABSENT_SWEEP_MS
			: this.#watchers.has(chatDir)
				? RECONCILE_MS
				: FALLBACK_SWEEP_MS;
		if (now - (this.#checked.get(chatDir) ?? 0) < interval) return false;
		this.#checked.set(chatDir, now);
		return true;
	}

	/** workspaceStorage gains entries rarely, so the listing is cached until the root changes. */
	async #hashesIn(root: string): Promise<string[]> {
		this.#io.statCalls++;
		const st = await fsp.stat(root).catch(() => undefined);
		if (!st) return [];
		if (this.#rootMtimes.get(root) === st.mtimeMs) return this.#rootHashes.get(root) ?? [];

		this.#io.dirReads++;
		const hashes = await fsp.readdir(root).catch(() => [] as string[]);
		this.#rootMtimes.set(root, st.mtimeMs);
		this.#rootHashes.set(root, hashes);
		return hashes;
	}

	// --- tailing ---------------------------------------------------------------

	private async poll(): Promise<void> {
		if (this.#polling) return;
		this.#polling = true;
		try {
			let changed = false;
			for (const j of this.#journals.values()) {
				changed = (await this.#tail(j)) || changed;
			}
			if (changed) this.emit("update", this.sessions());
		} finally {
			this.#polling = false;
		}
	}

	async #tail(j: Journal): Promise<boolean> {
		if (j.busy) return false;
		j.busy = true;
		try {
			return await this.#tailUnguarded(j);
		} finally {
			j.busy = false;
		}
	}

	async #tailUnguarded(j: Journal): Promise<boolean> {
		this.#io.statCalls++;
		const st = await fsp.stat(j.file).catch(() => undefined);
		if (!st) return false;
		if (st.mtimeMs === j.mtimeMs && st.size === j.offset) {
			if (j.handle && Date.now() - j.lastActivity > HANDLE_IDLE_MS) this.#closeHandle(j);
			return false;
		}
		j.mtimeMs = st.mtimeMs;

		// The file was rewritten/compacted, so start over.
		if (st.size < j.offset) this.#reset(j);

		// First sight of a file: seek near the end rather than replaying megabytes of history.
		if (j.offset === 0 && st.size > TAIL_BYTES) {
			j.offset = st.size - TAIL_BYTES;
			j.skipPartial = true;
		}

		if (st.size > j.offset) {
			const handle = await this.#openHandle(j);
			if (!handle) return false;
			try {
				const buf = Buffer.allocUnsafe(st.size - j.offset);
				const { bytesRead } = await handle.read(buf, 0, buf.length, j.offset);
				j.offset += bytesRead;
				this.#io.bytesRead += bytesRead;

				let text = j.partial + j.decoder.write(buf.subarray(0, bytesRead));
				if (j.skipPartial) {
					j.skipPartial = false;
					const firstBreak = text.indexOf("\n");
					text = firstBreak >= 0 ? text.slice(firstBreak + 1) : "";
				}
				const lines = text.split("\n");
				j.partial = lines.pop() ?? "";
				for (const line of lines) {
					if (line.length > 8) this.#applyLine(j, line);
				}
			} catch {
				this.#closeHandle(j);
				return false;
			}
		}

		j.lastActivity = st.mtimeMs;
		return true;
	}

	async #openHandle(j: Journal): Promise<FileHandle | undefined> {
		if (j.handle) return j.handle;
		this.#io.fileOpens++;
		j.handle = await fsp.open(j.file, "r").catch(() => undefined);
		return j.handle;
	}

	#closeHandle(j: Journal): void {
		const handle = j.handle;
		j.handle = undefined;
		void handle?.close().catch(() => undefined);
	}

	#reset(j: Journal): void {
		this.#closeHandle(j);
		j.offset = 0;
		j.partial = "";
		j.skipPartial = false;
		j.decoder = new StringDecoder("utf8");
		j.turns = 0;
		j.latestIndex = undefined;
		j.completedIndex = undefined;
		j.errored = false;
	}

	#applyLine(j: Journal, line: string): void {
		const head = recordHead(line);
		if (!head) return;
		const { kind, k } = head;

		if (kind === 0) {
			const snapshot = this.#parseValue<{ requests?: unknown[] }>(line);
			this.#replaceRequests(j, Array.isArray(snapshot?.requests) ? snapshot.requests : []);
			return;
		}

		if (k.length === 1 && k[0] === "requests") {
			const v = this.#parseValue<unknown[]>(line);
			if (!Array.isArray(v)) return;
			if (kind === 2) v.forEach((r) => this.#pushRequest(j, r));
			else this.#replaceRequests(j, v);
			return;
		}

		if (k.length !== 3 || k[0] !== "requests" || typeof k[1] !== "number") return;
		const index = k[1];
		// Absolute indices let a journal seeded from a tail recover the real turn count.
		j.latestIndex = Math.max(j.latestIndex ?? -1, index);
		j.turns = Math.max(j.turns, index + 1);

		switch (k[2]) {
			case "result":
				j.completedIndex = Math.max(j.completedIndex ?? -1, index);
				j.errored = line.includes('"errorDetails"');
				j.finishedAt = j.mtimeMs;
				break;
			case "elapsedMs": {
				// `result` embeds the rendered prompt and can be megabytes, so it may fall outside
				// the tail window. `elapsedMs` is tiny, follows it, and never appears on a live turn.
				j.completedIndex = Math.max(j.completedIndex ?? -1, index);
				j.finishedAt ??= j.mtimeMs;
				const m = SCALAR_V.exec(line);
				if (m?.[1]) j.elapsedMs = Number(m[1]);
				break;
			}
			case "isCanceled":
				if (line.includes('"v":true')) j.errored = true;
				break;
		}
	}

	#parseValue<T>(line: string): T | undefined {
		try {
			return (JSON.parse(line) as { v?: T }).v;
		} catch {
			return undefined;
		}
	}

	#pushRequest(j: Journal, request: unknown): void {
		const r = request as { message?: { text?: string }; timestamp?: number; result?: unknown } | null;
		// A tail-seeded journal learns its first index from whatever has already completed.
		j.latestIndex = (j.latestIndex ?? j.completedIndex ?? -1) + 1;
		j.turns = Math.max(j.turns + 1, j.latestIndex + 1);
		j.lastPrompt = firstLine(r?.message?.text) ?? j.lastPrompt;
		j.startedAt = typeof r?.timestamp === "number" ? r.timestamp : j.mtimeMs;
		j.elapsedMs = undefined;
		j.errored = false;
		if (r?.result === undefined) {
			j.finishedAt = undefined;
		} else {
			j.completedIndex = j.latestIndex;
			j.finishedAt = j.mtimeMs;
		}
	}

	#replaceRequests(j: Journal, requests: unknown[]): void {
		j.turns = requests.length;
		j.latestIndex = requests.length > 0 ? requests.length - 1 : undefined;
		j.completedIndex = undefined;
		j.errored = false;
		j.finishedAt = undefined;
		j.elapsedMs = undefined;

		requests.forEach((request, index) => {
			const r = request as { result?: { errorDetails?: unknown } } | null;
			if (r?.result !== undefined) j.completedIndex = Math.max(j.completedIndex ?? -1, index);
		});

		const last = requests[requests.length - 1] as
			| { result?: { errorDetails?: unknown }; timestamp?: number; message?: { text?: string } }
			| undefined;
		if (!last) return;
		j.lastPrompt = firstLine(last.message?.text) ?? j.lastPrompt;
		j.startedAt = typeof last.timestamp === "number" ? last.timestamp : undefined;
		j.errored = last.result?.errorDetails !== undefined;
	}

	#toSession(j: Journal): AgentSession {
		const workspace = this.#workspaceOf(j);
		return {
			sessionId: j.sessionId,
			file: j.file,
			storageHash: j.storageHash,
			workspacePath: workspace.path,
			workspaceName: workspace.name,
			flavor: j.flavor,
			status: this.#statusOf(j),
			requestCount: j.turns,
			lastPrompt: j.lastPrompt,
			startedAt: j.startedAt,
			finishedAt: j.finishedAt,
			elapsedMs: j.elapsedMs,
			lastActivity: j.lastActivity,
			stale: false,
			windowOpen: true
		};
	}

	#statusOf(j: Journal): AgentStatus {
		if (j.latestIndex === undefined) return "idle";
		if ((j.completedIndex ?? -1) < j.latestIndex) return "running";
		return j.errored ? "error" : "finished";
	}

	#workspaceOf(j: Journal): WorkspaceTarget {
		const cached = this.#workspaces.get(j.hashDir);
		if (cached) return cached;
		// Resolved lazily in the background; the first render falls back to the hash.
		this.#workspaces.set(j.hashDir, { path: undefined, name: j.storageHash.slice(0, 8) });
		void readWorkspaceTarget(j.hashDir).then((target) => {
			this.#workspaces.set(j.hashDir, target);
			this.emit("update", this.sessions());
		});
		return { path: undefined, name: j.storageHash.slice(0, 8) };
	}
}
