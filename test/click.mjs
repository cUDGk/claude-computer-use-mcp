// Real click-and-observe test: OCR the menu bar, click a menu label by coordinate, screenshot the result.
// If the dropdown opens, the displayed→window coordinate mapping for click is correct end-to-end.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = process.argv[2], ID = Number(process.argv[3]), LABEL = process.argv[4] || "ファイル";
const srv = spawn("node", [process.env.CUA_SERVER || join(HERE, "..", "index.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
srv.stderr.setEncoding("utf8"); srv.stderr.on("data", (d) => process.stderr.write("[srv] " + d));
let buf = "", nextId = 1; const pending = new Map();
srv.stdout.setEncoding("utf8");
srv.stdout.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n")) !== -1) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; let m; try { m = JSON.parse(l); } catch { continue; } if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
const rpc = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const textOf = (r) => (r.result?.content || []).find((c) => c.type === "text")?.text || "";
const imgOf = (r) => (r.result?.content || []).find((c) => c.type === "image");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await rpc("initialize", { protocolVersion: "2024-11-05" });
const W = { app: APP, id: ID };
await rpc("tools/call", { name: "activate_window", arguments: W });

// 1) OCR → find the menu label's box (displayed coords)
const t = textOf(await rpc("tools/call", { name: "get_window_state", arguments: { ...W, ocr: true } }));
const boxes = [...t.matchAll(/@\((\d+),(\d+)\s+(\d+)x(\d+)\)\s+(.+)/g)].map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4], text: m[5].replace(/\s/g, "") }));
const hit = boxes.find((b) => b.text.includes(LABEL));
if (!hit) { console.log("LABEL not found in OCR; sample:", boxes.slice(0, 8).map((b) => b.text).join(" / ")); srv.kill(); process.exit(1); }
const cx = hit.x + Math.round(hit.w / 2), cy = hit.y + Math.round(hit.h / 2);
console.log(`OCR "${LABEL}" box:`, JSON.stringify(hit), "-> click displayed", cx, cy);

// 2) click it by coordinate
await rpc("tools/call", { name: "click", arguments: { ...W, x: cx, y: cy } });
await sleep(700);

// 3) observe: screenshot after the click
const r = await rpc("tools/call", { name: "get_window_state", arguments: { ...W, include_screenshot: true, force: true } });
const img = imgOf(r);
const outPath = join(HERE, "click_out." + (img.mimeType.split("/")[1] || "png"));
writeFileSync(outPath, Buffer.from(img.data, "base64"));
console.log("after-click screenshot:", outPath);
// also report any menu-ish items the UIA tree now exposes
const tree = textOf(r);
const menuish = tree.split("\n").filter((l) => /新規|開く|名前を付けて|印刷|新しいウィンドウ|終了|menu item/.test(l)).slice(0, 8);
console.log("menu items in tree after click:\n" + menuish.join("\n"));

await rpc("tools/call", { name: "press_key", arguments: { ...W, key: "Escape" } });
await rpc("tools/call", { name: "end_computer_use", arguments: {} });
srv.kill();
process.exit(0);
