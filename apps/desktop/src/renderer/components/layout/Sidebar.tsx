import { motion, AnimatePresence } from "framer-motion";
import type { SidebarRoute, ConversationSession } from "../../types/ui.js";
import { useLanguage } from "../../i18n/LanguageContext.js";

interface SidebarProps {
  activeRoute: SidebarRoute;
  onNavigate: (route: SidebarRoute) => void;
  /** 当前激活的会话 ID */
  activeSessionId: string | null;
  /** 会话历史列表（按时间倒序） */
  sessions: ConversationSession[];
  /** 切换会话 */
  onSelectSession: (sessionId: string) => void;
  /** 新建会话 */
  onNewChat: () => void;
  /** Ollama 连接状态（来自 onOllamaStatus IPC 事件） */
  ollamaConnected?: boolean;
}

/** 导航按钮基础配置（label 在渲染时从 i18n 字典获取） */
const NAV_ROUTES: Array<{ route: SidebarRoute; icon: string; labelKey: keyof { dashboard: string; artifacts: string; settings: string } }> = [
  { route: "dashboard", icon: "⬡", labelKey: "dashboard" },
  { route: "artifacts", icon: "◫", labelKey: "artifacts" },
  { route: "settings",  icon: "◎", labelKey: "settings" },
];

/** 状态颜色映射 */
const SESSION_STATE_COLOR: Record<ConversationSession["state"], string> = {
  idle:      "rgba(255,255,255,0.25)",
  running:   "#60a5fa",   // blue
  completed: "#34d399",   // green
  failed:    "#f87171",   // red
  cancelled: "rgba(255,255,255,0.20)",
};

/**
 * Sidebar — 极简左侧边栏
 *
 * 布局分三区：
 *   ① Logo
 *   ② 页面导航按钮（dashboard / artifacts / settings）
 *   ③ 对话历史区域（New Chat 按钮 + 历史会话列表，仅 dashboard 路由时功能激活）
 *
 * 侧边栏宽度扩展为 200px（之前 52px），
 * 左侧图标 + 右侧文字，采用同一"Quiet Intelligence"风格
 */
export function Sidebar({
  activeRoute,
  onNavigate,
  activeSessionId,
  sessions,
  onSelectSession,
  onNewChat,
  ollamaConnected = false,
}: SidebarProps) {
  const { t } = useLanguage();

  return (
    <div
      className="flex flex-col flex-shrink-0 overflow-hidden"
      style={{
        width: "200px",
        background: "rgba(8, 9, 12, 0.98)",
        borderRight: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      {/* ① Logo — 文字标识 */}
      <div className="flex items-center px-3 py-3 flex-shrink-0">
        <span
          style={{
            fontFamily: "'SF Pro Display', 'Segoe UI', system-ui, sans-serif",
            fontSize: "20px",
            fontWeight: 700,
            letterSpacing: "0.04em",
            color: "rgba(255,255,255,0.92)",
            userSelect: "none",
          }}
        >
          Omega
        </span>
      </div>

      {/* ② 页面导航 */}
      <div className="flex flex-col gap-0.5 px-2 pb-3 flex-shrink-0">
        {NAV_ROUTES.map(item => (
          <NavButton
            key={item.route}
            route={item.route}
            icon={item.icon}
            label={t.sidebar[item.labelKey]}
            isActive={activeRoute === item.route}
            onClick={() => onNavigate(item.route)}
          />
        ))}
      </div>

      {/* 分割线 */}
      <div
        className="mx-3 flex-shrink-0"
        style={{ height: "1px", background: "rgba(255,255,255,0.06)" }}
      />

      {/* ③ 对话历史区域 */}
      <div className="flex flex-col flex-1 overflow-hidden pt-3">
        {/* New Chat 按钮 */}
        <div className="px-2 mb-2 flex-shrink-0">
          <motion.button
            onClick={() => {
              onNewChat();
              onNavigate("dashboard");
            }}
            className="w-full flex items-center gap-2 px-3 py-2 rounded text-left"
            style={{
              background: "rgba(96,165,250,0.08)",
              border: "1px solid rgba(96,165,250,0.15)",
              color: "rgba(96,165,250,0.80)",
              fontSize: "12px",
            }}
            whileHover={{
              background: "rgba(96,165,250,0.14)",
              borderColor: "rgba(96,165,250,0.25)",
            }}
            whileTap={{ scale: 0.97 }}
            transition={{ duration: 0.12 }}
          >
            {/* + icon */}
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ flexShrink: 0 }}>
              <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            <span>{t.sidebar.newChat}</span>
          </motion.button>
        </div>

        {/* 历史会话标题 */}
        <div
          className="px-4 pb-1.5 flex-shrink-0"
          style={{ fontSize: "10px", color: "rgba(255,255,255,0.25)", letterSpacing: "0.08em", textTransform: "uppercase" }}
        >
          {t.sidebar.history}
        </div>

        {/* 会话列表 — 可滚动 */}
        <div className="flex-1 overflow-y-auto px-2" style={{ scrollbarWidth: "none" }}>
          <AnimatePresence initial={false}>
            {sessions.length === 0 ? (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="px-3 py-2"
                style={{ fontSize: "11px", color: "rgba(255,255,255,0.18)" }}
              >
                {t.sidebar.noConversations}
              </motion.div>
            ) : (
              sessions.map((session, i) => (
                <motion.div
                  key={session.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.18, delay: i * 0.04 }}
                >
                  <SessionItem
                    session={session}
                    isActive={activeSessionId === session.id}
                    onSelect={() => {
                      onSelectSession(session.id);
                      onNavigate("dashboard");
                    }}
                  />
                </motion.div>
              ))
            )}
          </AnimatePresence>
        </div>

        {/* ④ Ollama 连接状态栏 — 底部 */}
        <div
          className="flex-shrink-0 px-4 py-2.5 flex items-center gap-2"
          style={{
            borderTop: "1px solid rgba(255,255,255,0.05)",
          }}
        >
          {/* 呼吸灯 */}
          <motion.div
            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{
              background: ollamaConnected ? "#60a5fa" : "rgba(255,255,255,0.20)",
              boxShadow: ollamaConnected ? "0 0 6px rgba(96,165,250,0.7)" : "none",
            }}
            animate={ollamaConnected ? { opacity: [0.5, 1, 0.5] } : { opacity: 0.4 }}
            transition={{ duration: 2, repeat: ollamaConnected ? Infinity : 0, ease: "easeInOut" }}
          />
          <span
            className="text-xs"
            style={{
              color: ollamaConnected ? "rgba(96,165,250,0.65)" : "rgba(255,255,255,0.22)",
              fontSize: "10px",
            }}
          >
            {ollamaConnected ? t.ollamaStatus.connected : t.ollamaStatus.disconnected}
          </span>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// 子组件：导航按钮
