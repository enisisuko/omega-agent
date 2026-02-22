/**
 * Mock 数据 — 用于 UI 开发阶段的演示数据
 * 真实运行时会替换为 WebSocket 推送的实时数据
 */
import type {
  SubagentNode, OrchestratorData,
  McpToolData, SkillData, TraceLogEntry,
  RunHistoryItem, ArtifactItem,
  ProviderConfig, PluginConfig,
  ConversationSession, ExecutionEdge, NodeStepRecord,
} from "../types/ui.js";

export const mockOrchestrator: OrchestratorData = {
  epicTaskName: "分析竞品并生成报告",
  progress: 63,
  totalTokens: 12840,
  totalCostUsd: 0.0384,
  activeAgents: 3,
  runId: "run_Xk9mN2pQ",
  state: "running",
};

export const mockSubagents: SubagentNode[] = [
  {
    id: "node-search",
    label: "Search Agent",
    type: "TOOL",
    pipeConnected: true,
    state: {
      status: "success",
      output: "Found 12 competitors",
      tokens: 320,
    },
  },
  {
    id: "node-analyze",
    label: "Analyze Agent",
    type: "LLM",
    pipeConnected: true,
    state: {
      status: "running",
      currentTask: "Extracting pricing patterns from Stripe, Linear, Notion...",
      progress: 48,
    },
  },
  {
    id: "node-autofix",
    label: "Data Agent",
    type: "LLM",
    pipeConnected: true,
    state: {
      status: "autofix",
      skillName: "RetryWithBackoff",
      originalError: "Rate limit exceeded (429)",
    },
  },
  {
    id: "node-writer",
    label: "Report Writer",
    type: "LLM",
    pipeConnected: true,
    state: {
      status: "idle",
    },
  },
];

export const mockMcpTools: McpToolData[] = [
  { id: "mcp-search", name: "web_search", description: "Tavily Web Search", active: true, callCount: 7 },
  { id: "mcp-browser", name: "browser_use", description: "Headless Browser Control", active: false, callCount: 0 },
  { id: "mcp-fs", name: "fs_read", description: "File System Read", active: true, callCount: 2 },
  { id: "mcp-code", name: "code_exec", description: "Python Code Executor", active: false, callCount: 0 },
];

export const mockSkills: SkillData[] = [
  { id: "skill-retry", name: "RetryWithBackoff", description: "自动指数退避重试", active: true, triggerCount: 1 },
  { id: "skill-compress", name: "ContextCompressor", description: "上下文智能压缩", active: false, triggerCount: 0 },
  { id: "skill-format", name: "OutputFormatter", description: "结构化输出格式化", active: true, triggerCount: 3 },
];

export const mockTraceLogs: TraceLogEntry[] = [
  { id: "t1", type: "SYSTEM", timestamp: "09:14:02", message: "Run started: run_Xk9mN2pQ" },
  { id: "t2", type: "AGENT_ACT", timestamp: "09:14:03", message: "Search Agent → invoking web_search", nodeId: "node-search" },
  { id: "t3", type: "MCP_CALL", timestamp: "09:14:04", message: "web_search(\"AI productivity tools 2025 pricing\")", nodeId: "node-search", details: "→ 12 results" },
  { id: "t4", type: "AGENT_ACT", timestamp: "09:14:08", message: "Search Agent completed in 4.2s", nodeId: "node-search" },
  { id: "t5", type: "AGENT_ACT", timestamp: "09:14:09", message: "Analyze Agent → processing results", nodeId: "node-analyze" },
  { id: "t6", type: "AGENT_ACT", timestamp: "09:14:10", message: "Data Agent → fetch pricing page", nodeId: "node-autofix" },
  { id: "t7", type: "MCP_CALL", timestamp: "09:14:11", message: "web_search(\"Notion pricing 2025\")", nodeId: "node-autofix", details: "→ 429 Rate Limited" },
  { id: "t8", type: "SKILL_MATCH", timestamp: "09:14:11", message: "Skill triggered: RetryWithBackoff", nodeId: "node-autofix", details: "waiting 2s before retry..." },
  { id: "t9", type: "MCP_CALL", timestamp: "09:14:13", message: "web_search retry #1 → success", nodeId: "node-autofix", details: "→ 8 results" },
  { id: "t10", type: "AGENT_ACT", timestamp: "09:14:18", message: "Analyze Agent processing 48% complete...", nodeId: "node-analyze" },
];

