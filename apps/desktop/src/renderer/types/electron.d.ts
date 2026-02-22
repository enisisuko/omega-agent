/**
 * window.omega — Electron contextBridge 暴露的 API 类型声明 (v1.1.0)
 * 与 src/preload/index.ts 保持同步
 *
 * v0.3.5 新增:
 *   - onTokenStream: LLM 流式 token 推送
 *   - getRules / saveRules: 用户全局 Rules
 *   - getProjectRules / saveProjectRules: 项目级 .omega/rules.md
 *
 * v1.1.0 新增:
 *   - onProjectContext: 监听主进程扫描工作目录后的项目上下文推送
 *   - changeWorkingDir: 弹出文件夹选择器更换工作目录
 *   - getWorkingDir: 读取当前保存的工作目录
 */

interface OmegaStepEventPayload {
  type: "SYSTEM" | "AGENT_ACT" | "MCP_CALL" | "SKILL_MATCH";
  message: string;
  nodeId?: string;
  details?: string;
}

interface OmegaOllamaStatusPayload {
  healthy: boolean;
  url: string;
}

interface OmegaRunCompletedPayload {
  state: string;
  durationMs: number;
  totalTokens: number;
  totalCostUsd: number;
  output?: unknown;
}

interface OmegaTokenUpdatePayload {
  tokens: number;
  costUsd: number;
}

interface OmegaRunGraphResult {
  runId?: string;
  error?: string;
}

/** Provider 配置（含 API Key，仅用于 IPC 传递） */
interface OmegaProviderConfig {
  id: string;
  name: string;
  type: "openai-compatible" | "ollama" | "lm-studio" | "custom";
  baseUrl: string;
  apiKey?: string;
  model?: string;
  isDefault: boolean;
  healthy?: boolean;
}

/** MCP 工具信息 */
interface OmegaMcpToolInfo {
  name: string;
  description: string;
  inputSchema?: unknown;
}

/** MCP 状态（包含工具列表和连接状态） */
interface OmegaMcpStatusResult {
  connected: boolean;
  allowedDir: string;
  tools: OmegaMcpToolInfo[];
  error?: string;
}

/** AgentLoop 单步迭代数据 */
interface OmegaAgentStepPayload {
  index: number;
  thought?: string;
  toolName?: string;
  toolInput?: unknown;
  observation?: string;
  finalAnswer?: string;
  status: "thinking" | "acting" | "observing" | "done" | "error";
  tokens: number;
}

interface OmegaApi {
  // ── Graph 运行时 ─────────────────────────────

  /** 运行一个 Graph（attachmentsJson 为附件数组的 JSON 字符串） */
  runGraph(graphJson: string, inputJson: string, attachmentsJson?: string): Promise<OmegaRunGraphResult>;

  /**
   * 运行 ReAct 动态 Agent 循环（Cline 风格，步骤数由 LLM 自主决定）
   * taskJson: { task, lang?, availableTools?, attachmentsJson? }
   */
  runAgentLoop?(taskJson: string): Promise<OmegaRunGraphResult>;

  /** 取消正在运行的 Run */
  cancelRun(runId: string): Promise<{ ok: boolean }>;
  /**
   * Fork 一个 Run：从指定 Step 开始重新执行，支持覆盖 input（Prompt 编辑）
   * 返回新的 newRunId，可用于后续跟踪
   */
  forkRun(
    parentRunId: string,
    fromStepId: string,
    graphJson: string,
    inputOverrideJson?: string,
  ): Promise<{ ok: boolean; newRunId?: string; error?: string }>;
  /** 列出历史 Run 记录 */
  listRuns(): Promise<unknown[]>;

  // ── Provider CRUD ────────────────────────────

  /** 列出所有已配置的 Provider */
  listProviders(): Promise<OmegaProviderConfig[]>;
  /** 保存（新增或更新）Provider 配置 */
  saveProvider(config: OmegaProviderConfig): Promise<{ ok?: boolean; error?: string }>;
  /** 删除 Provider 配置 */
  deleteProvider(id: string): Promise<{ ok?: boolean; error?: string }>;

  // ── MCP 工具管理 ──────────────────────────────

  /** 获取 MCP 工具列表及连接状态 */
  listMcpTools(): Promise<OmegaMcpStatusResult>;
  /** 设置 MCP 文件系统允许目录（"__dialog__" 打开文件夹选择器） */
  setMcpAllowedDir(dirOrDialog: string): Promise<OmegaMcpStatusResult>;
  /** 重载 Provider（保存配置后触发主进程重新健康检查并推送 ollama-status 事件） */
  reloadProvider(): Promise<{ ok?: boolean; healthy?: boolean; url?: string; error?: string; message?: string }>;
  /** 并行探测本地 Ollama / LM Studio，返回健康状态和已安装模型列表 */
  detectLocalAI?(): Promise<{
    ollama: { healthy: boolean; models: string[]; url: string };
    lmstudio: { healthy: boolean; models: string[]; url: string };
  }>;
  /** 按指定 type/baseUrl 获取模型列表 */
  listModels?(type: string, baseUrl: string): Promise<{ models: string[]; error?: string }>;

