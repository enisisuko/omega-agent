import { motion, AnimatePresence } from "framer-motion";
import { OrchestratorNode } from "./OrchestratorNode.js";
import { SubagentCard } from "./SubagentCard.js";
import { ResourceSubstrate } from "./ResourceSubstrate.js";
import { TaskInputBar } from "./TaskInputBar.js";
import { AiOutputCard } from "./AiOutputCard.js";
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

/** Edge 状态类型 */
type EdgeState = "pending" | "active" | "completed" | "failed";

/**
 * NodeConnector — 节点之间的视觉分隔符（替代 SVG 连线）
 *
 * 用简洁的垂直线 + 箭头表达节点间的流向关系，
 * 颜色随 edge 状态变化：pending=灰/active=蓝/completed=绿/failed=红
 */
function NodeConnector({ state }: { state?: EdgeState }) {
  const colorMap: Record<EdgeState, string> = {
    pending:   "rgba(255,255,255,0.12)",
    active:    "rgba(96,165,250,0.70)",
    completed: "rgba(52,211,153,0.60)",
    failed:    "rgba(248,113,113,0.60)",
  };
  const color = colorMap[state ?? "pending"];
  const isActive = state === "active";

  return (
    <div className="flex flex-col items-center" style={{ height: 28, paddingTop: 2, paddingBottom: 2 }}>
      {/* 垂直连接线 */}
      <div style={{ position: "relative", width: 1, flex: 1, background: color, opacity: 0.7 }}>
        {/* active 状态: 流动小球 */}
        {isActive && (
          <motion.div
            style={{
              position: "absolute",
              left: "50%",
              top: 0,
              width: 4,
              height: 4,
              borderRadius: "50%",
              background: color,
              transform: "translateX(-50%)",
              boxShadow: `0 0 6px ${color}`,
            }}
            animate={{ top: ["0%", "100%"] }}
            transition={{ duration: 1.2, repeat: Infinity, ease: "linear" }}
          />
        )}
      </div>
      {/* 向下箭头 */}
      <span
        style={{
          color,
          fontSize: 9,
          lineHeight: 1,
          opacity: state === "pending" ? 0.4 : 0.9,
        }}
      >
        ▼
      </span>
    </div>
  );
}

/**
 * 根据 ExecutionEdge[] 和真实 subagents 推导当前应显示的节点列表
 * 按拓扑顺序排列（BFS 层级从小到大），同层按 ID 字母序稳定排列
 */
