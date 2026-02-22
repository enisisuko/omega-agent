import { contextBridge, ipcRenderer } from "electron";

/**
 * ICEE Preload — contextBridge 安全接口 (v0.1.6)
 *
 * 通过 window.icee 暴露给 renderer 进程，
 * renderer 无法直接访问 Node.js / Electron API，只能通过这里的白名单方法。
 *
 * 新增（v0.1.6）:
 *   - saveProvider / deleteProvider / listProviders  — Provider CRUD
 *   - listMcpTools / setMcpAllowedDir               — MCP 配置
 *   - runGraph 新增 attachmentsJson 第三参数         — 附件传递
 */

// ── 事件监听器类型 ─────────────────────────────
type StepEventPayload = {
  type: "SYSTEM" | "AGENT_ACT" | "MCP_CALL" | "SKILL_MATCH";
  message: string;
  nodeId?: string;
  details?: string;
};

type OllamaStatusPayload = {
  healthy: boolean;
  url: string;
};

type RunCompletedPayload = {
  state: string;
  durationMs: number;
  totalTokens: number;
  totalCostUsd: number;
  output?: unknown;
};

type TokenUpdatePayload = {
  tokens: number;
  costUsd: number;
};

type ProviderConfigPayload = {
  id: string;
  name: string;
  type: "openai-compatible" | "ollama" | "lm-studio" | "custom";
  baseUrl: string;
  apiKey?: string;
  model?: string;
  isDefault: boolean;
  healthy?: boolean;
};

type McpToolPayload = {
  name: string;
  description: string;
  inputSchema?: unknown;
};

type McpStatusPayload = {
  connected: boolean;
  allowedDir: string;
  tools: McpToolPayload[];
  error?: string;
};

/** AgentLoop 单步迭代数据（对应 AgentStep 类型） */
type AgentStepPayload = {
  index: number;
  thought?: string;
  toolName?: string;
  toolInput?: unknown;
  observation?: string;
  finalAnswer?: string;
  status: "thinking" | "acting" | "observing" | "done" | "error";
  tokens: number;
};

// ── 暴露 API ───────────────────────────────────
contextBridge.exposeInMainWorld("icee", {
  // ── Graph 运行时 ─────────────────────────────

  /**
   * 运行一个 Graph（新增 attachmentsJson 第三参数）
   * @param graphJson     GraphDefinition 的 JSON 字符串
   * @param inputJson     输入数据的 JSON 字符串（如 {"query":"..."}）
   * @param attachmentsJson 附件数组的 JSON 字符串（可选）
   * @returns  { runId } 或 { error }
   */
  runGraph: (graphJson: string, inputJson: string, attachmentsJson?: string) =>
    ipcRenderer.invoke("icee:run-graph", graphJson, inputJson, attachmentsJson),

  /**
   * 运行 ReAct 动态 Agent 循环（Cline 风格，步骤数由 LLM 动态决定）
   * @param taskJson  JSON 字符串：{ task, lang?, availableTools?, attachmentsJson? }
   * @returns { runId } 或 { error }
   */
  runAgentLoop: (taskJson: string) =>
    ipcRenderer.invoke("icee:run-agent-loop", taskJson),

  /**
   * 取消正在运行的 Run
   */
  cancelRun: (runId: string) =>
    ipcRenderer.invoke("icee:cancel-run", runId),

  /**
   * Fork 一个 Run：从指定 Step 开始重新执行
   * @param parentRunId    原始 Run ID（用于查找历史步骤）
   * @param fromStepId     从哪个 Step 开始重跑（该步骤之前的步骤标记为 inherited）
   * @param graphJson      Graph 定义的 JSON 字符串
   * @param inputOverrideJson  覆盖的输入（如编辑后的 Prompt），JSON 字符串，可选
   */
  forkRun: (parentRunId: string, fromStepId: string, graphJson: string, inputOverrideJson?: string) =>
    ipcRenderer.invoke("icee:fork-run", parentRunId, fromStepId, graphJson, inputOverrideJson),

  /**
   * 列出历史 Run 记录（最近 20 条）
   */
  listRuns: () =>
    ipcRenderer.invoke("icee:list-runs"),

  // ── Provider CRUD ────────────────────────────

  /**
   * 列出所有已配置的 Provider
   */
  listProviders: () =>
    ipcRenderer.invoke("icee:list-providers"),

  /**
   * 保存（新增或更新）Provider 配置
   */
  saveProvider: (config: ProviderConfigPayload) =>
    ipcRenderer.invoke("icee:save-provider", config),

  /**
   * 删除 Provider 配置
   */
  deleteProvider: (id: string) =>
    ipcRenderer.invoke("icee:delete-provider", id),

  // ── MCP 工具管理 ──────────────────────────────

  /**
   * 获取 MCP 工具列表及连接状态
   */
  listMcpTools: () =>
    ipcRenderer.invoke("icee:list-mcp-tools"),

  /**
   * 设置 MCP 文件系统允许目录
   * 传入 "__dialog__" 时会打开系统文件夹选择器
   */
  setMcpAllowedDir: (dirOrDialog: string) =>
    ipcRenderer.invoke("icee:set-mcp-allowed-dir", dirOrDialog),

  /**
   * 重载 Provider（保存新配置后调用，让主进程重新健康检查并更新 Ollama 状态灯）
   */
  reloadProvider: () =>
    ipcRenderer.invoke("icee:reload-provider"),

  // ── 事件订阅 ──────────────────────────────────

  /**
   * 监听 Ollama 状态推送（窗口加载后首次检查结果）
   */
  onOllamaStatus: (callback: (payload: OllamaStatusPayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: OllamaStatusPayload) =>
      callback(payload);
    ipcRenderer.on("icee:ollama-status", handler);
    // 返回取消函数
    return () => ipcRenderer.off("icee:ollama-status", handler);
  },

  /**
   * 监听 StepEvent（用于 TraceLog 实时推送）
   */
  onStepEvent: (callback: (payload: StepEventPayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: StepEventPayload) =>
      callback(payload);
    ipcRenderer.on("icee:step-event", handler);
    return () => ipcRenderer.off("icee:step-event", handler);
  },

  /**
   * 监听 Run 完成事件（携带最终 token/cost/output）
   */
  onRunCompleted: (callback: (payload: RunCompletedPayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: RunCompletedPayload) =>
      callback(payload);
    ipcRenderer.on("icee:run-completed", handler);
    return () => ipcRenderer.off("icee:run-completed", handler);
  },

  /**
   * 监听 Token 用量实时更新
   */
  onTokenUpdate: (callback: (payload: TokenUpdatePayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TokenUpdatePayload) =>
      callback(payload);
    ipcRenderer.on("icee:token-update", handler);
    return () => ipcRenderer.off("icee:token-update", handler);
  },

  /**
   * 监听 AgentLoop 每步迭代结果（用于 UI 实时渲染 ReAct 步骤节点）
   */
  onAgentStep: (callback: (payload: { runId: string; step: AgentStepPayload }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { runId: string; step: AgentStepPayload }) =>
      callback(payload);
    ipcRenderer.on("icee:agent-step", handler);
    return () => ipcRenderer.off("icee:agent-step", handler);
  },
});

// ── 向 renderer 暴露的 window.icee 类型声明 ────
// （ts 类型补充在 src/renderer/types/electron.d.ts 里）
