#!/usr/bin/env node
// claude-computer-use-mcp — an MCP server that drives Codex's own codex-computer-use.exe helper.
//
// It does NOT ship that helper (proprietary OpenAI binary). Instead it locates the copy bundled
// with your local Codex install and spawns it, exposing its real Computer Use engine — on-screen
// overlay / highlight, UI Automation tree, occluded GPU capture, Esc-to-stop — as MCP tools.
//
// Helper resolution order:
//   1. $CLAUDE_CUA_HELPER         — full path to codex-computer-use.exe (set this to your Codex copy)
//   2. ./vendor/codex-computer-use.exe   — optional local copy you drop in yourself (gitignored)
//   3. ~/.codex/plugins/cache/openai-bundled/computer-use/<ver>/node_modules/@oai/sky/bin/windows/...
//
// Wire protocol (reverse-engineered from @oai/sky helper_transport.js):
//   launch:  codex-computer-use.exe --parent-pid <pid>   (stdio pipes, windowsHide)
//   request: {id, method, params, meta?}\n  to stdin
//   reply:   {id, ok, result} | {id, error} | {id, approvalRequest:{app}} \n  from stdout
//   approve: on {approvalRequest:{app}}, resend the same request with meta["x-oai-cua-approved-app"]=app

import { spawn, spawnSync } from "node:child_process";
import { readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const HERE = dirname(fileURLToPath(import.meta.url));

// The computer-use skill, surfaced to the model via the MCP `instructions` field and a `prompts` entry.
const SKILL = (() => {
  try { return readFileSync(join(HERE, "SKILL.md"), "utf8"); }
  catch { return ""; }
})();

// Our own home dir: holds the branded overlay config + interrupt markers. Never touches ~/.codex config.
const CUA_HOME = join(HERE, "home");

// ---- locate the helper engine ----
function resolveHelper() {
  // 1. Explicit override — point this at your local Codex install's exe.
  const env = process.env.CLAUDE_CUA_HELPER;
  if (env) {
    if (existsSync(env)) return env;
    throw new Error("CLAUDE_CUA_HELPER is set but the file does not exist: " + env);
  }
  // 2. Optional local copy (you may drop your own exe here; it is gitignored).
  const vendored = join(HERE, "vendor", "codex-computer-use.exe");
  if (existsSync(vendored)) return vendored;
  // 3. Auto-resolve from a local Codex install (newest version wins).
  const base = join(homedir(), ".codex", "plugins", "cache", "openai-bundled", "computer-use");
  const rel = join("node_modules", "@oai", "sky", "bin", "windows", "codex-computer-use.exe");
  if (existsSync(base)) {
    const versions = readdirSync(base).filter((d) => existsSync(join(base, d, rel)));
    if (versions.length) {
      versions.sort((a, b) => statSync(join(base, b)).mtimeMs - statSync(join(base, a)).mtimeMs);
      return join(base, versions[0], rel);
    }
  }
  throw new Error(
    "codex-computer-use.exe not found. Install Codex (it bundles the helper) so it can be auto-resolved " +
    "from " + base + ", or set the CLAUDE_CUA_HELPER environment variable to the full path of the exe."
  );
}

// ---- helper transport: spawn once, correlate line-JSON by id, auto-approve ----
class Helper {
  constructor() {
    this.child = null; this.nextId = 1; this.pending = new Map(); this.buf = ""; this.stderr = "";
  }
  ensure() {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) return;
    const exe = resolveHelper();
    this.child = spawn(exe, ["--parent-pid", String(process.pid)], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, CODEX_HOME: CUA_HOME }, // read our own overlay config / write markers here
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (c) => this._onData(c));
    this.child.stderr.on("data", (c) => { this.stderr = (this.stderr + c).slice(-4000); });
    this.child.on("exit", (code) => this._rejectAll(new Error(`helper exited (code ${code}): ${this.stderr.slice(-400)}`)));
    this.child.on("error", (e) => this._rejectAll(e));
  }
  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; } // non-JSON => log noise, ignore
      if (typeof msg.id !== "number") continue;
      const resolve = this.pending.get(msg.id);
      if (!resolve) continue;
      this.pending.delete(msg.id);
      resolve(msg);
    }
  }
  _rejectAll(err) {
    for (const [, resolve] of this.pending) resolve({ error: String(err?.message ?? err) });
    this.pending.clear();
    this.child = null;
  }
  _send(method, params, meta) {
    this.ensure();
    const id = this.nextId++;
    const env = meta ? { id, method, params, meta } : { id, method, params };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) resolve({ error: `request timed out: ${method}` });
      }, 35000);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.child.stdin.write(JSON.stringify(env) + "\n");
    });
  }
  async request(method, params) {
    const budget = { "x-oai-cua-request-budget-ms": 30000 };
    let msg = await this._send(method, params, budget);
    if (msg.approvalRequest?.app) {
      // auto-approve this app and resend the same request
      msg = await this._send(method, params, { ...budget, "x-oai-cua-approved-app": msg.approvalRequest.app });
    }
    if (msg.error) throw new Error(typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error));
    if (msg.ok || msg.result !== undefined) return msg.result;
    throw new Error("helper returned no result: " + JSON.stringify(msg));
  }
  // End the session: killing the helper tears down its on-screen overlay and releases control.
  // The next tool call lazily respawns it.
  shutdown() {
    const c = this.child;
    if (!c) return false;
    try { c.stdin.write(JSON.stringify({ id: this.nextId++, method: "close", params: {} }) + "\n"); } catch {}
    for (const [, resolve] of this.pending) resolve({ error: "computer use ended" });
    this.pending.clear();
    try { c.kill(); } catch {}
    this.child = null;
    return true;
  }
}

