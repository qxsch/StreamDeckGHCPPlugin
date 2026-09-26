import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { VsCodeWindow } from "../types.js";

const HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/win-helper.ps1");
const COMMAND_TIMEOUT_MS = 5_000;

interface Pending {
	resolve: (value: Record<string, unknown>) => void;
	reject: (reason: Error) => void;
	timer: NodeJS.Timeout;
}

/**
 * Wraps a long-lived PowerShell process that exposes EnumWindows/SetForegroundWindow.
 * Keeping it alive avoids paying the ~1s `Add-Type` compile cost on every key press.
 */
export class WindowHelper {
	#child: ChildProcessWithoutNullStreams | undefined;
	#buffer = "";
	#queue: Pending[] = [];
	#disposed = false;
	#onError: ((error: Error) => void) | undefined;

	public constructor(onError?: (error: Error) => void) {
		this.#onError = onError;
	}

	public async list(): Promise<VsCodeWindow[]> {
		const response = await this.#send("LIST");
		const raw = response.windows;
		const windows = Array.isArray(raw) ? raw : raw ? [raw] : [];
		return windows
			.map((w) => w as { h?: number; pid?: number; t?: string })
			.filter((w): w is { h: number; pid: number; t: string } => typeof w.h === "number" && typeof w.t === "string")
			.map((w) => ({ hwnd: w.h, pid: w.pid ?? 0, title: w.t }));
	}

	public async focus(hwnd: number): Promise<boolean> {
		const response = await this.#send(`FOCUS ${hwnd}`);
		return response.ok === true;
	}

	public dispose(): void {
		this.#disposed = true;
		this.#child?.kill();
		this.#child = undefined;
	}

	#ensureChild(): ChildProcessWithoutNullStreams {
		if (this.#child && !this.#child.killed) return this.#child;

		const child = spawn(
			"powershell.exe",
			["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", HELPER],
			{ windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
		);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.#onStdout(chunk));
		child.on("exit", () => {
			this.#child = undefined;
			this.#failAll(new Error("window helper exited"));
		});
		child.on("error", (error) => {
			this.#child = undefined;
			this.#failAll(error);
		});
		this.#child = child;
		return child;
	}

	#onStdout(chunk: string): void {
		this.#buffer += chunk;
		let index: number;
		while ((index = this.#buffer.indexOf("\n")) >= 0) {
			const line = this.#buffer.slice(0, index).trim();
			this.#buffer = this.#buffer.slice(index + 1);
			if (!line) continue;

			let payload: Record<string, unknown>;
			try {
				payload = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			// The helper announces itself before any command is issued.
			if (payload.ready === true && this.#queue.length === 0) continue;

			const pending = this.#queue.shift();
			if (!pending) continue;
			clearTimeout(pending.timer);
			pending.resolve(payload);
		}
	}

	#failAll(error: Error): void {
		const queued = this.#queue;
		this.#queue = [];
		for (const pending of queued) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		if (!this.#disposed) this.#onError?.(error);
	}

	#send(command: string): Promise<Record<string, unknown>> {
		return new Promise((resolve, reject) => {
			let child: ChildProcessWithoutNullStreams;
			try {
				child = this.#ensureChild();
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
				return;
			}

			const timer = setTimeout(() => {
				const index = this.#queue.findIndex((p) => p.timer === timer);
				if (index >= 0) this.#queue.splice(index, 1);
				reject(new Error(`window helper timed out: ${command}`));
			}, COMMAND_TIMEOUT_MS);

			this.#queue.push({ resolve, reject, timer });
			child.stdin.write(`${command}\n`);
		});
	}
}

/**
 * VS Code window titles end in `<file> - <rootName> - Visual Studio Code`, so the
 * workspace name is the last segment before the application name.
 */
export function windowRootName(title: string): string | undefined {
	const parts = title.split(" - ");
	if (parts.length < 2) return undefined;
	return parts[parts.length - 2]?.trim();
}
