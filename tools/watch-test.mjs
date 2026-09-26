// Verifies the watcher closes the "resumed chat older than maxAge" gap, using a
// throwaway fixture so real chat journals are never touched.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionMonitor } from "../.probe/vscode/session-monitor.js";

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sd-agents-"));
const hashDir = path.join(root, "abc123");
const chatDir = path.join(hashDir, "chatSessions");
const journal = path.join(chatDir, "11111111-2222-3333-4444-555555555555.jsonl");

await fsp.mkdir(chatDir, { recursive: true });
await fsp.writeFile(path.join(hashDir, "workspace.json"), JSON.stringify({ folder: "file:///c%3A/tmp/legacy-project" }));
await fsp.writeFile(
	journal,
	[
		JSON.stringify({ kind: 0, v: { requests: [] } }),
		JSON.stringify({ kind: 2, k: ["requests"], v: [{ requestId: "r0", timestamp: Date.now(), message: { text: "an old turn" } }] }),
		JSON.stringify({ kind: 1, k: ["requests", 0, "elapsedMs"], v: 1234 })
	].join("\n") + "\n"
);

// Backdate well past the 12 h tracking window; this is what used to make it invisible.
const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000);
await fsp.utimes(journal, threeDaysAgo, threeDaysAgo);

const monitor = new SessionMonitor({
	roots: [{ flavor: "stable", dir: root }],
	scanIntervalMs: 60_000,
	pollIntervalMs: 60_000 // effectively disabled, so only the watcher can pass this test
});

const results = [];
const check = (label, actual, expected) => {
	const ok = actual === expected;
	results.push(ok);
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
};

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const status = () => monitor.sessions()[0]?.status;

await monitor.start();
await settle(200);
check("stale file is not tracked at startup", monitor.sessions().length, 0);
check("directory is watched", monitor.stats().watchers, 1);

await fsp.appendFile(
	journal,
	JSON.stringify({ kind: 2, k: ["requests"], v: [{ requestId: "r1", timestamp: Date.now(), message: { text: "resumed!" } }] }) + "\n"
);
await settle(600);
check("resumed turn is discovered", monitor.sessions().length, 1);
check("status is running", status(), "running");
check("prompt was read", monitor.sessions()[0]?.lastPrompt, "resumed!");
check("workspace resolved", monitor.sessions()[0]?.workspaceName, "legacy-project");

await fsp.appendFile(journal, JSON.stringify({ kind: 1, k: ["requests", 1, "elapsedMs"], v: 5000 }) + "\n");
await settle(600);
check("status flips to finished", status(), "finished");
check("duration captured", monitor.sessions()[0]?.elapsedMs, 5000);

monitor.stop();
fs.rmSync(root, { recursive: true, force: true });

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
