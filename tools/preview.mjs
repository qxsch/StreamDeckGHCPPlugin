// Dev-only: writes a preview page showing every key state side by side.
import { writeFileSync } from "node:fs";
import { renderKey } from "../.probe/render.js";

const now = Date.now();
const base = {
	sessionId: "s",
	file: "",
	storageHash: "",
	workspacePath: "c:/node/steamdeck-plugin",
	flavor: "stable",
	requestCount: 3,
	lastPrompt: "do the thing",
	lastActivity: now,
	stale: false,
	windowOpen: true
};

const cases = [
	["empty", undefined, true],
	["running", { ...base, workspaceName: "steamdeck-plugin", status: "running", startedAt: now - 96_000 }, true],
	["running long", { ...base, workspaceName: "microhack-hub", status: "running", startedAt: now - 4_215_000 }, true],
	["finished", { ...base, workspaceName: "MicroHack", status: "finished", elapsedMs: 208_851 }, false],
	["acknowledged", { ...base, workspaceName: "MicroHack", status: "finished", elapsedMs: 208_851 }, true],
	["error", { ...base, workspaceName: "azure-infra-templates", status: "error" }, false],
	["stale", { ...base, workspaceName: "microhack-hub", status: "running", startedAt: now - 9_000_000, lastActivity: now - 8_900_000, stale: true }, true],
	["idle", { ...base, workspaceName: "steamdeck-plugin", status: "idle" }, true]
];

const tiles = cases
	.map(([label, session, acknowledged], i) => {
		const uri = renderKey({ slotIndex: i + 1, session, acknowledged, tick: 3, now });
		return `<figure><img src="${uri}" width="144" height="144"><figcaption>${label}</figcaption></figure>`;
	})
	.join("\n");

writeFileSync(
	new URL("../.probe/preview.html", import.meta.url),
	`<!doctype html><meta charset="utf-8">
<body style="background:#2d2d2d;font-family:Segoe UI,sans-serif;color:#ccc;margin:0;padding:24px">
<div style="display:flex;flex-wrap:wrap;gap:20px">${tiles}</div>
<style>figure{margin:0;text-align:center}figcaption{font-size:12px;margin-top:8px}img{border-radius:12px}</style>
</body>`
);
console.log("wrote .probe/preview.html");
