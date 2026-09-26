import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import type { AgentSession, VsCodeWindow } from "./types.js";
import { SessionMonitor } from "./vscode/session-monitor.js";
import { WindowHelper, windowRootName } from "./windows/win-helper.js";

export const MAX_SLOTS = 32;

/** A session that is still streaming counts as open even if we cannot match its window title. */
const RUNNING_IMPLIES_OPEN_MS = 2 * 60 * 1000;
/** A "running" turn whose journal has gone quiet for this long is almost certainly abandoned. */
const STALE_AFTER_MS = 5 * 60 * 1000;
const WINDOW_REFRESH_MS = 3_000;

export interface Slot {
	index: number;
	session: AgentSession | undefined;
	/** True once the user has pressed the key since the last turn finished. */
	acknowledged: boolean;
}

const normalise = (value: string): string => value.trim().toLowerCase();

export class AgentHub extends EventEmitter {
	readonly #monitor = new SessionMonitor();
	readonly #windows: WindowHelper;
	readonly #assignments = new Map<number, string>();
	readonly #acknowledged = new Set<string>();
	readonly #pinned = new Map<number, string>();
	#activeSlots = new Set<number>();
	#sessions = new Map<string, AgentSession>();
	#raw: AgentSession[] = [];
	#windowList: VsCodeWindow[] = [];
	#windowTimer: NodeJS.Timeout | undefined;
	#helperFailed = false;

	public constructor() {
		super();
		this.#windows = new WindowHelper((error) => {
			this.#helperFailed = true;
			this.emit("warning", `window helper unavailable: ${error.message}`);
		});
	}

	public async start(): Promise<void> {
		this.#monitor.on("update", (sessions: AgentSession[]) => this.#ingest(sessions));
		await this.#refreshWindows();
		this.#windowTimer = setInterval(() => void this.#refreshWindows(), WINDOW_REFRESH_MS);
		await this.#monitor.start();
		this.#ingest(this.#monitor.sessions());
	}

	public stop(): void {
		if (this.#windowTimer) clearInterval(this.#windowTimer);
		this.#monitor.stop();
		this.#windows.dispose();
	}

	/** Declares which slots currently have a key on a deck; agents are only assigned to these. */
	public setActiveSlots(slots: Set<number>): void {
		const unchanged = slots.size === this.#activeSlots.size && [...slots].every((s) => this.#activeSlots.has(s));
		if (unchanged) return;

		this.#activeSlots = slots;
		for (const index of [...this.#assignments.keys()]) {
			if (!slots.has(index)) this.#assignments.delete(index);
		}
		for (const index of [...this.#pinned.keys()]) {
			if (!slots.has(index)) this.#pinned.delete(index);
		}
		this.#rebuild();
	}

	/** Pins a slot to a specific workspace path, or clears the pin when `workspacePath` is undefined. */
	public pin(index: number, workspacePath: string | undefined): void {
		const current = this.#pinned.get(index);
		const next = workspacePath ? normalise(workspacePath) : undefined;
		if (current === next) return;

		if (next) this.#pinned.set(index, next);
		else this.#pinned.delete(index);
		this.#assignments.delete(index);
		this.#rebuild();
	}

	public slot(index: number): Slot {
		const sessionId = this.#assignments.get(index);
		const session = sessionId ? this.#sessions.get(sessionId) : undefined;
		return { index, session, acknowledged: sessionId ? this.#acknowledged.has(sessionId) : true };
	}

	/** Distinct workspaces currently visible, for the property inspector's pin picker. */
	public workspaces(): { path: string; name: string }[] {
		const byPath = new Map<string, string>();
		for (const session of this.#sessions.values()) {
			if (session.workspacePath) byPath.set(session.workspacePath, session.workspaceName);
		}
		return [...byPath].map(([p, name]) => ({ path: p, name })).sort((a, b) => a.name.localeCompare(b.name));
	}

	public acknowledge(index: number): void {
		const sessionId = this.#assignments.get(index);
		if (sessionId) this.#acknowledged.add(sessionId);
	}

	public async focus(index: number): Promise<boolean> {
		const { session } = this.slot(index);
		if (!session) return false;

		const matches = this.#matchWindows(session);
		if (matches.length === 1 && !this.#helperFailed) {
			const focused = await this.#windows.focus(matches[0]!.hwnd).catch(() => false);
			if (focused) return true;
		}
		// Ambiguous folder names (or a dead helper) fall back to the CLI, which VS Code
		// resolves by absolute path and uses to raise the window already hosting it.
		return this.#focusViaCli(session);
	}

	#focusViaCli(session: AgentSession): boolean {
		if (!session.workspacePath) return false;
		const cli = session.flavor === "insiders" ? "code-insiders.cmd" : "code.cmd";
		try {
			const child = spawn(cli, [session.workspacePath], { windowsHide: true, detached: true, stdio: "ignore", shell: false });
			child.on("error", () => this.emit("warning", `could not run ${cli}; is it on PATH?`));
			child.unref();
			return true;
		} catch {
			return false;
		}
	}

	#matchWindows(session: AgentSession): VsCodeWindow[] {
		const wanted = normalise(session.workspaceName);
		return this.#windowList.filter((w) => {
			const root = windowRootName(w.title);
			return root !== undefined && normalise(root) === wanted;
		});
	}

	async #refreshWindows(): Promise<void> {
		if (this.#helperFailed) return;
		try {
			this.#windowList = await this.#windows.list();
			this.#rebuild();
		} catch {
			// Transient; the next tick retries.
		}
	}

	#ingest(sessions: AgentSession[]): void {
		this.#raw = sessions;
		this.#rebuild();
	}

	#rebuild(): void {
		const now = Date.now();
		this.#sessions = new Map(
			this.#raw.map((session) => {
				const matched = this.#matchWindows(session).length > 0;
				const streaming = session.status === "running" && now - session.lastActivity < RUNNING_IMPLIES_OPEN_MS;
				const stale = session.status === "running" && now - session.lastActivity > STALE_AFTER_MS;

				// A live turn re-arms the "finished" highlight for when it completes.
				if (session.status === "running" && !stale) this.#acknowledged.delete(session.sessionId);

				return [session.sessionId, { ...session, stale, windowOpen: matched || streaming }];
			})
		);

		const eligible = [...this.#sessions.values()]
			.filter((s) => s.requestCount > 0 && s.windowOpen)
			.sort((a, b) => b.lastActivity - a.lastActivity);
		const eligibleIds = new Set(eligible.map((s) => s.sessionId));

		for (const [index, sessionId] of [...this.#assignments]) {
			if (!eligibleIds.has(sessionId)) this.#assignments.delete(index);
		}

		// Pinned slots win, and always show the newest session for their workspace.
		for (const [index, pinnedPath] of this.#pinned) {
			const match = eligible.find((s) => s.workspacePath && normalise(s.workspacePath) === pinnedPath);
			if (match) this.#assignments.set(index, match.sessionId);
			else this.#assignments.delete(index);
		}

		const taken = new Set(this.#assignments.values());
		const free = eligible.filter((s) => !taken.has(s.sessionId));
		for (const session of free) {
			const index = this.#firstFreeSlot();
			if (index === undefined) break;
			this.#assignments.set(index, session.sessionId);
		}

		this.emit("changed");
	}

	#firstFreeSlot(): number | undefined {
		for (const index of [...this.#activeSlots].sort((a, b) => a - b)) {
			if (!this.#assignments.has(index) && !this.#pinned.has(index)) return index;
		}
		return undefined;
	}
}

export const shortPath = (value: string | undefined): string => (value ? path.basename(value) : "");
