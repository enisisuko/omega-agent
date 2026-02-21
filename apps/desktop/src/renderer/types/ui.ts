/**
 * UI 层专用类型定义
 * 与 @icee/shared 的 Schema 类型解耦，专注于 UI 渲染需求
 */

/** Subagent 卡片状态机 (discriminated union) */
export type SubagentCardState =
  | { status: "idle" }
  | { status: "running"; currentTask: string; progress?: number }
  | { status: "error"; errorMsg: string; errorCode?: string }
  | { status: "autofix"; skillName: string; originalError: string }
  | { status: "success"; output: string; tokens?: number };

/**
 * 单次节点执行步骤记录（展开面板中显示的历史条目）
 *
 * 每次节点被执行（含重跑）都会追加一条记录，
 * 用于在展开面板中显示输入/输出/耗时/状态，
 * 并支持单步撤回和重新生成。
 */
export interface NodeStepRecord {
  /** 步骤唯一 ID */
  id: string;
  /** 步骤序号（从 1 开始） */
  index: number;
  /** 该步骤的状态 */
  status: "running" | "success" | "error" | "reverted";
  /** 执行时间戳（ISO 字符串） */
  startedAt: string;
  /** 耗时（毫秒） */
  durationMs?: number;
  /**
   * 发送给 AI 的 Prompt（LLM 节点专用）
   * 可在重新生成对话框中手动修改
   */
  prompt?: string;
  /** 节点接收的输入（JSON 字符串或纯文本） */
  input?: string;
  /** 节点产生的输出（JSON 字符串或纯文本） */
  output?: string;
  /** 消耗的 token 数 */
  tokens?: number;
  /** 错误信息（status=error 时） */
  errorMsg?: string;
  /** 是否为重跑步骤（相对于上一步的重新生成） */
  isRerun?: boolean;
}

/** Subagent 节点数据 (用于 Execution Engine 层渲染) */
export interface SubagentNode {
  id: string;
  label: string;
  type: "LLM" | "TOOL" | "PLANNING" | "REFLECTION" | "MEMORY";
  state: SubagentCardState;
  /** 绑定到 Orchestrator 的连线数据 */
  pipeConnected: boolean;
  /**
   * 该节点的执行步骤历史（按时间顺序，最新在末尾）
   * 点击展开节点时显示；支持单步撤回和重新生成
   */
  steps?: NodeStepRecord[];
}

/**
 * 可视化执行图中的有向边
 *
 * 每条边对应 Graph JSON 中的一条 edge，
 * state 随 StepEvent 动态更新，驱动 DataPipe 的颜色和粒子效果
 */
export interface ExecutionEdge {
  /** 边唯一 ID（来自 graphJson.edges[i].id） */
  id: string;
  /** 源节点 id */
  source: string;
  /** 目标节点 id */
  target: string;
  /**
   * 连线当前状态：
   * - pending   : 灰暗虚线，尚未执行到
   * - active    : 蓝色粒子流动，目标节点正在运行
   * - completed : 绿色静止，已成功执行
   * - failed    : 红色，执行失败
   */
  state: "pending" | "active" | "completed" | "failed";
}

/** Orchestrator Brain 数据 */
export interface OrchestratorData {
  epicTaskName: string;
  progress: number;        // 0-100
  totalTokens: number;
  totalCostUsd: number;
  activeAgents: number;
  runId?: string;
  state: "idle" | "running" | "paused" | "completed" | "failed";
}

/** MCP Tool 数据 (Resource Substrate 层) */
export interface McpToolData {
  id: string;
  name: string;
  description: string;
  active: boolean;
  callCount: number;
}

/** Skill 数据 (Resource Substrate 层) */
export interface SkillData {
  id: string;
  name: string;
  description: string;
  active: boolean;
  triggerCount: number;
}