function deriveDisplayNodes(
  edges: ExecutionEdge[],
  realSubagents: SubagentNode[],
): { node: SubagentNode; edgeAfter?: ExecutionEdge }[] {
  if (edges.length === 0 && realSubagents.length === 0) return [];

  const realMap = new Map(realSubagents.map((s) => [s.id, s]));

  // 拓扑排序：BFS 计算每个节点的层级
  const allNodeIds = new Set<string>();
  for (const e of edges) {
    allNodeIds.add(e.source);
    allNodeIds.add(e.target);
  }

  // 将 realSubagents 中不在 edges 里的节点也加入
  for (const s of realSubagents) {
    allNodeIds.add(s.id);
  }

  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const id of allNodeIds) { adj.set(id, []); inDegree.set(id, 0); }
  for (const e of edges) {
    adj.get(e.source)?.push(e.target);
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
  }

  const levelMap = new Map<string, number>();
  const roots: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) { roots.push(id); levelMap.set(id, 0); }
  }

  const bfsQueue = [...roots];
  while (bfsQueue.length > 0) {
    const cur = bfsQueue.shift()!;
    const curLevel = levelMap.get(cur) ?? 0;
    for (const child of (adj.get(cur) ?? [])) {
      const existing = levelMap.get(child);
      if (existing === undefined || existing < curLevel + 1) {
        levelMap.set(child, curLevel + 1);
        bfsQueue.push(child);
      }
    }
  }
  for (const id of allNodeIds) {
    if (!levelMap.has(id)) levelMap.set(id, 0);
  }

  // 按层级排序，取已激活（或 realSubagents 中存在）的节点
  const sorted = [...allNodeIds].sort((a, b) => {
    const la = levelMap.get(a) ?? 0;
    const lb = levelMap.get(b) ?? 0;
    return la !== lb ? la - lb : a.localeCompare(b);
  });

  // 过滤：只显示已出现的节点（非 pending 的 edge 涉及的节点，或 realSubagents 中已有数据的节点）
  const activatedIds = new Set<string>();
  for (const e of edges) {
    if (e.state !== "pending") {
      activatedIds.add(e.source);
      activatedIds.add(e.target);
    }
  }
  for (const s of realSubagents) {
    activatedIds.add(s.id);
  }

  const result: { node: SubagentNode; edgeAfter?: ExecutionEdge }[] = [];
  const visibleSorted = sorted.filter(id => activatedIds.has(id));

  for (let i = 0; i < visibleSorted.length; i++) {
    const id = visibleSorted[i];
    const nextId = visibleSorted[i + 1];

    // 构建节点数据
    let node = realMap.get(id);
    if (!node) {
      // 从 edges 推断
      const lc = id.toLowerCase();
      const type: SubagentNode["type"] =
        lc.includes("plan") ? "PLANNING"
        : lc.includes("mem") || lc.includes("decomp") ? "MEMORY"
        : lc.includes("reflect") ? "REFLECTION"
        : lc.includes("tool") ? "TOOL"
        : "LLM";

      const inEdges = edges.filter(e => e.target === id);
      const outEdges = edges.filter(e => e.source === id);
      const hasActive = [...inEdges, ...outEdges].some(e => e.state === "active");
      const hasFailed = inEdges.some(e => e.state === "failed");
      const hasDone = outEdges.some(e => e.state === "completed") || inEdges.some(e => e.state === "completed");

      node = {
        id,
        label: id.charAt(0).toUpperCase() + id.slice(1),
        type,
        pipeConnected: true,
        state: hasFailed
          ? { status: "error", errorMsg: "Execution failed" }
          : hasActive
          ? { status: "running", currentTask: `Processing ${id}...` }
          : hasDone
          ? { status: "success", output: `${id} completed` }
          : { status: "idle" },
      };
    }

    // 找到当前节点到下一节点的 edge
    const edgeAfter = nextId
      ? edges.find(e => e.source === id && e.target === nextId)
      : undefined;

    result.push({ node, edgeAfter });
  }

  return result;
}

