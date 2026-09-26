// Dev-only harness: prints live agent state from the real VS Code session journals.
import { SessionMonitor } from "../.probe/vscode/session-monitor.js";

const monitor = new SessionMonitor();
const render = (sessions) => {
	const interesting = sessions
		.filter((s) => s.requestCount > 0)
		.sort((a, b) => b.lastActivity - a.lastActivity)
		.slice(0, 10);
	console.clear();
	console.log(`${new Date().toLocaleTimeString()}  tracked=${sessions.length}`);
	for (const s of interesting) {
		const age = ((Date.now() - s.lastActivity) / 1000).toFixed(0).padStart(5);
		console.log(
			`  ${s.status.padEnd(9)} turns=${String(s.requestCount).padStart(2)} ${age}s ago  ${s.workspaceName.padEnd(24)} ${(s.lastPrompt ?? "").slice(0, 50)}`
		);
	}
};

monitor.on("update", render);
await monitor.start();
render(monitor.sessions());

// Startup does a one-off full sweep, so rates are measured from a later baseline.
const BASELINE_AT = 20_000;
const RUN_FOR = 120_000;
let baseline;

setTimeout(() => {
	baseline = { at: Date.now(), ...monitor.stats() };
}, BASELINE_AT);

setTimeout(() => {
	const io = monitor.stats();
	monitor.stop();
	const seconds = (Date.now() - baseline.at) / 1000;
	console.log(
		`\nstartup: read=${(baseline.bytesRead / 1024 / 1024).toFixed(2)}MB fileOpens=${baseline.fileOpens} ` +
			`stats=${baseline.statCalls} dirReads=${baseline.dirReads}`
	);
	console.log(
		`steady state over ${seconds.toFixed(0)}s: ` +
			`${((io.statCalls - baseline.statCalls) / seconds).toFixed(1)} stat/s, ` +
			`${((io.dirReads - baseline.dirReads) / seconds).toFixed(2)} dirRead/s, ` +
			`${(((io.bytesRead - baseline.bytesRead) / 1024) / seconds).toFixed(1)} KB/s, ` +
			`tracked=${io.tracked} watchers=${io.watchers} openHandles=${io.openHandles}`
	);
	process.exit(0);
}, RUN_FOR);