/** Trace Log 条目 */
export interface TraceLogEntry {
  id: string;
  type: "MCP_CALL" | "SKILL_MATCH" | "AGENT_ACT" | "SYSTEM";
  timestamp: string;
  message: string;
  nodeId?: string;
  details?: string;
}

/** 侧边栏导航项 */
export type SidebarRoute = "dashboard" | "artifacts" | "settings";

// ─────────────────────────────────────────────
// 会话历史类型
// ─────────────────────────────────────────────

/** 单个对话 Session — 每次 New Chat 或提交任务创建一个 */
export interface ConversationSession {
  /** 唯一 ID（与 Run ID 对应） */
  id: string;
  /** 会话标题（取自首条用户任务，截断为 ≤ 40 字符） */
  title: string;
  /** 会话状态 */
  state: "idle" | "running" | "completed" | "failed" | "cancelled";
  /** 创建时间（ISO 字符串） */
  createdAt: string;
  /** 该会话对应的 Orchestrator 状态快照 */
  orchestrator: OrchestratorData;
  /** 该会话对应的 Trace 日志 */
  traceLogs: TraceLogEntry[];
  /** AI 最终回复文本（Run 完成后写入） */
  aiOutput?: string;
  /** 该会话的真实节点执行状态（从 StepEvent 驱动，为空时 fallback 到 mockSubagents） */
  subagents: SubagentNode[];
  /**
   * 当前 Run 的有向执行边列表
   * - 提交任务时从 graphJson.edges 解析，初始全为 pending
   * - 每当 onStepEvent 到达时，target===nodeId 的边变为 active
   * - onRunCompleted 时所有 active 变为 completed（或 failed）
   * - 为空时 NerveCenter 显示 mockSubagents 兼容视图
   */
  executionEdges: ExecutionEdge[];
}

// ─────────────────────────────────────────────
// Artifacts 页面类型
// ─────────────────────────────────────────────

/** Run 历史列表条目 */
export interface RunHistoryItem {
  runId: string;
  graphName: string;
  state: "COMPLETED" | "FAILED" | "CANCELLED" | "RUNNING";
  totalTokens: number;
  totalCostUsd: number;
  durationMs?: number;
  startedAt: string;
  /** AI 输出文本（可作为 artifact 内容） */
  aiOutput?: string;
}

/** 工件类型 */
export type ArtifactType = "text" | "json" | "file";

/** 工件条目 */
export interface ArtifactItem {
  id: string;
  runId: string;
  label: string;
  type: ArtifactType;
  content: string;
  createdAt: string;
}

// ─────────────────────────────────────────────
// Settings 页面类型
// ─────────────────────────────────────────────

/** Settings 分组导航 */
export type SettingsSection = "providers" | "plugins" | "appearance";

/** LLM Provider 配置记录 */
export interface ProviderConfig {
  id: string;
  name: string;
  type: "openai-compatible" | "ollama" | "lm-studio" | "custom";
  baseUrl: string;
  /** API Key（openai-compatible / custom 类型使用） */
  apiKey?: string;
  /** 默认使用的模型名（如 gpt-4o / llama3.2） */
  model?: string;
  isDefault: boolean;
  /** 是否已通过健康检查 */
  healthy?: boolean;
}

/** 用户上传的附件（图片/文件），以 base64 dataUrl 形式传递 */
export interface AttachmentItem {
  /** 文件名 */
  name: string;
  /** 附件类型 */
  type: "image" | "file";
  /** base64 data URL（含 mime 头，如 data:image/png;base64,...） */
  dataUrl: string;
  /** MIME 类型，如 image/png、application/pdf */
  mimeType: string;
  /** 文件大小（字节） */
  sizeBytes: number;
}

/** 已安装插件记录 */
export interface PluginConfig {
  id: string;
  displayName: string;
  type: "PROVIDER" | "TOOL" | "SKILL" | "SUBAGENT";
  version: string;
  enabled: boolean;
  permissions: string[];
  description: string;
}
