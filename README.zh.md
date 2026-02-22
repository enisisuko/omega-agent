# 🧊 ICee Agent

<div align="center">

**本地优先的可视化 AI 智能体桌面应用 — 基于 ReAct 循环引擎，实时节点图可视化。**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D9-orange)](https://pnpm.io/)
[![Electron](https://img.shields.io/badge/Electron-35-blueviolet)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-18-61dafb)](https://react.dev/)

[English](README.md) · [提交 Bug](https://github.com/enisisuko/ICee-agent/issues) · [功能建议](https://github.com/enisisuko/ICee-agent/issues)

</div>

---

![ICee Agent 运行截图](screenshots/icee-v034-fixed.png)

---

## ICee Agent 是什么？

ICee Agent 是一款**本地桌面应用**，让你使用任意大语言模型运行 AI 智能体 —— 支持 Ollama、LM Studio 或任何兼容 OpenAI 协议的服务。它将智能体的思考过程以实时节点图的方式可视化展示，让你能清楚看到 AI 每一步在做什么。

底层运行的是 **ReAct（推理 + 行动）循环**：智能体自主地「思考 → 调用工具 → 观察结果 → 决定是否继续」，最多循环 20 次，每个 token 实时流式推送到界面。

---

## ✨ 核心亮点

| 特性 | 说明 |
|------|------|
| 🧠 **ReAct 循环引擎** | 自主 Think → Act → Observe 循环，用 `<attempt_completion>` 标签自动终止 |
| 🎨 **实时节点可视化** | 每步执行渲染为动态卡片，状态实时变化（思考中 / 行动中 / 完成 / 失败） |
| 🔌 **8 个内置工具** | `web_search`、`http_fetch`、`fs_read`、`fs_write`、`code_exec`、`clipboard_read`、`clipboard_write`、`browser_open` |
| 🔀 **任意步骤分叉重跑** | 从历史任意步骤分支，编辑 Prompt 后重跑，无需从头重算 |
| 🔥 **全链路流式输出** | LLM 逐 token 流式推送，UI 打字机效果实时展示 |
| 📋 **双层 Rules 系统** | 全局规则（DB 存储）+ 项目级 `.icee/rules.md`，双层注入系统提示词 |
| 🔌 **MCP 协议支持** | 接入 Model Context Protocol 工具服务器 |
| 🌏 **中英双语** | 完整中英文 UI，自动检测系统语言 |

---

## 🚀 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) >= 20.0.0
- [pnpm](https://pnpm.io/) >= 9.0.0
- 本地 LLM：推荐 [Ollama](https://ollama.com/)，或任意兼容 OpenAI API 的服务

### 1. 安装依赖

```bash
git clone https://github.com/enisisuko/ICee-agent.git
cd ICee-agent
pnpm install
```

### 2. 启动 Ollama（首次运行推荐）

```bash
ollama serve
ollama pull qwen2.5:7b   # 中文推荐，或 llama3.2、deepseek-r1:8b 等
```

### 3. 启动桌面应用

```bash
pnpm desktop
```

应用会自动打开。进入 **Settings** 配置你的 LLM Provider。

---

## ⚙️ Provider 配置

打开 **Settings → Providers**，添加你的 LLM：

| Provider | Base URL | 说明 |
|----------|----------|------|
| Ollama | `http://localhost:11434` | 默认，无需 API Key |
| LM Studio | `http://localhost:1234/v1` | 本地推理 |
| OpenAI | `https://api.openai.com/v1` | 需要 API Key |
| Groq | `https://api.groq.com/openai/v1` | 快速云端推理 |
| Azure OpenAI | `https://<resource>.openai.azure.com/v1` | 企业版 |

---

## 🗂️ 项目结构

这是一个使用 **pnpm Workspaces + Turborepo** 的 monorepo：

```
ICee-agent/
├── apps/
│   └── desktop/                  # Electron 桌面应用
│       └── src/
│           ├── main/             # 主进程：IPC、运行时初始化、MCP
│           │   ├── index.ts      # 核心编排器（约 1464 行）
│           │   └── mcp/
│           │       └── BuiltinMcpTools.ts   # 8 个内置工具
│           ├── preload/          # 安全上下文桥
│           └── renderer/         # React UI
│               ├── App.tsx       # 根组件，会话状态管理
│               ├── components/
│               │   ├── nerve-center/     # 画布：节点、边、Trace 日志
│               │   └── layout/           # 侧边栏、导航
│               ├── hooks/        # useIceeRuntime、useDraggableCanvas
│               └── i18n/         # 中英文翻译
├── packages/
│   ├── core/                     # 智能体执行引擎
│   │   ├── runtime.ts            # GraphRuntime（run/forkRun/cancel）
│   │   ├── AgentLoopExecutor.ts  # ReAct 循环（最多 20 次迭代）
│   │   ├── executors/            # LLM / Planning / Memory / Reflection / Tool
│   │   ├── skills/               # AgentSkills（压缩/重试/格式化/搜索）
│   │   └── providers/            # OllamaProvider、OpenAICompatibleProvider
│   ├── shared/                   # Zod Schema、共享类型
│   └── db/                       # SQLite 层（better-sqlite3，8 张表）
└── demo/
    ├── ollama-chat/              # 最简 3 节点对话示例
    └── search-summarize/         # 4 节点搜索+总结流水线
```

---

## 🧩 节点类型

智能体图支持 7 种节点类型，每种都有专属执行器：

| 节点 | 类型 | 职责 |
|------|------|------|
| Input | `INPUT` | 入口，接收用户任务 |
| Planner | `PLANNING` | 将任务拆解为步骤 |
| Context | `MEMORY` | 提取关键约束和上下文 |
| Executor | `LLM` | 生成实际输出内容 |
| Reflector | `REFLECTION` | 质量审查与整合优化 |
| Tool | `TOOL` | 调用外部工具 / MCP 服务器 |
| Output | `OUTPUT` | 格式化并输出最终结果 |

---

## 🛠️ 内置工具（无需外部服务）

所有工具直接在 Electron 主进程中运行：

| 工具 | 说明 |
|------|------|
| `web_search` | DuckDuckGo 搜索，无需 API Key |
| `http_fetch` | 抓取任意 URL，自动去除 HTML 标签 |
| `fs_read` | 读取文件或列出目录内容 |
| `fs_write` | 写入文件（自动创建目录） |
| `code_exec` | 内联执行 JS / Python / Bash 代码 |
| `clipboard_read` | 读取系统剪贴板 |
| `clipboard_write` | 写入系统剪贴板 |
| `browser_open` | 用系统默认浏览器打开 URL |

---

## 🔀 分叉重跑 — 时光倒流调试

ICee 的标志性功能之一：**从任意历史步骤分支**。

1. 点击图中已完成的任意节点
2. 在重跑弹窗中编辑提示词
3. ICee 创建一个**分叉运行** —— 继承所有前置步骤，仅从分支点重新执行

这意味着你可以在工作流中间实验不同的提示词，而无需重新运行所有前置步骤。

---

## 📋 Rules 系统

ICee 支持双层规则系统，塑造智能体行为：

- **全局规则** —— 存储在本地 SQLite 数据库，应用于每个会话
- **项目规则** —— 在任意项目目录放置 `.icee/rules.md` 文件；ICee 会在该文件夹下工作时自动加载

两层规则都会在每次 Agent 运行前注入系统提示词。

---

## 🔌 MCP 集成

ICee 支持接入 [Model Context Protocol](https://modelcontextprotocol.io/) 工具服务器。通过 Settings 配置 filesystem MCP 服务器或任意自定义服务器。内置工具优先级高于 MCP 工具（名称冲突时）。

---

## 📦 技术栈

| 层 | 技术 | 版本 |
|----|------|------|
| 桌面壳 | Electron | 35 |
| UI 框架 | React | 18 |
| 动画 | Framer Motion | 11 |
| 样式 | Tailwind CSS | 3 |
| 构建工具 | Vite | 5 |
| 数据库 | SQLite (better-sqlite3) | — |
| 打包 | electron-builder | 24 |
| Monorepo | pnpm Workspaces + Turborepo | — |
| Schema 校验 | Zod | — |
| 协议 | Model Context Protocol SDK | 1.26 |

---

## 🗺️ 路线图

- [x] 带流式输出的 ReAct 智能体循环
- [x] 实时节点可视化（NerveCenter）
- [x] 8 个内置工具（无需 API Key）
- [x] 从任意步骤分叉/重跑
- [x] 多 Provider 支持（Ollama、OpenAI 兼容）
- [x] Rules 系统（全局 + 项目级）
- [x] MCP 工具服务器集成
- [x] 多轮对话
- [ ] Electron 打包安装程序（NSIS / DMG）
- [ ] 子智能体市场预设
- [ ] 插件系统（架构已就位）
- [ ] 性能基准测试套件
- [ ] Web 版本（纯渲染进程模式）

---

## 🤝 贡献

请查看 [CONTRIBUTING.md](CONTRIBUTING.md) 了解如何搭建开发环境、新增 Provider 或构建新的节点执行器。

欢迎提交 PR 和 Issue！如果你在实验本地 LLM、工具集成或 MCP，非常欢迎分享你的使用场景。

---

## 📄 许可证

[MIT](LICENSE) © 2026 ICee Agent Contributors
