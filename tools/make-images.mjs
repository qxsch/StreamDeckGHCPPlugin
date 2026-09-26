// Generates the static PNG assets referenced by manifest.json.
// Pure Node (zlib only) so the repo needs no image tooling.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sdPlugin = resolve(root, "com.marcoweber.copilot-agents.sdPlugin");

const CRC_TABLE = (() => {
	const t = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c;
	}
	return t;
})();

function crc32(buf) {
	let c = -1;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}

function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body), 0);
	return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // RGBA
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (width * 4 + 1)] = 0; // filter: none
		rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0))
	]);
}

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

/** Draws shapes with 4x4 supersampled coverage, painted back-to-front. */
function render(size, shapes) {
	const px = Buffer.alloc(size * size * 4);
	const SS = 4;
	for (const { color, alpha = 1, test } of shapes) {
		const [r, g, b] = hex(color);
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				let hits = 0;
				for (let sy = 0; sy < SS; sy++) {
					for (let sx = 0; sx < SS; sx++) {
						if (test((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size)) hits++;
					}
				}
				if (!hits) continue;
				const a = (hits / (SS * SS)) * alpha;
				const i = (y * size + x) * 4;
				const dstA = px[i + 3] / 255;
				const outA = a + dstA * (1 - a);
				px[i] = Math.round((r * a + px[i] * dstA * (1 - a)) / outA);
				px[i + 1] = Math.round((g * a + px[i + 1] * dstA * (1 - a)) / outA);
				px[i + 2] = Math.round((b * a + px[i + 2] * dstA * (1 - a)) / outA);
				px[i + 3] = Math.round(outA * 255);
			}
		}
	}
	return px;
}

// All shape predicates work in normalised 0..1 space so one design scales to every size.
const roundRect = (inset, radius) => (x, y) => {
	const lo = inset;
	const hi = 1 - inset;
	if (x < lo || x > hi || y < lo || y > hi) return false;
	const cx = Math.min(Math.max(x, lo + radius), hi - radius);
	const cy = Math.min(Math.max(y, lo + radius), hi - radius);
	return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
};

const annulus = (inner, outer) => (x, y) => {
	const d = Math.hypot(x - 0.5, y - 0.5);
	return d >= inner && d <= outer;
};

// A gap in the ring turns it into a "progress/activity" mark rather than a plain circle.
const arcGap = (inner, outer, fromDeg, toDeg) => (x, y) => {
	const d = Math.hypot(x - 0.5, y - 0.5);
	if (d < inner || d > outer) return false;
	let a = (Math.atan2(y - 0.5, x - 0.5) * 180) / Math.PI;
	if (a < 0) a += 360;
	return !(a >= fromDeg && a <= toDeg);
};

const dot = (r) => (x, y) => Math.hypot(x - 0.5, y - 0.5) <= r;

const withBackground = [
	{ color: "#15181e", test: roundRect(0.0, 0.16) },
	{ color: "#2a3140", test: annulus(0.3, 0.345) },
	{ color: "#4c8dff", test: arcGap(0.3, 0.345, 100, 330) },
	{ color: "#4c8dff", test: dot(0.11) }
];

const transparent = [
	{ color: "#d6dbe4", test: annulus(0.3, 0.36) },
	{ color: "#d6dbe4", test: dot(0.12) }
];

const targets = [
	["imgs/plugin/marketplace.png", 288, withBackground],
	["imgs/plugin/marketplace@2x.png", 576, withBackground],
	["imgs/plugin/category-icon.png", 28, transparent],
	["imgs/plugin/category-icon@2x.png", 56, transparent],
	["imgs/actions/slot/icon.png", 20, transparent],
	["imgs/actions/slot/icon@2x.png", 40, transparent],
	["imgs/actions/slot/key.png", 72, withBackground],
	["imgs/actions/slot/key@2x.png", 144, withBackground]
];

for (const [rel, size, shapes] of targets) {
	const out = resolve(sdPlugin, rel);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, encodePng(size, size, render(size, shapes)));
	console.log(`wrote ${rel} (${size}x${size})`);
}