const helper = new Helper();

// ---- clipboard (the helper has no clipboard op, so do it at the Node layer via PowerShell) ----
// base64 round-trips through PowerShell to avoid codepage corruption of non-ASCII (e.g. Japanese) text.
function clipboardGet() {
  const r = spawnSync("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw"], { encoding: "utf8", windowsHide: true });
  return (r.stdout || "").replace(/\r?\n$/, "");
}
function clipboardSet(text) {
  const b64 = Buffer.from(String(text), "utf8").toString("base64");
  spawnSync("powershell", ["-NoProfile", "-Command", `Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`], { windowsHide: true });
}

// ---- MCP content helpers ----
const txt = (s) => ({ type: "text", text: s });
function dataUrlToImage(url) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url || "");
  if (!m) return null;
  return { type: "image", data: m[2], mimeType: m[1] };
}

// ---- tool dispatch ----
async function callTool(name, a) {
  a = a || {};
  const win = () => ({ app: String(a.app), id: Number(a.id) });
  switch (name) {
    case "list_apps": return [txt(JSON.stringify(await helper.request("list_apps", {}), null, 2))];
    case "list_windows": return [txt(JSON.stringify(await helper.request("list_windows", {}), null, 2))];
    case "get_window":
      return [txt(JSON.stringify(await helper.request("get_window", a.app ? { id: Number(a.id), app: String(a.app) } : { id: Number(a.id) }), null, 2))];
    case "launch_app": await helper.request("launch_app", { app: String(a.app) }); return [txt("launched " + a.app)];
    case "activate_window": await helper.request("activate_window", { window: win() }); return [txt("activated")];
    case "get_window_state": {
      const st = await helper.request("get_window_state", {
        window: win(),
        include_screenshot: a.include_screenshot !== false,
        include_text: a.include_text === true,
      });
      const out = [];
      for (const s of st.screenshots || []) { const img = dataUrlToImage(s.url); if (img) out.push(img); }
      const lines = ["window: " + JSON.stringify(st.window)];
      const acc = st.accessibility;
      if (acc) {
        if (acc.focused_element) lines.push("focused: " + acc.focused_element);
        if (acc.selected_text) lines.push("selected_text: " + acc.selected_text);
        if (acc.document_text) lines.push("document_text: " + acc.document_text);
        if (acc.tree) lines.push("", acc.tree);
      }
      out.push(txt(lines.join("\n")));
      return out;
    }
    case "click":
      if (a.element_index !== undefined)
        await helper.request("click_element", { window: win(), element_index: Number(a.element_index), click_count: Number(a.count || 1), mouse_button: a.button || "left" });
      else
        await helper.request("click", { window: win(), x: Number(a.x), y: Number(a.y), click_count: Number(a.count || 1), mouse_button: a.button || "left", ...(a.screenshotId ? { screenshotId: a.screenshotId } : {}) });
      return [txt("clicked")];
    case "type_text": await helper.request("type_text", { window: win(), text: String(a.text) }); return [txt("typed")];
    case "press_key": await helper.request("press_key", { window: win(), key: String(a.key) }); return [txt("pressed " + a.key)];
    case "scroll": await helper.request("scroll", { window: win(), x: Number(a.x), y: Number(a.y), scrollX: Number(a.scroll_x || 0), scrollY: Number(a.scroll_y || 0) }); return [txt("scrolled")];
    case "drag": await helper.request("drag", { window: win(), from_x: Number(a.from_x), from_y: Number(a.from_y), to_x: Number(a.to_x), to_y: Number(a.to_y) }); return [txt("dragged")];
    case "set_value": await helper.request("set_value", { window: win(), element_index: Number(a.element_index), value: String(a.value) }); return [txt("set")];
    case "perform_secondary_action": await helper.request("perform_secondary_action", { window: win(), element_index: Number(a.element_index), action: String(a.action) }); return [txt("done")];
    case "clipboard_get": return [txt(clipboardGet())];
    case "clipboard_set": clipboardSet(a.text); return [txt("clipboard set")];
    case "end_computer_use": return [txt(helper.shutdown() ? "Computer use ended — overlay dismissed, control released." : "No active computer-use session.")];
    default: throw new Error("unknown tool: " + name);
  }
}

