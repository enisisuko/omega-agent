# Changelog

All notable changes to ICee Agent will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Planned
- Plugin system (architecture already in place)
- Sub-agent marketplace presets
- Web version (browser-based)
- Multi-language UI (Chinese / English toggle)

---

## [0.3.6] — 2026-02-22

### Changed
- Redesigned bilingual README (English + Chinese) to highlight two core advantages:
  - **Step-level rewind & re-execution** with prompt editing
  - **Local-model first** architecture via Ollama
- Added three focused screenshots illustrating step detail, rerun modal, and node graph states
- Added `CONTRIBUTING.md`, issue templates, and CI workflow

---

## [0.3.5] — 2026-02-22

### Added
- `README.md` fully rewritten with accurate project information, Quick Start, tech stack, and roadmap
- `README.zh.md` — Chinese version of the README
- `CONTRIBUTING.md` — contributor guide covering dev setup, adding providers, node executors, and built-in tools
- `.github/ISSUE_TEMPLATE/bug_report.md` — structured bug report template
- `.github/ISSUE_TEMPLATE/feature_request.md` — feature request template

---

## [0.3.4] — 2026-02-22

### Added
- **Packaged installer support** via `electron-builder` (NSIS on Windows, DMG on macOS)
- **Built-in MCP Tools** (`BuiltinMcpTools.ts`):
  - `web_search` — DuckDuckGo search, no API key required
  - `http_fetch` — fetch text content from any URL
  - `browser_open` — open URLs in system default browser
  - `clipboard_read` / `clipboard_write` — clipboard access
- **Agent Skills** (`AgentSkills.ts`):
  - `ContextCompressor` — auto-compresses conversation history at 80% token threshold
  - `RetryWithBackoff` — exponential backoff retry on LLM failure (2 attempts)
  - `OutputFormatter` — normalizes code blocks and whitespace in final output
  - `WebSearchSkill` — DuckDuckGo Instant Answer API integration
- Application icon (`build-resources/icon.ico`)

### Fixed
- Dynamic `import()` calls replaced with static imports to fix bundled app startup failures

---

## [0.3.2] — 2026-02-22

### Changed
- **NerveCenter**: Switched from draggable canvas (SVG connections) to vertical scrolling list with inline `NodeConnector` arrows
- **SubagentCard**: Redesigned as full-width flat card with left-side colored accent bar (replaces narrow fixed-width card)
- Node state display now shows `taskPreview` (one-line role description) before execution begins
- `deriveDisplayNodes` function handles BFS topological ordering for the node list

### Added
- `NodeConnector` inline component: replaces SVG bezier curves with vertical line + animated dot (state-aware colors)

---

## [0.3.1] — 2026-02-21

### Fixed
- `MemoryNodeExecutor` — complete rewrite from key-value store to LLM-based executor
- `PlanningNodeExecutor` — complete rewrite from static template to LLM-based executor
- `ReflectionNodeExecutor` — complete rewrite from fixed "acceptable" to LLM-based quality reviewer
- All node types now share `sharedInvokeProvider` closure (extracted from `LLMNodeExecutor`)
- Node color display: all nodes were incorrectly showing blue (LLM type); fixed via `NODE_ID_TYPE_MAP` lookup
- Context compression warning shown in TraceLogDrawer when token count exceeds 3000

---

## [0.3.0] — 2026-02-21

### Added
- **6-node chain-of-thought agent graph**: `input → plan → decompose → execute → reflect → output`
- Bilingual prompts (Chinese/English) for all 6 node types via `translations.ts`
- Diamond layout engine: context node offset left, executor node offset right
- Node entrance animation: slides from parent node position instead of fading in from center
- Color accent bars on node cards (purple/cyan/blue/gold/rose by node type)

### Fixed
- `renderTemplate` now correctly passes string output between chained nodes

---

## [0.2.11] — 2026-02-20

### Fixed
- IPC handlers for `run-graph`, `cancel-run`, `fork-run` now registered early as placeholders, preventing "No handler registered" crash on startup
- Framer Motion `whileHover` warnings eliminated by replacing `"transparent"` with `"rgba(0,0,0,0)"`

---

## [0.2.9] — 2026-02-20

### Added
- Model selector dropdown in the task input bar — select model per-run without going to Settings

---

## [0.2.8] — 2026-02-20

### Fixed
- **SQLite path unified**: `app.setPath("userData", ...)` forces `Roaming\ICeeAgent` in both dev and production
- Auto-migration from old DB paths (`Electron\`, `@icee\desktop\`)
- `OpenAICompatibleProvider` constructor now correctly passes `id`/`name` fields
- Last surviving provider automatically set as default

---

## [0.2.7] — 2026-02-19

### Fixed
- `providers` table migration now handles "duplicate column" gracefully without swallowing real errors
- `ALTER TABLE providers ADD COLUMN api_key/model` runs in `ensureEarlyDb()` — guarantees columns exist before any INSERT

---

## [0.2.3] — 2026-02-18

### Fixed
- Provider IPC handlers (`list-providers`, `save-provider`, `delete-provider`, `reload-provider`) moved from async `initRuntime()` to `registerProviderHandlers()` — registered before renderer starts, eliminating race condition
- Hardcoded `model: "llama3.2"` removed from `graphJson` — executor now falls back to `globalProviderRef.model`
- Settings drawer z-index corrected so it renders above the canvas

---

## [0.2.2] — 2026-02-17

### Added
- **Draggable canvas**: left-click drag to pan, double-click to reset origin
- **Multi-turn conversation**: `ExecutionRound` type, rounds stacked vertically with separator labels

### Fixed
- Provider form fields now reset correctly when switching providers (`useEffect` replaces `useState` initial value)
- `providers` table schema updated with `api_key` and `model` columns; `migrateProviders()` auto-adds columns on startup

---

## [0.2.1] — 2026-02-16

### Added
- `forkRun` IPC connected (preload / main / renderer)
- Real MCP tool data integrated into tool list display
- Empty canvas onboarding message

---

## [0.2.0] — 2026-02-15

### Added
- `NodeDetailPanel` — expandable node detail view showing step history
- `RerunModal` — prompt editing dialog for rerunning from a specific node
- `SubagentCard` expandable to show per-step records

---

## [0.1.9] — 2026-02-14

### Added
- `ExecutionEdge` interface and BFS layout engine (`useLayoutEngine`)
- `DataPipe` SVG bezier animated connections between nodes
- Dynamic graph visualization as agent executes

---

## [0.1.0] — 2026-02-10

### Added
- Initial Electron + React + TypeScript monorepo setup
- ReAct agent loop (`AgentLoopExecutor`)
- `GraphRuntime` with `run`, `forkRun`, `cancelRun`
- `OllamaProvider` and `OpenAICompatibleProvider`
- SQLite persistence via `better-sqlite3`
- Basic node types: Input, Output, LLM, Planning, Memory, Reflection, Tool
- `NerveCenter` canvas with real-time node visualization
- Sidebar with session list
- Settings page for provider management
