import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useLanguage } from "../../i18n/LanguageContext.js";

interface AiOutputCardProps {
  /** AI 输出文本；为 undefined 时隐藏 */
  output: string | undefined;
  /** 是否正在流式输出中（显示打字机光标） */
  isStreaming?: boolean;
  /** 流式 token 累积文本（streaming 过程中实时展示） */
  streamingText?: string;
}

/**
 * AiOutputCard — AI 回复展示卡片（v0.3.5 流式输出支持）
 *
 * 新功能：
 *   - isStreaming: true 时显示闪烁的打字机光标
 *   - streamingText: streaming 过程中实时显示累积的 token
 *   - 完成后光标淡出，最终内容由 output prop 接管
 */
export function AiOutputCard({ output, isStreaming, streamingText }: AiOutputCardProps) {
  const { t } = useLanguage();
  const [copied, setCopied] = useState(false);

  // 显示内容优先级：streaming 过程中用 streamingText，完成后用 output
  const displayText = isStreaming ? (streamingText ?? "") : (output ?? "");
  const shouldShow = isStreaming || !!output;

  const handleCopy = () => {
    const content = output ?? streamingText ?? "";
    if (!content) return;
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <AnimatePresence>
      {shouldShow && (
        <motion.div
          key="ai-output-card"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          transition={{ duration: 0.3, ease: "easeOut" }}
          className="w-full max-w-2xl rounded-xl relative overflow-hidden"
          style={{
            background: "rgba(13,17,23,0.80)",
            border: "1px solid rgba(34,197,94,0.18)",
            backdropFilter: "blur(8px)",
          }}
        >
          {/* 顶部微光条（绿色渐变） */}
          <div
            className="absolute top-0 left-0 right-0 h-px"
            style={{
              background: "linear-gradient(90deg, transparent, rgba(34,197,94,0.35), transparent)",
            }}
          />

          {/* 标题栏 */}
          <div
            className="flex items-center justify-between px-4 py-2 border-b"
            style={{ borderColor: "rgba(34,197,94,0.10)" }}
          >
            <div className="flex items-center gap-2">
              {/* 绿色呼吸小点：streaming 时加速闪烁 */}
              <motion.div
                className="w-1.5 h-1.5 rounded-full bg-green-400"
                animate={{ opacity: isStreaming ? [0.3, 1, 0.3] : [0.5, 1, 0.5] }}
                transition={{
                  duration: isStreaming ? 0.8 : 2,
                  repeat: Infinity,
                  ease: "easeInOut",
                }}
              />
              <span
                className="text-xs font-medium tracking-wide"
                style={{ color: "rgba(74,222,128,0.85)" }}
              >
                {isStreaming ? "⟳ Streaming..." : t.aiOutput.title}
              </span>
            </div>

            {/* 复制按钮（streaming 过程中禁用） */}
            {!isStreaming && (
              <motion.button
                onClick={handleCopy}
                className="flex items-center gap-1 text-2xs px-2 py-0.5 rounded"
                style={{
                  color: copied ? "rgba(74,222,128,0.90)" : "rgba(255,255,255,0.30)",
                  background: copied ? "rgba(34,197,94,0.10)" : "transparent",
                  border: "1px solid",
                  borderColor: copied ? "rgba(34,197,94,0.25)" : "rgba(255,255,255,0.08)",
                  fontSize: "10px",
                }}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.97 }}
                transition={{ duration: 0.1 }}
              >
                {copied ? "✓" : "⧉"} {copied ? t.aiOutput.copied : t.aiOutput.copy}
              </motion.button>
            )}
          </div>

          {/* 内容区 */}
          <div className="px-4 py-3">
            <pre
              className="font-mono text-sm whitespace-pre-wrap break-words leading-relaxed"
              style={{ color: "rgba(255,255,255,0.72)" }}
            >
              {displayText}
              {/* 打字机光标（仅 streaming 时显示） */}
              {isStreaming && (
                <motion.span
                  className="inline-block w-0.5 h-4 ml-0.5 bg-green-400 align-middle"
                  animate={{ opacity: [1, 0, 1] }}
                  transition={{ duration: 0.6, repeat: Infinity, ease: "linear" }}
                  style={{ verticalAlign: "text-bottom" }}
                />
              )}
            </pre>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
