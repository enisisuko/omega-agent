<div align="center">

# Ω Omega Agent · v2.0.0

**Run AI agents locally. No API key. No cloud. No data leaving your machine.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![Electron](https://img.shields.io/badge/Electron-35-blueviolet)](https://www.electronjs.org/)
[![Ollama](https://img.shields.io/badge/Ollama-ready-black)](https://ollama.com/)
[![MCP](https://img.shields.io/badge/MCP-supported-orange)](https://modelcontextprotocol.io/)

[中文文档](README.zh.md) · [Report Bug](https://github.com/enisisuko/ICee-agent/issues) · [Request Feature](https://github.com/enisisuko/ICee-agent/issues)

<img src="https://raw.githubusercontent.com/enisisuko/ICee-agent/main/screenshots/omega-welcome.png" alt="Omega Agent Welcome Screen" width="60%">

</div>

---

Omega is built to run on **your machine**, with **your models**. Ollama and LM Studio are first-class citizens — detected automatically on launch, no configuration needed. Everything works offline, including web search (DuckDuckGo, no key).

If you want to use a cloud provider, you can — but you never have to.

| | Other agents | Omega |
|---|:---:|:---:|
| Runs on local models (Ollama, LM Studio) | Maybe | **Yes, by default** |
| Works fully offline | Maybe | **Always** |
| Requires an API key | Required | **Never required** |
| See every step live | ✗ | ✓ |
| Edit prompt mid-run | ✗ | ✓ |
| Fork from any step | ✗ | ✓ |

---

## What it looks like

**Agent running — watch each tool call happen in real time:**

<img src="https://raw.githubusercontent.com/enisisuko/ICee-agent/main/screenshots/omega-agent-running.png" alt="Agent running" width="100%">

**Rerun from any node — edit the prompt, branch forward:**

<img src="https://raw.githubusercontent.com/enisisuko/ICee-agent/main/screenshots/omega-rerun-modal.png" alt="Rerun modal" width="100%">

**Agent finished — full output with reflection:**

<img src="https://raw.githubusercontent.com/enisisuko/ICee-agent/main/screenshots/omega-agent-done.png" alt="Agent done" width="100%">

**Provider setup — auto-detects Ollama and LM Studio:**

<table>
<tr>
<td><img src="https://raw.githubusercontent.com/enisisuko/ICee-agent/main/screenshots/omega-providers-cn.png" alt="Providers CN" width="100%"></td>
<td><img src="https://raw.githubusercontent.com/enisisuko/ICee-agent/main/screenshots/omega-providers-en.png" alt="Providers EN" width="100%"></td>
</tr>
<tr><td align="center">中文界面</td><td align="center">English UI</td></tr>
</table>

---

## Core features

### Local-first — works out of the box with Ollama

Omega launches and immediately scans for local model servers. If Ollama or LM Studio is running, it shows up automatically. Pick a model, start chatting — no account, no key, no billing.

```bash
# Install Ollama, then pull any model
ollama pull qwen2.5:7b      # recommended for Chinese tasks
ollama pull llama3.2        # fast, good general-purpose
ollama pull deepseek-r1:8b  # stronger reasoning
```

Every feature — streaming output, tool calls, multi-turn memory, context compression — works identically on local and cloud models. Switching providers is one config change.

| Provider | Type | Notes |
|----------|------|-------|
| **Ollama** | Local | Default — zero setup, full privacy |
| **LM Studio** | Local | Auto-detected, OpenAI-compatible |
| **OpenAI** | Cloud | GPT-4o, o1, etc. |
| **Groq** | Cloud | Fast inference, generous free tier |
| **Azure OpenAI** | Cloud | Enterprise |
| Any OpenAI-compatible API | Either | One URL field to configure |

### Step-level rewind & re-execution

Every node stores its exact input, output, token count, and duration. At any point you can revert a step or branch the entire workflow forward from that node — with an edited prompt if you want.

Each fork gets a new `runId` in SQLite. The full execution lineage is always preserved.

### 8 built-in tools — all work offline, no setup needed

| Tool | What it does |
|------|-------------|
| `web_search` | DuckDuckGo — no API key |
| `http_fetch` | Fetch URL, strips HTML |
| `fs_read` | Read files or list directories |
| `fs_write` | Write files, auto-creates directories |
| `code_exec` | Run JS / Python / Bash inline |
| `clipboard_read` | Read system clipboard |
| `clipboard_write` | Write to clipboard |
| `browser_open` | Open URL in default browser |

### MCP tool servers

Connect any [Model Context Protocol](https://modelcontextprotocol.io/) server. Built-in tools take priority on name conflicts.

### Rules system

- **Global rules** — stored in SQLite, injected into every session
- **Project rules** — place `.Omega/rules.md` in any directory, auto-loaded when working there

---

## Quick start

### Step 1 — Get a local model running

Install [Ollama](https://ollama.com/) and pull a model:

```bash
ollama pull qwen2.5:7b
```

That's it for the model side. Omega will find it automatically.

### Step 2 — Install Omega

Grab the latest installer from [Releases](https://github.com/enisisuko/omega-agent/releases):
- **Windows**: `Omega Agent Setup 2.0.0.exe`
- **macOS**: `omega-agent-2.0.0.dmg`

Launch Omega → it detects Ollama → select a model → start.

### Build from source

Requires [Node.js](https://nodejs.org/) ≥ 20, [pnpm](https://pnpm.io/) ≥ 9, [Ollama](https://ollama.com/)

```bash
# Terminal 1 — start Ollama
ollama serve
ollama pull qwen2.5:7b

# Terminal 2 — start Omega
git clone https://github.com/enisisuko/omega-agent.git
cd omega-agent
pnpm install
pnpm desktop
```

---

## Project structure

pnpm monorepo, powered by Turborepo:

```
ICee-agent/
├── apps/
│   └── desktop/           # Electron app
│       └── src/
│           ├── main/      # IPC, MCP client, built-in tools, SQLite
│           └── renderer/  # React UI — NerveCenter, Sidebar, Settings
├── packages/
│   ├── core/              # ReAct loop, GraphRuntime, node executors
│   ├── providers/         # LLM adapters: Ollama, OpenAI-compatible
│   ├── shared/            # Zod schemas, shared types
│   └── db/                # SQLite layer, 8 tables, auto-migration
```

## Tech stack

| Layer | Technology |
|-------|------------|
| Desktop shell | Electron 35 |
| UI | React 18 + Framer Motion + Tailwind CSS |
| Agent engine | ReAct loop · GraphRuntime (run / forkRun / cancelRun) |
| Persistence | SQLite via better-sqlite3 · auto-migration |
| Build | Vite 5 · pnpm workspaces · Turborepo |
| Packaging | electron-builder · NSIS (Windows) · DMG (macOS) |

---

## Roadmap

- [x] ReAct agent loop with token streaming
- [x] Live node visualization (NerveCenter)
- [x] Step-level revert & rerun with prompt editing
- [x] Fork execution with DB-level lineage tracking
- [x] 8 built-in tools
- [x] Ollama / local-model first
- [x] Multi-provider support
- [x] Rules system (global + per-project)
- [x] MCP tool server integration
- [x] i18n (Chinese + English)
- [x] Packaged installer — v2.0.0 (Windows + macOS)
- [ ] Visual graph editor
- [ ] Web version
- [ ] Plugin marketplace

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup and how to add a provider, node executor, or built-in tool.

---

## License

[MIT](LICENSE) © 2026 Omega Agent Contributors