  // ── 事件订阅 ──────────────────────────────────

  /** 监听 Ollama 状态（返回取消函数） */
  onOllamaStatus(callback: (payload: OmegaOllamaStatusPayload) => void): () => void;
  /** 监听 StepEvent（返回取消函数） */
  onStepEvent(callback: (payload: OmegaStepEventPayload) => void): () => void;
  /** 监听 Run 完成（返回取消函数） */
  onRunCompleted(callback: (payload: OmegaRunCompletedPayload) => void): () => void;
  /** 监听 Token 用量更新（返回取消函数） */
  onTokenUpdate(callback: (payload: OmegaTokenUpdatePayload) => void): () => void;
  /** 监听 AgentLoop 迭代步骤（ReAct 每步回调，用于节点卡片实时渲染） */
  onAgentStep?(callback: (payload: { runId: string; step: OmegaAgentStepPayload }) => void): () => void;

  /** 监听 LLM 流式 token（打字机效果，每 token 一次回调） */
  onTokenStream?(callback: (payload: { token: string; runId: string }) => void): () => void;

  /** 监听新 LLM 迭代开始（每次迭代 streaming 前触发，用于清空 buffer 实现逐轮显示） */
  onStreamClear?(callback: (payload: { runId: string }) => void): () => void;

  /** 监听 Run 开始事件（携带后端真实 runId，用于 token-stream 过滤 ID 对齐） */
  onRunStarted?(callback: (payload: { runId: string }) => void): () => void;

  /**
   * 监听 AI 提问事件（ask_followup_question 工具触发）
   * UI 收到后显示提问气泡和回复输入框
   */
  onAskFollowup?(callback: (payload: { runId: string; question: string; options?: string[] }) => void): () => void;

  /**
   * 提交用户对 AI 提问的回答
   * @param runId  对应的 Run ID
   * @param answer 用户输入的回答文字
   */
  submitFollowupAnswer?(runId: string, answer: string): void;

  // ── Rules 管理 ────────────────────────────────

  /** 获取用户全局 Rules */
  getRules?(): Promise<{ userRules: string }>;
  /** 保存用户全局 Rules */
  saveRules?(userRules: string): Promise<{ ok?: boolean; error?: string }>;
  /** 获取项目级 Rules（.omega/rules.md） */
  getProjectRules?(dirPath?: string): Promise<{ content: string; path: string; error?: string }>;
  /** 保存项目级 Rules 到 .omega/rules.md */
  saveProjectRules?(dirPath: string, content: string): Promise<{ ok?: boolean; path?: string; error?: string }>;

  // ── 工作目录管理 ──────────────────────────────

  /** 监听项目上下文推送（main 进程扫描工作目录后发送） */
  onProjectContext?(callback: (ctx: OmegaProjectContext) => void): () => void;
  /** 弹出文件夹选择器更换工作目录（main 自动推送新 omega:project-context） */
  changeWorkingDir?(): Promise<{ ok?: boolean; canceled?: boolean; workingDir?: string; error?: string }>;
  /** 读取当前保存的工作目录 */
  getWorkingDir?(): Promise<{ workingDir: string | null; error?: string }>;
  /** 清除工作目录并回到欢迎/选目录页（main 推送 omega:need-workdir） */
  clearWorkingDir?(): Promise<{ ok?: boolean; error?: string }>;

  // ── 窗口控制（自定义标题栏） ──────────────────────
  winMinimize?(): Promise<void>;
  winMaximize?(): Promise<boolean>;
  winClose?(): Promise<void>;
  winIsMaximized?(): Promise<boolean>;
  onWinMaximized?(callback: (isMax: boolean) => void): () => void;

  // ── 工作目录选择页 ────────────────────────────────
  onNeedWorkdir?(callback: () => void): () => void;

  // ── 对话历史管理（跨轮次记忆）──────────────────────
  /**
   * 清除指定 session 的对话历史（New Chat 时调用）
   * @param sessionId 会话 ID
   */
  clearSessionHistory?(sessionId: string): Promise<{ ok: boolean; reason?: string }>;
}

declare global {
  interface Window {
    /** Omega Electron API（仅 Electron 环境下可用；浏览器 dev 模式下为 undefined） */
    omega?: OmegaApi;
  }

  /** 项目上下文（由主进程扫描工作目录后生成）— 全局类型，供 App/SettingsPage 使用 */
  interface OmegaProjectContext {
    workingDir: string;
    isGitRepo: boolean;
    gitRemote?: string;
    projectName?: string;
    frameworks: string[];
    hasTypeScript: boolean;
    hasPython: boolean;
    projectRules?: string;
    gitignorePatterns: string[];
  }
}

export {};
