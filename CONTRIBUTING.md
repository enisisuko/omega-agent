# Contributing to ICee Agent

Thank you for your interest in contributing! This guide will help you get up and running quickly.

---

## Table of Contents

- [Dev Environment Setup](#dev-environment-setup)
- [Project Structure](#project-structure)
- [Running the App](#running-the-app)
- [Adding a New LLM Provider](#adding-a-new-llm-provider)
- [Adding a New Node Executor](#adding-a-new-node-executor)
- [Adding a New Built-in Tool](#adding-a-new-built-in-tool)
- [Code Style](#code-style)
- [Commit Convention](#commit-convention)
- [Opening a Pull Request](#opening-a-pull-request)

---

## Dev Environment Setup

### Requirements

| Tool | Version |
|------|---------|
| Node.js | >= 20.0.0 |
| pnpm | >= 9.0.0 |
| Ollama | latest (optional but recommended) |

### Steps

```bash
# 1. Clone the repo
git clone https://github.com/enisisuko/ICee-agent.git
cd ICee-agent

# 2. Install all dependencies (monorepo-wide)
pnpm install

# 3. Build all packages once (needed before first run)
pnpm build

# 4. Start the desktop app in dev mode
pnpm desktop
```

The app uses **Vite HMR** for the renderer — changes to React components reload instantly. Changes to the Electron main process require a manual restart.

### Recommended VS Code Extensions

- **ESLint** — `dbaeumer.vscode-eslint`
- **Tailwind CSS IntelliSense** — `bradlc.vscode-tailwindcss`
- **TypeScript** — built-in

---

## Project Structure

```
ICee-agent/
├── apps/desktop/        # Electron app (main + renderer + preload)
├── packages/
│   ├── core/            # Agent runtime — AgentLoopExecutor, GraphRuntime, executors
│   ├── shared/          # Zod schemas and TypeScript types shared across packages
│   ├── db/              # SQLite database layer (better-sqlite3)
│   └── providers/       # LLM provider adapters
└── demo/                # Standalone demos (ollama-chat, search-summarize)
```

Each package has its own `package.json` and is linked via pnpm workspace. Import them as:

```ts
import { GraphRuntime } from '@icee/core'
import { db } from '@icee/db'
```

---

## Running the App

| Command | Description |
|---------|-------------|
| `pnpm desktop` | Start the Electron desktop app (dev mode) |
| `pnpm build` | Build all packages and the desktop app |
| `pnpm test` | Run all tests (Vitest) |
| `pnpm lint` | Lint all packages |
| `pnpm clean` | Clean all build artifacts |

---

## Adding a New LLM Provider

Providers live in `packages/core/src/providers/` (adapter classes) and are registered in `apps/desktop/src/main/index.ts`.

### 1. Create the adapter

```ts
// packages/core/src/providers/MyProvider.ts
export class MyProvider implements LLMProvider {
  readonly id: string
  readonly name: string

  constructor(config: { id: string; name: string; apiKey: string; baseUrl: string }) {
    this.id = config.id
    this.name = config.name
    // ...
  }

  async *streamChat(messages: ChatMessage[], options?: StreamOptions): AsyncIterable<string> {
    // yield tokens one by one
  }
}
```

### 2. Register it in `main/index.ts`

Find the `createProviderFromDB` helper and add your provider type:

```ts
case 'MyProvider':
  return new MyProvider({ id: row.id, name: row.name, apiKey: row.api_key, baseUrl: row.base_url })
```

### 3. Add it to the Settings UI

Update `apps/desktop/src/renderer/components/pages/SettingsPage.tsx` to include the new provider type in the "Add Provider" form.

---

## Adding a New Node Executor

Node executors live in `packages/core/src/executor/builtins/`.

### 1. Create the executor

```ts
// packages/core/src/executor/builtins/MyNodeExecutor.ts
import type { NodeExecutor, ExecutorContext } from '../types'

export class MyNodeExecutor implements NodeExecutor {
  readonly type = 'MY_NODE_TYPE'

  async execute(ctx: ExecutorContext): Promise<void> {
    const input = ctx.getInput()
    // ... do work ...
    ctx.setOutput({ text: result })
  }
}
```

### 2. Register it in `main/index.ts`

```ts
runtime.registerExecutor(new MyNodeExecutor())
```

### 3. Add to the graph schema

Update `packages/shared/src/schemas.ts` to include the new node type in the `NodeType` union.

---

## Adding a New Built-in Tool

Built-in tools live in `apps/desktop/src/main/mcp/BuiltinMcpTools.ts`.

```ts
{
  name: 'my_tool',
  description: 'Does something useful',
  inputSchema: {
    type: 'object',
    properties: {
      param: { type: 'string', description: 'A parameter' }
    },
    required: ['param']
  },
  handler: async ({ param }: { param: string }) => {
    // ... implementation ...
    return { content: [{ type: 'text', text: result }] }
  }
}
```

Add the tool object to the `BUILTIN_TOOLS` array. No other registration is needed — the agent automatically sees all built-in tools.

---

## Code Style

- **TypeScript strict mode** is enabled — avoid `any`, use proper types
- **No unused imports** — ESLint will catch these
- **Comments**: only explain non-obvious intent or constraints, not what the code does
- **No console.log in production paths** — use `pino` logger for main process logs
- **React components**: function components with named exports, hooks in `hooks/` folder

---

## Commit Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(core): add streaming support for ToolNodeExecutor
fix(db): handle missing api_key column in migration
docs: update provider setup guide
refactor(renderer): extract SubagentCard into smaller components
```

Common prefixes: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

---

## Opening a Pull Request

1. Fork the repo and create a branch: `git checkout -b feat/my-feature`
2. Make your changes and add tests if relevant
3. Run `pnpm lint` and `pnpm test` — both must pass
4. Push and open a PR against the `main` branch
5. Describe what you changed and why in the PR description

We review PRs as time allows. For large changes, please open an issue first to discuss the approach.

---

## Questions?

Open an [issue](https://github.com/enisisuko/ICee-agent/issues) or start a [discussion](https://github.com/enisisuko/ICee-agent/discussions).
