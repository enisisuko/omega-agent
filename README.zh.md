<div align="center">

# Ω Omega Agent · v2.0.0

**在本地跑 AI 智能体。不需要 API Key，不需要云服务，数据不离开你的电脑。**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![Electron](https://img.shields.io/badge/Electron-35-blueviolet)](https://www.electronjs.org/)
[![Ollama](https://img.shields.io/badge/Ollama-ready-black)](https://ollama.com/)
[![MCP](https://img.shields.io/badge/MCP-supported-orange)](https://modelcontextprotocol.io/)

[English](README.md) · [提交 Bug](https://github.com/enisisuko/omega-agent/issues) · [功能请求](https://github.com/enisisuko/omega-agent/issues)

<img src="https://raw.githubusercontent.com/enisisuko/omega-agent/main/screenshots/omega-welcome.png" alt="Omega Agent 启动界面" width="60%">

</div>

---

Omega 是为本地模型而生的。启动时自动扫描 Ollama 和 LM Studio，检测到了直接用，没有账号，没有 Key，没有按量计费。所有功能离线可用，包括网页搜索（DuckDuckGo，无需 Key）。

如果你想接云端服务商，也可以——但从来不是必须的。

| | 其他智能体工具 | Omega |
|---|:---:|:---:|
| 支持本地模型（Ollama、LM Studio） | 部分 | **默认支持** |
| 完全离线运行 | 部分 | **始终可以** |
| 需要 API Key | 必须 | **从不需要** |
| 实时查看每一步 | ✗ | ✓ |
| 运行中编辑提示词 | ✗ | ✓ |
| 从任意步骤分支执行 | ✗ | ✓ |

---

## 界面预览

**Agent 运行中 — 实时看到每次工具调用：**

<img src="https://raw.githubusercontent.com/enisisuko/omega-agent/main/screenshots/omega-agent-running.png" alt="Agent 运行中" width="100%">

**从任意节点重跑 — 编辑提示词，从那里分支：**

<img src="https://raw.githubusercontent.com/enisisuko/omega-agent/main/screenshots/omega-rerun-modal.png" alt="重跑弹窗" width="100%">

**Agent 完成 — 含 Reflection 的完整输出：**

<img src="https://raw.githubusercontent.com/enisisuko/omega-agent/main/screenshots/omega-agent-done.png" alt="Agent 完成" width="100%">

**服务商配置 — 自动检测 Ollama 和 LM Studio：**

<table>
<tr>
<td><img src="https://raw.githubusercontent.com/enisisuko/omega-agent/main/screenshots/omega-providers-cn.png" alt="设置页中文" width="100%"></td>
<td><img src="https://raw.githubusercontent.com/enisisuko/omega-agent/main/screenshots/omega-providers-en.png" alt="设置页英文" width="100%"></td>
</tr>
<tr><td align="center">中文界面</td><td align="center">English UI</td></tr>
</table>

---

## 核心功能

### 本地优先 — 开箱即用，无需配置

启动后 Omega 自动扫描本地 AI 服务。Ollama 或 LM Studio 只要在运行，就会自动出现在列表里。选一个模型，开始对话，没有任何注册流程。

```bash
# 安装 Ollama 后拉取模型
ollama pull qwen2.5:7b      # 中文任务推荐
ollama pull llama3.2        # 快速通用
ollama pull deepseek-r1:8b  # 强推理能力
```

本地模型和云端模型的体验完全一致：流式输出、工具调用、多轮记忆、上下文压缩——全部支持。换服务商只改一个配置项。

| 服务商 | 类型 | 备注 |
|--------|------|------|
| **Ollama** | 本地 | 默认——零配置，完全私密 |
| **LM Studio** | 本地 | 自动检测，OpenAI 兼容 |
| **OpenAI** | 云端 | GPT-4o、o1 等 |
| **Groq** | 云端 | 快速推理，免费额度充足 |
| **Azure OpenAI** | 云端 | 企业级部署 |
| 任意 OpenAI 兼容 API | 均可 | 填写 URL 即可 |

### 步骤级回退与重新执行

每个节点都记录精确的输入、输出、Token 数和耗时。任意时刻可以回退一步，或从该节点向前分支整个工作流 — 还可以先改提示词再跑。

每次 Fork 在 SQLite 中生成新的 `runId`，完整执行链永久保存。

### 8 个内置工具 — 全部离线可用，零配置

| 工具 | 功能 |
|------|------|
| `web_search` | DuckDuckGo 搜索 — 无需 API Key |
| `http_fetch` | 抓取 URL，自动过滤 HTML |
| `fs_read` | 读取文件或列出目录 |
| `fs_write` | 写入文件，自动创建目录 |
| `code_exec` | 内联运行 JS / Python / Bash |
| `clipboard_read` | 读取系统剪贴板 |
| `clipboard_write` | 写入系统剪贴板 |
| `browser_open` | 在默认浏览器打开 URL |

### MCP 工具服务器

连接任意 [Model Context Protocol](https://modelcontextprotocol.io/) 服务器。名称冲突时内置工具优先。

### 规则系统

- **全局规则** — 存储于 SQLite，注入到每次会话的系统提示词
- **项目规则** — 在任意目录放置 `.Omega/rules.md`，工作于该目录时自动加载

---

## 快速开始

### 第一步 — 先把本地模型跑起来

安装 [Ollama](https://ollama.com/)，然后拉一个模型：

```bash
ollama pull qwen2.5:7b
```

模型侧就这一步。Omega 启动后会自动找到它。

### 第二步 — 安装 Omega

从 [Releases](https://github.com/enisisuko/omega-agent/releases) 下载最新版本：
- **Windows**：`Omega Agent Setup 2.0.0.exe`
- **macOS**：`omega-agent-2.0.0.dmg`

启动 Omega → 自动检测 Ollama → 选择模型 → 开始。

### 从源码运行

环境要求：[Node.js](https://nodejs.org/) ≥ 20、[pnpm](https://pnpm.io/) ≥ 9、[Ollama](https://ollama.com/)

```bash
# 终端 1 — 启动 Ollama
ollama serve
ollama pull qwen2.5:7b

# 终端 2 — 启动 Omega
git clone https://github.com/enisisuko/omega-agent.git
cd omega-agent
pnpm install
pnpm desktop
```

---

## 项目结构

pnpm Monorepo，由 Turborepo 驱动：

```
omega-agent/
├── apps/
│   └── desktop/           # Electron 应用
│       └── src/
│           ├── main/      # IPC、MCP 客户端、内置工具、SQLite
│           └── renderer/  # React UI — NerveCenter、侧边栏、设置
├── packages/
│   ├── core/              # ReAct 循环、GraphRuntime、节点执行器
│   ├── providers/         # LLM 适配器：Ollama、OpenAI 兼容
│   ├── shared/            # Zod Schema、共享类型
│   └── db/                # SQLite 层，8 张表，自动迁移
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面外壳 | Electron 35 |
| UI | React 18 + Framer Motion + Tailwind CSS |
| 智能体引擎 | ReAct 循环 · GraphRuntime（run / forkRun / cancelRun） |
| 持久化 | SQLite（better-sqlite3）· 自动迁移 |
| 构建 | Vite 5 · pnpm workspaces · Turborepo |
| 打包 | electron-builder · NSIS（Windows）· DMG（macOS） |

---

## 路线图

- [x] 带 Token 流式输出的 ReAct 循环
- [x] 实时节点可视化（NerveCenter）
- [x] 步骤级回退与重跑（含提示词编辑）
- [x] 基于 Fork 的执行，DB 级血统追踪
- [x] 8 个内置工具
- [x] Ollama / 本地模型优先
- [x] 多服务商支持
- [x] 规则系统（全局 + 项目级）
- [x] MCP 工具服务器集成
- [x] 多语言支持（中文 + 英文）
- [x] 打包安装程序 — v2.0.0（Windows + macOS）
- [ ] 可视化工作流图形编辑器
- [ ] Web 版本
- [ ] 插件市场

---

## 参与贡献

查看 [CONTRIBUTING.md](CONTRIBUTING.md) 了解开发环境配置，以及如何添加服务商、节点执行器或内置工具。

---

## 许可证

[MIT](LICENSE) © 2026 Omega Agent Contributors
