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
import { createHash } from "node:crypto";
import { readdirSync, existsSync, statSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

// Screenshot token cost scales with pixel count (≈ width*height/750), not bytes — so we resize the
// long edge down to MAX_DIM before handing the image to the model. 0 disables. Resize uses .NET
// System.Drawing via PowerShell (no npm deps, same trick as the clipboard helpers). On any failure
// the original image is returned untouched, so a broken resize never loses the screenshot.
const MAX_DIM = Number(process.env.CLAUDE_CUA_MAX_DIM ?? 1280);
function downscaleDataUrl(url) {
  if (!Number.isFinite(MAX_DIM) || MAX_DIM <= 0) return url;
  const m = /^data:(image\/[^;]+);base64,(.*)$/s.exec(url || "");
  if (!m) return url;
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), "cua-"));
    const inPath = join(dir, "in"), outPath = join(dir, "out.jpg");
    writeFileSync(inPath, Buffer.from(m[2], "base64"));
    const ps = [
      "$ErrorActionPreference='Stop'", "Add-Type -AssemblyName System.Drawing",
      `$img=[System.Drawing.Image]::FromFile('${inPath}')`,
      `$s=[Math]::Min(1.0, ${MAX_DIM}/[Math]::Max($img.Width,$img.Height))`,
      "if($s -ge 1.0){$img.Dispose(); exit 2}", // already small enough — keep original
      "$nw=[int]($img.Width*$s); $nh=[int]($img.Height*$s)",
      "$bmp=New-Object System.Drawing.Bitmap $nw,$nh",
      "$g=[System.Drawing.Graphics]::FromImage($bmp)",
      "$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic",
      "$g.DrawImage($img,0,0,$nw,$nh)",
      "$enc=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|?{$_.MimeType -eq 'image/jpeg'}",
      "$p=New-Object System.Drawing.Imaging.EncoderParameters 1",
      "$p.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality),([int64]82)",
      `$bmp.Save('${outPath}',$enc,$p)`, "$g.Dispose(); $bmp.Dispose(); $img.Dispose()",
    ].join("; ");
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true });
    if (r.status !== 0 || !existsSync(outPath)) return url; // status 2 (no resize) or any error => keep original
    return "data:image/jpeg;base64," + readFileSync(outPath).toString("base64");
  } catch { return url; }
  finally { if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} } }
}

// ---- UIA tree pruning: drop purely structural nodes, keep interactable/named ones (indices preserved) ----
// The codex helper localizes some control types (JP) and not others (EN), so the noise set lists both.
const TREE_NOISE = ["ウィンドウ", "window", "pane", "ペイン", "スクロール バー", "scroll bar", "タイトル バー", "title bar", "グループ", "group", "セパレーター", "separator", "区切り", "縮小", "custom", "カスタム"];
function pruneTree(tree) {
  if (!tree) return tree;
  const out = []; let dropped = 0;
  for (const line of tree.split("\n")) {
    const m = /^(\s*)(\d+)\s+(.*)$/.exec(line);
    if (!m) { out.push(line); continue; }            // header / blank — keep verbatim
    const rest = m[3];
    if (TREE_NOISE.some((p) => rest === p || rest.startsWith(p + " "))) { dropped++; continue; }
    out.push(line);
  }
  if (dropped) out.push(`\t… ${dropped} structural nodes hidden (pass prune:false for the full tree)`);
  return out.join("\n");
}

// ---- change-detection dedup: skip re-sending a byte-identical-UI screenshot for the same window ----
const sha = (s) => createHash("sha1").update(String(s)).digest("hex");
const lastSig = new Map(); const delivered = new Set();

// ---- crop a screenshot dataURL to a window-relative region {x,y,w,h} (System.Drawing, no deps) ----
function cropDataUrl(url, region) {
  const m = /^data:(image\/[^;]+);base64,(.*)$/s.exec(url || "");
  const w = Math.round(region?.w ?? region?.width ?? 0), h = Math.round(region?.h ?? region?.height ?? 0);
  if (!m || w <= 0 || h <= 0) return url;
  const x = Math.max(0, Math.round(region?.x ?? 0)), y = Math.max(0, Math.round(region?.y ?? 0));
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), "cua-crop-"));
    const inPath = join(dir, "in"), outPath = join(dir, "out.png");
    writeFileSync(inPath, Buffer.from(m[2], "base64"));
    const ps = [
      "$ErrorActionPreference='Stop'", "Add-Type -AssemblyName System.Drawing",
      `$img=[System.Drawing.Image]::FromFile('${inPath}')`,
      `$x=[Math]::Min([Math]::Max(0,${x}),$img.Width-1); $y=[Math]::Min([Math]::Max(0,${y}),$img.Height-1)`,
      `$w=[Math]::Min(${w}, $img.Width-$x); $h=[Math]::Min(${h}, $img.Height-$y)`,
      "if($w -le 0 -or $h -le 0){$img.Dispose(); exit 2}",
      "$crop=$img.Clone((New-Object System.Drawing.Rectangle $x,$y,$w,$h),$img.PixelFormat)",
      `$crop.Save('${outPath}',[System.Drawing.Imaging.ImageFormat]::Png)`,
      "$crop.Dispose(); $img.Dispose()",
    ].join("; ");
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true });
    if (r.status !== 0 || !existsSync(outPath)) return url;
    return "data:image/png;base64," + readFileSync(outPath).toString("base64");
  } catch { return url; }
  finally { if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} } }
}

