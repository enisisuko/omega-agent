import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { SubagentNode, SubagentCardState } from "../../types/ui.js";
import { NodeDetailPanel } from "./NodeDetailPanel.js";

interface SubagentCardProps {
  node: SubagentNode;
  /** 撤回某步骤回调 */
  onRevert?: (nodeId: string, stepId: string) => void;
  /** 重新生成回调 */
  onRerun?: (nodeId: string, stepId: string, editedPrompt: string) => void;
}

/** 节点类型图标 */
const NODE_TYPE_ICONS: Record<SubagentNode["type"], string> = {
  LLM: "◈",
  TOOL: "⚙",
  PLANNING: "◎",
  REFLECTION: "◇",
  MEMORY: "▣",
};

/**
 * 节点类型左侧彩色竖条颜色（4px 宽，全高，用于区分节点身份）
 * 参考 ICEE 色彩系统：紫/青/蓝/金/玫红
 */
const TYPE_ACCENT: Record<SubagentNode["type"], string> = {
  PLANNING:   "rgba(167,139,250,0.80)",  // 紫色 — Planner
  MEMORY:     "rgba(34,211,238,0.80)",   // 青色 — Context
  LLM:        "rgba(96,165,250,0.80)",   // 蓝色 — Executor
  REFLECTION: "rgba(251,191,36,0.80)",   // 金色 — Reflector
  TOOL:       "rgba(251,113,133,0.80)",  // 玫红 — Tool
};

/** 根据状态返回边框颜色 */
function getBorderColor(state: SubagentCardState): string {
  switch (state.status) {
    case "running": return "rgba(96, 165, 250, 0.35)";
    case "success": return "rgba(52, 211, 153, 0.25)";
    case "error":   return "rgba(248, 113, 113, 0.35)";
    case "autofix": return "rgba(251, 191, 36, 0.45)";
    default:        return "rgba(255, 255, 255, 0.05)";
  }
}

/** 根据状态返回发光投影 */
function getBoxShadow(state: SubagentCardState): string {
  switch (state.status) {
    case "running": return "0 2px 16px rgba(96, 165, 250, 0.10)";
    case "success": return "0 2px 12px rgba(52, 211, 153, 0.08)";
    case "error":   return "0 2px 12px rgba(248, 113, 113, 0.10)";
    case "autofix": return "0 2px 18px rgba(251, 191, 36, 0.15)";
    default:        return "none";
  }
}

/** 状态标签文字 */
function getStatusLabel(state: SubagentCardState): { text: string; color: string } {
  switch (state.status) {
    case "idle":    return { text: "waiting", color: "rgba(255,255,255,0.22)" };
    case "running": return { text: "running",  color: "#60a5fa" };
    case "success": return { text: "done",     color: "#34d399" };
    case "error":   return { text: "error",    color: "#f87171" };
    case "autofix": return { text: "autofix",  color: "#fbbf24" };
  }
}

/**
 * SubagentCard — 全宽扁平执行节点卡片（v0.3.2 重构版）
 *
 * 设计改动：
 * - 全宽（w-full）扁平横向卡片，适配垂直列表布局
 * - 左侧 4px 彩色竖条标识节点类型
 * - idle/running 初始阶段显示 taskPreview（任务概览说明）
 * - 点击卡片头部展开步骤历史（向下挤开，不覆盖）
 * - 展开条件放宽：只要有 steps 就可展开（包含 running 中）
 *
 * 状态转换：idle → running → error → autofix → success
 */