// ─────────────────────────────────────────────
// Artifacts 页面 Mock 数据
// ─────────────────────────────────────────────

export const mockRunHistory: RunHistoryItem[] = [
  {
    runId: "run_Xk9mN2pQ",
    graphName: "Search & Summarize",
    state: "RUNNING",
    totalTokens: 12840,
    totalCostUsd: 0.0384,
    startedAt: "2026-02-21T09:14:02Z",
  },
  {
    runId: "run_Ht3vR8wL",
    graphName: "Competitor Analysis",
    state: "COMPLETED",
    totalTokens: 28450,
    totalCostUsd: 0.0853,
    durationMs: 142300,
    startedAt: "2026-02-21T08:30:11Z",
  },
  {
    runId: "run_Qp7nK4dF",
    graphName: "Search & Summarize",
    state: "FAILED",
    totalTokens: 4210,
    totalCostUsd: 0.0126,
    durationMs: 31800,
    startedAt: "2026-02-21T07:55:44Z",
  },
  {
    runId: "run_Bm2sJ9cY",
    graphName: "Document QA",
    state: "COMPLETED",
    totalTokens: 51200,
    totalCostUsd: 0.1536,
    durationMs: 203500,
    startedAt: "2026-02-20T23:12:08Z",
  },
  {
    runId: "run_Wz6xE1oA",
    graphName: "Code Review",
    state: "CANCELLED",
    totalTokens: 1830,
    totalCostUsd: 0.0055,
    durationMs: 8200,
    startedAt: "2026-02-20T21:40:33Z",
  },
];

export const mockArtifacts: Record<string, ArtifactItem[]> = {
  "run_Ht3vR8wL": [
    {
      id: "art-1",
      runId: "run_Ht3vR8wL",
      label: "Competitor Summary",
      type: "text",
      content: `# Competitor Analysis Report

## Top 5 Competitors Identified

1. **Linear** — Project management, $8/user/month. Strong keyboard-first UX.
2. **Notion** — All-in-one workspace, $10/user/month. Flexible but complex.
3. **ClickUp** — Feature-rich PM tool, $7/user/month. Steep learning curve.
4. **Asana** — Enterprise focus, $13.49/user/month. Good integrations.
5. **Monday.com** — Visual PM, $9/user/month. Strong no-code automation.

## Key Insights
- All competitors are moving toward AI-assisted task management
- Pricing convergence around $8-13/user/month for pro tiers
- Linear's minimalism is gaining traction among developer teams`,
      createdAt: "2026-02-21T08:32:23Z",
    },
    {
      id: "art-2",
      runId: "run_Ht3vR8wL",
      label: "Pricing Data (JSON)",
      type: "json",
      content: JSON.stringify({
        competitors: [
          { name: "Linear", price_per_user: 8, tier: "Pro", billing: "monthly" },
          { name: "Notion", price_per_user: 10, tier: "Plus", billing: "monthly" },
          { name: "ClickUp", price_per_user: 7, tier: "Unlimited", billing: "monthly" },
          { name: "Asana", price_per_user: 13.49, tier: "Premium", billing: "monthly" },
          { name: "Monday.com", price_per_user: 9, tier: "Basic", billing: "monthly" },
        ],
        avg_price: 9.5,
        market_leader: "Notion",
        fastest_growing: "Linear",
      }, null, 2),
      createdAt: "2026-02-21T08:32:45Z",
    },
  ],
  "run_Bm2sJ9cY": [
    {
      id: "art-3",
      runId: "run_Bm2sJ9cY",
      label: "QA Response",
      type: "text",
      content: `Based on the provided documentation, the ICEE Agent Graph Runtime uses an event sourcing architecture where every node execution generates an immutable StepEvent. This allows full trace replay and fork capabilities without additional infrastructure.

Key features:
- Append-only event log
- Deterministic replay via providerMeta snapshot
- Fork from any step with optional input override`,
      createdAt: "2026-02-20T23:55:12Z",
    },
  ],
  "run_Qp7nK4dF": [],
  "run_Xk9mN2pQ": [],
  "run_Wz6xE1oA": [],
};

