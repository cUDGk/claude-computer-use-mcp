<div align="center">

# claude-computer-use-mcp

### 将 Codex 的 Computer Use 引擎作为 Claude Code 的 MCP 使用

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=flat&logo=node.js&logoColor=white)](package.json)
[![MCP](https://img.shields.io/badge/MCP-stdio-7C3AED?style=flat)](index.mjs)
[![Platform](https://img.shields.io/badge/Platform-Windows-0078D6?style=flat&logo=windows&logoColor=white)](#环境要求)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat)](LICENSE)

**一个轻量包装器：直接 spawn Codex 自带的 `codex-computer-use.exe`，把 Windows 图形界面操作（截图＋UIA 树＋输入）暴露为 MCP 工具。**

🌐 [日本語](README.md) ・ [English](README_en.md) ・ **中文**

---

</div>

## 概述

`claude-computer-use-mcp` 会 spawn 随 OpenAI Codex 一起安装的 Computer Use 引擎（`codex-computer-use.exe`），并将其作为 **MCP 服务器**，供任意 MCP 客户端（例如 Claude Code）调用。

引擎本体 **不随本仓库分发**（它是 OpenAI 的专有组件）。包装器会在你的机器上找到 Codex 已安装的那份 exe 并运行它。因此 **需要本地已安装 Codex**。

你得到的是真正的引擎本身，而非克隆：

- 屏幕上的 **覆盖层**（操作中指示 / 高亮边框）
- **UI Automation 树**（带元素索引）
- 基于 **Windows.Graphics.Capture** 的截图，即使窗口被遮挡也能捕获
- 物理 **Esc 键**可中断操作

## 工作原理

```mermaid
flowchart LR
    A[MCP 客户端] -- JSON-RPC/stdio --> B[index.mjs]
    B -- spawn + 换行分隔 JSON --> C[codex-computer-use.exe]
    C -- SendInput / UIA / Graphics.Capture --> D[Windows 应用]
    C -- 截图 + UIA 树 --> B --> A
```

exe 解析顺序：

| 优先级 | 来源 | 用途 |
|---|---|---|
| 1 | 环境变量 `CLAUDE_CUA_HELPER` | 以 **完整路径**显式指定你的 Codex exe |
| 2 | `./vendor/codex-computer-use.exe` | 你自行放入的本地副本（不纳入 git） |
| 3 | `~/.codex/.../@oai/sky/bin/windows/codex-computer-use.exe` | 从本地 Codex 安装中 **自动检测**（最新版本） |

若都未找到，会返回说明如何配置的错误信息。

### 环境变量

| 变量 | 默认值 | 用途 |
|---|---|---|
| `CLAUDE_CUA_HELPER` | （未设置） | 以完整路径显式指定 Codex 的 exe |
| `CLAUDE_CUA_MAX_DIM` | `1280` | 将截图长边缩小到该像素数（节省 token）。`0` 表示禁用 |

为降低 token 消耗，`get_window_state` **默认只返回 UIA 树（文本）**。仅当传入 `include_screenshot:true` 时才截图，并自动缩小到 `CLAUDE_CUA_MAX_DIM`。截图大约消耗 `宽×高÷750` 个 token，因此请优先用 UIA 的 `element_index` 进行点击，仅在需要查看画面时才请求图像。

## 特性

| 能力 | 说明 |
|---|---|
| 真实引擎 | 运行 Codex 的真正 exe，截图 / UIA / 输入质量与上游一致 |
| 遮挡截图 | Graphics.Capture 可捕获被部分或完全遮挡的窗口 |
| 元素索引操作 | 按 UIA 元素索引进行点击 / 设值 / 二级操作 |
| Unicode 输入 | `type_text` 原样发送 Unicode（支持中日韩） |
| 剪贴板 | `clipboard_get` / `clipboard_set`（base64 往返，非 ASCII 也安全） |
| 覆盖层控制 | `end_computer_use` 关闭操作中覆盖层并释放控制 |
| 不含 exe | 不分发专有 exe，使用你本地的 Codex 副本 |

## 环境要求

- **Windows**（使用 Graphics.Capture / UI Automation / SendInput）
- **Node.js 18 及以上**
- **本地已安装的 OpenAI Codex**（其中自带 `codex-computer-use.exe`）

## 安装

```bash
git clone https://github.com/cUDGk/claude-computer-use-mcp.git
cd claude-computer-use-mcp
```

注册到 Claude Code（user 作用域示例）：

```bash
claude mcp add claude-computer-use --scope user -- node "C:/path/to/claude-computer-use-mcp/index.mjs"
```

若要显式指定 Codex exe，注册时附带环境变量：

```bash
claude mcp add claude-computer-use --scope user \
  -e CLAUDE_CUA_HELPER="C:/Users/<you>/.codex/plugins/cache/openai-bundled/computer-use/<ver>/node_modules/@oai/sky/bin/windows/codex-computer-use.exe" \
  -- node "C:/path/to/claude-computer-use-mcp/index.mjs"
```

或直接写入配置（例如 `claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "claude-computer-use": {
      "command": "node",
      "args": ["C:/path/to/claude-computer-use-mcp/index.mjs"]
    }
  }
}
```

## 使用

注册后，客户端即可调用以下工具：

| 工具 | 说明 |
|---|---|
| `list_apps` | 已安装应用及其打开的窗口 |
| `list_windows` | 可操作窗口列表 `{app,id,title}` |
| `get_window` | 按 id 重新获取窗口 |
| `launch_app` | 按应用 id 或 exe 路径启动 |
| `activate_window` | 将窗口置于前台（最小化则还原） |
| `get_window_state` | 默认返回 UIA 树（文本）；传入 `include_screenshot:true` 可获取缩小后的截图 |
| `click` | 按坐标 `(x,y)` 或元素索引点击 |
| `type_text` | 向焦点控件输入文本 |
| `press_key` | 按键 / 组合键（`Return`、`Control+a`、`KP_5` 等） |
| `scroll` | 从指定点滚动 |
| `drag` | 拖拽（窗口相对坐标） |
| `set_value` | 直接设置可编辑元素的值 |
| `perform_secondary_action` | Expand/Collapse 等二级操作 |
| `clipboard_get` / `clipboard_set` | 读写剪贴板 |
| `end_computer_use` | 关闭覆盖层并结束会话 |

典型流程：`list_windows` → `activate_window` → `get_window_state`（观察）→ `click`/`type_text`（操作）→ 完成后 `end_computer_use`。服务器会以 MCP `instructions` 字段提供 [SKILL.md](SKILL.md) 作为详细操作指引。

### 省 token 选项（get_window_state）

图形界面自动化中图像 token 占主导，因此 `get_window_state` 提供了这些手段：

| 选项 | 效果 |
|---|---|
| 默认（文本） | 仅返回 UIA 树。截图通过 `include_screenshot:true` 显式开启 |
| `prune`（默认 true） | 从树中剔除 window/pane/scrollbar 等结构节点（保留 index）。`false` 返回原始树 |
| `region:{x,y,w,h}` | 在返回／OCR 前将截图裁剪为窗口相对矩形——只读一个对话框即可大幅省 token |
| `ocr:true` | 内置 Windows OCR 将像素转为文本＋坐标。读取 UIA 无法暴露的 Canvas/游戏/Electron 界面，且不耗图像 token |
| 变化检测 | 再次请求未变化的窗口时返回「无变化」提示而非图像。`force:true` 可强制重取 |

截图时其长边会自动缩小到 `CLAUDE_CUA_MAX_DIM`（默认 1280px；1920×1080 约省 56%）。

### 浏览器限制

原版 Codex helper 会对浏览器窗口强制实施 **URL 允许策略**，而该策略在 Windows 上尚未支持，因此会拒绝操作浏览器窗口（Chrome / Edge / Firefox / Brave 等）。浏览器自动化请使用专用的浏览器 MCP（例如 Playwright）。原生应用窗口不受影响。

## 致谢与说明

本仓库 **只提供包装器**。真正执行图形界面操作的 `codex-computer-use.exe` 是随 **OpenAI Codex**（`@oai/sky`）一起分发的专有组件，**本仓库不予分发**；其使用受 OpenAI 条款约束。stdio 协议参考 `@oai/sky` 的 `helper_transport.js` 实现。

## 许可证

[MIT License](LICENSE) © 2026 cUDGk（仅包装器代码；`codex-computer-use.exe` 不在范围内）
