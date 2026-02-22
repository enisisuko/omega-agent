import { useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { OrchestratorNode } from "./OrchestratorNode.js";
import { SubagentCard } from "./SubagentCard.js";
import { DataPipe } from "./DataPipe.js";
import { ResourceSubstrate } from "./ResourceSubstrate.js";
import { TaskInputBar } from "./TaskInputBar.js";
import { AiOutputCard } from "./AiOutputCard.js";
import { useLayoutEngine, toTopLeft, getPipeEndpoints } from "../../hooks/useLayoutEngine.js";
import { useDraggableCanvas } from "../../hooks/useDraggableCanvas.js";
import type {
  OrchestratorData,
  SubagentNode,
  McpToolData,
  SkillData,
  AttachmentItem,
  ExecutionEdge,
  ExecutionRound,
  ProviderConfig,
} from "../../types/ui.js";

interface NerveCenterProps {
  orchestrator: OrchestratorData;
  /** 当前最新轮节点列表（向下兼容，优先使用 rounds） */
  subagents: SubagentNode[];
  mcpTools: McpToolData[];
  skills: SkillData[];
  /** AI 最终回复文本（向下兼容，最新轮的回复） */
  aiOutput?: string;
  /** 当前最新轮执行边（向下兼容，优先使用 rounds） */
  executionEdges?: ExecutionEdge[];
  /**
   * 多轮对话执行图列表（从 session.rounds 传入）
   * 每轮垂直续接渲染，历史轮降低亮度
   */
  rounds?: ExecutionRound[];
  /** 用户提交任务回调（含附件列表和选中模型） */
  onTaskSubmit?: (task: string, attachments: AttachmentItem[], model?: string) => void;
  /** 停止当前 Run 的回调 */
  onStop?: () => void;
  /** 节点步骤撤回回调（从 App.tsx 传入） */
  onNodeRevert?: (nodeId: string, stepId: string) => void;
  /** 节点重新生成回调（从 App.tsx 传入） */
  onNodeRerun?: (nodeId: string, stepId: string, editedPrompt: string) => void;
  /** 可用的 Provider 列表（用于模型选择下拉） */
  providers?: ProviderConfig[];
  /** 当前选中的模型 */
  selectedModel?: string;
  /** 模型变更回调 */
  onModelChange?: (model: string) => void;
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
  rounds = [],
  onTaskSubmit,
  onStop,
  onNodeRevert,
  onNodeRerun,
  providers = [],
  selectedModel,
  onModelChange,
}: NerveCenterProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // ── 画布拖拽 ─────────────────────────────────────────────────
  const { offset, isDragging, handlers: dragHandlers, reset: resetCanvas } = useDraggableCanvas();

  // 切换会话或新建会话时，重置画布视角
  const prevRoundsLen = useRef(rounds.length);
  useEffect(() => {
    if (rounds.length === 0 && prevRoundsLen.current > 0) {
      resetCanvas();
    }
    prevRoundsLen.current = rounds.length;
  }, [rounds.length, resetCanvas]);

  // 画布区域宽度（用于布局计算，估算值，精度足够）
  const containerWidth = 600;

  // ── 多轮模式：rounds 有数据时优先使用 ────────────────────────
  const useRoundsMode = rounds.length > 0;

  // ── 单轮兼容模式：只用 executionEdges（旧逻辑） ──────────────
  const { positions, canvasHeight } = useLayoutEngine(
    useRoundsMode ? [] : executionEdges,
    containerWidth,
  );

  // ── 是否使用动态图模式（单轮） ───────────────────────────────
  const useDynamicGraph = !useRoundsMode && executionEdges.length > 0;

  // ── 动态图模式：从 edges 派生可见节点（单轮兼容） ────────────
  const dynamicNodes = useDynamicGraph ? edgesToNodes(executionEdges, subagents) : [];

  // ── 静态模式兼容：subagents 直接渲染（旧逻辑） ───────────────
  const staticSubagents = useDynamicGraph ? [] : subagents;

  // ── 是否显示空画布引导提示 ───────────────────────────────────
  const isEmptyCanvas = !useRoundsMode && !useDynamicGraph && staticSubagents.length === 0;

  // ── 多轮模式：计算每轮的 yOffset（累积高度） ──────────────────
  // 预先为每一轮单独调用布局引擎（不用 Hook，直接调用工具函数）
  // 这里用 useMemo 来缓存所有轮次的布局结果
  const roundLayouts = useRoundsMode
    ? computeRoundLayouts(rounds, containerWidth)
    : [];

  // 多轮模式下的总画布高度（最后一轮的底部 + 下边距）
  const totalRoundsHeight = roundLayouts.length > 0
    ? (roundLayouts[roundLayouts.length - 1]?.yOffset ?? 0) +
      (roundLayouts[roundLayouts.length - 1]?.canvasHeight ?? 200) + 60
    : 200;

  // 最新轮的 AI 回复（取 rounds 最后一项）
  const latestAiOutput = useRoundsMode
    ? rounds[rounds.length - 1]?.aiOutput ?? aiOutput
    : aiOutput;

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
          providers={providers}
          selectedModel={selectedModel}
          onModelChange={onModelChange}
        />
        {/* AI 回复卡片 — Run 完成后淡入（显示最新轮的回复） */}
        <AiOutputCard output={latestAiOutput} />
      </div>

      {/* ── Middle: Execution Engine（可拖拽画布） ── */}
      {/* 外层：溢出隐藏 + 拖拽事件绑定 */}
      <div
        ref={containerRef}
        className="flex-1 w-full relative overflow-hidden"
        style={{
          minHeight: useRoundsMode ? Math.max(totalRoundsHeight, 200)
            : useDynamicGraph ? Math.max(canvasHeight, 200)
            : isEmptyCanvas ? 200 : 160,
          cursor: isDragging ? "grabbing" : isEmptyCanvas ? "default" : "grab",
          userSelect: "none",
        }}
        {...dragHandlers}
      >
        {/* 内层：跟随 offset 平移的画布内容 */}
        <div
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px)`,
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            // 高度撑开到所有内容的高度（让 SVG 连线不截断）
            minHeight: useRoundsMode ? totalRoundsHeight : canvasHeight,
          }}
        >

          {/* ════════════════════════════════
              多轮对话模式（rounds 驱动）
              每轮垂直续接，历史轮半透明
              ════════════════════════════════ */}
          {useRoundsMode && (
            <>
              {/* 全局 SVG：所有轮次的连线都绘制在同一个 SVG 内 */}
              <svg
                className="absolute inset-0 pointer-events-none"
                style={{ width: "100%", height: totalRoundsHeight, overflow: "visible" }}
              >
                <AnimatePresence>
                  {roundLayouts.map(({ round, positions: rPos, yOffset: rY }, ri) => {
                    const isLatest = ri === roundLayouts.length - 1;
                    return round.executionEdges.map((edge) => {
                      const srcPos = rPos.get(edge.source);
                      const tgtPos = rPos.get(edge.target);
                      if (!srcPos || !tgtPos) return null;
                      const { fromPt, toPt } = getPipeEndpoints(srcPos, tgtPos);
                      return (
                        <DataPipeSvgPath
                          key={`r${ri}-${edge.id}`}
                          from={fromPt}
                          to={toPt}
                          state={isLatest ? edge.state : "completed"}
                          edgeId={`r${ri}-${edge.id}`}
                          opacity={isLatest ? 1 : 0.35}
                        />
                      );
                    });
                  })}
                </AnimatePresence>
              </svg>

              {/* 所有轮次的节点卡片 */}
              {roundLayouts.map(({ round, positions: rPos, yOffset: rY }, ri) => {
                const isLatest = ri === roundLayouts.length - 1;
                const roundNodes = edgesToNodes(round.executionEdges, round.subagents);
                return (
                  <div key={`round-${ri}`}>
                    {/* 轮次分隔线（第 2 轮起才显示） */}
                    {ri > 0 && (
                      <div
                        className="absolute w-full flex items-center gap-3"
                        style={{ top: rY - 28, left: 0, pointerEvents: "none" }}
                      >
                        <div className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.06)" }} />
                        <span className="text-xs px-2 py-0.5 rounded" style={{
                          color: "rgba(255,255,255,0.25)",
                          background: "rgba(255,255,255,0.04)",
                          border: "1px solid rgba(255,255,255,0.06)",
                          fontSize: "10px",
                        }}>
                          Round {round.roundIndex} · {round.task.slice(0, 30)}{round.task.length > 30 ? "…" : ""}
                        </span>
                        <div className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.06)" }} />
                      </div>
                    )}

                    {/* 节点卡片 */}
                    <AnimatePresence>
                      {roundNodes.map((node) => {
                        const pos = rPos.get(node.id);
                        if (!pos) return null;
                        const { left, top } = toTopLeft(pos);
                        // 从父节点滑出动画
                        const parentEdge = round.executionEdges.find(e => e.target === node.id);
                        const parentPos = parentEdge ? rPos.get(parentEdge.source) : undefined;
                        const initialY = parentPos
                          ? Math.max((parentPos.y - pos.y) * 0.35, -30)
                          : -20;
                        const initialX = parentPos ? (parentPos.x - pos.x) * 0.25 : 0;
                        // 同层节点同时出现（level 驱动 delay）
                        const levelDelay = pos.level * 0.12;
                        return (
                          <motion.div
                            key={`r${ri}-${node.id}`}
                            className="absolute"
                            style={{
                              left,
                              top,
                              width: 192,
                              zIndex: 10,
                              filter: isLatest ? "none" : "saturate(0.4)",
                            }}
                            initial={{ opacity: 0, scale: 0.90, y: initialY, x: initialX }}
                            animate={{ opacity: isLatest ? 1 : 0.45, scale: 1, y: 0, x: 0 }}
                            exit={{ opacity: 0, scale: 0.85, y: -8 }}
                            transition={{
                              duration: 0.42,
                              ease: [0.23, 1, 0.32, 1],
                              delay: levelDelay,
                            }}
                            onMouseDown={(e) => e.stopPropagation()}
                            onDoubleClick={(e) => e.stopPropagation()}
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
                  </div>
                );
              })}
            </>
          )}

          {/* ════════════════════════════════
              单轮动态图模式（executionEdges 驱动，兼容旧版）
              ════════════════════════════════ */}
          {useDynamicGraph && (
            <>
              {/* SVG 覆盖层：DataPipe 连线 */}
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

                  // 出现动画：从父节点位置滑出
                  const parentEdge = executionEdges.find(e => e.target === node.id);
                  const parentPos = parentEdge ? positions.get(parentEdge.source) : undefined;
                  const initialY = parentPos
                    ? Math.max((parentPos.y - pos.y) * 0.35, -30)
                    : -20;
                  const initialX = parentPos
                    ? (parentPos.x - pos.x) * 0.25
                    : 0;

                  // 用 BFS level 决定出现延迟：同层节点同时出现，不同层按 level * 0.12s 错落
                  // 这样 plan(level=1) 先出现，decompose/execute(level=2) 同时出现，reflect(level=3) 再出现
                  const levelDelay = pos.level * 0.12;

                  return (
                    <motion.div
                      key={node.id}
                      className="absolute"
                      style={{ left, top, width: 192, zIndex: 10 }}
                      initial={{ opacity: 0, scale: 0.90, y: initialY, x: initialX }}
                      animate={{ opacity: 1, scale: 1, y: 0, x: 0 }}
                      exit={{ opacity: 0, scale: 0.85, y: -8 }}
                      transition={{
                        duration: 0.42,
                        ease: [0.23, 1, 0.32, 1],
                        delay: levelDelay,
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
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

              {/* 空白提示：Run 未开始 */}
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
              <motion.div
                className="w-3 h-3 rounded-full"
                style={{ background: "rgba(96,165,250,0.25)", boxShadow: "0 0 12px rgba(96,165,250,0.2)" }}
                animate={{ scale: [1, 1.4, 1], opacity: [0.3, 0.7, 0.3] }}
                transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
              />
              <p className="text-sm text-center" style={{ color: "rgba(255,255,255,0.22)", maxWidth: 240, lineHeight: 1.7 }}>
                Submit a task above to begin
              </p>
              <p className="text-xs text-center" style={{ color: "rgba(255,255,255,0.10)", maxWidth: 260 }}>
                The execution graph will grow step-by-step as the agent works
              </p>
            </motion.div>
          )}

          {/* ════════════════════════════════
              静态兼容模式（无 executionEdges）
              旧版卡片行 + SVG 直线连接
              ════════════════════════════════ */}
          {!useRoundsMode && !useDynamicGraph && staticSubagents.length > 0 && (
            <>
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
                        x1="50%" y1="0"
                        x2={`calc(50% + ${targetXOffset}px)`} y2="100%"
                        stroke={
                          agent.state.status === "running" ? "rgba(96,165,250,0.15)"
                            : agent.state.status === "autofix" ? "rgba(251,191,36,0.15)"
                            : agent.state.status === "success" ? "rgba(52,211,153,0.10)"
                            : "rgba(255,255,255,0.04)"
                        }
                        strokeWidth="1"
                        strokeDasharray={agent.state.status === "idle" ? "4 8" : "none"}
                      />
                    </g>
                  );
                })}
              </svg>
              <div className="flex items-center gap-4 flex-wrap justify-center relative z-10 h-full">
                {staticSubagents.map((agent) => (
                  <div key={agent.id} onMouseDown={(e) => e.stopPropagation()}>
                    <SubagentCard
                      node={agent}
                      {...(onNodeRevert !== undefined && { onRevert: onNodeRevert })}
                      {...(onNodeRerun !== undefined && { onRerun: onNodeRerun })}
                    />
                  </div>
                ))}
              </div>
            </>
          )}

        </div>{/* end 内层 transform 容器 */}

        {/* 拖拽提示（右下角） */}
        {!isEmptyCanvas && (
          <div
            className="absolute bottom-2 right-3 flex items-center gap-1 pointer-events-none"
            style={{ opacity: 0.18, fontSize: "10px", color: "white" }}
          >
            <span>drag to pan</span>
            <span style={{ opacity: 0.5 }}>· double-click to reset</span>
          </div>
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
  /** 整体透明度（历史轮次降低到 0.35 等） */
  opacity?: number;
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
function DataPipeSvgPath({ from, to, state, edgeId, opacity = 1 }: DataPipeSvgPathProps) {
  const colors = resolveColors(state);
  const midY = (from.y + to.y) / 2;
  const pathD = `M ${from.x} ${from.y} C ${from.x} ${midY}, ${to.x} ${midY}, ${to.x} ${to.y}`;
  const gradId = `grad-${edgeId}`;

  return (
    <g opacity={opacity}>
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

// ─────────────────────────────────────────────────────────────────────────────
// 工具函数：为多轮对话计算每轮的布局（非 Hook，可在渲染体内调用）
// ─────────────────────────────────────────────────────────────────────────────

/** 单轮布局结果（含 yOffset 信息，用于绑定到轮次分隔线） */
interface RoundLayoutResult {
  round: import("../../types/ui.js").ExecutionRound;
  positions: Map<string, NodePosition>;
  canvasHeight: number;
  yOffset: number;
}

/**
 * 为所有轮次计算 BFS 布局，并按轮次累积 yOffset
 *
 * 每轮的 yOffset = 前面所有轮次的 canvasHeight 之和 + 轮次间距（48px）
 * 直接调用纯函数版布局（不依赖 useMemo，避免条件 Hook 问题）
 */
function computeRoundLayouts(
  rounds: import("../../types/ui.js").ExecutionRound[],
  containerWidth: number,
): RoundLayoutResult[] {
  const results: RoundLayoutResult[] = [];
  let cumulativeY = 0;

  for (const round of rounds) {
    // 复用 useLayoutEngine 的纯计算逻辑（从 edges 计算节点坐标）
    const { positions, canvasHeight } = computeLayout(round.executionEdges, containerWidth, "orchestrator", cumulativeY);
    results.push({ round, positions, canvasHeight, yOffset: cumulativeY });
    cumulativeY += canvasHeight + 48; // 每轮之间留 48px 间距
  }

  return results;
}

/** computeLayout — 纯函数版布局计算（逻辑与 useLayoutEngine 完全一致，无 Hook 依赖） */
function computeLayout(
  edges: ExecutionEdge[],
  containerWidth: number,
  orchestratorId: string,
  yOffset: number,
): { positions: Map<string, NodePosition>; canvasHeight: number } {
  const NODE_W = 192;
  const NODE_H = 100;
  const LEVEL_H = 160;
  const GAP_X = 24;

  const positions = new Map<string, NodePosition>();

  if (edges.length === 0) {
    return { positions, canvasHeight: 200 };
  }

  const allNodeIds = new Set<string>();
  for (const e of edges) {
    allNodeIds.add(e.source);
    allNodeIds.add(e.target);
  }

  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const id of allNodeIds) { adj.set(id, []); inDegree.set(id, 0); }
  for (const e of edges) {
    adj.get(e.source)!.push(e.target);
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  }

  const levelMap = new Map<string, number>();
  const roots: string[] = [];
  if (allNodeIds.has(orchestratorId)) {
    roots.push(orchestratorId);
    levelMap.set(orchestratorId, 0);
  } else {
    for (const [id, deg] of inDegree) {
      if (deg === 0) { roots.push(id); levelMap.set(id, 0); }
    }
  }

  const queue = [...roots];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const curLevel = levelMap.get(cur) ?? 0;
    for (const child of (adj.get(cur) ?? [])) {
      const existing = levelMap.get(child);
      if (existing === undefined || existing < curLevel + 1) {
        levelMap.set(child, curLevel + 1);
        queue.push(child);
      }
    }
  }
  for (const id of allNodeIds) {
    if (!levelMap.has(id)) levelMap.set(id, 1);
  }

  const levelGroups = new Map<number, string[]>();
  for (const [id, level] of levelMap) {
    const group = levelGroups.get(level) ?? [];
    group.push(id);
    levelGroups.set(level, group);
  }

  const maxLevel = Math.max(...levelMap.values());
  const canvasHeight = yOffset + (maxLevel + 1) * LEVEL_H + NODE_H + 40;

  for (const [level, ids] of levelGroups) {
    const count = ids.length;
    const y = yOffset + 20 + level * LEVEL_H + NODE_H / 2;
    ids.forEach((id, i) => {
      const offsetX = (i - (count - 1) / 2) * (NODE_W + GAP_X);
      const x = containerWidth / 2 + offsetX;
      positions.set(id, { id, x, y, level, indexInLevel: i, totalInLevel: count });
    });
  }

  return { positions, canvasHeight };
}

// NodePosition 类型在这里需要重新引用（已从 useLayoutEngine 导入）
type NodePosition = import("../../hooks/useLayoutEngine.js").NodePosition;
type ExecutionEdge = import("../../types/ui.js").ExecutionEdge;
