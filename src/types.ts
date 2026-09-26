export type AgentStatus = "running" | "finished" | "error" | "idle";

export interface AgentSession {
	/** VS Code chat session id (one chat tab). */
	sessionId: string;
	/** Absolute path of the `<sessionId>.jsonl` journal. */
	file: string;
	/** workspaceStorage hash folder name. */
	storageHash: string;
	/** Absolute path of the folder / .code-workspace open in that window, if resolvable. */
	workspacePath: string | undefined;
	/** Display name, normally the folder basename. */
	workspaceName: string;
	/** "stable" | "insiders" */
	flavor: string;
	status: AgentStatus;
	/** Number of turns recorded in the session. */
	requestCount: number;
	/** First line of the prompt for the most recent turn. */
	lastPrompt: string | undefined;
	/** Epoch ms the most recent turn started. */
	startedAt: number | undefined;
	/** Epoch ms the most recent turn completed. */
	finishedAt: number | undefined;
	/** Duration of the most recent completed turn. */
	elapsedMs: number | undefined;
	/** Epoch ms of the last write to the journal. */
	lastActivity: number;
	/** True when the turn claims to be running but the journal has gone quiet. */
	stale: boolean;
	/** True when a VS Code window with this workspace is currently open. */
	windowOpen: boolean;
}

export interface VsCodeWindow {
	hwnd: number;
	pid: number;
	title: string;
}
