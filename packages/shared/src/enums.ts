/**
 * ICEE 核心状态枚举
 * 所有状态机的状态定义集中于此，不允许在其他地方重新定义
 */

/** Run（一次完整的 Agent 执行任务）生命周期状态 */
export const RunState = {
  IDLE: "IDLE",
  RUNNING: "RUNNING",
  PAUSED: "PAUSED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const;
export type RunState = (typeof RunState)[keyof typeof RunState];

/** Node（图中单个执行节点）状态 */
export const NodeState = {
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  SUCCESS: "SUCCESS",
  ERROR: "ERROR",
  SKIPPED: "SKIPPED",
} as const;
export type NodeState = (typeof NodeState)[keyof typeof NodeState];

/** 节点类型 */
export const NodeType = {
  INPUT: "INPUT",
  OUTPUT: "OUTPUT",
  LLM: "LLM",
  TOOL: "TOOL",
  PLANNING: "PLANNING",
  REFLECTION: "REFLECTION",
  MEMORY: "MEMORY",
  /** ReAct 动态循环节点（Cline 风格：Thought→Action→Observation 反复迭代直到完成） */
  AGENT_LOOP: "AGENT_LOOP",
} as const;
export type NodeType = (typeof NodeType)[keyof typeof NodeType];

/** 错误分类 */
export const ErrorType = {
  PROVIDER_ERROR: "PROVIDER_ERROR",
  TOOL_ERROR: "TOOL_ERROR",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  TIMEOUT_ERROR: "TIMEOUT_ERROR",
  PERMISSION_ERROR: "PERMISSION_ERROR",
  SYSTEM_ERROR: "SYSTEM_ERROR",
} as const;
export type ErrorType = (typeof ErrorType)[keyof typeof ErrorType];

/** 插件类型 */
export const PluginType = {
  PROVIDER: "PROVIDER",
  TOOL: "TOOL",
  SKILL: "SKILL",
  SUBAGENT: "SUBAGENT",
} as const;
export type PluginType = (typeof PluginType)[keyof typeof PluginType];

/** 缓存策略 */
export const CacheStrategy = {
  NO_CACHE: "no-cache",
  READ_THROUGH: "read-through",
  FORCE_REFRESH: "force-refresh",
} as const;
export type CacheStrategy = (typeof CacheStrategy)[keyof typeof CacheStrategy];

/** Backoff 策略 */
export const BackoffStrategy = {
  FIXED: "fixed",
  EXPONENTIAL: "exponential",
} as const;
export type BackoffStrategy = (typeof BackoffStrategy)[keyof typeof BackoffStrategy];

/** Trace Log 条目类型 (用于 UI 颜色区分) */
export const TraceLogType = {
  MCP_CALL: "MCP_CALL",         // 粉色 rose-400
  SKILL_MATCH: "SKILL_MATCH",   // 琥珀色 amber-400
  AGENT_ACT: "AGENT_ACT",       // 紫色 violet-400
  SYSTEM: "SYSTEM",             // 灰色
} as const;
export type TraceLogType = (typeof TraceLogType)[keyof typeof TraceLogType];
