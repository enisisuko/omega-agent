import { contextBridge, ipcRenderer } from "electron";

/**
 * Omega Preload — contextBridge 安全接口 (v0.3.5)
 *
 * 通过 window.omega 暴露给 renderer 进程，
 * renderer 无法直接访问 Node.js / Electron API，只能通过这里的白名单方法。
 *
 * 新增（v0.3.5）:
 *   - getRules / saveRules               — 用户全局 Rules CRUD
 *   - getProjectRules / saveProjectRules — 项目级 .omega/rules.md
 *   - onTokenStream                      — LLM 流式 token 推送
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
contextBridge.exposeInMainWorld("omega", {
  // ── Graph 运行时 ─────────────────────────────

  /**
   * 运行一个 Graph（新增 attachmentsJson 第三参数）
   * @param graphJson     GraphDefinition 的 JSON 字符串
   * @param inputJson     输入数据的 JSON 字符串（如 {"query":"..."}）
   * @param attachmentsJson 附件数组的 JSON 字符串（可选）
   * @returns  { runId } 或 { error }
   */
  runGraph: (graphJson: string, inputJson: string, attachmentsJson?: string) =>
    ipcRenderer.invoke("omega:run-graph", graphJson, inputJson, attachmentsJson),

  /**
   * 运行 ReAct 动态 Agent 循环（Cline 风格，步骤数由 LLM 动态决定）
   * @param taskJson  JSON 字符串：{ task, lang?, availableTools?, attachmentsJson? }
   * @returns { runId } 或 { error }
   */
  runAgentLoop: (taskJson: string) =>
    ipcRenderer.invoke("omega:run-agent-loop", taskJson),

  /**
   * 取消正在运行的 Run
   */
  cancelRun: (runId: string) =>
    ipcRenderer.invoke("omega:cancel-run", runId),

  /**
   * Fork 一个 Run：从指定 Step 开始重新执行
   * @param parentRunId    原始 Run ID（用于查找历史步骤）
   * @param fromStepId     从哪个 Step 开始重跑（该步骤之前的步骤标记为 inherited）
   * @param graphJson      Graph 定义的 JSON 字符串
   * @param inputOverrideJson  覆盖的输入（如编辑后的 Prompt），JSON 字符串，可选
   */
  forkRun: (parentRunId: string, fromStepId: string, graphJson: string, inputOverrideJson?: string) =>
    ipcRenderer.invoke("omega:fork-run", parentRunId, fromStepId, graphJson, inputOverrideJson),

  /**
   * 列出历史 Run 记录（最近 20 条）
   */
  listRuns: () =>
    ipcRenderer.invoke("omega:list-runs"),

  // ── Provider CRUD ────────────────────────────

  /**
   * 列出所有已配置的 Provider
   */
  listProviders: () =>
    ipcRenderer.invoke("omega:list-providers"),

  /**
   * 保存（新增或更新）Provider 配置
   */
  saveProvider: (config: ProviderConfigPayload) =>
    ipcRenderer.invoke("omega:save-provider", config),

  /**
   * 删除 Provider 配置
   */
  deleteProvider: (id: string) =>
    ipcRenderer.invoke("omega:delete-provider", id),

  // ── MCP 工具管理 ──────────────────────────────

  /**
   * 获取 MCP 工具列表及连接状态
   */
  listMcpTools: () =>
    ipcRenderer.invoke("omega:list-mcp-tools"),

  /**
   * 设置 MCP 文件系统允许目录
   * 传入 "__dialog__" 时会打开系统文件夹选择器
   */
  setMcpAllowedDir: (dirOrDialog: string) =>
    ipcRenderer.invoke("omega:set-mcp-allowed-dir", dirOrDialog),

  /**
   * 重载 Provider（保存新配置后调用，让主进程重新健康检查并更新 Ollama 状态灯）
   */
  reloadProvider: () =>
    ipcRenderer.invoke("omega:reload-provider"),

  /**
   * 并行探测本地 Ollama 和 LM Studio，返回健康状态和已安装模型列表
   */
  detectLocalAI: (): Promise<{
    ollama: { healthy: boolean; models: string[]; url: string };
    lmstudio: { healthy: boolean; models: string[]; url: string };
  }> =>
    ipcRenderer.invoke("omega:detect-local-ai"),

  /**
   * 按指定 type/baseUrl 获取模型列表（用于表单中的模型下拉）
   */
  listModels: (type: string, baseUrl: string): Promise<{ models: string[]; error?: string }> =>
    ipcRenderer.invoke("omega:list-models", { type, baseUrl }),

  // ── 事件订阅 ──────────────────────────────────

  /**
   * 监听 Ollama 状态推送（窗口加载后首次检查结果）
   */
  onOllamaStatus: (callback: (payload: OllamaStatusPayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: OllamaStatusPayload) =>
      callback(payload);
    ipcRenderer.on("omega:ollama-status", handler);
    // 返回取消函数
    return () => ipcRenderer.off("omega:ollama-status", handler);
  },

  /**
   * 监听 StepEvent（用于 TraceLog 实时推送）
   */
  onStepEvent: (callback: (payload: StepEventPayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: StepEventPayload) =>
      callback(payload);
    ipcRenderer.on("omega:step-event", handler);
    return () => ipcRenderer.off("omega:step-event", handler);
  },

  /**
   * 监听 Run 完成事件（携带最终 token/cost/output）
   */
  onRunCompleted: (callback: (payload: RunCompletedPayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: RunCompletedPayload) =>
      callback(payload);
    ipcRenderer.on("omega:run-completed", handler);
    return () => ipcRenderer.off("omega:run-completed", handler);
  },

  /**
   * 监听 Token 用量实时更新
   */
  onTokenUpdate: (callback: (payload: TokenUpdatePayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TokenUpdatePayload) =>
      callback(payload);
    ipcRenderer.on("omega:token-update", handler);
    return () => ipcRenderer.off("omega:token-update", handler);
  },

  /**
   * 监听 AgentLoop 每步迭代结果（用于 UI 实时渲染 ReAct 步骤节点）
   */
  onAgentStep: (callback: (payload: { runId: string; step: AgentStepPayload }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { runId: string; step: AgentStepPayload }) =>
      callback(payload);
    ipcRenderer.on("omega:agent-step", handler);
    return () => ipcRenderer.off("omega:agent-step", handler);
  },

  /**
   * 监听 LLM 流式 token 推送（打字机效果）
   * 每收到一个 token 片段即触发回调，Run 完成后停止
   */
  onTokenStream: (callback: (payload: { token: string; runId: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { token: string; runId: string }) =>
      callback(payload);
    ipcRenderer.on("omega:token-stream", handler);
    return () => ipcRenderer.off("omega:token-stream", handler);
  },

  /**
   * 监听新 LLM 调用开始（每次迭代开始时发送，用于清空 streaming buffer 实现每轮独立显示）
   */
  onStreamClear: (callback: (payload: { runId: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { runId: string }) =>
      callback(payload);
    ipcRenderer.on("omega:stream-clear", handler);
    return () => ipcRenderer.off("omega:stream-clear", handler);
  },

  /**
   * 监听 Run 开始事件（携带后端真实 runId，用于 token 过滤 ID 同步）
   */
  onRunStarted: (callback: (payload: { runId: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { runId: string }) =>
      callback(payload);
    ipcRenderer.on("omega:run-started", handler);
    return () => ipcRenderer.off("omega:run-started", handler);
  },

  /**
   * 监听 AI 提问事件（ask_followup_question 工具触发）
   * UI 收到后显示提问气泡和回复输入框
   */
  onAskFollowup: (callback: (payload: { runId: string; question: string; options?: string[] }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { runId: string; question: string; options?: string[] }) =>
      callback(payload);
    ipcRenderer.on("omega:ask-followup", handler);
    return () => ipcRenderer.off("omega:ask-followup", handler);
  },

  /**
   * 提交用户对 AI 提问的回答（由 UI 回复输入框触发）
   * @param runId  对应的 Run ID
   * @param answer 用户的回答文字
   */
  submitFollowupAnswer: (runId: string, answer: string): void => {
    ipcRenderer.send("omega:answer-followup", { runId, answer });
  },

  // ── Rules 管理 ────────────────────────────────

  /**
   * 获取用户全局 Rules（存储于 SQLite user_settings 表）
   */
  getRules: (): Promise<{ userRules: string }> =>
    ipcRenderer.invoke("omega:get-rules"),

  /**
   * 保存用户全局 Rules
   */
  saveRules: (userRules: string): Promise<{ ok?: boolean; error?: string }> =>
    ipcRenderer.invoke("omega:save-rules", userRules),

  /**
   * 获取项目级 Rules（.omega/rules.md）
   * @param dirPath 项目目录路径，不传则默认 Documents
   */
  getProjectRules: (dirPath?: string): Promise<{ content: string; path: string; error?: string }> =>
    ipcRenderer.invoke("omega:get-project-rules", dirPath ?? ""),

  /**
   * 保存项目级 Rules 到 .omega/rules.md
   */
  saveProjectRules: (dirPath: string, content: string): Promise<{ ok?: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke("omega:save-project-rules", dirPath, content),

  // ── 工作目录管理 ──────────────────────────────

  /**
   * 监听项目上下文推送（main 进程扫描工作目录后发送）
   * 返回取消订阅函数
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onProjectContext: (callback: (ctx: any) => void) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (_event: Electron.IpcRendererEvent, ctx: any) => callback(ctx);
    ipcRenderer.on("omega:project-context", handler);
    return () => ipcRenderer.off("omega:project-context", handler);
  },

  /**
   * 弹出文件夹选择器以更换工作目录
   * main 进程处理选择并自动推送新的 omega:project-context 事件
   */
  changeWorkingDir: (): Promise<{
    ok?: boolean;
    canceled?: boolean;
    workingDir?: string;
    error?: string;
  }> =>
    ipcRenderer.invoke("omega:change-working-dir"),

  /**
   * 获取当前已保存的工作目录路径
   */
  getWorkingDir: (): Promise<{ workingDir: string | null; error?: string }> =>
    ipcRenderer.invoke("omega:get-working-dir"),

  /**
   * 清除当前工作目录并让 main 推送 omega:need-workdir，
   * 使 renderer 回到欢迎/选目录页
   */
  clearWorkingDir: (): Promise<{ ok?: boolean; error?: string }> =>
    ipcRenderer.invoke("omega:clear-working-dir"),

  // ── 窗口控制（自定义标题栏） ──────────────────────
  /** 最小化窗口 */
  winMinimize: (): Promise<void> =>
    ipcRenderer.invoke("omega:win-minimize"),
  /** 最大化 / 还原窗口，返回最大化后的状态 */
  winMaximize: (): Promise<boolean> =>
    ipcRenderer.invoke("omega:win-maximize"),
  /** 关闭窗口 */
  winClose: (): Promise<void> =>
    ipcRenderer.invoke("omega:win-close"),
  /** 查询当前是否最大化 */
  winIsMaximized: (): Promise<boolean> =>
    ipcRenderer.invoke("omega:win-is-maximized"),
  /** 监听最大化/还原事件（返回取消函数） */
  onWinMaximized: (callback: (isMax: boolean) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, isMax: boolean) => callback(isMax);
    ipcRenderer.on("omega:win-maximized", handler);
    return () => ipcRenderer.off("omega:win-maximized", handler);
  },

  // ── 工作目录选择页控制 ────────────────────────────
  /** 监听"需要选择工作目录"事件（未保存目录时 main 推送，renderer 显示欢迎页） */
  onNeedWorkdir: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("omega:need-workdir", handler);
    return () => ipcRenderer.off("omega:need-workdir", handler);
  },

  // ── 对话历史管理（跨轮次记忆）──────────────────────
  /**
   * 清除指定 session 的对话历史（用户点击 New Chat 时调用）
   * 避免旧会话记忆带入新会话
   * @param sessionId 会话 ID（对应 App.tsx 中的 session.id）
   */
  clearSessionHistory: (sessionId: string): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke("omega:clear-session-history", sessionId),
});

// ── 向 renderer 暴露的 window.omega 类型声明 ────
// （ts 类型补充在 src/renderer/types/electron.d.ts 里）
