// End-to-end test: spawn the MCP server and drive it over JSON-RPC against a real window.
// Usage: node test/e2e.mjs "<app>" <windowId>
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = process.argv[2], ID = Number(process.argv[3]);
const SERVER = process.env.CUA_SERVER || join(HERE, "..", "index.mjs");
const srv = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
srv.stderr.setEncoding("utf8"); srv.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

let buf = "", nextId = 1; const pending = new Map();
srv.stdout.setEncoding("utf8");
srv.stdout.on("data", (c) => {
  buf += c; let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
const rpc = (method, params) => new Promise((res) => {
  const id = nextId++; pending.set(id, res);
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const summarize = (r) => (r.result?.content || []).map((c) =>
  c.type === "image" ? `IMAGE(${c.mimeType}, ${Math.round((c.data || "").length / 1365)}KB→~${Math.round((c.data || "").length * 0.75 / 1024)}KB)`
                     : `TEXT(${c.text.length}c)`).join(" + ");

await rpc("initialize", { protocolVersion: "2024-11-05" });
const W = { app: APP, id: ID };

console.log("\n=== 1) OCR only (no image expected) ===");
let r = await rpc("tools/call", { name: "get_window_state", arguments: { ...W, ocr: true } });
console.log("content:", summarize(r));
{ const t = r.result.content.find((c) => c.type === "text").text;
  const ocr = t.split("OCR (")[1] || ""; console.log("OCR sample:", ocr.split("\n").slice(1, 4).join(" | ").slice(0, 160)); }

console.log("\n=== 2) pruned tree vs raw ===");
const pr = await rpc("tools/call", { name: "get_window_state", arguments: { ...W } });
const raw = await rpc("tools/call", { name: "get_window_state", arguments: { ...W, prune: false } });
const treeLen = (r2) => { const t = r2.result.content.find((c) => c.type === "text").text; const k = t.indexOf("\n\n"); return k < 0 ? 0 : t.slice(k).split("\n").length; };
console.log("pruned tree lines:", treeLen(pr), " raw tree lines:", treeLen(raw));

console.log("\n=== 3) screenshot (image expected, downscaled) ===");
r = await rpc("tools/call", { name: "get_window_state", arguments: { ...W, include_screenshot: true, force: true } });
console.log("content:", summarize(r));

console.log("\n=== 4) dedup: same again without force (image should be skipped) ===");
r = await rpc("tools/call", { name: "get_window_state", arguments: { ...W, include_screenshot: true } });
console.log("content:", summarize(r));
console.log("dedup note:", r.result.content.find((c) => c.type === "text").text.includes("no UI change") ? "YES (skipped)" : "no");

console.log("\n=== 5) region crop + image (small image expected) ===");
r = await rpc("tools/call", { name: "get_window_state", arguments: { ...W, include_screenshot: true, region: { x: 0, y: 0, w: 400, h: 120 }, force: true } });
console.log("content:", summarize(r));

await rpc("tools/call", { name: "end_computer_use", arguments: {} });
srv.kill();
console.log("\nDONE");
process.exit(0);