// ─────────────────────────────────────────────
// 会话历史 Mock 数据
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// Mock ExecutionEdge 数据（各 session 的完整执行图）
// ─────────────────────────────────────────────

/** 竞品分析 session 的执行边（search → analyze → report，多分支图） */
const competitorAnalysisEdges: ExecutionEdge[] = [
  { id: "ca-e1", source: "search", target: "analyze", state: "completed" },
  { id: "ca-e2", source: "search", target: "dataAgent", state: "completed" },
  { id: "ca-e3", source: "analyze", target: "writer", state: "completed" },
  { id: "ca-e4", source: "dataAgent", target: "writer", state: "completed" },
  { id: "ca-e5", source: "writer", target: "output", state: "completed" },
];

/** Notion AI 失败 session 的执行边（search 失败，后续未执行） */
const failedSearchEdges: ExecutionEdge[] = [
  { id: "fs-e1", source: "search", target: "summarize", state: "failed" },
  { id: "fs-e2", source: "summarize", target: "output", state: "pending" },
];

/** Document QA session 的执行边（memory → llm → output） */
const docQaEdges: ExecutionEdge[] = [
  { id: "dq-e1", source: "memory", target: "llm", state: "completed" },
  { id: "dq-e2", source: "llm", target: "formatter", state: "completed" },
  { id: "dq-e3", source: "formatter", target: "output", state: "completed" },
];

// ── Mock NodeStepRecords（各节点历史步骤，用于展开面板演示） ──────
const searchSteps: NodeStepRecord[] = [
  {
    id: "search-s1",
    index: 1,
    status: "success",
    startedAt: "2026-02-21T08:30:13Z",
    durationMs: 3100,
    input: '{"query": "AI productivity tools pricing 2025", "limit": 20}',
    output: "Found 12 results: Linear ($8), Notion ($10), ClickUp ($7), Asana ($13.49), Monday.com ($9)...",
    tokens: 320,
  },
];

const analyzeSteps: NodeStepRecord[] = [
  {
    id: "analyze-s1",
    index: 1,
    status: "success",
    startedAt: "2026-02-21T08:30:18Z",
    durationMs: 89400,
    prompt: "You are a competitive analysis expert. Analyze the following search results and extract key pricing patterns, strengths, and weaknesses for each competitor.\n\nSearch results:\n{{search.output}}\n\nProvide a structured analysis.",
    input: "Found 12 results: Linear ($8), Notion ($10)...",
    output: "Pricing patterns extracted:\n1. Linear: $8/user/mo — keyboard-first UX\n2. Notion: $10/user/mo — flexible but complex\n3. Convergence around $8-13/user/month for pro tiers",
    tokens: 8420,
  },
];

const dataAgentSteps: NodeStepRecord[] = [
  {
    id: "data-s1",
    index: 1,
    status: "error",
    startedAt: "2026-02-21T08:30:18Z",
    durationMs: 2200,
    prompt: "Fetch detailed pricing page for Notion AI and extract structured data.",
    input: "Target: Notion pricing page",
    errorMsg: "429 Rate Limited by web_search after 3 retries",
  },
  {
    id: "data-s2",
    index: 2,
    status: "success",
    startedAt: "2026-02-21T08:30:23Z",
    durationMs: 3800,
    prompt: "Fetch detailed pricing page for Notion AI and extract structured data. Use alternative search terms to avoid rate limiting.",
    input: "Target: Notion pricing page (retry with backoff)",
    output: '{"name":"Notion","price_per_user":10,"tier":"Plus","billing":"monthly","ai_addon":8}',
    tokens: 1580,
    isRerun: true,
  },
];

const writerSteps: NodeStepRecord[] = [
  {
    id: "writer-s1",
    index: 1,
    status: "success",
    startedAt: "2026-02-21T08:30:28Z",
    durationMs: 98700,
    prompt: "Write a comprehensive competitor analysis report based on the following data.\n\nAnalysis data:\n{{analyze.output}}\n\nPricing data:\n{{dataAgent.output}}\n\nFormat as a professional markdown report with executive summary, competitor comparison table, and strategic recommendations.",
    input: "Pricing patterns + structured data from 5 competitors",
    output: "# Competitor Analysis Report\n\n## Executive Summary\nThe AI productivity tools market is consolidating around $8-13/user/month pricing...\n\n[1,240 words total]",
    tokens: 14200,
  },
];

