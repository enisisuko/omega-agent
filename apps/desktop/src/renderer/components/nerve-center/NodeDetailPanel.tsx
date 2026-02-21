import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { NodeStepRecord, SubagentNode } from "../../types/ui.js";
import { RerunModal } from "./RerunModal.js";

interface NodeDetailPanelProps {
  node: SubagentNode;
  /** 撤回某步骤回调（将该步及后续标记为 reverted） */
  onRevert: (nodeId: string, stepId: string) => void;
  /** 重新生成回调（打开 RerunModal 后确认触发） */
  onRerun: (nodeId: string, stepId: string, editedPrompt: string) => void;
}

/** 状态对应颜色配置 */
const STATUS_COLOR: Record<NodeStepRecord["status"], { text: string; dot: string; bg: string }> = {
  running:  { text: "#60a5fa", dot: "#60a5fa", bg: "rgba(96,165,250,0.08)" },
  success:  { text: "#34d399", dot: "#34d399", bg: "rgba(52,211,153,0.06)" },
  error:    { text: "#f87171", dot: "#f87171", bg: "rgba(248,113,113,0.08)" },
  reverted: { text: "rgba(255,255,255,0.25)", dot: "rgba(255,255,255,0.18)", bg: "rgba(255,255,255,0.03)" },
};

/** 格式化耗时 */
function fmtDuration(ms?: number): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 截断长文本 */
function truncate(text: string, max = 120): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/**
 * NodeDetailPanel — 节点展开详情面板
 *
 * 设计：卡片下方向下展开的附属面板，
 * 显示该节点所有历史执行步骤（Step History），
 * 每步可单独撤回或重新生成（带 Prompt 编辑）。
 *
 * 交互：
 * - 每条步骤记录可展开查看完整 input/output
 * - "Revert" 按钮：将该步标记为已撤回，清除下游节点
 * - "Rerun" 按钮：打开 RerunModal，可编辑 prompt 后重新执行
 */
