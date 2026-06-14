// Coordinate round-trip test: OCR a UI element to get its DISPLAYED coords, then crop a region at those
// same displayed coords. If the crop contains that element, displayed↔actual scaling is correct.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = process.argv[2], ID = Number(process.argv[3]);
const srv = spawn("node", [process.env.CUA_SERVER || join(HERE, "..", "index.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
srv.stderr.setEncoding("utf8"); srv.stderr.on("data", (d) => process.stderr.write("[srv] " + d));
let buf = "", nextId = 1; const pending = new Map();
srv.stdout.setEncoding("utf8");
srv.stdout.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n")) !== -1) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; let m; try { m = JSON.parse(l); } catch { continue; } if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
const rpc = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const textOf = (r) => (r.result?.content || []).find((c) => c.type === "text")?.text || "";
const imgOf = (r) => (r.result?.content || []).find((c) => c.type === "image");

await rpc("initialize", { protocolVersion: "2024-11-05" });
const W = { app: APP, id: ID };

// 1) OCR the whole window → displayed-space boxes
const o = await rpc("tools/call", { name: "get_window_state", arguments: { ...W, ocr: true } });
const t = textOf(o);
const scaleLine = textOf(await rpc("tools/call", { name: "get_window_state", arguments: { ...W, include_screenshot: true, force: true } })).split("\n").find((l) => l.startsWith("coords:")) || "(scale 1)";
const boxes = [...t.matchAll(/@\((\d+),(\d+)\s+(\d+)x(\d+)\)\s+(.+)/g)].map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4], text: m[5] }));
// pick a clear, non-trivial label near the top
const target = boxes.find((b) => b.text.replace(/\s/g, "").length >= 3 && b.y > 5 && b.y < 200) || boxes[0];
console.log("scale line:", scaleLine);
console.log("OCR target (displayed coords):", JSON.stringify(target));

// 2) crop a region AT those displayed coords — should frame the target
const pad = 12;
const region = { x: target.x - pad, y: target.y - pad, w: target.w + pad * 2, h: target.h + pad * 2 };
const r = await rpc("tools/call", { name: "get_window_state", arguments: { ...W, include_screenshot: true, region, force: true } });
const img = imgOf(r);
const outPath = join(HERE, "crop_out." + (img.mimeType.split("/")[1] || "png"));
writeFileSync(outPath, Buffer.from(img.data, "base64"));
console.log("crop region (displayed):", JSON.stringify(region));
console.log("crop saved:", outPath, "(" + img.mimeType + ")");

await rpc("tools/call", { name: "end_computer_use", arguments: {} });
srv.kill();
process.exit(0);