/** 竞品分析 session 对应的 subagent 节点（含完整步骤历史，供展开面板演示） */
const competitorSubagents: SubagentNode[] = [
  {
    id: "search",
    label: "Search Agent",
    type: "TOOL",
    pipeConnected: true,
    state: { status: "success", output: "Found 12 competitors", tokens: 320 },
    steps: searchSteps,
  },
  {
    id: "analyze",
    label: "Analyze Agent",
    type: "LLM",
    pipeConnected: true,
    state: { status: "success", output: "Pricing patterns extracted", tokens: 8420 },
    steps: analyzeSteps,
  },
  {
    id: "dataAgent",
    label: "Data Agent",
    type: "LLM",
    pipeConnected: true,
    state: { status: "success", output: "Retry succeeded after rate limit", tokens: 1580 },
    steps: dataAgentSteps,
  },
  {
    id: "writer",
    label: "Report Writer",
    type: "LLM",
    pipeConnected: true,
    state: { status: "success", output: "Report generated (1,240 words)", tokens: 14200 },
    steps: writerSteps,
  },
  {
    id: "output",
    label: "Output",
    type: "PLANNING",
    pipeConnected: true,
    state: { status: "success", output: "Report delivered" },
  },
];

/** 失败 session subagent */
const failedSubagents: SubagentNode[] = [
  {
    id: "search",
    label: "Search Agent",
    type: "TOOL",
    pipeConnected: true,
    state: { status: "error", errorMsg: "429 Rate Limited after 3 retries" },
  },
  {
    id: "summarize",
    label: "Summarize",
    type: "LLM",
    pipeConnected: false,
    state: { status: "idle" },
  },
];

/** Document QA subagent */
const docQaSubagents: SubagentNode[] = [
  {
    id: "memory",
    label: "Memory Agent",
    type: "MEMORY",
    pipeConnected: true,
    state: { status: "success", output: "Loaded 14 document chunks", tokens: 2340 },
  },
  {
    id: "llm",
    label: "QA Agent",
    type: "LLM",
    pipeConnected: true,
    state: { status: "success", output: "QA response generated", tokens: 39420 },
  },
  {
    id: "formatter",
    label: "Formatter",
    type: "REFLECTION",
    pipeConnected: true,
    state: { status: "success", output: "Markdown formatted" },
  },
  {
    id: "output",
    label: "Output",
    type: "PLANNING",
    pipeConnected: true,
    state: { status: "success", output: "Response delivered" },
  },
];

