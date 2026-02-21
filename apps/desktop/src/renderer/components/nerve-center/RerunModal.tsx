import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { NodeStepRecord } from "../../types/ui.js";

interface RerunModalProps {
  /** 是否显示 */
  open: boolean;
  /** 节点 ID */
  nodeId: string;
  /** 节点名称 */
  nodeLabel: string;
  /** 要重跑的步骤记录（提供初始 prompt） */
  step: NodeStepRecord | null;
  /** 确认重跑回调：传出编辑后的 prompt */
  onConfirm: (nodeId: string, stepId: string, editedPrompt: string) => void;
  /** 关闭回调 */
  onClose: () => void;
}

/**
 * RerunModal — 重新生成对话框
 *
 * 功能：
 * - 显示本次步骤的原始 Prompt（可完整编辑 / 重写）
 * - 同时展示上一次的 input / output 作为参考
 * - 确认后触发重跑，不影响其他节点
 *
 * 设计：毛玻璃背景遮罩 + 居中卡片，"Quiet Intelligence" 风格
 */
export function RerunModal({ open, nodeId, nodeLabel, step, onConfirm, onClose }: RerunModalProps) {
  const [editedPrompt, setEditedPrompt] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 每次打开时重置 prompt 为上一步的值
  useEffect(() => {
    if (open && step) {
      setEditedPrompt(step.prompt ?? step.input ?? "");
      // 稍后聚焦，等动画完成
      setTimeout(() => textareaRef.current?.focus(), 200);
    }
  }, [open, step]);

  // Esc 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    if (open) document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  function handleConfirm() {
    if (!step) return;
    onConfirm(nodeId, step.id, editedPrompt);
    onClose();
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* 遮罩层 */}
          <motion.div
            className="fixed inset-0 z-50"
            style={{ background: "rgba(0,0,0,0.60)", backdropFilter: "blur(4px)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
          />

          {/* 对话框卡片 */}
          <motion.div
            className="fixed z-50 left-1/2 top-1/2 w-[560px] max-w-[90vw]"
            style={{ transform: "translate(-50%, -50%)" }}
            initial={{ opacity: 0, scale: 0.94, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: 8 }}
            transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="rounded-lg overflow-hidden"
              style={{
                background: "rgba(10, 12, 18, 0.97)",
                border: "1px solid rgba(255,255,255,0.10)",
                boxShadow: "0 24px 64px rgba(0,0,0,0.60), 0 0 0 1px rgba(96,165,250,0.08)",
              }}
            >
              {/* 顶部标题栏 */}
              <div
                className="flex items-center gap-3 px-5 py-4 border-b"
                style={{ borderColor: "rgba(255,255,255,0.07)" }}
              >
                {/* 节点类型图标 */}
                <div
                  className="w-7 h-7 rounded flex items-center justify-center flex-shrink-0"
                  style={{ background: "rgba(96,165,250,0.12)", border: "1px solid rgba(96,165,250,0.25)" }}
                >
                  <span className="text-xs font-mono" style={{ color: "#60a5fa" }}>↻</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold truncate" style={{ color: "rgba(255,255,255,0.85)" }}>
                    Rerun Node — {nodeLabel}
                  </p>
                  <p className="text-2xs mt-0.5" style={{ color: "rgba(255,255,255,0.30)" }}>
                    Edit the prompt below to modify what gets sent to the AI
                  </p>
                </div>
                {/* 关闭按钮 */}
                <button
                  onClick={onClose}
                  className="w-6 h-6 flex items-center justify-center rounded flex-shrink-0"
                  style={{ color: "rgba(255,255,255,0.35)" }}
                >
                  <span className="text-base leading-none">×</span>
                </button>
              </div>

              {/* 上一次 input/output 参考（折叠展示） */}
              {(step?.input ?? step?.output) && (
                <div
                  className="px-5 py-3 border-b"
                  style={{ borderColor: "rgba(255,255,255,0.05)", background: "rgba(255,255,255,0.02)" }}
                >
                  <p className="text-2xs mb-2 uppercase tracking-wider font-mono" style={{ color: "rgba(255,255,255,0.25)" }}>
                    Previous result (step #{step?.index})
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    {step?.input && (
                      <div>
                        <p className="text-2xs mb-1" style={{ color: "rgba(255,255,255,0.30)" }}>Input</p>
                        <p
                          className="text-xs leading-relaxed line-clamp-3"
                          style={{ color: "rgba(255,255,255,0.50)", fontFamily: "monospace" }}
                        >
                          {step.input}
                        </p>
                      </div>
                    )}
                    {step?.output && (
                      <div>
                        <p className="text-2xs mb-1" style={{ color: "rgba(52,211,153,0.50)" }}>Output</p>
                        <p
                          className="text-xs leading-relaxed line-clamp-3"
                          style={{ color: "rgba(52,211,153,0.65)", fontFamily: "monospace" }}
                        >
                          {step.output}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Prompt 编辑区 */}
              <div className="px-5 py-4">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-2xs uppercase tracking-wider font-mono" style={{ color: "rgba(255,255,255,0.35)" }}>
                    Prompt / Input to send
                  </label>
                  {/* 重置按钮 */}
                  <button
                    className="text-2xs px-2 py-0.5 rounded"
                    style={{
                      color: "rgba(255,255,255,0.30)",
                      border: "1px solid rgba(255,255,255,0.10)",
                      background: "transparent",
                    }}
                    onClick={() => setEditedPrompt(step?.prompt ?? step?.input ?? "")}
                  >
                    Reset
                  </button>
                </div>

                <textarea
                  ref={textareaRef}
                  value={editedPrompt}
                  onChange={(e) => setEditedPrompt(e.target.value)}
                  rows={7}
                  className="w-full rounded resize-none outline-none text-xs leading-relaxed font-mono"
                  placeholder="Enter the prompt or input to send to the node..."
                  style={{
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.10)",
                    color: "rgba(255,255,255,0.80)",
                    padding: "10px 12px",
                    caretColor: "#60a5fa",
                    transition: "border-color 0.2s",
                  }}
                  onFocus={(e) => {
                    e.currentTarget.style.borderColor = "rgba(96,165,250,0.40)";
                  }}
                  onBlur={(e) => {
                    e.currentTarget.style.borderColor = "rgba(255,255,255,0.10)";
                  }}
                />

                {/* 字符计数 */}
                <p className="text-right text-2xs mt-1" style={{ color: "rgba(255,255,255,0.18)" }}>
                  {editedPrompt.length} chars
                </p>
              </div>

              {/* 底部操作栏 */}
              <div
                className="flex items-center justify-between px-5 pb-4 pt-1 gap-3"
              >
                <p className="text-2xs flex-1" style={{ color: "rgba(255,255,255,0.22)" }}>
                  This will rerun from this node. Downstream nodes will be cleared.
                </p>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={onClose}
                    className="px-3 py-1.5 rounded text-xs"
                    style={{
                      background: "rgba(255,255,255,0.06)",
                      border: "1px solid rgba(255,255,255,0.10)",
                      color: "rgba(255,255,255,0.55)",
                    }}
                  >
                    Cancel
                  </button>
                  <motion.button
                    onClick={handleConfirm}
                    className="px-4 py-1.5 rounded text-xs font-medium flex items-center gap-1.5"
                    style={{
                      background: "rgba(96,165,250,0.18)",
                      border: "1px solid rgba(96,165,250,0.35)",
                      color: "#60a5fa",
                    }}
                    whileHover={{ background: "rgba(96,165,250,0.26)" }}
                    whileTap={{ scale: 0.97 }}
                    transition={{ duration: 0.12 }}
                  >
                    <span>↻</span>
                    <span>Rerun from here</span>
                  </motion.button>
                </div>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