// ---- OCR a screenshot dataURL via the built-in Windows.Media.Ocr engine (no deps); returns text+coords ----
// Reads pixels the UIA tree can't (canvas / games / custom-drawn Electron) and costs text tokens, not image tokens.
function ocrDataUrl(url) {
  const m = /^data:image\/[^;]+;base64,(.*)$/s.exec(url || "");
  if (!m) return null;
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), "cua-ocr-"));
    const inPath = join(dir, "in.png");
    writeFileSync(inPath, Buffer.from(m[1], "base64"));
    const ps = [
      "$ErrorActionPreference='Stop'", "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
      "$asTask=([System.WindowsRuntimeSystemExtensions].GetMethods()|?{$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'})[0]",
      "function Await($op,$t){ $k=$asTask.MakeGenericMethod($t).Invoke($null,@($op)); $k.Wait(-1)|Out-Null; $k.Result }",
      "[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]|Out-Null",
      "[Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]|Out-Null",
      "[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Foundation,ContentType=WindowsRuntime]|Out-Null",
      "[Windows.Storage.StorageFile,Windows.Foundation,ContentType=WindowsRuntime]|Out-Null",
      "[Windows.Storage.Streams.IRandomAccessStream,Windows.Foundation,ContentType=WindowsRuntime]|Out-Null",
      `$sf=Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('${inPath}')) ([Windows.Storage.StorageFile])`,
      "$st=Await ($sf.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])",
      "$dec=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($st)) ([Windows.Graphics.Imaging.BitmapDecoder])",
      "$sb=Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])",
      "$eng=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()",
      "if(-not $eng){ exit 3 }",
      "$res=Await ($eng.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])",
      "foreach($ln in $res.Lines){ $f=$null; foreach($w in $ln.Words){ $f=$w; break }; $r=$f.BoundingRect; Write-Output ('@('+[int][double]$r.X+','+[int][double]$r.Y+' '+[int][double]$r.Width+'x'+[int][double]$r.Height+') '+$ln.Text) }",
    ].join("\n");
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, encoding: "utf8", maxBuffer: 1 << 24 });
    if (r.status !== 0) return null;
    let t = (r.stdout || "").trim();
    if (!t) return null;
    // the CJK recognizer inserts a space between every character — collapse them back
    return t.replace(/([぀-ヿ㐀-鿿＀-￯])\s+(?=[぀-ヿ㐀-鿿＀-￯])/g, "$1");
  } catch { return null; }
  finally { if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} } }
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
      // Token economy: UIA text tree by default; the screenshot (≈ w*h/750 tokens) is opt-in. `ocr` and `region`
      // imply a capture, but the image itself is returned only when include_screenshot is true.
      const region = a.region && typeof a.region === "object" ? a.region : null;
      const needCapture = a.include_screenshot === true || a.ocr === true || region != null;
      const wantText = a.include_text !== false;
      const st = await helper.request("get_window_state", {
        window: win(),
        include_screenshot: needCapture,
        include_text: wantText,
      });
      const out = [];
      const shot = st.screenshots && st.screenshots[0] && st.screenshots[0].url;
      // OCR: read pixels as cheap text+coords (no image tokens).
      let ocr = null;
      if (a.ocr === true && shot) ocr = ocrDataUrl(region ? cropDataUrl(shot, region) : shot);
      // The screenshot image is returned only on explicit request, with change-detection dedup.
      if (a.include_screenshot === true && shot) {
        const url = region ? cropDataUrl(shot, region) : shot;
        const key = String(a.app) + "/" + Number(a.id);
        const sig = wantText && !region ? sha(st.accessibility?.tree || st.window?.title || "") : null;
        if (!a.force && sig && lastSig.get(key) === sig && delivered.has(key)) {
          out.push(txt("(no UI change since last capture — screenshot skipped; pass force:true to re-capture)"));
        } else {
          const img = dataUrlToImage(downscaleDataUrl(url));
          if (img) { out.push(img); delivered.add(key); }
        }
        if (sig) lastSig.set(key, sig);
      }
      const lines = ["window: " + JSON.stringify(st.window)];
      const acc = st.accessibility;
      if (acc) {
        if (acc.focused_element) lines.push("focused: " + acc.focused_element);
        if (acc.selected_text) lines.push("selected_text: " + acc.selected_text);
        if (acc.document_text) lines.push("document_text: " + acc.document_text);
        if (acc.tree) lines.push("", a.prune === false ? acc.tree : pruneTree(acc.tree));
      }
      if (ocr) lines.push("", "OCR (text @(x,y w×h), window-relative):", ocr);
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
  { name: "get_window_state", description: "Inspect a window. Returns a pruned UI Automation tree (element indexes) by default — cheap. Options: include_screenshot for a (downscaled) image, region to crop it, ocr to read pixels as text+coords, prune:false for the raw tree.", inputSchema: { type: "object", properties: { ...WIN,
      include_screenshot: { type: "boolean", description: "Return a screenshot image (default false; ~width*height/750 tokens, auto-downscaled to CLAUDE_CUA_MAX_DIM long edge)." },
      include_text: { type: "boolean", description: "Return the UI Automation tree (default true)." },
      prune: { type: "boolean", description: "Trim purely structural nodes (window/pane/scrollbar...) from the tree, keeping interactable/named ones and their indices (default true). Pass false for the raw tree." },
      region: { type: "object", description: "Window-relative rect to crop the screenshot to before returning / OCR.", properties: { x: { type: "integer" }, y: { type: "integer" }, w: { type: "integer" }, h: { type: "integer" } } },
      ocr: { type: "boolean", description: "Run built-in Windows OCR on the capture and append recognized text with coordinates — reads canvas/game/Electron surfaces UIA can't see, with no image tokens (default false)." },
      force: { type: "boolean", description: "Bypass the no-change screenshot dedup and always return a fresh image (default false)." }
    }, required: ["app", "id"] } },
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
