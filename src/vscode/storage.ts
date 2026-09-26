import fsp from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface StorageRoot {
	flavor: string;
	dir: string;
}

/** workspaceStorage folders for every VS Code flavour we know about. */
export function storageRoots(): StorageRoot[] {
	const appData = process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming");
	return [
		{ flavor: "stable", dir: path.join(appData, "Code", "User", "workspaceStorage") },
		{ flavor: "insiders", dir: path.join(appData, "Code - Insiders", "User", "workspaceStorage") }
	];
}

export interface WorkspaceTarget {
	/** Absolute path of the folder, or of the .code-workspace file. */
	path: string | undefined;
	name: string;
}

function toPath(uri: unknown): string | undefined {
	if (typeof uri !== "string" || !uri.startsWith("file://")) return undefined;
	try {
		return fileURLToPath(uri);
	} catch {
		return undefined;
	}
}

/**
 * Resolves `<workspaceStorage>/<hash>/workspace.json`, which is how VS Code records
 * what a given window has open. Empty windows have no resolvable target.
 */
export async function readWorkspaceTarget(hashDir: string): Promise<WorkspaceTarget> {
	try {
		const raw = await fsp.readFile(path.join(hashDir, "workspace.json"), "utf8");
		const json = JSON.parse(raw) as { folder?: string; workspace?: string };

		const folder = toPath(json.folder);
		if (folder) return { path: folder, name: path.basename(folder) };

		const workspace = toPath(json.workspace);
		if (workspace) {
			return { path: workspace, name: `${path.basename(workspace, ".code-workspace")} (workspace)` };
		}
	} catch {
		// Missing or unreadable: treated as an untitled / empty window below.
	}
	return { path: undefined, name: "Untitled window" };
}
