import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import type { TraceLogEntry } from "../../types/ui.js";
import { useLanguage } from "../../i18n/LanguageContext.js";

interface TraceLogDrawerProps {
  entries: TraceLogEntry[];
}

/** 条目类型对应的颜色和标签 */
const TYPE_STYLE: Record<TraceLogEntry["type"], { color: string; label: string }> = {
  MCP_CALL:    { color: "#fb7185", label: "MCP" },
  SKILL_MATCH: { color: "#fbbf24", label: "SKILL" },
  AGENT_ACT:   { color: "#a78bfa", label: "AGENT" },
  SYSTEM:      { color: "rgba(255,255,255,0.25)", label: "SYS" },
};

/**
 * TraceLogDrawer — 右侧执行终端
 * 高速滚动展示 Agent 执行过程，严格区分三种事件颜色
 */
export function TraceLogDrawer({ entries }: TraceLogDrawerProps) {
  const { t } = useLanguage();
  const scrollRef = useRef<HTMLDivElement>(null);

  // 新条目进来时自动滚到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries]);

  return (
    <div
      className="flex flex-col h-full rounded-lg overflow-hidden"
      style={{
        background: "rgba(8, 9, 12, 0.90)",
        border: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      {/* 标题栏 */}
      <div
        className="flex items-center gap-2 px-4 py-3 border-b flex-shrink-0"
        style={{ borderColor: "rgba(255,255,255,0.06)" }}
      >
        {/* 录制指示点 */}
        <motion.div
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: "#f87171" }}
          animate={{ opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 1.5, repeat: Infinity }}
        />
        <span className="text-xs text-white/40 tracking-widest uppercase">{t.traceLog.title}</span>
        <span className="ml-auto text-2xs font-mono text-white/20">{entries.length} {t.traceLog.events}</span>
      </div>

      {/* 日志区域 */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto py-2"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {entries.map((entry, i) => {
          const style = TYPE_STYLE[entry.type];
          // 上下文压缩警告：SYSTEM 类型且包含 "Context approaching limit" 关键字
          const isContextWarn = entry.type === "SYSTEM" && entry.message.includes("Context approaching limit");
          return (
            <motion.div
              key={entry.id}
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.15, delay: i < entries.length - 3 ? 0 : (i - (entries.length - 3)) * 0.05 }}
              className="flex items-start gap-2 px-4 py-1 group hover:bg-white/[0.02] transition-colors"
              style={isContextWarn ? {
                background: "rgba(251,191,36,0.06)",
                borderLeft: "2px solid rgba(251,191,36,0.50)",
                borderRadius: "0 4px 4px 0",
              } : undefined}
            >
              {/* 时间戳 */}
              <span className="text-2xs flex-shrink-0 mt-0.5" style={{ color: "rgba(255,255,255,0.18)", minWidth: "48px" }}>
                {entry.timestamp}
              </span>

              {/* 类型标签 */}
              <span
                className="text-2xs flex-shrink-0 mt-0.5 font-medium"
                style={{
                  color: isContextWarn ? "#fbbf24" : style.color,
                  minWidth: "36px",
                  opacity: isContextWarn ? 1 : 0.70,
                }}
              >
                {style.label}
              </span>

              {/* 消息内容 */}
              <div className="flex-1 min-w-0">
                <span
                  className="text-xs leading-relaxed break-all"
                  style={{ color: isContextWarn ? "rgba(251,191,36,0.85)" : "rgba(255,255,255,0.55)" }}
                >
                  {entry.message}
                </span>
                {entry.details && (
                  <span className="text-2xs block mt-0.5" style={{ color: style.color, opacity: 0.55 }}>
                    {entry.details}
                  </span>
                )}
              </div>
            </motion.div>
          );
        })}

        {/* 末尾光标 */}
        <div className="flex items-center gap-2 px-4 py-1">
          <span className="text-2xs" style={{ color: "rgba(255,255,255,0.18)", minWidth: "48px" }} />
          <motion.span
            className="inline-block w-1.5 h-3"
            style={{ background: "rgba(255,255,255,0.20)", borderRadius: "1px" }}
            animate={{ opacity: [1, 1, 0, 0] }}
          transition={{ duration: 0.8, repeat: Infinity, ease: "linear" }}
          />
        </div>
      </div>
    </div>
  );
}
