# 🧊 ICee Agent

<div align="center">

**A local-first, visual AI agent desktop app — built on a ReAct loop runtime with real-time node visualization.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D9-orange)](https://pnpm.io/)
[![Electron](https://img.shields.io/badge/Electron-35-blueviolet)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-18-61dafb)](https://react.dev/)

[中文文档](README.zh.md) · [Report Bug](https://github.com/enisisuko/ICee-agent/issues) · [Request Feature](https://github.com/enisisuko/ICee-agent/issues)

</div>

---

![ICee Agent in action](screenshots/icee-v034-fixed.png)

---

## What is ICee Agent?

ICee Agent is a **desktop application** that lets you run AI agents locally using any LLM — Ollama, LM Studio, or any OpenAI-compatible API. It visualizes the agent's thinking process step-by-step as a live node graph, so you can see exactly what the AI is doing at every moment.

Under the hood, it runs a **ReAct (Reason + Act) loop**: the agent autonomously thinks, calls tools, observes results, and decides whether to continue or complete — up to 20 iterations, with real-time streaming to the UI.

---

## ✨ Highlights

| Feature | Details |
|---------|---------|
| 🧠 **ReAct Loop Runtime** | Autonomous Think → Act → Observe cycles, self-terminating with `<attempt_completion>` |
| 🎨 **Live Node Visualization** | Every step rendered as an animated card with status (thinking / acting / done / failed) |
| 🔌 **8 Built-in Tools** | `web_search`, `http_fetch`, `fs_read`, `fs_write`, `code_exec`, `clipboard_read`, `clipboard_write`, `browser_open` |
| 🔀 **Fork & Rerun** | Branch from any historical step — replay with edited prompts without re-running from scratch |
| 🔥 **Streaming Everywhere** | Token-level streaming from LLM → live typewriter output in UI |
| 📋 **Rules System** | Global rules (DB) + per-project `.icee/rules.md` — injected into every system prompt |
| 🔌 **MCP Support** | Model Context Protocol tool server integration |
| 🌏 **i18n** | Full Chinese / English UI, auto-detected from system locale |

---

## 🚀 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) >= 20.0.0
- [pnpm](https://pnpm.io/) >= 9.0.0
- A local LLM: [Ollama](https://ollama.com/) (recommended) or any OpenAI-compatible service

### 1. Install

```bash
git clone https://github.com/enisisuko/ICee-agent.git
cd ICee-agent
pnpm install
```

### 2. Start Ollama (recommended for first run)

```bash
ollama serve
ollama pull qwen2.5:7b   # or llama3.2, deepseek-r1:8b, etc.
```

### 3. Launch the desktop app

```bash
pnpm desktop
```

The app opens automatically. Head to **Settings** to configure your LLM provider.

---

## ⚙️ Provider Setup

Open **Settings → Providers** and add your LLM:

| Provider | Base URL | Notes |
|----------|----------|-------|
| Ollama | `http://localhost:11434` | Default, no API key needed |
| LM Studio | `http://localhost:1234/v1` | Local inference |
| OpenAI | `https://api.openai.com/v1` | Requires API key |
| Groq | `https://api.groq.com/openai/v1` | Fast cloud inference |
| Azure OpenAI | `https://<resource>.openai.azure.com/v1` | Enterprise |

---

## 🗂️ Project Structure

This is a **pnpm monorepo** powered by Turborepo:

```
ICee-agent/
├── apps/
│   └── desktop/                  # Electron desktop app
│       └── src/
│           ├── main/             # Main process: IPC, runtime init, MCP
│           │   ├── index.ts      # Core orchestrator (~1464 lines)
│           │   └── mcp/
│           │       └── BuiltinMcpTools.ts   # 8 built-in tools
│           ├── preload/          # Secure context bridge
│           └── renderer/         # React UI
│               ├── App.tsx       # Root component, session state
│               ├── components/
│               │   ├── nerve-center/     # Canvas: nodes, edges, trace
│               │   └── layout/           # Sidebar, navigation
│               ├── hooks/        # useIceeRuntime, useDraggableCanvas
│               └── i18n/         # zh/en translations
├── packages/
│   ├── core/                     # Agent execution engine
│   │   ├── runtime.ts            # GraphRuntime (run/forkRun/cancel)
│   │   ├── AgentLoopExecutor.ts  # ReAct loop (max 20 iters)
│   │   ├── executors/            # LLM / Planning / Memory / Reflection / Tool
│   │   ├── skills/               # AgentSkills (compress/retry/format/search)
│   │   └── providers/            # OllamaProvider, OpenAICompatibleProvider
│   ├── shared/                   # Zod schemas, shared types
│   └── db/                       # SQLite layer (better-sqlite3, 8 tables)
└── demo/
    ├── ollama-chat/              # Minimal 3-node chat example
    └── search-summarize/         # 4-node search + summarize pipeline
```

---

## 🧩 Agent Node Types

The agent graph supports 7 node types, each with a dedicated executor:

| Node | Type | Role |
|------|------|------|
| Input | `INPUT` | Entry point, receives user task |
| Planner | `PLANNING` | Decomposes task into steps |
| Context | `MEMORY` | Extracts key constraints and context |
| Executor | `LLM` | Generates the actual output |
| Reflector | `REFLECTION` | Quality review and integration |
| Tool | `TOOL` | Calls external tools / MCP servers |
| Output | `OUTPUT` | Formats and delivers final result |

---

## 🛠️ Built-in Tools (no external service needed)

All tools run directly in the Electron main process:

| Tool | Description |
|------|-------------|
| `web_search` | DuckDuckGo search — no API key required |
| `http_fetch` | Fetch any URL, strips HTML automatically |
| `fs_read` | Read file or list directory |
| `fs_write` | Write file (creates directories as needed) |
| `code_exec` | Execute JS / Python / Bash inline |
| `clipboard_read` | Read system clipboard |
| `clipboard_write` | Write to system clipboard |
| `browser_open` | Open URL in system default browser |

---

## 🔀 Fork Run — Time-Travel Debugging

One of ICee's signature features: **branch from any historical step**.

1. Click any completed node in the graph
2. Edit its prompt in the rerun modal
3. ICee creates a **fork run** — inheriting all previous steps, re-executing only from the branch point

This means you can experiment with different prompts mid-workflow without paying the cost of re-running everything from scratch.

---

## 📋 Rules System

ICee supports a two-layer rules system that shapes agent behavior:

- **Global Rules** — stored in the local SQLite DB, applied to every session
- **Project Rules** — place a `.icee/rules.md` file in any project directory; ICee auto-loads it when you work in that folder

Both are injected into the system prompt before each agent run.

---

## 🔌 MCP Integration

ICee connects to [Model Context Protocol](https://modelcontextprotocol.io/) tool servers. Configure a filesystem MCP server or any custom server via Settings. The built-in tools take priority over MCP tools when names conflict.

---

## 📦 Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Desktop shell | Electron | 35 |
| UI framework | React | 18 |
| Animations | Framer Motion | 11 |
| Styling | Tailwind CSS | 3 |
| Build tool | Vite | 5 |
| Database | SQLite (better-sqlite3) | — |
| Packaging | electron-builder | 24 |
| Monorepo | pnpm Workspaces + Turborepo | — |
| Schema validation | Zod | — |
| Protocol | Model Context Protocol SDK | 1.26 |

---

## 🗺️ Roadmap

- [x] ReAct agent loop with streaming
- [x] Live node visualization (NerveCenter)
- [x] 8 built-in tools (no API key)
- [x] Fork/rerun from any step
- [x] Multi-provider support (Ollama, OpenAI compatible)
- [x] Rules system (global + per-project)
- [x] MCP tool server integration
- [x] Multi-turn conversation
- [ ] Electron packaged installer (NSIS / DMG)
- [ ] Sub-agent marketplace presets
- [ ] Plugin system (architecture in place)
- [ ] Benchmark suite
- [ ] Web version (renderer-only mode)

---

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up a dev environment, add a new Provider, or build a new node executor.

PRs and issues are welcome! If you're experimenting with local LLMs, tooling, or MCP integrations, we'd love to hear about your setup.

---

## 📄 License

[MIT](LICENSE) © 2026 ICee Agent Contributors
