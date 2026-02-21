import { useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { OrchestratorNode } from "./OrchestratorNode.js";
import { SubagentCard } from "./SubagentCard.js";
import { DataPipe } from "./DataPipe.js";
import { ResourceSubstrate } from "./ResourceSubstrate.js";
import { TaskInputBar } from "./TaskInputBar.js";
import { AiOutputCard } from "./AiOutputCard.js";
import { useLayoutEngine, toTopLeft, getPipeEndpoints } from "../../hooks/useLayoutEngine.js";
import type {
  OrchestratorData,
  SubagentNode,
  McpToolData,
  SkillData,
  AttachmentItem,
  ExecutionEdge,
} from "../../types/ui.js";

interface NerveCenterProps {
  orchestrator: OrchestratorData;
  subagents: SubagentNode[];
  mcpTools: McpToolData[];
  skills: SkillData[];
  /** AI 最终回复文本（Run 完成后由 App.tsx 传入） */
  aiOutput?: string;
  /**
   * 当前 Run 的有向执行边列表（由 App.tsx 从 graphJson 解析后传入）
   * 为空时 fallback 到旧版 subagents 静态视图
   */
  executionEdges?: ExecutionEdge[];
  /** 用户提交任务回调（含附件列表） */
  onTaskSubmit?: (task: string, attachments: AttachmentItem[]) => void;
  /** 停止当前 Run 的回调 */
  onStop?: () => void;
  /** 节点步骤撤回回调（从 App.tsx 传入） */
  onNodeRevert?: (nodeId: string, stepId: string) => void;
  /** 节点重新生成回调（从 App.tsx 传入） */
  onNodeRerun?: (nodeId: string, stepId: string, editedPrompt: string) => void;
}

/**
 * 根据 ExecutionEdge[] 派生节点卡片数据
 *
 * 规则：
 * - 凡是出现在 edges 里的 source/target 节点，只要对应 edge 的 state 不是 pending，
 *   就认为该节点已"出现"（否则仅显示连线但不显示卡片）
 * - 节点类型根据 ID 前缀猜测（简单启发式，可后续扩展）
 */
function edgesToNodes(edges: ExecutionEdge[], realSubagents: SubagentNode[]): SubagentNode[] {
  // 先用真实 subagents Map 做快速查找
  const realMap = new Map(realSubagents.map((s) => [s.id, s]));

  // 收集所有"已激活"的节点 ID（target 节点 edge.state !== "pending"）
  const activeTargets = new Set<string>();
  // source 节点只要任何一条出边激活了，source 也要显示
  const activeSources = new Set<string>();

  for (const e of edges) {
    if (e.state !== "pending") {
      activeTargets.add(e.target);
      activeSources.add(e.source);
    }
  }

  // 合并：source 或 target 激活即显示
  const visibleIds = new Set([...activeTargets, ...activeSources]);

  // 映射为 SubagentNode
  const result: SubagentNode[] = [];
  for (const id of visibleIds) {
    // 优先使用真实 subagent 数据
    if (realMap.has(id)) {
      result.push(realMap.get(id)!);
      continue;
    }
    // 启发式推断节点类型
    const lc = id.toLowerCase();
    const type: SubagentNode["type"] =
      lc.includes("llm") || lc.includes("chat") || lc.includes("ai") ? "LLM"
      : lc.includes("tool") || lc.includes("search") || lc.includes("mcp") ? "TOOL"
      : lc.includes("plan") ? "PLANNING"
      : lc.includes("mem") || lc.includes("memory") ? "MEMORY"
      : lc.includes("reflect") ? "REFLECTION"
      : "LLM";

    // 查找该节点相关 edges 以推断状态
    const inEdges = edges.filter((e) => e.target === id);
    const outEdges = edges.filter((e) => e.source === id);
    const hasActive = inEdges.some((e) => e.state === "active") || outEdges.some((e) => e.state === "active");
    const hasFailed = inEdges.some((e) => e.state === "failed");
    const hasCompleted = outEdges.some((e) => e.state === "completed") || inEdges.some((e) => e.state === "completed");

    const state: SubagentNode["state"] =
      hasFailed
        ? { status: "error", errorMsg: "Execution failed" }
        : hasActive
        ? { status: "running", currentTask: `Processing ${id}...` }
        : hasCompleted
        ? { status: "success", output: `${id} completed` }
        : { status: "idle" };

    result.push({
      id,
      label: id.charAt(0).toUpperCase() + id.slice(1),
      type,
      pipeConnected: true,
      state,
    });
  }

  return result;
}

/**
 * NerveCenter — 中心动态画布（v0.1.9 重构版）
 *
 * 三层深度布局:
 *   Top    — Orchestrator Brain + TaskInputBar + AiOutputCard
 *   Middle — 动态执行图（ExecutionEdge 驱动逐步生长）
 *   Bottom — Resource Substrate（工具/技能资源池）
 *
 * 图形系统：
 *   - executionEdges 有值时启用动态图模式
 *   - useLayoutEngine BFS 拓扑排序计算各节点坐标
 *   - DataPipe SVG 贝塞尔曲线随 edge.state 改变颜色和粒子
 *   - 节点卡片在 edge 激活时 Framer Motion 淡入出现
 */
export function NerveCenter({
  orchestrator,
  subagents,
  mcpTools,
  skills,
  aiOutput,
  executionEdges = [],
  onTaskSubmit,
  onStop,
  onNodeRevert,
  onNodeRerun,
}: NerveCenterProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // 画布区域宽度（用于布局计算，估算值，精度足够）
  const containerWidth = 600;

  // ── 布局引擎：从 edges 计算节点坐标 ──────────────────────────
  const { positions, canvasHeight } = useLayoutEngine(executionEdges, containerWidth);

  // ── 是否使用动态图模式 ────────────────────────────────────────
  // 有 executionEdges 时优先使用动态图；否则 fallback 到旧版静态卡片行
  const useDynamicGraph = executionEdges.length > 0;

  // ── 动态图模式：从 edges 派生可见节点 ────────────────────────
  const dynamicNodes = useDynamicGraph ? edgesToNodes(executionEdges, subagents) : [];

  // ── 静态模式兼容：subagents 直接渲染（旧逻辑） ───────────────
  // 注：新建会话 subagents=[]，不再 fallback 到 mockSubagents，NerveCenter 显示空画布引导
  const staticSubagents = useDynamicGraph ? [] : subagents;

  // ── 是否显示空画布引导提示 ───────────────────────────────────
  // 新建会话：没有 executionEdges 且没有 subagents 时显示
  const isEmptyCanvas = !useDynamicGraph && staticSubagents.length === 0;

  return (
    <div className="flex flex-col items-center justify-between h-full px-8 py-6 gap-4 relative">

      {/* ── Top: Orchestrator Brain ── */}
      <div className="flex-shrink-0 w-full flex flex-col items-center gap-3">
        <OrchestratorNode data={orchestrator} />
        {/* 任务输入栏 — 紧贴大脑节点下方 */}
        <TaskInputBar
          orchestratorState={orchestrator.state}
          onSubmit={onTaskSubmit ?? (() => {})}
          {...(onStop !== undefined && { onStop })}
        />
        {/* AI 回复卡片 — Run 完成后淡入 */}
        <AiOutputCard output={aiOutput} />
      </div>

      {/* ── Middle: Execution Engine ── */}
      <div
        className="flex-1 w-full relative"
        ref={containerRef}
        style={{ minHeight: useDynamicGraph ? Math.max(canvasHeight, 200) : isEmptyCanvas ? 200 : 160 }}
      >
        {/* ════════════════════════════════
            动态图模式（executionEdges 驱动）
            ════════════════════════════════ */}
        {useDynamicGraph && (
          <>
            {/* SVG 覆盖层：DataPipe 连线（绝对定位覆盖整个执行区域） */}
            <svg
              className="absolute inset-0 pointer-events-none"
              style={{ width: "100%", height: "100%", overflow: "visible" }}
            >
              <AnimatePresence>
                {executionEdges.map((edge) => {
                  const srcPos = positions.get(edge.source);
                  const tgtPos = positions.get(edge.target);
                  if (!srcPos || !tgtPos) return null;

                  const { fromPt, toPt } = getPipeEndpoints(srcPos, tgtPos);

                  return (
                    // 用 foreignObject 包裹 DataPipe 的独立 SVG（DataPipe 自带 svg 标签）
                    // 这里直接渲染嵌套路径而非使用外层 foreignObject
                    <DataPipeSvgPath
                      key={edge.id}
                      from={fromPt}
                      to={toPt}
                      state={edge.state}
                      edgeId={edge.id}
                    />
                  );
                })}
              </AnimatePresence>
            </svg>

            {/* 节点卡片（absolute 定位到计算坐标） */}
            <AnimatePresence>
              {dynamicNodes.map((node) => {
                const pos = positions.get(node.id);
                if (!pos) return null;
                const { left, top } = toTopLeft(pos);

                return (
                  <motion.div
                    key={node.id}
                    className="absolute"
                    style={{ left, top, width: 192, zIndex: 10 }}
                    initial={{ opacity: 0, scale: 0.85, y: 8 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.85 }}
                    transition={{ duration: 0.35, ease: [0.23, 1, 0.32, 1] }}
                  >
                    <SubagentCard
                      node={node}
                      {...(onNodeRevert !== undefined && { onRevert: onNodeRevert })}
                      {...(onNodeRerun !== undefined && { onRerun: onNodeRerun })}
                    />
                  </motion.div>
                );
              })}
            </AnimatePresence>

            {/* 空白提示：Run 开始后等待第一个 step */}
            {dynamicNodes.length === 0 && orchestrator.state === "running" && (
              <motion.div
                className="absolute inset-0 flex items-center justify-center"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.5 }}
              >
                <div className="flex flex-col items-center gap-3">
                  <motion.div
                    className="w-2 h-2 rounded-full"
                    style={{ background: "rgba(96,165,250,0.6)" }}
                    animate={{ scale: [1, 1.5, 1], opacity: [0.4, 1, 0.4] }}
                    transition={{ duration: 1.5, repeat: Infinity }}
                  />
                  <span className="text-xs" style={{ color: "rgba(255,255,255,0.25)" }}>
                    Waiting for execution steps...
                  </span>
                </div>
              </motion.div>
            )}

            {/* 空白提示：Run 未开始，引导用户输入 */}
            {dynamicNodes.length === 0 && orchestrator.state !== "running" && (
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-xs" style={{ color: "rgba(255,255,255,0.12)" }}>
                  Execution graph will appear when task runs
                </span>
              </div>
            )}
          </>
        )}

        {/* ════════════════════════════════
            空画布引导提示（新建会话无任务时）
            ════════════════════════════════ */}
        {isEmptyCanvas && (
          <motion.div
            className="absolute inset-0 flex flex-col items-center justify-center gap-4"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
          >
            {/* 脉冲圆点 */}
            <motion.div
              className="w-3 h-3 rounded-full"
              style={{ background: "rgba(96,165,250,0.25)", boxShadow: "0 0 12px rgba(96,165,250,0.2)" }}
              animate={{ scale: [1, 1.4, 1], opacity: [0.3, 0.7, 0.3] }}
              transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
            />
            {/* 主引导文字 */}
            <p className="text-sm text-center" style={{ color: "rgba(255,255,255,0.22)", maxWidth: 240, lineHeight: 1.7 }}>
              Submit a task above to begin
            </p>
            {/* 副文字 */}
            <p className="text-xs text-center" style={{ color: "rgba(255,255,255,0.10)", maxWidth: 260 }}>
              The execution graph will grow step-by-step as the agent works
            </p>
          </motion.div>
        )}

        {/* ════════════════════════════════
            静态兼容模式（无 executionEdges）
            旧版卡片行 + SVG 直线连接
            ════════════════════════════════ */}
        {!useDynamicGraph && staticSubagents.length > 0 && (
          <>
            {/* 旧版 SVG 连线 */}
            <svg
              className="absolute inset-0 w-full h-full pointer-events-none"
              style={{ overflow: "visible" }}
            >
              {staticSubagents.map((agent, i) => {
                const total = staticSubagents.length;
                const cardWidth = 192 + 16;
                const targetXOffset = (i - (total - 1) / 2) * cardWidth;
                return (
                  <g key={agent.id}>
                    <line
                      x1="50%"
                      y1="0"
                      x2={`calc(50% + ${targetXOffset}px)`}
                      y2="100%"
                      stroke={
                        agent.state.status === "running" ? "rgba(96,165,250,0.15)"
                          : agent.state.status === "autofix" ? "rgba(251,191,36,0.15)"
                          : agent.state.status === "success" ? "rgba(52,211,153,0.10)"
                          : "rgba(255,255,255,0.04)"
                      }
                      strokeWidth="1"
                      strokeDasharray={agent.state.status === "idle" ? "4 8" : "none"}
                    />
                    {(agent.state.status === "running" || agent.state.status === "autofix") && (
                      <circle
                        r="1.8"
                        fill={agent.state.status === "autofix" ? "#fbbf24" : "#60a5fa"}
                        opacity="0.8"
                      >
                        <animateMotion
                          dur={agent.state.status === "autofix" ? "1.2s" : "2s"}
                          repeatCount="indefinite"
                          path={`M 0,0 L ${targetXOffset},100`}
                          begin={`${i * 0.3}s`}
                        />
                      </circle>
                    )}
                  </g>
                );
              })}
            </svg>

            {/* 旧版卡片行 */}
            <div className="flex items-center gap-4 flex-wrap justify-center relative z-10 h-full">
              {staticSubagents.map((agent) => (
                <SubagentCard
                  key={agent.id}
                  node={agent}
                  {...(onNodeRevert !== undefined && { onRevert: onNodeRevert })}
                  {...(onNodeRerun !== undefined && { onRerun: onNodeRerun })}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* ── Bottom: Resource Substrate ── */}
      <div className="flex-shrink-0 w-full">
        <ResourceSubstrate mcpTools={mcpTools} skills={skills} />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部：内联 SVG 路径组件（避免在外层 svg 中嵌套 svg）
// DataPipe 原来是独立 svg，这里拆出其路径逻辑直接渲染为 <g> 元素
// ─────────────────────────────────────────────────────────────────────────────

interface DataPipeSvgPathProps {
  from: { x: number; y: number };
  to: { x: number; y: number };
  state: "pending" | "active" | "completed" | "failed";
  edgeId: string;
}

/** 根据 state 派生颜色 */
function resolveColors(state: DataPipeSvgPathProps["state"]) {
  switch (state) {
    case "active":
      return { stroke: "rgba(96,165,250,0.35)", particle: "#60a5fa" };
    case "completed":
      return { stroke: "rgba(52,211,153,0.40)", particle: "#34d399" };
    case "failed":
      return { stroke: "rgba(248,113,113,0.40)", particle: "#f87171" };
    default:
      return { stroke: "rgba(255,255,255,0.08)", particle: "rgba(255,255,255,0.3)" };
  }
}

/**
 * DataPipeSvgPath — 直接嵌入外层 SVG 的路径组件
 *
 * 与 DataPipe.tsx（独立 SVG）不同，这个组件输出 SVG 元素（<g>），
 * 可直接放在父 <svg> 内，避免 SVG 嵌套问题。
 */
function DataPipeSvgPath({ from, to, state, edgeId }: DataPipeSvgPathProps) {
  const colors = resolveColors(state);
  const midY = (from.y + to.y) / 2;
  const pathD = `M ${from.x} ${from.y} C ${from.x} ${midY}, ${to.x} ${midY}, ${to.x} ${to.y}`;
  const gradId = `grad-${edgeId}`;

  return (
    <g>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={colors.particle} stopOpacity="0.7" />
          <stop offset="100%" stopColor={colors.particle} stopOpacity="0.15" />
        </linearGradient>
      </defs>

      {/* 底层虚化线（始终存在） */}
      <path
        d={pathD}
        fill="none"
        stroke="rgba(255,255,255,0.04)"
        strokeWidth={1}
        strokeLinecap="round"
      />

      {/* pending: 灰色虚线 */}
      {state === "pending" && (
        <path
          d={pathD}
          fill="none"
          stroke={colors.stroke}
          strokeWidth={1}
          strokeLinecap="round"
          strokeDasharray="4 8"
        />
      )}

      {/* active/completed/failed: 实线渐变 */}
      {state !== "pending" && (
        <motion.path
          d={pathD}
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth={1.5}
          strokeLinecap="round"
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ duration: state === "failed" ? 0.3 : 0.7, ease: "easeOut" }}
        />
      )}

      {/* active: 流动粒子 */}
      {state === "active" && (
        <>
          <motion.circle
            r="2.5"
            fill={colors.particle}
            style={{ filter: `drop-shadow(0 0 4px ${colors.particle})` }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4 }}
          >
            <animateMotion dur="1.8s" repeatCount="indefinite" path={pathD} />
          </motion.circle>
          <motion.circle
            r="1.4"
            fill={colors.particle}
            opacity="0.5"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.5 }}
            transition={{ delay: 0.4 }}
          >
            <animateMotion dur="1.8s" begin="0.9s" repeatCount="indefinite" path={pathD} />
          </motion.circle>
        </>
      )}

      {/* completed: 收尾粒子（一次性，到达终点后消失） */}
      {state === "completed" && (
        <motion.circle
          r="2"
          fill={colors.particle}
          style={{ filter: `drop-shadow(0 0 3px ${colors.particle})` }}
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={{ delay: 1.0, duration: 0.6 }}
        >
          <animateMotion dur="1.0s" repeatCount="1" fill="freeze" path={pathD} />
        </motion.circle>
      )}
    </g>
  );
}