export function NodeDetailPanel({ node, onRevert, onRerun }: NodeDetailPanelProps) {
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);
  const [rerunStep, setRerunStep] = useState<NodeStepRecord | null>(null);
  const [rerunModalOpen, setRerunModalOpen] = useState(false);

  const steps = node.steps ?? [];

  function handleRerunClick(step: NodeStepRecord) {
    setRerunStep(step);
    setRerunModalOpen(true);
  }

  function handleRerunConfirm(nodeId: string, stepId: string, editedPrompt: string) {
    onRerun(nodeId, stepId, editedPrompt);
  }

  return (
    <>
      {/* 主面板 */}
      <div
        className="rounded-b-md overflow-hidden"
        style={{
          background: "rgba(8, 10, 15, 0.97)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderTop: "none",
          marginTop: -1,
        }}
      >
        {/* 面板标题栏 */}
        <div
          className="flex items-center gap-2 px-3 py-2 border-b"
          style={{ borderColor: "rgba(255,255,255,0.05)" }}
        >
          <span className="text-2xs font-mono uppercase tracking-widest" style={{ color: "rgba(255,255,255,0.28)" }}>
            Step History
          </span>
          <span
            className="text-2xs px-1.5 py-0.5 rounded-full font-mono"
            style={{
              background: "rgba(255,255,255,0.06)",
              color: "rgba(255,255,255,0.35)",
            }}
          >
            {steps.length}
          </span>
        </div>

        {/* 步骤列表 */}
        {steps.length === 0 ? (
          <div className="px-3 py-4 text-center">
            <p className="text-xs" style={{ color: "rgba(255,255,255,0.20)" }}>
              No step history yet
            </p>
          </div>
        ) : (
          <div className="divide-y" style={{ borderColor: "rgba(255,255,255,0.04)" }}>
            {steps.map((step, idx) => {
              const colors = STATUS_COLOR[step.status];
              const isExpanded = expandedStepId === step.id;
              const isReverted = step.status === "reverted";

              return (
                <div key={step.id} style={{ opacity: isReverted ? 0.5 : 1 }}>
                  {/* 步骤行头 */}
                  <div
                    className="flex items-center gap-2 px-3 py-2 cursor-pointer group"
                    style={{ background: isExpanded ? colors.bg : "transparent", transition: "background 0.15s" }}
                    onClick={() => setExpandedStepId(isExpanded ? null : step.id)}
                  >
                    {/* 序号 + 状态点 */}
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <span
                        className="w-4 h-4 rounded-sm flex items-center justify-center text-2xs font-mono"
                        style={{
                          background: "rgba(255,255,255,0.06)",
                          color: "rgba(255,255,255,0.30)",
                        }}
                      >
                        {idx + 1}
                      </span>
                      <motion.div
                        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                        style={{ background: colors.dot }}
                        animate={step.status === "running" ? { opacity: [0.4, 1, 0.4] } : {}}
                        transition={{ duration: 1.5, repeat: step.status === "running" ? Infinity : 0 }}
                      />
                    </div>

                    {/* 步骤摘要 */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs truncate" style={{ color: "rgba(255,255,255,0.60)" }}>
                          {step.isRerun ? "↻ Rerun" : `Step #${step.index}`}
                        </span>
                        <span className="text-2xs flex-shrink-0" style={{ color: colors.text }}>
                          {step.status}
                        </span>
                        {step.tokens !== undefined && (
                          <span className="text-2xs flex-shrink-0 font-mono" style={{ color: "rgba(255,255,255,0.20)" }}>
                            {step.tokens}t
                          </span>
                        )}
                        <span className="text-2xs flex-shrink-0 font-mono" style={{ color: "rgba(255,255,255,0.20)" }}>
                          {fmtDuration(step.durationMs)}
                        </span>
                      </div>
                      {/* 输出摘要 */}
                      {step.output && (
                        <p className="text-2xs truncate mt-0.5" style={{ color: "rgba(255,255,255,0.30)" }}>
                          {truncate(step.output, 60)}
                        </p>
                      )}
                    </div>

                    {/* 展开箭头 */}
                    <motion.span
                      className="text-xs flex-shrink-0"
                      style={{ color: "rgba(255,255,255,0.25)" }}
                      animate={{ rotate: isExpanded ? 180 : 0 }}
                      transition={{ duration: 0.2 }}
                    >
                      ▾
                    </motion.span>
                  </div>

                  {/* 展开详情 */}
                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
                        style={{ overflow: "hidden" }}
                      >
                        <div
                          className="px-3 pb-3 space-y-3"
                          style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}
                        >
                          {/* Prompt（LLM 节点才有） */}
                          {step.prompt && (
                            <div className="pt-3">
                              <p className="text-2xs mb-1.5 uppercase tracking-wider font-mono" style={{ color: "rgba(255,255,255,0.25)" }}>
                                Prompt sent
                              </p>
                              <div
                                className="rounded p-2 text-xs font-mono leading-relaxed"
                                style={{
                                  background: "rgba(96,165,250,0.06)",
                                  border: "1px solid rgba(96,165,250,0.15)",
                                  color: "rgba(255,255,255,0.60)",
                                  maxHeight: 120,
                                  overflowY: "auto",
                                  wordBreak: "break-word",
                                  whiteSpace: "pre-wrap",
                                }}
                              >
                                {step.prompt}
                              </div>
                            </div>
                          )}

                          {/* Input */}
                          {step.input && !step.prompt && (
                            <div className="pt-3">
                              <p className="text-2xs mb-1.5 uppercase tracking-wider font-mono" style={{ color: "rgba(255,255,255,0.25)" }}>
                                Input
                              </p>
                              <div
                                className="rounded p-2 text-xs font-mono leading-relaxed"
                                style={{
                                  background: "rgba(255,255,255,0.04)",
                                  border: "1px solid rgba(255,255,255,0.08)",
                                  color: "rgba(255,255,255,0.55)",
                                  maxHeight: 100,
                                  overflowY: "auto",
                                  wordBreak: "break-word",
                                  whiteSpace: "pre-wrap",
                                }}
                              >
                                {step.input}
                              </div>
                            </div>
                          )}

                          {/* Output */}
                          {step.output && (
                            <div>
                              <p className="text-2xs mb-1.5 uppercase tracking-wider font-mono" style={{ color: "rgba(52,211,153,0.40)" }}>
                                Output
                              </p>
                              <div
                                className="rounded p-2 text-xs font-mono leading-relaxed"
                                style={{
                                  background: "rgba(52,211,153,0.05)",
                                  border: "1px solid rgba(52,211,153,0.15)",
                                  color: "rgba(52,211,153,0.75)",
                                  maxHeight: 120,
                                  overflowY: "auto",
                                  wordBreak: "break-word",
                                  whiteSpace: "pre-wrap",
                                }}
                              >
                                {step.output}
                              </div>
                            </div>
                          )}

                          {/* 错误信息 */}
                          {step.errorMsg && (
                            <div>
                              <p className="text-2xs mb-1.5 uppercase tracking-wider font-mono" style={{ color: "rgba(248,113,113,0.40)" }}>
                                Error
                              </p>
                              <div
                                className="rounded p-2 text-xs font-mono leading-relaxed"
                                style={{
                                  background: "rgba(248,113,113,0.06)",
                                  border: "1px solid rgba(248,113,113,0.20)",
                                  color: "#f87171",
                                }}
                              >
                                {step.errorMsg}
                              </div>
                            </div>
                          )}

                          {/* 操作按钮行 */}
                          {!isReverted && (
                            <div className="flex items-center gap-2 pt-1">
                              {/* 撤回按钮 */}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onRevert(node.id, step.id);
                                }}
                                className="flex items-center gap-1 px-2.5 py-1 rounded text-2xs"
                                style={{
                                  background: "rgba(248,113,113,0.08)",
                                  border: "1px solid rgba(248,113,113,0.20)",
                                  color: "#f87171",
                                  cursor: "pointer",
                                }}
                              >
                                <span>⤺</span>
                                <span>Revert this step</span>
                              </button>

                              {/* 重新生成按钮 */}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRerunClick(step);
                                }}
                                className="flex items-center gap-1 px-2.5 py-1 rounded text-2xs"
                                style={{
                                  background: "rgba(96,165,250,0.10)",
                                  border: "1px solid rgba(96,165,250,0.25)",
                                  color: "#60a5fa",
                                  cursor: "pointer",
                                }}
                              >
                                <span>↻</span>
                                <span>Rerun from here</span>
                              </button>
                            </div>
                          )}

                          {/* 已撤回标记 */}
                          {isReverted && (
                            <div className="flex items-center gap-1.5 pt-1">
                              <span className="text-2xs" style={{ color: "rgba(255,255,255,0.25)" }}>⤺</span>
                              <span className="text-2xs" style={{ color: "rgba(255,255,255,0.25)" }}>
                                This step has been reverted
                              </span>
                            </div>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Rerun 对话框 */}
      <RerunModal
        open={rerunModalOpen}
        nodeId={node.id}
        nodeLabel={node.label}
        step={rerunStep}
        onConfirm={handleRerunConfirm}
        onClose={() => setRerunModalOpen(false)}
      />
    </>
  );
}
