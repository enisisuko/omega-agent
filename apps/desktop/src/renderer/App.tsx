import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Sidebar } from "./components/layout/Sidebar.js";
import { NerveCenter } from "./components/nerve-center/NerveCenter.js";
import { TraceLogDrawer } from "./components/nerve-center/TraceLogDrawer.js";
import { ArtifactsPage } from "./components/pages/ArtifactsPage.js";
import { SettingsPage } from "./components/pages/SettingsPage.js";
import { WorkdirPickerPage } from "./components/pages/WorkdirPickerPage.js";
import { CustomTitleBar } from "./components/layout/CustomTitleBar.js";
import { useOmegaRuntime } from "./hooks/useOmegaRuntime.js";
import { useLanguage } from "./i18n/LanguageContext.js";
import {
  mockSubagents,
  mockMcpTools,
  mockSkills,
  mockSessions,
  mockProviders,
} from "./data/mockData.js";
import type {
  SidebarRoute,
  OrchestratorData,
  TraceLogEntry,
  ConversationSession,
  AttachmentItem,
  RunHistoryItem,
  SubagentNode,
  ExecutionEdge,
  ExecutionRound,
  NodeStepRecord,
  McpToolData,
  ProviderConfig,
} from "./types/ui.js";

/** 生成唯一 Session / Run ID */
function genId() {
  return `run_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 节点 ID → SubagentNode 类型映射（决定卡片顶部彩色光条颜色）
 * 与 handleTaskSubmit 中 graphJson 的节点 ID 保持一致
 */
const NODE_ID_TYPE_MAP: Record<string, SubagentNode["type"]> = {
  input:     "LLM",         // INPUT 节点，无特殊彩条
  plan:      "PLANNING",    // 紫色 — 规划节点
  decompose: "MEMORY",      // 青色 — 上下文分析节点
  execute:   "LLM",         // 蓝色 — 执行节点
  reflect:   "REFLECTION",  // 金色 — 反思节点
  output:    "LLM",         // OUTPUT 节点，无特殊彩条
  chat:      "LLM",         // 向后兼容旧版 3 节点图
};

/** 节点 ID → 友好标签映射 */
const NODE_ID_LABEL_MAP: Record<string, string> = {
  input:     "User Input",
  plan:      "Planner",
  decompose: "Context",
  execute:   "Executor",
  reflect:   "Reflector",
  output:    "Response",
  chat:      "AI Response",
};


/** 创建空白 idle 会话（New Chat 时使用） */
function createBlankSession(): ConversationSession {
  return {
    id: genId(),
    title: "New conversation",
    state: "idle",
    createdAt: new Date().toISOString(),
    orchestrator: {
      epicTaskName: "Waiting for task...",
      progress: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      activeAgents: 0,
      state: "idle",
    },
    traceLogs: [],
    subagents: [],
    executionEdges: [],
    rounds: [],
  };
}

/**
 * 从 graphJson 字符串解析出 ExecutionEdge[]
 * 初始全部 state: "pending"
 */
function parseEdgesFromGraph(graphJson: string): ExecutionEdge[] {
  try {
    const graph = JSON.parse(graphJson) as {
      edges?: Array<{ id: string; source: string; target: string }>;
    };
    if (!Array.isArray(graph.edges)) return [];
    return graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      state: "pending" as const,
    }));
  } catch {
    return [];
  }
}

/**
 * App — Omega Desktop 主应用
 *
 * 会话机制：
 *   - 启动时：一个新空白会话 + mock 历史会话
 *   - New Chat：插入新空白会话并激活
 *   - 点击历史会话：切换 activeSessionId，NerveCenter / TraceLog 内容随之切换
 *   - 提交任务：更新当前会话状态（running → completed），不影响其他历史
 *
 * 路由：
 *   dashboard → NerveCenter + TraceLogDrawer
 *   artifacts → ArtifactsPage
 *   settings  → SettingsPage
 */
export function App() {
  // 读取当前语言翻译（LanguageProvider 在 main.tsx 中包裹，此处可直接调用）
  const { t } = useLanguage();

  /** 节点 ID → 任务概览说明（跟随语言切换） */
  const NODE_ID_PREVIEW_MAP = useMemo<Record<string, string>>(() => ({
    input:     t.nerveCenter.nodePreviewInput,
    plan:      t.nerveCenter.nodePreviewPlan,
    decompose: t.nerveCenter.nodePreviewDecompose,
    execute:   t.nerveCenter.nodePreviewExecute,
    reflect:   t.nerveCenter.nodePreviewReflect,
    output:    t.nerveCenter.nodePreviewOutput,
    chat:      t.nerveCenter.nodePreviewChat,
  }), [t]);

  const [activeRoute, setActiveRoute] = useState<SidebarRoute>("dashboard");

  // 所有会话列表：头部是新空白会话，其余是历史
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const [sessions, setSessions] = useState<ConversationSession[]>(() => {
    const blank = createBlankSession();
    return [blank, ...mockSessions];
  });

  // 当前激活会话 ID（初始指向第一个空白会话）
  const [activeSessionId, setActiveSessionId] = useState<string>(
    () => sessions[0]!.id
  );
  // useRef 版本：供 IPC 回调闭包读取最新值，避免闭包捕获旧 sessionId
  const activeSessionIdRef = useRef<string>(sessions[0]!.id);
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  // 从 sessions 数组派生当前会话数据，避免 state 冗余
  const currentSession =
    sessions.find((s) => s.id === activeSessionId) ?? sessions[0]!;
  const orchestrator: OrchestratorData = currentSession.orchestrator;
  const traceLogs: TraceLogEntry[] = currentSession.traceLogs;

  const isDashboard = activeRoute === "dashboard";

  // ── Run 历史列表（Artifacts 页面数据源）────────────────────────
  const [runHistory, setRunHistory] = useState<RunHistoryItem[]>([]);

  // ── 流式输出状态（打字机效果）────────────────────────────────
  const [streamingText, setStreamingText] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState(false);
  // 当前活跃的 runId（用于过滤 token-stream，防止多 run 混流）
  const activeRunIdRef = useRef<string | null>(null);

  // ── ask_followup_question 状态（AI 向用户提问）────────────────
  const [pendingFollowup, setPendingFollowup] = useState<{
    runId: string;
    question: string;
    options?: string[];
  } | null>(null);

  // ── 真实 MCP 工具数据（Electron 下从主进程拉取；浏览器 dev fallback mockMcpTools）─────
  const [mcpToolsData, setMcpToolsData] = useState<McpToolData[]>([]);

  // ── Ollama 连接状态（Sidebar 呼吸灯数据源）─────────────────────
  const [ollamaConnected, setOllamaConnected] = useState(false);

  // ── Provider 配置（提升到 App 层，防止 SettingsPage 卸载后状态丢失）────
  // 初始为空数组，Electron 下通过 IPC 拉取真实数据；浏览器 dev 模式 fallback mockProviders
  const [providers, setProviders] = useState<ProviderConfig[]>([]);

  // ── 选中的模型（输入框右侧下拉选择器的状态）────────────────────────
  // 格式为 provider 的 model 字段字符串，如 "zai-org/glm-4.7-flash"
  const [selectedModel, setSelectedModel] = useState<string | undefined>(undefined);

  // ── 项目上下文（工作目录扫描结果，由主进程推送）────────────────────
  const [projectContext, setProjectContext] = useState<OmegaProjectContext | null>(null);
  // needWorkdir: true = 显示欢迎/选目录页；false/null = 主界面
  // null 表示"还没收到主进程的消息，等待中"（避免闪屏）
  const [needWorkdir, setNeedWorkdir] = useState<boolean | null>(null);

  useEffect(() => {
    // 监听主进程推送的项目上下文（有工作目录 → 进主界面）
    const unsubCtx = window.omega?.onProjectContext?.((ctx) => {
      console.log(`[OMEGA] Project context received: dir=${ctx.workingDir} git=${ctx.isGitRepo}`);
      setProjectContext(ctx);
      setNeedWorkdir(false); // 有了工作目录，进主界面
    });
    // 监听主进程推送的"需要选择工作目录"（无工作目录 → 欢迎页）
    const unsubNeed = window.omega?.onNeedWorkdir?.(() => {
      console.log("[OMEGA] Need workdir, showing picker page");
      setNeedWorkdir(true);
    });
    return () => {
      unsubCtx?.();
      unsubNeed?.();
    };
  }, []);

  // ── IPC 桥接（Electron 环境下激活，浏览器 dev 静默跳过）────────
  const { isElectron, runGraph, cancelRun } = useOmegaRuntime({
    // 实时追加 TraceLog + 更新 subagents 状态 + 更新 executionEdges 到当前会话
    onStepEvent: useCallback((entry: TraceLogEntry) => {
      // 使用 ref 读取最新 sessionId，避免闭包捕获旧值（session 切换时仍能正确写入）
      const sid = activeSessionIdRef.current;
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sid) return s;

          // ── 更新 subagents 节点状态 ──────────────────────────
          let updatedSubagents = s.subagents;
          if (entry.nodeId) {
            const nodeId = entry.nodeId;
            const existingIdx = updatedSubagents.findIndex((n) => n.id === nodeId);

            // 判断步骤启停
            const isStart = entry.message.includes("start") || entry.type === "AGENT_ACT";
            const isError = entry.message.toLowerCase().includes("error") || entry.message.toLowerCase().includes("failed");

            // 查表获取节点类型（颜色标识）、友好标签、任务概览
            const nodeType = NODE_ID_TYPE_MAP[nodeId] ?? "LLM";
            const nodeLabel = NODE_ID_LABEL_MAP[nodeId]
              ?? (nodeId.charAt(0).toUpperCase() + nodeId.slice(1));
            const nodePreview = NODE_ID_PREVIEW_MAP[nodeId];

            // 保留已有的 taskPreview（节点第一次出现时写入，后续更新时不覆盖）
            const existingNode = updatedSubagents.find((n) => n.id === nodeId);
            const taskPreview = existingNode?.taskPreview ?? nodePreview;

            const newNode: SubagentNode = {
              id: nodeId,
              label: nodeLabel,
              type: nodeType,
              pipeConnected: true,
              ...(taskPreview !== undefined && { taskPreview }),
              state: isError
                ? { status: "error", errorMsg: entry.message }
                : isStart
                ? { status: "running", currentTask: entry.message }
                : { status: "success", output: entry.message },
            };

            if (existingIdx >= 0) {
              updatedSubagents = updatedSubagents.map((n) => n.id === nodeId ? newNode : n);
            } else {
              updatedSubagents = [...updatedSubagents, newNode];
            }
          }

          // ── 更新 executionEdges 状态 ──────────────────────────
          // 当 nodeId 对应的节点开始执行时，将以该节点为 target 的边激活 (active)
          // 当该节点执行完成时（非 AGENT_ACT start），将以该节点为 source 的边也激活
          let updatedEdges = s.executionEdges;
          if (entry.nodeId && updatedEdges.length > 0) {
            const nodeId = entry.nodeId;
            const isError = entry.message.toLowerCase().includes("error") || entry.message.toLowerCase().includes("failed");
            const isCompletion = !entry.message.includes("start") && entry.type !== "AGENT_ACT";

            updatedEdges = updatedEdges.map((edge) => {
              // 入边：该节点开始运行 → 入边变为 active
              if (edge.target === nodeId && edge.state === "pending") {
                return { ...edge, state: isError ? "failed" as const : "active" as const };
              }
              // 出边：该节点完成 → 出边准备激活（下一个节点还未运行时先置 pending 保持，
              //        等下一个节点的 stepEvent 到来后再激活）
              // 注意：此处不提前修改出边，让 target 节点的 stepEvent 来驱动
              return edge;
            });

            // 若该节点的事件是完成类型，将其入边置为 completed
            if (isCompletion) {
              updatedEdges = updatedEdges.map((edge) => {
                if (edge.target === nodeId && (edge.state === "active" || edge.state === "pending")) {
                  return { ...edge, state: isError ? "failed" as const : "completed" as const };
                }
                return edge;
              });
            }
          }

          // ── 同步更新最新轮（rounds 最后一项）──────────────────
          const updatedRounds = (s.rounds ?? []).map((r, i) => {
            if (i !== (s.rounds?.length ?? 1) - 1) return r; // 只更新最新轮
            return {
              ...r,
              subagents: updatedSubagents,
              executionEdges: updatedEdges,
            };
          });

          return {
            ...s,
            traceLogs: [...s.traceLogs, entry],
            subagents: updatedSubagents,
            executionEdges: updatedEdges,
            rounds: updatedRounds,
          };
        })
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),  // 使用 activeSessionIdRef 读取，无需依赖 activeSessionId

    // Run 完成时更新 orchestrator 状态 + 写入 aiOutput + 推入 runHistory + 最终化 executionEdges
    onRunCompleted: useCallback((payload) => {
      const aiText = typeof payload.output === "string"
        ? payload.output
        : payload.output != null
          ? JSON.stringify(payload.output, null, 2)
          : undefined;

      const isFailed = payload.state !== "COMPLETED";

      // 使用 ref 读取最新 sessionId
      const sid = activeSessionIdRef.current;
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sid) return s;

          // 将完成的 run 推入历史列表（使用条件展开处理可选字段）
          const historyItem: RunHistoryItem = {
            runId: s.orchestrator.runId ?? s.id,
            graphName: s.orchestrator.epicTaskName,
            state: payload.state === "COMPLETED" ? "COMPLETED" : "FAILED",
            totalTokens: payload.totalTokens,
            totalCostUsd: payload.totalCostUsd,
            ...((payload as { durationMs?: number }).durationMs !== undefined && {
              durationMs: (payload as { durationMs?: number }).durationMs!,
            }),
            startedAt: s.createdAt,
            ...(aiText !== undefined && { aiOutput: aiText }),
          };
          setRunHistory((h) => [historyItem, ...h]);

          // 最终化 executionEdges：active 边变为 completed 或 failed
          const finalEdges: ExecutionEdge[] = s.executionEdges.map((edge) => {
            if (edge.state === "active") {
              return { ...edge, state: isFailed ? "failed" as const : "completed" as const };
            }
            return edge;
          });

          // ── 将所有仍在 running 的 subagent 节点置为终态 ────────
          const finalSubagents = s.subagents.map((n) =>
            n.state.status === "running"
              ? {
                  ...n,
                  state: isFailed
                    ? { status: "error" as const, errorMsg: "Run ended" }
                    : { status: "success" as const, output: "Completed" },
                }
              : n
          );

          // ── 同步更新最新轮状态和 AI 回复 ──────────────────────
          const completedRounds = (s.rounds ?? []).map((r, i) => {
            if (i !== (s.rounds?.length ?? 1) - 1) return r;
            return {
              ...r,
              executionEdges: finalEdges,
              state: (isFailed ? "failed" : "completed") as "completed" | "failed",
              ...(aiText !== undefined && { aiOutput: aiText }),
              // 同步轮内的 subagents 状态
              subagents: (r.subagents ?? s.subagents).map((n) =>
                n.state.status === "running"
                  ? {
                      ...n,
                      state: isFailed
                        ? { status: "error" as const, errorMsg: "Run ended" }
                        : { status: "success" as const, output: "Completed" },
                    }
                  : n
              ),
            };
          });

          return {
            ...s,
            state: (payload.state.toLowerCase() as ConversationSession["state"]),
            orchestrator: {
              ...s.orchestrator,
              state: payload.state === "COMPLETED" ? "completed" : "failed",
              progress: 100,
              totalTokens: payload.totalTokens,
              totalCostUsd: payload.totalCostUsd,
              activeAgents: 0,
            },
            // 将 running 节点置为终态
            subagents: finalSubagents,
            // 写入 AI 回复（向下兼容）
            ...(aiText !== undefined && { aiOutput: aiText }),
            // 更新最终边状态（向下兼容）
            executionEdges: finalEdges,
            // 更新多轮数据
            rounds: completedRounds,
          };
        })
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),  // 使用 activeSessionIdRef 读取，无需依赖 activeSessionId

    // Token 实时更新（进度条用）+ 上下文压缩预警
    // 当单次 Run 累计 token 超过 TOKEN_WARN_THRESHOLD 时，
    // 自动在 TraceLog 中追加系统警告，提示用户上下文即将压缩
    onTokenUpdate: useCallback((tokens: number, costUsd: number) => {
      const TOKEN_WARN_THRESHOLD = 3000; // token 预警阈值（可按需调整）
      const sid = activeSessionIdRef.current;
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sid) return s;
          const prevTokens = s.orchestrator.totalTokens ?? 0;
          // 仅在本次更新跨越阈值时追加一次警告（避免每次更新都追加）
          const crossedThreshold =
            prevTokens < TOKEN_WARN_THRESHOLD && tokens >= TOKEN_WARN_THRESHOLD;
          const warnEntry: TraceLogEntry | null = crossedThreshold
            ? {
                id: `ctx-warn-${Date.now()}`,
                type: "SYSTEM" as const,
                timestamp: new Date().toLocaleTimeString("en-GB", { hour12: false }),
                message: `⚠️ Context approaching limit (${tokens} tokens). Long context may be compressed automatically to maintain performance.`,
              }
            : null;
          return {
            ...s,
            orchestrator: {
              ...s.orchestrator,
              totalTokens: tokens,
              totalCostUsd: costUsd,
            },
            traceLogs: warnEntry ? [...s.traceLogs, warnEntry] : s.traceLogs,
          };
        })
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),  // 使用 activeSessionIdRef 读取，无需依赖 activeSessionId

    // Ollama 状态 → 存入 state，Sidebar 读取显示呼吸灯
    onOllamaStatus: useCallback((healthy: boolean, url: string) => {
      console.log(`[OMEGA] Ollama ${healthy ? "✅" : "❌"} @ ${url}`);
      setOllamaConnected(healthy);
    }, []),

    /**
     * AgentLoop 每步迭代回调（ReAct 模式）
     * 把每次 LLM 迭代步骤转换为 SubagentNode，实时更新当前轮次的 subagents
     *
     * 映射规则：
     *   thinking → type=LLM, status=running, taskPreview=thought
     *   acting   → type=TOOL, status=running, taskPreview=toolName
     *   observing → type=MEMORY, status=running, taskPreview=observation摘要
     *   done     → type=LLM, status=success, output=finalAnswer
     *   error    → type=LLM, status=error
     */
    onAgentStep: useCallback((event: import("./hooks/useOmegaRuntime.js").AgentStepEvent) => {
      const { step } = event;
      // 每个 step.index 对应唯一一个节点卡片，随 thinking→acting→observing→done 流转
      const nodeId = `agent_step_${step.index}`;

      console.log(`[OMEGA AgentStep] step=${step.index} status=${step.status} tool=${step.toolName ?? "-"}`);

      const sid = activeSessionIdRef.current;
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sid) return s;

          const rounds = s.rounds ?? [];
          if (rounds.length === 0) return s;

          const lastRoundIdx = rounds.length - 1;
          const lastRound = rounds[lastRoundIdx]!;

          // 找到已有节点（同 index 的不同 status 阶段都共用同一节点）
          const existingNode = lastRound.subagents.find(n => n.id === nodeId);

          // ── 生成有意义的节点标签 ──────────────────────────────
          // 思考节点：显示思考内容摘要（取前 50 字）
          // 工具节点：显示工具名 + 观察结果摘要
          // 完成节点：显示最终答案摘要
          let nodeLabel = existingNode?.label ?? `Step ${step.index}`;
          let nodeType: SubagentNode["type"] = existingNode?.type ?? "LLM";

          if (step.status === "thinking") {
            // 思考时：显示思考内容摘要作为标签
            const thoughtSnip = step.thought?.replace(/\n/g, " ").trim().slice(0, 50);
            nodeLabel = thoughtSnip ? `💭 ${thoughtSnip}` : `思考 #${step.index}`;
            nodeType = "LLM";
          } else if (step.status === "acting") {
            // 工具调用时：显示工具名
            nodeLabel = `⚙ ${step.toolName ?? "Tool"}`;
            nodeType = "TOOL";
          } else if (step.status === "observing") {
            // 观察时：保留 acting 时的标签，更新类型
            nodeLabel = existingNode?.label ?? `⚙ ${step.toolName ?? "Tool"}`;
            nodeType = "MEMORY";
          } else if (step.status === "done") {
            // 完成：显示答案摘要
            const ansSnip = step.finalAnswer?.replace(/\n/g, " ").trim().slice(0, 50);
            nodeLabel = ansSnip ? `✓ ${ansSnip}` : `完成 #${step.index}`;
            nodeType = "REFLECTION";
          } else if (step.status === "error") {
            nodeLabel = existingNode?.label ?? `错误 #${step.index}`;
            nodeType = "LLM";
          }

          // ── 生成节点状态 ──────────────────────────────────────
          const nodeState: SubagentNode["state"] =
            step.status === "done"
              ? { status: "success", output: step.finalAnswer ?? "Done", tokens: step.tokens }
              : step.status === "error"
              ? { status: "error", errorMsg: step.thought ?? "Error" }
              : {
                  status: "running",
                  currentTask: step.status === "acting"
                    ? `${t.nerveCenter.nodeStepRunningTool}${step.toolName}`
                    : step.status === "observing"
                    ? `${t.nerveCenter.nodeStepObserveResult}${(step.observation ?? "").slice(0, 60)}`
                    : step.thought?.slice(0, 80) ?? t.nerveCenter.nodeStepThinkingIdle,
                };

          // ── taskPreview（节点副标题，只在首次出现时写入） ──────
          let taskPreview = existingNode?.taskPreview;
          if (!taskPreview) {
            if (step.status === "thinking") taskPreview = step.thought?.slice(0, 120);
            else if (step.status === "acting") taskPreview = `${t.nerveCenter.callingTool}${step.toolName}`;
            else if (step.status === "observing") taskPreview = t.nerveCenter.continueAnalyze;
            else if (step.status === "done") taskPreview = t.nerveCenter.taskCompleted;
          }

          // ── 累积 steps 记录（使展开功能可用）─────────────────
          // 每个新 status 阶段都追加一条 NodeStepRecord，
          // 这样 hasSteps=true，canExpand 就能成立
          const prevSteps: NodeStepRecord[] = existingNode?.steps ?? [];
          const stepRecordId = `${nodeId}_${step.status}_${Date.now()}`;
          const newStepRecord: NodeStepRecord = {
            id: stepRecordId,
            index: prevSteps.length + 1,
            status: step.status === "done" ? "success"
              : step.status === "error" ? "error"
              : "running",
            startedAt: new Date().toISOString(),
            ...(step.thought && { prompt: step.thought }),
            ...(step.observation && { input: step.observation }),
            ...(step.finalAnswer && { output: step.finalAnswer }),
            ...(step.tokens && { tokens: step.tokens }),
            ...(step.toolName && { input: `Tool: ${step.toolName}` }),
          };
          const updatedSteps = [...prevSteps, newStepRecord];

          // ── 组装新节点 ────────────────────────────────────────
          const newNode: SubagentNode = {
            id: nodeId,
            label: nodeLabel,
            type: nodeType,
            pipeConnected: true,
            ...(taskPreview !== undefined && { taskPreview }),
            steps: updatedSteps,
            state: nodeState,
          };

          // 替换或新增节点
          const existingIdx = lastRound.subagents.findIndex(n => n.id === nodeId);
          const updatedSubagents = existingIdx >= 0
            ? lastRound.subagents.map((n, i) => i === existingIdx ? newNode : n)
            : [...lastRound.subagents, newNode];

          const updatedRound = { ...lastRound, subagents: updatedSubagents };
          const updatedRounds = [...rounds.slice(0, lastRoundIdx), updatedRound];

          return {
            ...s,
            rounds: updatedRounds,
            subagents: updatedSubagents,
          };
        })
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),  // 使用 activeSessionIdRef 读取，无需依赖 activeSessionId
  });

  // ── 流式 token 监听（打字机效果）──────────────────────────────
  // 每次 Run 开始时清空 streamingText，逐 token 追加；Run 完成后停止
  // 使用 activeRunIdRef 过滤 token，防止多 run 并发时 token 混流
  useEffect(() => {
    if (!isElectron || !window.omega?.onTokenStream) return;

    const unsub = window.omega.onTokenStream(({ token, runId }) => {
      // 只接受当前活跃 run 的 token（过滤残留或并发 token）
      if (runId && activeRunIdRef.current && runId !== activeRunIdRef.current) return;
      setIsStreaming(true);
      setStreamingText(prev => prev + token);
    });
    return unsub;
  }, [isElectron]);

  // ── Run 开始时同步真实 runId（解决 token 过滤 ID 不匹配问题）──────
  // main process 在 agent loop 开始时立即发送 omega:run-started 携带后端真实 runId
  // 前端用这个真实 runId 替换 tempRunId，使后续的 token-stream 过滤正确匹配
  useEffect(() => {
    if (!isElectron || !window.omega?.onRunStarted) return;

    const unsub = window.omega.onRunStarted(({ runId }) => {
      // 将后端真实 runId 同步到 ref，确保 token 过滤不会因为 ID 不同而丢弃所有 token
      activeRunIdRef.current = runId;
    });
    return unsub;
  }, [isElectron]);

  // ── 每次新迭代开始时清空 streaming buffer ──────────────────────
  // main process 在每次 LLM 调用前发送 omega:stream-clear
  // 确保每轮 streaming 独立显示，不累积多轮历史文本
  useEffect(() => {
    if (!isElectron || !window.omega?.onStreamClear) return;

    const unsub = window.omega.onStreamClear(({ runId }) => {
      // 只处理当前活跃 run 的信号（此时 activeRunIdRef 已是真实 runId）
      if (runId && activeRunIdRef.current && runId !== activeRunIdRef.current) return;
      setStreamingText("");   // 清空旧迭代文本，准备接收新迭代 token
      setIsStreaming(false);  // 短暂重置，等第一个 token 到来时再置 true
    });
    return unsub;
  }, [isElectron]);

  // Run 完成时停止 streaming 状态（onRunCompleted 已处理 aiOutput，streaming 状态重置）
  useEffect(() => {
    if (currentSession.state === "completed" || currentSession.state === "failed" || currentSession.state === "cancelled") {
      setIsStreaming(false);
      setStreamingText(""); // 清空 streaming buffer（最终内容已在 session.aiOutput）
      activeRunIdRef.current = null;
      setPendingFollowup(null); // 清空悬挂的提问（run 结束后提问无意义）
    }
  }, [currentSession.state]);

  // ── 监听 AI 提问事件（ask_followup_question）─────────────────
  useEffect(() => {
    if (!isElectron || !window.omega?.onAskFollowup) return;
    const unsub = window.omega.onAskFollowup((payload) => {
      setPendingFollowup(payload); // 显示提问气泡
    });
    return unsub;
  }, [isElectron]);

  // 启动时通过 IPC 拉取历史 Run 记录
  useEffect(() => {
    if (!isElectron || !window.omega) return;
    window.omega.listRuns().then((rows) => {
      if (!Array.isArray(rows)) return;
      const mapped: RunHistoryItem[] = rows.map((r: unknown) => {
        const row = r as Record<string, unknown>;
        const durationMsRaw = row["duration_ms"] ?? row["durationMs"];
        return {
          runId: String(row["id"] ?? row["runId"] ?? ""),
          graphName: String(row["graph_name"] ?? row["graphName"] ?? ""),
          state: (row["state"] as RunHistoryItem["state"]) ?? "COMPLETED",
          totalTokens: Number(row["total_tokens"] ?? row["totalTokens"] ?? 0),
          totalCostUsd: Number(row["total_cost_usd"] ?? row["totalCostUsd"] ?? 0),
          ...(durationMsRaw != null && { durationMs: Number(durationMsRaw) }),
          startedAt: String(row["started_at"] ?? row["startedAt"] ?? new Date().toISOString()),
        };
      });
      setRunHistory(mapped);
    }).catch((e) => {
      console.warn("[OMEGA] listRuns failed:", e);
    });
  }, [isElectron]);

  // 启动时通过 IPC 拉取真实 MCP 工具列表（仅 Electron 环境）
  useEffect(() => {
    if (!isElectron || !window.omega) return;
    window.omega.listMcpTools().then((result) => {
      // 将 IceMcpToolInfo[] 映射为 McpToolData[]
      const mapped: McpToolData[] = (result.tools ?? []).map((tool: { name: string; description?: string; inputSchema?: unknown }) => ({
        id: tool.name,
        name: tool.name,
        description: tool.description ?? "",
        status: result.connected ? ("available" as const) : ("offline" as const),
        type: "mcp" as const,
        active: result.connected,
        callCount: 0,
      }));
      setMcpToolsData(mapped);
      console.log(`[OMEGA] Loaded ${mapped.length} MCP tools (connected=${result.connected})`);
    }).catch((e: unknown) => {
      console.warn("[OMEGA] listMcpTools failed:", e);
    });
  }, [isElectron]);

  // 启动时通过 IPC 拉取 Provider 配置（仅 Electron 环境）
  // 注意：放在 App 层而非 SettingsPage，防止路由切换时状态丢失
  useEffect(() => {
    if (isElectron && window.omega?.listProviders) {
      window.omega.listProviders()
        .then((list) => {
          // 无论 list 是否为空都设置（不 fallback mock，让用户看到真实状态）
          setProviders(list ?? []);
          console.log(`[OMEGA] Loaded ${(list ?? []).length} providers from DB`);
        })
        .catch((e: unknown) => {
          console.warn("[OMEGA] listProviders failed:", e);
          setProviders(mockProviders); // 失败时 fallback mock
        });
    } else {
      // 浏览器 dev 模式 fallback
      setProviders(mockProviders);
    }
  }, [isElectron]);

  /** 保存 Provider（乐观更新 state，再持久化到 DB + 通知主进程热重载）*/
  const handleSaveProvider = useCallback((config: ProviderConfig) => {
    // 1. 乐观更新本地 state（新增或更新）
    setProviders((prev) => {
      const exists = prev.find((p) => p.id === config.id);
      return exists
        ? prev.map((p) => (p.id === config.id ? config : p))
        : [...prev, config];
    });
    // 2. 写入 DB 并热重载 provider
    if (!window.omega) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    window.omega.saveProvider(config as any)
      .then((result: { error?: string } | null) => {
        if (result?.error) {
          console.error("[OMEGA] saveProvider error:", result.error);
          // 将保存失败错误写入当前 session 的 trace log，让用户在 UI 看到
          setSessions((prev) =>
            prev.map((s) =>
              s.id !== activeSessionId ? s : {
                ...s,
                traceLogs: [
                  ...s.traceLogs,
                  {
                    id: `save-err-${Date.now()}`,
                    type: "SYSTEM" as const,
                    timestamp: new Date().toLocaleTimeString("en-GB", { hour12: false }),
                    message: `⚠️ Provider save failed: ${result.error}`,
                  },
                ],
              }
            )
          );
          return;
        }
        console.log("[OMEGA] Provider saved, reloading...");
        return window.omega?.reloadProvider();
      })
      .catch((e: unknown) => console.error("[OMEGA] saveProvider failed:", e));
  }, []);

  /** 删除 Provider（乐观更新 state，再从 DB 删除）*/
  const handleDeleteProvider = useCallback((id: string) => {
    setProviders((prev) => prev.filter((p) => p.id !== id));
    window.omega?.deleteProvider(id).catch((e: unknown) =>
      console.error("[OMEGA] deleteProvider failed:", e)
    );
  }, []);

  /** 新建空白会话，插到列表头部并激活 */
  const handleNewChat = useCallback(() => {
    const blank = createBlankSession();
    // 通知主进程清除当前会话的对话历史（避免旧记忆带入新会话）
    if (isElectron && activeSessionId) {
      window.omega?.clearSessionHistory?.(activeSessionId).catch(() => {
        // 忽略清除失败（主进程可能尚未就绪）
      });
    }
    setSessions((prev) => [blank, ...prev]);
    setActiveSessionId(blank.id);
  }, [activeSessionId]);

  /** 退出当前工作目录 → 清除数据库记录 → 回到欢迎页 */
  const handleExitWorkdir = useCallback(async () => {
    try {
      await window.omega?.clearWorkingDir?.();
      // main 会推送 omega:need-workdir，useEffect 会把 needWorkdir 置 true
      // 但 main 已经推了，以防万一本地也设一下
      setNeedWorkdir(true);
    } catch (e) {
      console.error("[OMEGA] clearWorkingDir failed:", e);
      setNeedWorkdir(true);
    }
  }, []);

  /** 点击历史会话切换 */
  const handleSelectSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
  }, []);

  /**
   * 用户提交新任务（含附件列表和可选模型覆盖）
   *
   * v0.3.3 改造：改为调用 runAgentLoop（ReAct 动态循环）
   * - 不再传送固定的 6 节点 graphJson
   * - 步骤数由 LLM 自主决定（Cline 风格），每步都实时更新 UI
   * - 每次迭代步骤通过 onAgentStep IPC 推送到 UI，映射为 SubagentNode
   */
  const handleTaskSubmit = useCallback(
    async (task: string, attachments: AttachmentItem[] = [], _modelOverride?: string) => {
      const sid = activeSessionId;
      const timestamp = new Date().toLocaleTimeString("en-GB", { hour12: false });
      const titleBase = task.trim() || (attachments.length > 0 ? `[${attachments.length} attachment(s)]` : "New task");
      const shortTitle = titleBase.length > 40 ? titleBase.slice(0, 40) + "…" : titleBase;
      const tempRunId = genId();

      // 新任务开始前：清空流式文本，注册活跃 runId
      // 防止新任务的 token 接在旧任务残留文本后面
      setStreamingText("");
      setIsStreaming(false);
      activeRunIdRef.current = tempRunId;

      // AgentLoop 不需要 graphJson，只需要空 edges 占位
      const initialEdges: ExecutionEdge[] = [];

      // 构造新一轮 ExecutionRound（无 edges / nodes，动态填充）
      const newRound: ExecutionRound = {
        roundIndex: 0,
        task,
        // 保存附件供 UserBubble 显示（图片/文件）
        ...(attachments.length > 0 && { attachments }),
        submittedAt: new Date().toISOString(),
        executionEdges: initialEdges,
        subagents: [],
        state: "running" as const,
      };

      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sid) return s;
          const roundIndex = (s.rounds?.length ?? 0) + 1;
          const round = { ...newRound, roundIndex };
          return {
            ...s,
            title: shortTitle,
            state: "running" as const,
            orchestrator: {
              epicTaskName: task,
              progress: 2,
              totalTokens: 0,
              totalCostUsd: 0,
              activeAgents: 1,
              runId: tempRunId,
              state: "running" as const,
            },
            traceLogs: [
              ...s.traceLogs,
              {
                id: `sys-${Date.now()}`,
                type: "SYSTEM" as const,
                timestamp,
                message: `Task submitted: "${shortTitle}"`,
              },
            ],
            rounds: [...(s.rounds ?? []), round],
            executionEdges: initialEdges,
            subagents: [],
          };
        })
      );

      // ── Electron 环境：调用 runAgentLoop IPC ──────────────
      if (isElectron) {
        const lang = t === t ? (navigator.language.startsWith("zh") ? "zh" : "en") : "zh";
        const attachmentsJson = attachments.length > 0 ? JSON.stringify(attachments) : undefined;
        const taskJson = JSON.stringify({
          task,
          lang,
          // 关键：传入 sessionId，让主进程能跨轮次保存和加载对话历史（Cline 风格记忆）
          // sid 是当前激活会话的 ID，同一会话内多次发消息都使用同一个 sid
          sessionId: sid,
          ...(attachmentsJson && { attachmentsJson }),
          // 注入项目上下文（工作目录信息、框架、rules 等），供 Agent 系统提示使用
          ...(projectContext && { projectContext }),
        });

        // 使用 runAgentLoop（若已有则使用，否则降级 runGraph）
        const runFn = window.omega?.runAgentLoop
          ? (j: string) => window.omega!.runAgentLoop!(j)
          : async () => ({ error: "runAgentLoop not available" });

        const result = await runFn(taskJson);

        if (result?.error) {
          // 运行失败，切换为 failed 状态
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== sid) return s;
              return {
                ...s,
                state: "failed" as const,
                orchestrator: { ...s.orchestrator, state: "failed" as const, activeAgents: 0 },
                traceLogs: [
                  ...s.traceLogs,
                  {
                    id: `err-${Date.now()}`,
                    type: "SYSTEM" as const,
                    timestamp: new Date().toLocaleTimeString("en-GB", { hour12: false }),
                    message: `❌ Run failed: ${result.error}`,
                  },
                ],
              };
            })
          );
        }
        // 成功时 progress 由 IPC 事件驱动，不在这里更新
        return;
      }

      // ── 浏览器 dev 环境：走 mock 模拟（含逐步节点生长）─────────
      const runId = tempRunId;

      // Mock 执行步骤序列：模拟 input → chat → output 的逐步激活
      // 每个步骤间隔 1.2s，让可视化动态生长清晰可见
      const mockSteps: Array<{
        delay: number;
        nodeId: string;
        edgeIds: string[];       // 此步骤激活的边
        completeEdgeIds?: string[]; // 此步骤完成的边
        message: string;
        type: TraceLogEntry["type"];
      }> = [
        {
          delay: 800,
          nodeId: "input",
          edgeIds: [],            // input 是起点，无入边
          message: "Input node: processing user query",
          type: "AGENT_ACT",
        },
        {
          delay: 1800,
          nodeId: "chat",
          edgeIds: ["e1"],        // e1: input → chat 激活
          completeEdgeIds: [],
          message: "LLM node: generating response...",
          type: "AGENT_ACT",
        },
        {
          delay: 3200,
          nodeId: "output",
          edgeIds: ["e2"],        // e2: chat → output 激活
          completeEdgeIds: ["e1"], // e1 完成
          message: "Output node: response ready",
          type: "AGENT_ACT",
        },
      ];

      // 逐步模拟步骤事件（更新 edges + subagents + traceLogs）
      mockSteps.forEach(({ delay, nodeId, edgeIds, completeEdgeIds, message, type }) => {
        setTimeout(() => {
          const stepTime = new Date().toLocaleTimeString("en-GB", { hour12: false });
          setSessions((prev) =>
            prev.map((s) => {
              if (s.id !== sid) return s;

              // 更新边状态
              const updatedEdges = s.executionEdges.map((edge) => {
                if (edgeIds.includes(edge.id)) return { ...edge, state: "active" as const };
                if (completeEdgeIds?.includes(edge.id)) return { ...edge, state: "completed" as const };
                return edge;
              });

              // 更新或添加 subagent 节点（同时追加 step 记录）
              const existingIdx = s.subagents.findIndex((n) => n.id === nodeId);
              const existingNode = existingIdx >= 0 ? s.subagents[existingIdx] : null;
              const existingSteps = existingNode?.steps ?? [];
              const newStepRecord: NodeStepRecord = {
                id: `mock-step-${nodeId}-${Date.now()}`,
                index: existingSteps.length + 1,
                status: "running",
                startedAt: new Date().toISOString(),
                input: message,
                ...(nodeId === "chat" && { prompt: `[Mock] User task: "${shortTitle}"` }),
              };
              const newNode: SubagentNode = {
                id: nodeId,
                label: nodeId.charAt(0).toUpperCase() + nodeId.slice(1),
                type: nodeId === "chat" ? "LLM" : nodeId === "input" ? "PLANNING" : "TOOL",
                pipeConnected: true,
                state: { status: "running", currentTask: message },
                steps: [...existingSteps, newStepRecord],
              };
              const updatedSubagents = existingIdx >= 0
                ? s.subagents.map((n) => n.id === nodeId ? newNode : n)
                : [...s.subagents, newNode];

              return {
                ...s,
                executionEdges: updatedEdges,
                subagents: updatedSubagents,
                traceLogs: [
                  ...s.traceLogs,
                  { id: `step-${nodeId}-${Date.now()}`, type, timestamp: stepTime, message, nodeId },
                ],
                orchestrator: {
                  ...s.orchestrator,
                  progress: nodeId === "input" ? 20 : nodeId === "chat" ? 55 : 85,
                },
              };
            })
          );
        }, delay);
      });

      // 模拟 Run 完成（最后一步 + 1s 后）
      const totalDelay = mockSteps[mockSteps.length - 1]!.delay + 1000;
      setTimeout(() => {
        const doneTime = new Date().toLocaleTimeString("en-GB", { hour12: false });
        const finalTokens = Math.floor(Math.random() * 20000) + 5000;
        const finalCost = parseFloat((Math.random() * 0.08 + 0.01).toFixed(4));
        const mockOutput = `[Mock] 任务"${shortTitle}"已完成。这是一条模拟 AI 回复，展示执行图从空白到动态生长的过程。`;

        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== sid) return s;

            // 将所有 active 边变为 completed
            const finalEdges = s.executionEdges.map((edge) =>
              edge.state === "active" ? { ...edge, state: "completed" as const } : edge
            );
            // 将所有 subagents 变为 success，并完成最后一个 step
            const finalSubagents = s.subagents.map((n) => ({
              ...n,
              state: { status: "success" as const, output: `${n.label} completed` },
              steps: (n.steps ?? []).map((step, idx, arr) =>
                // 将最后一个 running step 标记为 success
                idx === arr.length - 1 && step.status === "running"
                  ? {
                      ...step,
                      status: "success" as const,
                      output: `${n.label} completed successfully`,
                      durationMs: Math.floor(Math.random() * 2000) + 500,
                      tokens: Math.floor(Math.random() * 1000) + 100,
                    }
                  : step
              ),
            }));

            return {
              ...s,
              state: "completed" as const,
              orchestrator: {
                ...s.orchestrator,
                state: "completed" as const,
                progress: 100,
                totalTokens: finalTokens,
                totalCostUsd: finalCost,
                activeAgents: 0,
              },
              traceLogs: [
                ...s.traceLogs,
                {
                  id: `sys-done-${Date.now()}`,
                  type: "SYSTEM" as const,
                  timestamp: doneTime,
                  message: `Run completed: ${runId}`,
                },
              ],
              executionEdges: finalEdges,
              subagents: finalSubagents,
              aiOutput: mockOutput,
            };
          })
        );
      }, totalDelay);
    },
    [activeSessionId, isElectron, runGraph, t, projectContext]
  ); // handleTaskSubmit

  /**
   * 撤回某节点的某步骤
   *
   * 将该步骤标记为 reverted，并在 traceLogs 中追加一条记录。
   * 下游边状态重置为 pending（若有），让用户可以选择重跑。
   */
  const handleNodeRevert = useCallback((nodeId: string, stepId: string) => {
    const timestamp = new Date().toLocaleTimeString("en-GB", { hour12: false });
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== activeSessionId) return s;

        // 将该节点指定步骤标记为 reverted
        const updatedSubagents = s.subagents.map((node) => {
          if (node.id !== nodeId) return node;
          return {
            ...node,
            steps: (node.steps ?? []).map((step) =>
              step.id === stepId ? { ...step, status: "reverted" as const } : step
            ),
            // 节点状态改为 error（表示该步已撤销）
            state: { status: "error" as const, errorMsg: `Step reverted by user` },
          };
        });

        // 将该节点的出边重置为 pending（允许用户重新执行）
        const updatedEdges = s.executionEdges.map((edge) => {
          if (edge.source === nodeId && (edge.state === "active" || edge.state === "completed")) {
            return { ...edge, state: "pending" as const };
          }
          return edge;
        });

        return {
          ...s,
          subagents: updatedSubagents,
          executionEdges: updatedEdges,
          traceLogs: [
            ...s.traceLogs,
            {
              id: `revert-${stepId}-${Date.now()}`,
              type: "SYSTEM" as const,
              timestamp,
              message: `⤺ Step reverted on node "${nodeId}" (step: ${stepId})`,
              nodeId,
            },
          ],
        };
      })
    );
  }, [activeSessionId]);

  /**
   * 重新生成某节点的某步骤
   *
   * 1. 将该节点状态改回 running
   * 2. 清除该节点的下游边（重置为 pending）
   * 3. 新增一条 NodeStepRecord（isRerun=true，记录编辑后的 prompt）
   * 4. Electron：真实重跑（TODO 扩展 IPC）；浏览器：mock 模拟延迟完成
   */
  const handleNodeRerun = useCallback((nodeId: string, stepId: string, editedPrompt: string) => {
    const timestamp = new Date().toLocaleTimeString("en-GB", { hour12: false });
    const newStepId = `step-rerun-${Date.now()}`;

    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== activeSessionId) return s;

        // 找到该节点
        const targetNode = s.subagents.find((n) => n.id === nodeId);
        if (!targetNode) return s;

        // 新建重跑 step 记录
        const existingSteps = targetNode.steps ?? [];
        const newStep: NodeStepRecord = {
          id: newStepId,
          index: existingSteps.length + 1,
          status: "running",
          startedAt: new Date().toISOString(),
          prompt: editedPrompt,
          input: editedPrompt,
          isRerun: true,
        };

        // 更新节点状态为 running
        const updatedSubagents = s.subagents.map((node) => {
          if (node.id !== nodeId) return node;
          return {
            ...node,
            state: { status: "running" as const, currentTask: `Rerunning: ${editedPrompt.slice(0, 50)}...` },
            steps: [...existingSteps, newStep],
          };
        });

        // 将该节点出边重置为 pending（清除下游）
        const updatedEdges = s.executionEdges.map((edge) => {
          if (edge.source === nodeId) {
            return { ...edge, state: "pending" as const };
          }
          return edge;
        });

        return {
          ...s,
          subagents: updatedSubagents,
          executionEdges: updatedEdges,
          traceLogs: [
            ...s.traceLogs,
            {
              id: `rerun-${newStepId}`,
              type: "AGENT_ACT" as const,
              timestamp,
              message: `↻ Rerunning node "${nodeId}" with edited prompt`,
              nodeId,
            },
          ],
        };
      })
    );

    // ── 浏览器 dev 模式：模拟重跑结果（1.5s 后完成）──────────────
    if (!isElectron) {
      setTimeout(() => {
        const doneTime = new Date().toLocaleTimeString("en-GB", { hour12: false });
        const mockRerunOutput = `[Rerun] Response for: "${editedPrompt.slice(0, 80)}"`;

        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== activeSessionId) return s;
            const updatedSubagents = s.subagents.map((node) => {
              if (node.id !== nodeId) return node;
              return {
                ...node,
                state: { status: "success" as const, output: mockRerunOutput },
                steps: (node.steps ?? []).map((step) =>
                  step.id === newStepId
                    ? { ...step, status: "success" as const, output: mockRerunOutput, durationMs: 1480, tokens: Math.floor(Math.random() * 800) + 200 }
                    : step
                ),
              };
            });

            // 将出边重新激活（模拟下游继续执行）
            const updatedEdges = s.executionEdges.map((edge) => {
              if (edge.source === nodeId && edge.state === "pending") {
                return { ...edge, state: "completed" as const };
              }
              return edge;
            });

            return {
              ...s,
              subagents: updatedSubagents,
              executionEdges: updatedEdges,
              traceLogs: [
                ...s.traceLogs,
                {
                  id: `rerun-done-${newStepId}`,
                  type: "SYSTEM" as const,
                  timestamp: doneTime,
                  message: `↻ Rerun completed for node "${nodeId}"`,
                  nodeId,
                },
              ],
            };
          })
        );
      }, 1500);
    }
    // ── Electron 环境：调用真实 forkRun IPC ──────────────────────
    if (isElectron && window.omega?.forkRun) {
      // 获取当前 session 的 runId 和 graphJson
      setSessions((prev) => {
        const session = prev.find((s) => s.id === activeSessionId);
        if (!session) return prev;

        const parentRunId = session.orchestrator.runId ?? "";
        const currentGraphJson = session.graphJson ?? "{}";
        // 构造覆盖输入（将编辑后的 prompt 作为 query）
        const inputOverrideJson = JSON.stringify({ query: editedPrompt });

        // 异步调用 forkRun，然后更新 session 状态
        window.omega!.forkRun(parentRunId, stepId, currentGraphJson, inputOverrideJson)
          .then((result) => {
            console.log("[OMEGA] forkRun result:", result);
            if (result.ok && result.newRunId) {
              // 更新 session 的 runId 为新 fork 出来的 runId
              setSessions((innerPrev) =>
                innerPrev.map((s) => {
                  if (s.id !== activeSessionId) return s;
                  return {
                    ...s,
                    orchestrator: {
                      ...s.orchestrator,
                      runId: result.newRunId!,
                      state: "running" as const,
                    },
                  };
                })
              );
            } else if (result.error) {
              // forkRun 出错，将节点改为 error 状态
              console.error("[OMEGA] forkRun error:", result.error);
              setSessions((innerPrev) =>
                innerPrev.map((s) => {
                  if (s.id !== activeSessionId) return s;
                  return {
                    ...s,
                    subagents: s.subagents.map((node) => {
                      if (node.id !== nodeId) return node;
                      return {
                        ...node,
                        state: { status: "error" as const, errorMsg: result.error ?? "Unknown error" },
                        steps: (node.steps ?? []).map((step) =>
                          step.id === newStepId
                            ? { ...step, status: "error" as const, errorMsg: result.error ?? "Unknown error" }
                            : step
                        ),
                      } as SubagentNode;
                    }),
                  };
                })
              );
            }
          })
          .catch((err: unknown) => {
            console.error("[OMEGA] forkRun IPC failed:", err);
          });

        return prev; // 不修改，由上面的异步 setSessions 处理
      });
    }
  }, [activeSessionId, isElectron]);

  /** 停止当前 Run */
  const handleStop = useCallback(async () => {
    const timestamp = new Date().toLocaleTimeString("en-GB", { hour12: false });

    // Electron 环境：通知 main process 取消 run
    if (isElectron) {
      const runId = currentSession.orchestrator.runId;
      if (runId) await cancelRun(runId);
    }

    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== activeSessionId) return s;
        return {
          ...s,
          state: "cancelled" as const,
          orchestrator: {
            // exactOptionalPropertyTypes: 省略 runId（不能赋 undefined）
            epicTaskName: "Waiting for task...",
            progress: 0,
            totalTokens: s.orchestrator.totalTokens,
            totalCostUsd: s.orchestrator.totalCostUsd,
            state: "idle" as const,
            activeAgents: 0,
          },
          traceLogs: [
            ...s.traceLogs,
            {
              id: `sys-stop-${Date.now()}`,
              type: "SYSTEM" as const,
              timestamp,
              message: "Run cancelled by user",
            },
          ],
        };
      })
    );
  }, [activeSessionId, isElectron, cancelRun, currentSession.orchestrator.runId]);

  // ── 等待主进程消息（避免初始闪屏）────────────────────────────────────
  if (needWorkdir === null) {
    return (
      <div className="flex flex-col h-screen w-screen bg-[#0d0e11]">
        <CustomTitleBar />
        <div className="flex-1" />
      </div>
    );
  }

  // ── 欢迎页（未选工作目录）────────────────────────────────────────────
  if (needWorkdir === true) {
    return (
      <div className="flex flex-col h-screen w-screen bg-[#0d0e11]">
        <CustomTitleBar />
        <WorkdirPickerPage
          onSelected={() => setNeedWorkdir(false)}
        />
      </div>
    );
  }

  // ── 主界面 ───────────────────────────────────────────────────────────
  return (
    <div
      className="flex flex-col h-screen w-screen overflow-hidden"
      style={{ background: "#0d0e11" }}
    >
      {/* 自定义标题栏（类 Cursor 风格） */}
      <CustomTitleBar />

      {/* 主体：侧边栏 + 内容区 */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* 左侧侧边栏（含会话历史 + Ollama 状态） */}
      <Sidebar
        activeRoute={activeRoute}
        onNavigate={setActiveRoute}
        activeSessionId={activeSessionId}
        sessions={sessions}
        onSelectSession={handleSelectSession}
        onNewChat={handleNewChat}
        ollamaConnected={ollamaConnected}
        onExitWorkdir={handleExitWorkdir}
      />

      {/* 主内容区（路由切换） */}
      <div className="flex-1 min-w-0 overflow-hidden relative">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeRoute}
            className="absolute inset-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
          >
            {activeRoute === "dashboard" && (
              <AnimatePresence>
                {/* key 绑定 sessionId，切换 session 时触发淡入淡出（sync 模式避免全黑空档） */}
                <motion.div
                  key={activeSessionId}
                  className="absolute inset-0"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.1 }}
                >
                  <NerveCenter
                    orchestrator={orchestrator}
                    subagents={currentSession.subagents}
                    mcpTools={
                      // Electron 下用真实 MCP 数据；浏览器 dev 模式 fallback mockMcpTools
                      mcpToolsData.length > 0 ? mcpToolsData : mockMcpTools
                    }
                    skills={mockSkills}
                    {...(currentSession.aiOutput !== undefined && { aiOutput: currentSession.aiOutput })}
                    isStreaming={isStreaming}
                    streamingText={streamingText}
                    executionEdges={currentSession.executionEdges}
                    rounds={currentSession.rounds ?? []}
                    onTaskSubmit={handleTaskSubmit}
                    onStop={handleStop}
                    onNodeRevert={handleNodeRevert}
                    onNodeRerun={handleNodeRerun}
                    providers={providers}
                    selectedModel={selectedModel}
                    onModelChange={setSelectedModel}
                    pendingFollowup={pendingFollowup}
                    onSubmitFollowup={(answer) => {
                      if (!pendingFollowup) return;
                      window.omega?.submitFollowupAnswer?.(pendingFollowup.runId, answer);
                      setPendingFollowup(null); // 清除提问状态
                    }}
                  />
                </motion.div>
              </AnimatePresence>
            )}
            {activeRoute === "artifacts" && (
              <ArtifactsPage runHistory={runHistory} />
            )}
            {activeRoute === "settings" && (
              <SettingsPage
                providers={providers}
                onSaveProvider={handleSaveProvider}
                onDeleteProvider={handleDeleteProvider}
                projectContext={projectContext}
                onProjectContextChange={setProjectContext}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* 右侧 Trace Log 抽屉 — 仅 Dashboard，内容跟随当前会话 */}
      <AnimatePresence>
        {isDashboard && (
          <motion.div
            key="trace-drawer"
            className="flex-shrink-0 p-3"
            style={{
              width: "280px",
              borderLeft: "1px solid rgba(255,255,255,0.06)",
            }}
            initial={{ opacity: 0, width: 0, paddingLeft: 0, paddingRight: 0 }}
            animate={{
              opacity: 1,
              width: 280,
              paddingLeft: 12,
              paddingRight: 12,
            }}
            exit={{ opacity: 0, width: 0, paddingLeft: 0, paddingRight: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            <TraceLogDrawer entries={traceLogs} />
          </motion.div>
        )}
      </AnimatePresence>
      </div> {/* flex flex-1 min-h-0 wrapper */}
    </div>
  );
}