/**
 * NerveCenter — 数字神经中枢（v0.3.2 重构版）
 *
 * 改动：
 * - 中间区域从"自由画布（拖拽 + transform）"改为"垂直滚动列表"
 * - 节点卡片全宽扁平显示，点击展开向下挤开（不覆盖）
 * - 滚轮上下滚动浏览所有节点
 * - 移除 SVG 连线，改为 NodeConnector 视觉分隔符
 * - AI 结果就地嵌入最后节点下方（不再独立显示在顶部）
 * - 节点开始前显示 taskPreview（任务角色说明）
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
  // 最新轮的 AI 回复
  const useRoundsMode = rounds.length > 0;
  const latestRound = rounds[rounds.length - 1];
  const latestAiOutput = useRoundsMode
    ? latestRound?.aiOutput ?? aiOutput
    : aiOutput;

  // 最新轮的节点和 edges（用于推导显示列表）
  const latestEdges = useRoundsMode
    ? (latestRound?.executionEdges ?? [])
    : executionEdges;
  const latestSubagents = useRoundsMode
    ? (latestRound?.subagents ?? subagents)
    : subagents;

  // 按拓扑顺序推导当前轮应显示的节点列表
  const displayEntries = deriveDisplayNodes(latestEdges, latestSubagents);

  // 历史轮次（不含最新轮）
  const historyRounds = useRoundsMode ? rounds.slice(0, -1) : [];

  const isEmpty = displayEntries.length === 0 && historyRounds.length === 0;

  return (
    <div className="flex flex-col h-full">

      {/* ── Top: Orchestrator Brain + 输入栏 ── */}
      <div className="flex-shrink-0 flex flex-col items-center gap-3 px-8 pt-6 pb-3">
        <OrchestratorNode data={orchestrator} />
        <TaskInputBar
          orchestratorState={orchestrator.state}
          onSubmit={onTaskSubmit ?? (() => {})}
          {...(onStop !== undefined && { onStop })}
          providers={providers}
          selectedModel={selectedModel}
          onModelChange={onModelChange}
        />
      </div>

      {/* ── Middle: 垂直滚动节点列表 ── */}
      <div
        className="flex-1 overflow-y-auto"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
      >
        <div className="px-6 pb-6">

          {/* 空状态引导 */}
          {isEmpty && (
            <motion.div
              className="flex flex-col items-center justify-center gap-4 py-16"
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
                Each agent step will appear here as it executes
              </p>
            </motion.div>
          )}

          {/* 历史轮次（半透明，可折叠查看） */}
          {historyRounds.map((round, ri) => {
            const roundEntries = deriveDisplayNodes(round.executionEdges, round.subagents);
            return (
              <div key={`history-round-${ri}`} className="mb-6 opacity-40">
                {/* 历史轮次标签 */}
                <div className="flex items-center gap-2 mb-3">
                  <div className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.06)" }} />
                  <span
                    className="text-xs px-2 py-0.5 rounded"
                    style={{
                      color: "rgba(255,255,255,0.30)",
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid rgba(255,255,255,0.06)",
                      fontSize: "10px",
                    }}
                  >
                    Round {round.roundIndex + 1} · {round.task.slice(0, 28)}{round.task.length > 28 ? "…" : ""}
                  </span>
                  <div className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.06)" }} />
                </div>
                {/* 历史节点列表（只读，不展开） */}
                <div className="flex flex-col">
                  {roundEntries.map(({ node, edgeAfter }, ni) => (
                    <div key={node.id}>
                      <SubagentCard
                        node={node}
                        {...(onNodeRevert !== undefined && { onRevert: onNodeRevert })}
                        {...(onNodeRerun !== undefined && { onRerun: onNodeRerun })}
                      />
                      {ni < roundEntries.length - 1 && (
                        <NodeConnector state={edgeAfter?.state ?? "completed"} />
                      )}
                    </div>
                  ))}
                  {/* 历史轮次的 AI 回复 */}
                  {round.aiOutput && (
                    <div className="mt-3">
                      <AiOutputCard output={round.aiOutput} />
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* 当前轮次分隔线（有历史轮时显示） */}
          {historyRounds.length > 0 && displayEntries.length > 0 && (
            <div className="flex items-center gap-2 mb-4">
              <div className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.06)" }} />
              <span
                className="text-xs px-2 py-0.5 rounded"
                style={{
                  color: "rgba(255,255,255,0.40)",
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  fontSize: "10px",
                }}
              >
                Current · {latestRound?.task.slice(0, 28)}{(latestRound?.task.length ?? 0) > 28 ? "…" : ""}
              </span>
              <div className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.06)" }} />
            </div>
          )}

          {/* 当前轮次节点列表（动态生长） */}
          <AnimatePresence>
            {displayEntries.map(({ node, edgeAfter }, idx) => (
              <motion.div
                key={node.id}
                initial={{ opacity: 0, y: -12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.35, ease: [0.23, 1, 0.32, 1] }}
              >
                <SubagentCard
                  node={node}
                  {...(onNodeRevert !== undefined && { onRevert: onNodeRevert })}
                  {...(onNodeRerun !== undefined && { onRerun: onNodeRerun })}
                />
                {/* 节点间 Connector（非最后一个节点） */}
                {idx < displayEntries.length - 1 && (
                  <NodeConnector state={edgeAfter?.state} />
                )}
              </motion.div>
            ))}
          </AnimatePresence>

          {/* AI 最终回复（内嵌在节点列表末尾，Run 完成后淡入） */}
          {latestAiOutput && displayEntries.length > 0 && (
            <motion.div
              key="ai-output-inline"
              className="mt-3"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: "easeOut" }}
            >
              <AiOutputCard output={latestAiOutput} />
            </motion.div>
          )}

        </div>
      </div>

      {/* ── Bottom: Resource Substrate ── */}
      <div className="flex-shrink-0 px-8 pb-4">
        <ResourceSubstrate mcpTools={mcpTools} skills={skills} />
      </div>

    </div>
  );
}
