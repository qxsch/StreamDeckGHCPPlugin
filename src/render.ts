import type { AgentSession } from "./types.js";

const PALETTE = {
	running: { bg: "#0d2237", ring: "#1d3d5c", accent: "#4c8dff", primary: "#f2f7ff", name: "#b8cdf0" },
	finished: { bg: "#0f2a1b", ring: "#1e4a32", accent: "#35d07f", primary: "#eaffef", name: "#a7dcbf" },
	acknowledged: { bg: "#15181e", ring: "#262c38", accent: "#4d7f66", primary: "#c3ccd9", name: "#89939f" },
	error: { bg: "#2e1419", ring: "#5a2730", accent: "#ff5c6c", primary: "#ffeced", name: "#e3a8ae" },
	idle: { bg: "#15181e", ring: "#262c38", accent: "#7d8798", primary: "#c3ccd9", name: "#89939f" },
	stale: { bg: "#1f1b10", ring: "#3a3521", accent: "#e0b33c", primary: "#fff4d8", name: "#cbb383" },
	empty: { bg: "#0e1014", ring: "#1d2129", accent: "#3f4756", primary: "#59616f", name: "#4a525f" }
} as const;

type Tone = keyof typeof PALETTE;

const escapeXml = (value: string): string =>
	value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

const clip = (value: string, max: number): string => (value.length <= max ? value : `${value.slice(0, max - 1)}…`);

function formatDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const seconds = total % 60;
	const minutes = Math.floor(total / 60) % 60;
	const hours = Math.floor(total / 3600);
	const pad = (n: number): string => n.toString().padStart(2, "0");
	return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Splits a name across at most two lines so long folder names stay readable. */
function wrap(value: string, perLine: number): string[] {
	if (value.length <= perLine) return [value];
	// Break after separators but keep them, so "steamdeck-plugin" stays hyphenated.
	const tokens = value.split(/(?<=[\s\-_.])/).filter(Boolean);
	const lines: string[] = [];
	let current = "";
	for (const token of tokens) {
		const candidate = current + token;
		if (candidate.length > perLine && current) {
			lines.push(current);
			current = token;
			if (lines.length === 2) break;
		} else {
			current = candidate;
		}
	}
	if (lines.length < 2 && current) lines.push(current);
	return lines.slice(0, 2).map((line) => clip(line.trimEnd(), perLine));
}

/** The primary line carries the timer, so it scales up to stay as large as will fit. */
function primaryFontSize(text: string): number {
	if (text.length <= 4) return 46;
	if (text.length <= 5) return 40;
	if (text.length <= 7) return 31;
	return 25;
}

const GX = 119;
const GY = 22;

/** Small corner mark so state is readable even when the colour is ambiguous. */
function statusGlyph(tone: Tone, session: AgentSession | undefined, tick: number): string {
	const { accent, ring, bg } = PALETTE[tone];
	if (!session) {
		return `<circle cx="${GX}" cy="${GY}" r="10" fill="none" stroke="${accent}" stroke-width="3" stroke-dasharray="4 5"/>`;
	}
	if (session.status === "running" && !session.stale) {
		return `<circle cx="${GX}" cy="${GY}" r="11" fill="none" stroke="${ring}" stroke-width="4"/>
<path d="M ${GX} ${GY - 11} A 11 11 0 0 1 ${GX + 11} ${GY}" fill="none" stroke="${accent}" stroke-width="4" stroke-linecap="round" transform="rotate(${(tick * 45) % 360} ${GX} ${GY})"/>`;
	}
	if (session.status === "running") {
		return `<circle cx="${GX}" cy="${GY}" r="11" fill="none" stroke="${accent}" stroke-width="4" stroke-dasharray="3 6"/>`;
	}
	if (session.status === "error") {
		return `<circle cx="${GX}" cy="${GY}" r="12" fill="${accent}"/>
<path d="M ${GX - 5} ${GY - 5} l 10 10 M ${GX + 5} ${GY - 5} l -10 10" fill="none" stroke="${bg}" stroke-width="3.2" stroke-linecap="round"/>`;
	}
	if (session.status === "finished") {
		return `<circle cx="${GX}" cy="${GY}" r="12" fill="${accent}"/>
<path d="M ${GX - 6} ${GY} l 4 5 l 8 -10" fill="none" stroke="${bg}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>`;
	}
	return `<circle cx="${GX}" cy="${GY}" r="10" fill="none" stroke="${accent}" stroke-width="3"/>`;
}

export interface RenderInput {
	slotIndex: number;
	session: AgentSession | undefined;
	acknowledged: boolean;
	tick: number;
	now: number;
}

export function renderKey({ slotIndex, session, acknowledged, tick, now }: RenderInput): string {
	let tone: Tone;
	let primary: string;

	if (!session) {
		tone = "empty";
		primary = "–";
	} else if (session.status === "running" && session.stale) {
		tone = "stale";
		primary = formatDuration(now - session.lastActivity);
	} else if (session.status === "running") {
		tone = "running";
		primary = session.startedAt ? formatDuration(now - session.startedAt) : "…";
	} else if (session.status === "error") {
		tone = "error";
		primary = "failed";
	} else if (session.status === "finished") {
		tone = acknowledged ? "acknowledged" : "finished";
		primary = session.elapsedMs !== undefined ? formatDuration(session.elapsedMs) : "done";
	} else {
		tone = "idle";
		primary = "idle";
	}

	const colors = PALETTE[tone];
	const nameLines = session ? wrap(session.workspaceName, 14) : [`slot ${slotIndex}`];
	const nameY = nameLines.length > 1 ? [112, 133] : [125];
	const nameSvg = nameLines
		.map(
			(line, i) =>
				`<text x="72" y="${nameY[i] ?? 125}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="17" font-weight="700" fill="${colors.name}">${escapeXml(line)}</text>`
		)
		.join("");

	// A pulsing edge makes "still working" obvious from across the desk.
	const animating = session?.status === "running" && !session.stale;
	const pulse = animating ? 0.4 + 0.5 * Math.abs(((tick % 8) - 4) / 4) : 1;
	const border =
		animating || (session?.status === "finished" && !acknowledged) || session?.status === "error"
			? `<rect x="2.5" y="2.5" width="139" height="139" rx="17" fill="none" stroke="${colors.accent}" stroke-width="4" opacity="${pulse.toFixed(2)}"/>`
			: "";

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<rect width="144" height="144" rx="19" fill="${colors.bg}"/>
${border}
<text x="12" y="30" font-family="Arial, Helvetica, sans-serif" font-size="20" font-weight="700" fill="${colors.accent}">${slotIndex}</text>
${statusGlyph(tone, session, tick)}
<text x="72" y="86" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${primaryFontSize(primary)}" font-weight="700" fill="${colors.primary}">${escapeXml(primary)}</text>
${nameSvg}
</svg>`;

	return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
}