// ---- tool schemas ----
const WIN = { app: { type: "string", description: "App id from list_apps/list_windows." }, id: { type: "integer", description: "Window id from list_apps/list_windows." } };
const TOOLS = [
  { name: "list_apps", description: "List installed apps and their open windows (id, displayName, isRunning).", inputSchema: { type: "object", properties: {} } },
  { name: "list_windows", description: "List currently open targetable windows ({app,id,title}).", inputSchema: { type: "object", properties: {} } },
  { name: "get_window", description: "Rehydrate a window by id (and optional app).", inputSchema: { type: "object", properties: WIN, required: ["id"] } },
  { name: "launch_app", description: "Launch an app by id (from list_apps) or an explicit .exe path.", inputSchema: { type: "object", properties: { app: WIN.app }, required: ["app"] } },
  { name: "activate_window", description: "Bring a window to the foreground (restores if minimized).", inputSchema: { type: "object", properties: WIN, required: ["app", "id"] } },
  { name: "get_window_state", description: "Capture a window: screenshot (Graphics.Capture, works occluded) and/or UI Automation tree with element indexes. Returns image(s) + text.", inputSchema: { type: "object", properties: { ...WIN, include_screenshot: { type: "boolean", description: "Capture screenshot (default true)." }, include_text: { type: "boolean", description: "Capture accessibility tree (default false)." } }, required: ["app", "id"] } },
  { name: "click", description: "Click a window: by coordinate (x,y, window-relative) or by element_index from get_window_state.", inputSchema: { type: "object", properties: { ...WIN, x: { type: "integer" }, y: { type: "integer" }, element_index: { type: "integer" }, button: { type: "string", description: "left|right|middle" }, count: { type: "integer", description: "click count" } }, required: ["app", "id"] } },
  { name: "type_text", description: "Type literal text into the focused control.", inputSchema: { type: "object", properties: { ...WIN, text: { type: "string" } }, required: ["app", "id", "text"] } },
  { name: "press_key", description: "Press a key/chord, e.g. 'Return', 'Control+a', 'KP_5' (X keysym names).", inputSchema: { type: "object", properties: { ...WIN, key: { type: "string" } }, required: ["app", "id", "key"] } },
  { name: "scroll", description: "Scroll from (x,y) by deltas. Positive scroll_y = down.", inputSchema: { type: "object", properties: { ...WIN, x: { type: "integer" }, y: { type: "integer" }, scroll_x: { type: "integer" }, scroll_y: { type: "integer" } }, required: ["app", "id", "x", "y"] } },
  { name: "drag", description: "Drag from (from_x,from_y) to (to_x,to_y), window-relative.", inputSchema: { type: "object", properties: { ...WIN, from_x: { type: "integer" }, from_y: { type: "integer" }, to_x: { type: "integer" }, to_y: { type: "integer" } }, required: ["app", "id", "from_x", "from_y", "to_x", "to_y"] } },
  { name: "set_value", description: "Set the value of an editable element by element_index.", inputSchema: { type: "object", properties: { ...WIN, element_index: { type: "integer" }, value: { type: "string" } }, required: ["app", "id", "element_index", "value"] } },
  { name: "perform_secondary_action", description: "Invoke a secondary accessibility action (Expand/Collapse/Scroll Up...) on an element_index.", inputSchema: { type: "object", properties: { ...WIN, element_index: { type: "integer" }, action: { type: "string" } }, required: ["app", "id", "element_index", "action"] } },
  { name: "clipboard_get", description: "Read the Windows clipboard as text.", inputSchema: { type: "object", properties: {} } },
  { name: "clipboard_set", description: "Write text to the Windows clipboard.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "end_computer_use", description: "End the computer-use session: dismiss the on-screen overlay and release control. Call this when the GUI task is finished.", inputSchema: { type: "object", properties: {} } },
];

// ---- MCP stdio JSON-RPC (newline-delimited) ----
function write(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
function reply(id, result) { write({ jsonrpc: "2.0", id, result }); }

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  line = line.trim();
  if (!line) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const { id, method } = msg;
  try {
    if (method === "initialize") {
      reply(id, {
        protocolVersion: msg.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: "claude-computer-use", version: "1.0.0" },
        ...(SKILL ? { instructions: SKILL } : {}),
      });
    } else if (method === "tools/list") {
      reply(id, { tools: TOOLS });
    } else if (method === "prompts/list") {
      reply(id, { prompts: [{ name: "computer-use", description: "How to control Windows apps with this server (screenshot + UI Automation + input injection)." }] });
    } else if (method === "prompts/get") {
      if (msg.params?.name === "computer-use")
        reply(id, { description: "Computer Use skill", messages: [{ role: "user", content: { type: "text", text: SKILL } }] });
      else
        write({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown prompt: " + msg.params?.name } });
    } else if (method === "tools/call") {
      try {
        const content = await callTool(msg.params.name, msg.params.arguments);
        reply(id, { content, isError: false });
      } catch (e) {
        reply(id, { content: [txt("Error: " + (e?.message ?? String(e)))], isError: true });
      }
    } else if (method === "ping") {
      reply(id, {});
    } else if (id !== undefined) {
      write({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } });
    }
  } catch (e) {
    if (id !== undefined) write({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e?.message ?? e) } });
  }
});
