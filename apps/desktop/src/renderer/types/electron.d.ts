/**
 * window.icee — Electron contextBridge 暴露的 API 类型声明 (v0.1.6)
 * 与 src/preload/index.ts 保持同步
 */

interface IceeStepEventPayload {
  type: "SYSTEM" | "AGENT_ACT" | "MCP_CALL" | "SKILL_MATCH";
  message: string;
  nodeId?: string;
  details?: string;
}

interface IceeOllamaStatusPayload {
  healthy: boolean;
  url: string;
}

interface IceeRunCompletedPayload {
  state: string;
  durationMs: number;
  totalTokens: number;
  totalCostUsd: number;
  output?: unknown;
}

interface IceeTokenUpdatePayload {
  tokens: number;
  costUsd: number;
}

interface IceeRunGraphResult {
  runId?: string;
  error?: string;
}

/** Provider 配置（含 API Key，仅用于 IPC 传递） */
interface IceeProviderConfig {
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
interface IceMcpToolInfo {
  name: string;
  description: string;
  inputSchema?: unknown;
}

/** MCP 状态（包含工具列表和连接状态） */
interface IceeMcpStatusResult {
  connected: boolean;
  allowedDir: string;
  tools: IceMcpToolInfo[];
  error?: string;
}

interface IceeApi {
  // ── Graph 运行时 ─────────────────────────────

  /** 运行一个 Graph（attachmentsJson 为附件数组的 JSON 字符串） */
  runGraph(graphJson: string, inputJson: string, attachmentsJson?: string): Promise<IceeRunGraphResult>;
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
  listProviders(): Promise<IceeProviderConfig[]>;
  /** 保存（新增或更新）Provider 配置 */
  saveProvider(config: IceeProviderConfig): Promise<{ ok?: boolean; error?: string }>;
  /** 删除 Provider 配置 */
  deleteProvider(id: string): Promise<{ ok?: boolean; error?: string }>;

  // ── MCP 工具管理 ──────────────────────────────

  /** 获取 MCP 工具列表及连接状态 */
  listMcpTools(): Promise<IceeMcpStatusResult>;
  /** 设置 MCP 文件系统允许目录（"__dialog__" 打开文件夹选择器） */
  setMcpAllowedDir(dirOrDialog: string): Promise<IceeMcpStatusResult>;
  /** 重载 Provider（保存配置后触发主进程重新健康检查并推送 ollama-status 事件） */
  reloadProvider(): Promise<{ ok?: boolean; healthy?: boolean; url?: string; error?: string; message?: string }>;

  // ── 事件订阅 ──────────────────────────────────

  /** 监听 Ollama 状态（返回取消函数） */
  onOllamaStatus(callback: (payload: IceeOllamaStatusPayload) => void): () => void;
  /** 监听 StepEvent（返回取消函数） */
  onStepEvent(callback: (payload: IceeStepEventPayload) => void): () => void;
  /** 监听 Run 完成（返回取消函数） */
  onRunCompleted(callback: (payload: IceeRunCompletedPayload) => void): () => void;
  /** 监听 Token 用量更新（返回取消函数） */
  onTokenUpdate(callback: (payload: IceeTokenUpdatePayload) => void): () => void;
}

declare global {
  interface Window {
    /** ICEE Electron API（仅 Electron 环境下可用；浏览器 dev 模式下为 undefined） */
    icee?: IceeApi;
  }
}

export {};