export const mockSessions: ConversationSession[] = [
  {
    id: "run_Ht3vR8wL",
    title: "分析竞品并生成报告",
    state: "completed",
    createdAt: "2026-02-21T08:30:11Z",
    orchestrator: {
      epicTaskName: "分析竞品并生成报告",
      progress: 100,
      totalTokens: 28450,
      totalCostUsd: 0.0853,
      activeAgents: 0,
      runId: "run_Ht3vR8wL",
      state: "completed",
    },
    traceLogs: [
      { id: "s2t1", type: "SYSTEM", timestamp: "08:30:11", message: "Run started: run_Ht3vR8wL" },
      { id: "s2t2", type: "AGENT_ACT", timestamp: "08:30:12", message: "Search Agent → invoking web_search", nodeId: "search" },
      { id: "s2t3", type: "MCP_CALL", timestamp: "08:30:14", message: "web_search(\"AI productivity tools pricing\")", details: "→ 12 results", nodeId: "search" },
      { id: "s2t4", type: "SKILL_MATCH", timestamp: "08:30:28", message: "ContextCompressor triggered", details: "Reduced tokens by 34%", nodeId: "analyze" },
      { id: "s2t5", type: "AGENT_ACT", timestamp: "08:31:48", message: "Report Writer completed in 98.7s", nodeId: "writer" },
      { id: "s2t6", type: "SYSTEM", timestamp: "08:32:23", message: "Run completed: run_Ht3vR8wL" },
    ],
    subagents: competitorSubagents,
    executionEdges: competitorAnalysisEdges,
    rounds: [],
    aiOutput: "竞品分析报告已完成。核心发现：Stripe 定价模式以交易抽成为主，Linear 采用席位制，Notion AI 按使用量计费。建议 ICEE 采用混合模式：基础免费 + API 调用量计费。",
  },
  {
    id: "run_Qp7nK4dF",
    title: "Search & Summarize — Notion AI",
    state: "failed",
    createdAt: "2026-02-21T07:55:44Z",
    orchestrator: {
      epicTaskName: "Search & Summarize — Notion AI",
      progress: 42,
      totalTokens: 4210,
      totalCostUsd: 0.0126,
      activeAgents: 0,
      runId: "run_Qp7nK4dF",
      state: "failed",
    },
    traceLogs: [
      { id: "s3t1", type: "SYSTEM", timestamp: "07:55:44", message: "Run started: run_Qp7nK4dF" },
      { id: "s3t2", type: "AGENT_ACT", timestamp: "07:55:45", message: "Search Agent → invoking web_search", nodeId: "search" },
      { id: "s3t3", type: "MCP_CALL", timestamp: "07:55:47", message: "web_search(\"Notion AI 2025\")", details: "→ 429 Rate Limited", nodeId: "search" },
      { id: "s3t4", type: "SKILL_MATCH", timestamp: "07:55:47", message: "RetryWithBackoff triggered", details: "Max retries reached", nodeId: "search" },
      { id: "s3t5", type: "SYSTEM", timestamp: "07:56:22", message: "Run failed: PROVIDER_ERROR after 3 retries" },
    ],
    subagents: failedSubagents,
    executionEdges: failedSearchEdges,
    rounds: [],
  },
  {
    id: "run_Bm2sJ9cY",
    title: "Document QA — ICEE Architecture",
    state: "completed",
    createdAt: "2026-02-20T23:12:08Z",
    orchestrator: {
      epicTaskName: "Document QA — ICEE Architecture",
      progress: 100,
      totalTokens: 51200,
      totalCostUsd: 0.1536,
      activeAgents: 0,
      runId: "run_Bm2sJ9cY",
      state: "completed",
    },
    traceLogs: [
      { id: "s4t1", type: "SYSTEM", timestamp: "23:12:08", message: "Run started: run_Bm2sJ9cY" },
      { id: "s4t2", type: "AGENT_ACT", timestamp: "23:12:09", message: "Memory Agent → loading document context", nodeId: "memory" },
      { id: "s4t3", type: "AGENT_ACT", timestamp: "23:12:22", message: "LLM Agent → generating QA response", nodeId: "llm" },
      { id: "s4t4", type: "SYSTEM", timestamp: "23:55:12", message: "Run completed: run_Bm2sJ9cY" },
    ],
    subagents: docQaSubagents,
    executionEdges: docQaEdges,
    rounds: [],
    aiOutput: "ICEE 架构文档问答完成。架构采用 Event Sourcing + 图模型，支持 Replay、Fork 和 Plugin 扩展。详细内容见 docs/architecture.md。",
  },
];

// ─────────────────────────────────────────────
// Settings 页面 Mock 数据
// ─────────────────────────────────────────────

export const mockProviders: ProviderConfig[] = [
  {
    id: "provider-openai",
    name: "OpenAI",
    type: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    isDefault: true,
    healthy: true,
  },
  {
    id: "provider-ollama",
    name: "Ollama (Local)",
    type: "ollama",
    baseUrl: "http://localhost:11434",
    isDefault: false,
    healthy: false,
  },
];

export const mockPlugins: PluginConfig[] = [
  {
    id: "plugin-web-search",
    displayName: "Web Search",
    type: "TOOL",
    version: "1.2.0",
    enabled: true,
    permissions: ["net.access"],
    description: "Tavily-powered web search tool for real-time information retrieval.",
  },
  {
    id: "plugin-retry-skill",
    displayName: "RetryWithBackoff",
    type: "SKILL",
    version: "1.0.1",
    enabled: true,
    permissions: [],
    description: "Automatic exponential backoff retry skill for transient errors.",
  },
  {
    id: "plugin-fs-read",
    displayName: "File System Reader",
    type: "TOOL",
    version: "1.0.0",
    enabled: true,
    permissions: ["fs.read"],
    description: "Read local files and directories for context injection.",
  },
  {
    id: "plugin-code-exec",
    displayName: "Python Executor",
    type: "TOOL",
    version: "0.9.2",
    enabled: false,
    permissions: ["process.spawn", "fs.write"],
    description: "Execute Python code snippets in a sandboxed environment.",
  },
];