// ──────────────────────────────────────────────

function NavButton({
  icon,
  label,
  isActive,
  onClick,
}: {
  route: SidebarRoute;
  icon: string;
  label: string;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <motion.button
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3 py-2 rounded text-left"
      style={{
        background: isActive ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0)",
        border: "1px solid rgba(0,0,0,0)",
        borderColor: isActive ? "rgba(255,255,255,0.09)" : "rgba(0,0,0,0)",
        color: isActive ? "rgba(255,255,255,0.72)" : "rgba(255,255,255,0.28)",
        fontSize: "12px",
      }}
      whileHover={{ background: "rgba(255,255,255,0.05)" }}
      whileTap={{ scale: 0.97 }}
      transition={{ duration: 0.12 }}
    >
      <span className="text-sm w-4 text-center flex-shrink-0">{icon}</span>
      <span>{label}</span>
    </motion.button>
  );
}

// ──────────────────────────────────────────────
// 子组件：历史会话条目
// ──────────────────────────────────────────────

function SessionItem({
  session,
  isActive,
  onSelect,
}: {
  session: ConversationSession;
  isActive: boolean;
  onSelect: () => void;
}) {
  const stateColor = SESSION_STATE_COLOR[session.state];

  // 格式化时间：今天显示时分，否则显示月/日
  const timeLabel = (() => {
    const d = new Date(session.createdAt);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) {
      return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
    }
    return `${d.getMonth() + 1}/${d.getDate()}`;
  })();

  return (
    <motion.button
      onClick={onSelect}
      className="w-full text-left rounded px-2.5 py-2 mb-0.5 relative"
      style={{
        background: isActive ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0)",
        border: "1px solid rgba(0,0,0,0)",
        borderColor: isActive ? "rgba(255,255,255,0.09)" : "rgba(0,0,0,0)",
      }}
      whileHover={{ background: "rgba(255,255,255,0.045)" }}
      whileTap={{ scale: 0.98 }}
      transition={{ duration: 0.10 }}
    >
      {/* 激活时左侧指示线 */}
      {isActive && (
        <motion.div
          layoutId="session-indicator"
          className="absolute left-0 top-1/2 -translate-y-1/2 rounded-full"
          style={{
            width: "2px",
            height: "16px",
            background: "#60a5fa",
            boxShadow: "0 0 6px rgba(96,165,250,0.6)",
          }}
          transition={{ duration: 0.2, type: "spring", stiffness: 400, damping: 30 }}
        />
      )}

      {/* 标题行 */}
      <div className="flex items-center gap-1.5 mb-0.5">
        {/* 状态点 */}
        <div
          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{
            background: stateColor,
            boxShadow: session.state === "running" ? `0 0 5px ${stateColor}` : "none",
          }}
        />
        {/* 标题，超出截断 */}
        <span
          className="flex-1 min-w-0 truncate"
          style={{
            fontSize: "11.5px",
            color: isActive ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.42)",
            fontWeight: isActive ? 500 : 400,
          }}
        >
          {session.title}
        </span>
      </div>

      {/* 副标题行：时间 + token 数 */}
      <div
        className="flex items-center gap-1.5 pl-3"
        style={{ fontSize: "10px", color: "rgba(255,255,255,0.22)" }}
      >
        <span>{timeLabel}</span>
        {session.orchestrator.totalTokens > 0 && (
          <>
            <span>·</span>
            <span>{(session.orchestrator.totalTokens / 1000).toFixed(1)}k tok</span>
          </>
        )}
      </div>
    </motion.button>
  );
}