export function SubagentCard({ node, onRevert, onRerun }: SubagentCardProps) {
  const { state } = node;
  const statusLabel = getStatusLabel(state);
  const isActive = state.status === "running" || state.status === "autofix";

  // 是否展开步骤历史面板
  const [expanded, setExpanded] = useState(false);

  // 有 steps 记录才显示展开按钮（放宽：running 中也可展开）
  const hasSteps = (node.steps?.length ?? 0) > 0;
  const canExpand = hasSteps && state.status !== "idle";

  function handleHeaderClick() {
    if (!canExpand) return;
    setExpanded((v) => !v);
  }

  function handleRevert(nodeId: string, stepId: string) {
    onRevert?.(nodeId, stepId);
  }

  function handleRerun(nodeId: string, stepId: string, editedPrompt: string) {
    onRerun?.(nodeId, stepId, editedPrompt);
  }

  const accentColor = TYPE_ACCENT[node.type] ?? "rgba(255,255,255,0.20)";

  return (
    <div className="relative w-full">
      {/* ── 主卡片 ─────────────────────────────── */}
      <motion.div
        className="relative w-full rounded-lg overflow-hidden select-none"
        style={{
          background: state.status === "idle"
            ? "rgba(10, 12, 16, 0.70)"
            : "rgba(13, 15, 21, 0.90)",
          border: `1px solid ${getBorderColor(state)}`,
          boxShadow: getBoxShadow(state),
          // 展开时底部圆角移除，与详情面板无缝衔接
          borderBottomLeftRadius: expanded ? 0 : undefined,
          borderBottomRightRadius: expanded ? 0 : undefined,
        }}
        animate={{
          border: `1px solid ${getBorderColor(state)}`,
          boxShadow: getBoxShadow(state),
          opacity: state.status === "idle" ? 0.65 : 1,
        }}
        transition={{ duration: 0.3, ease: "easeOut" }}
      >
        {/* 左侧类型彩色竖条 */}
        <div
          style={{
            position: "absolute",
            top: 0, left: 0, bottom: 0,
            width: "3px",
            background: accentColor,
            borderRadius: "8px 0 0 8px",
            zIndex: 1,
          }}
        />

        {/* Running 状态: 顶部流光扫描条 */}
        {state.status === "running" && (
          <motion.div
            className="absolute top-0 left-0 h-px"
            style={{ background: "rgba(255,255,255,0.70)", zIndex: 2 }}
            animate={{ width: ["0%", "100%"] }}
            transition={{ duration: 2.0, repeat: Infinity, ease: "linear" }}
          />
        )}

        {/* AutoFix 状态: 金色半透明蒙版 */}
        <AnimatePresence>
          {state.status === "autofix" && (
            <motion.div
              key="autofix-overlay"
              className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 rounded"
              style={{ background: "rgba(251, 191, 36, 0.06)" }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              <span className="text-xs font-medium" style={{ color: "#fbbf24" }}>
                ✦ Skill Applied
              </span>
              <span className="text-2xs" style={{ color: "rgba(251,191,36,0.60)" }}>
                {state.skillName}
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── 卡片头部（可点击展开） ── */}
        <div
          className="flex items-center gap-3 pl-5 pr-4 py-3"
          style={{ cursor: canExpand ? "pointer" : "default" }}
          onClick={handleHeaderClick}
          title={canExpand ? (expanded ? "收起步骤历史" : "展开步骤历史") : undefined}
        >
          {/* 类型图标 */}
          <span
            className="text-base flex-shrink-0"
            style={{ color: accentColor, fontFamily: "monospace", lineHeight: 1 }}
          >
            {NODE_TYPE_ICONS[node.type]}
          </span>

          {/* 节点标签 */}
          <span
            className="text-sm font-medium flex-shrink-0"
            style={{ color: "rgba(255,255,255,0.80)" }}
          >
            {node.label}
          </span>

          {/* 节点类型 badge */}
          <span
            className="text-2xs font-mono px-1.5 py-0.5 rounded flex-shrink-0"
            style={{
              color: accentColor,
              background: accentColor.replace("0.80)", "0.08)"),
              border: `1px solid ${accentColor.replace("0.80)", "0.20)")}`,
              fontSize: "10px",
            }}
          >
            {node.type}
          </span>

          {/* 弹性间距 */}
          <div className="flex-1" />

          {/* 右侧：状态指示 */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* 状态点（running/autofix 时呼吸闪烁） */}
            <motion.div
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: statusLabel.color }}
              animate={isActive ? { opacity: [0.4, 1, 0.4] } : { opacity: 1 }}
              transition={{ duration: 1.8, repeat: isActive ? Infinity : 0 }}
            />
            {/* 状态文字 */}
            <span
              className="text-xs"
              style={{ color: statusLabel.color, minWidth: "46px", textAlign: "right" }}
            >
              {statusLabel.text}
            </span>
            {/* 步骤计数 */}
            {hasSteps && (
              <span
                className="text-2xs px-1.5 py-0.5 rounded-full font-mono"
                style={{
                  background: "rgba(255,255,255,0.06)",
                  color: "rgba(255,255,255,0.28)",
                  fontSize: "10px",
                }}
              >
                {node.steps!.length}
              </span>
            )}
            {/* 展开箭头 */}
            {canExpand && (
              <motion.span
                className="text-xs flex-shrink-0"
                style={{ color: "rgba(255,255,255,0.22)", lineHeight: 1 }}
                animate={{ rotate: expanded ? 180 : 0 }}
                transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
              >
                ▾
              </motion.span>
            )}
          </div>
        </div>

        {/* ── 卡片内容区 ── */}
        <AnimatePresence mode="wait">
          {/* idle 状态：显示任务概览说明 */}
          {state.status === "idle" && node.taskPreview && (
            <motion.div
              key="idle-preview"
              className="pl-5 pr-4 pb-3"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              <p
                className="text-xs leading-relaxed"
                style={{ color: "rgba(255,255,255,0.28)", borderLeft: `2px solid ${accentColor.replace("0.80)", "0.25)")}`, paddingLeft: "8px" }}
              >
                {node.taskPreview}
              </p>
            </motion.div>
          )}

          {/* running 状态：显示任务概览 + 当前任务 + 打字光标 */}
          {state.status === "running" && (
            <motion.div
              key="running-content"
              className="pl-5 pr-4 pb-3 space-y-2"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              {/* 任务概览（节点角色说明） */}
              {node.taskPreview && (
                <p
                  className="text-xs"
                  style={{ color: "rgba(255,255,255,0.38)", borderLeft: `2px solid ${accentColor.replace("0.80)", "0.30)")}`, paddingLeft: "8px" }}
                >
                  {node.taskPreview}
                </p>
              )}
              {/* 当前执行消息 */}
              <p className="text-xs leading-relaxed" style={{ color: "rgba(255,255,255,0.55)" }}>
                {state.currentTask.length > 80
                  ? state.currentTask.slice(0, 80) + "..."
                  : state.currentTask}
                {/* 打字光标 */}
                <motion.span
                  className="inline-block ml-0.5 w-1 h-3 rounded-sm align-middle"
                  style={{ background: "rgba(96,165,250,0.70)" }}
                  animate={{ opacity: [1, 1, 0, 0] }}
                  transition={{ duration: 0.8, repeat: Infinity, ease: "linear" }}
                />
              </p>
            </motion.div>
          )}

          {/* error 状态 */}
          {state.status === "error" && (
            <motion.div
              key="error-content"
              className="pl-5 pr-4 pb-3"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              <p className="text-xs" style={{ color: "#f87171" }}>
                {state.errorMsg.length > 120 ? state.errorMsg.slice(0, 120) + "..." : state.errorMsg}
              </p>
            </motion.div>
          )}

          {/* success 状态：显示输出摘要 */}
          {state.status === "success" && (
            <motion.div
              key="success-content"
              className="pl-5 pr-4 pb-3"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
            >
              <p className="text-xs leading-relaxed" style={{ color: "rgba(52,211,153,0.75)" }}>
                {state.output.length > 120 ? state.output.slice(0, 120) + "..." : state.output}
                {state.tokens !== undefined && (
                  <span className="ml-2 text-2xs" style={{ color: "rgba(255,255,255,0.18)" }}>
                    {state.tokens} tokens
                  </span>
                )}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* ── 展开的步骤历史面板（向下挤开，不覆盖） ── */}
      <AnimatePresence>
        {expanded && canExpand && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.28, ease: [0.23, 1, 0.32, 1] }}
            style={{ overflow: "hidden" }}
          >
            <NodeDetailPanel
              node={node}
              onRevert={handleRevert}
              onRerun={handleRerun}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
