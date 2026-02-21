import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { SettingsSection, ProviderConfig, PluginConfig } from "../../types/ui.js";
import { mockPlugins } from "../../data/mockData.js";
import { useLanguage } from "../../i18n/LanguageContext.js";
import type { Locale } from "../../i18n/translations.js";

// 扩展 SettingsSection 以支持 mcp 分组（局部覆盖，不修改 ui.ts 枚举）
type ExtendedSettingsSection = SettingsSection | "mcp";

/**
 * SettingsPage — 配置中心页面
 *
 * 布局：左侧分组导航（160px）+ 右侧配置面板（flex-1）
 * 分组：Providers / Plugins / MCP / Appearance
 *
 * v0.2.4 更新：providers 状态提升到 App.tsx 顶层，通过 props 传入，
 * 避免 AnimatePresence 路由切换时组件卸载导致状态丢失。
 */
export function SettingsPage({
  providers,
  onSaveProvider,
  onDeleteProvider,
}: {
  providers: ProviderConfig[];
  onSaveProvider: (config: ProviderConfig) => void;
  onDeleteProvider: (id: string) => void;
}) {
  const [activeSection, setActiveSection] = useState<ExtendedSettingsSection>("providers");
  const [plugins, setPlugins] = useState<PluginConfig[]>(mockPlugins);

  // 编辑状态：null 表示新增，有值表示编辑某个 provider
  const [editingProvider, setEditingProvider] = useState<ProviderConfig | null>(null);
  const [showProviderForm, setShowProviderForm] = useState(false);

  // MCP 状态（依然在本地管理，因为它不需要跨路由持久化）
  const [mcpConnected, setMcpConnected] = useState(false);
  const [mcpDir, setMcpDir] = useState("");
  const [mcpTools, setMcpTools] = useState<Array<{ name: string; description: string }>>([]);

  // 加载 MCP 工具列表（listMcpTools 返回单个 IceeMcpStatusResult 对象）
  useEffect(() => {
    const icee = window.icee as (typeof window.icee & {
      listMcpTools?: () => Promise<{ connected: boolean; allowedDir: string; tools: Array<{ name: string; description: string }> }>;
    });
    if (!icee?.listMcpTools) return;

    icee.listMcpTools().then((data) => {
      if (data) {
        setMcpConnected(data.connected ?? false);
        setMcpDir(data.allowedDir ?? "");
        if (Array.isArray(data.tools)) {
          setMcpTools(data.tools.map(item => ({ name: item.name, description: item.description })));
        }
      }
    }).catch(console.error);
  }, []);

  const togglePlugin = (id: string) => {
    setPlugins(prev =>
      prev.map(p => p.id === id ? { ...p, enabled: !p.enabled } : p)
    );
  };

  /** 打开新增 Provider 表单 */
  const handleAddProvider = () => {
    setEditingProvider(null);
    setShowProviderForm(true);
  };

  /** 打开编辑 Provider 表单 */
  const handleEditProvider = (provider: ProviderConfig) => {
    setEditingProvider(provider);
    setShowProviderForm(true);
  };

  /** 内部保存处理：关闭抽屉，调用外部 onSaveProvider prop */
  const handleSaveProvider = (config: ProviderConfig) => {
    setShowProviderForm(false);
    setEditingProvider(null);
    // providers 状态由 App.tsx 管理，这里只通知父组件
    onSaveProvider(config);
  };

  /** 内部删除处理：直接调用外部 onDeleteProvider prop */
  const handleDeleteProvider = (id: string) => {
    onDeleteProvider(id);
  };

  /** 设置 MCP 文件系统根目录 */
  const handleSetMcpDir = () => {
    const icee = window.icee as (typeof window.icee & { setMcpAllowedDir?: (dir: string) => Promise<{ connected: boolean; tools: Array<{ name: string; description: string }> }> });
    if (!icee?.setMcpAllowedDir) {
      // 浏览器模式：弹出输入框
      const dir = window.prompt("输入 MCP 文件系统允许目录（绝对路径）：", mcpDir || "C:\\Users");
      if (dir) setMcpDir(dir);
      return;
    }
    // Electron：调用 IPC 打开文件夹选择器
    icee.setMcpAllowedDir("__dialog__").then((result) => {
      if (result) {
        setMcpConnected(result.connected);
        if (Array.isArray(result.tools)) {
          setMcpTools(result.tools.map(item => ({ name: item.name, description: item.description })));
        }
        if (result.allowedDir) setMcpDir(result.allowedDir);
      }
    }).catch(console.error);
  };

  return (
    <div className="flex h-full w-full overflow-hidden relative">
      {/* 左侧分组导航 */}
      <SettingsNav activeSection={activeSection} onSelect={setActiveSection} />

      {/* 右侧配置面板 */}
      <div className="flex-1 min-w-0 overflow-y-auto p-8">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeSection}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            className="max-w-2xl"
          >
            {activeSection === "providers" && (
              <ProvidersPanel
                providers={providers}
                onAdd={handleAddProvider}
                onEdit={handleEditProvider}
                onDelete={handleDeleteProvider}
              />
            )}
            {activeSection === "plugins" && (
              <PluginsPanel plugins={plugins} onToggle={togglePlugin} />
            )}
            {activeSection === "mcp" && (
              <McpPanel
                connected={mcpConnected}
                allowedDir={mcpDir}
                tools={mcpTools}
                onSetDir={handleSetMcpDir}
              />
            )}
            {activeSection === "appearance" && (
              <AppearancePanel />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Provider 添加/编辑表单抽屉 */}
      <AnimatePresence>
        {showProviderForm && (
          <ProviderFormDrawer
            initial={editingProvider}
            onSave={handleSaveProvider}
            onClose={() => {
              setShowProviderForm(false);
              setEditingProvider(null);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// ─────────────────────────────────────────────
// 左侧导航（新增 MCP 分组）
// ─────────────────────────────────────────────

function SettingsNav({
  activeSection,
  onSelect,
}: {
  activeSection: ExtendedSettingsSection;
  onSelect: (s: ExtendedSettingsSection) => void;
}) {
  const { t } = useLanguage();

  // 动态生成分组列表（支持 i18n）
  const sections: Array<{ id: ExtendedSettingsSection; label: string; desc: string }> = [
    { id: "providers",  label: t.settings.providers,  desc: t.settings.providersDesc },
    { id: "plugins",    label: t.settings.plugins,    desc: t.settings.pluginsDesc },
    { id: "mcp",        label: t.settings.mcp,        desc: t.settings.mcpDesc },
    { id: "appearance", label: t.settings.appearance, desc: t.settings.appearanceDesc },
  ];

  return (
    <div
      className="flex flex-col py-6 px-3 flex-shrink-0 gap-1"
      style={{
        width: "160px",
        borderRight: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      <p className="text-2xs uppercase tracking-widest px-3 mb-3" style={{ color: "rgba(255,255,255,0.20)" }}>
        {t.settings.title}
      </p>
      {sections.map(section => (
        <button
          key={section.id}
          onClick={() => onSelect(section.id)}
          className="w-full text-left px-3 py-2.5 rounded transition-colors"
          style={{
            background: activeSection === section.id ? "rgba(255,255,255,0.07)" : "transparent",
            borderLeft: activeSection === section.id
              ? "2px solid rgba(96,165,250,0.40)"
              : "2px solid transparent",
          }}
        >
          <p
            className="text-xs font-medium"
            style={{ color: activeSection === section.id ? "rgba(255,255,255,0.80)" : "rgba(255,255,255,0.40)" }}
          >
            {section.label}
          </p>
          <p className="text-2xs mt-0.5" style={{ color: "rgba(255,255,255,0.20)" }}>
            {section.desc}
          </p>
        </button>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────
// Providers 面板（新增 CRUD 功能）
// ─────────────────────────────────────────────

function ProvidersPanel({
  providers,
  onAdd,
  onEdit,
  onDelete,
}: {
  providers: ProviderConfig[];
  onAdd: () => void;
  onEdit: (p: ProviderConfig) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useLanguage();

  return (
    <div>
      <SectionHeader
        title={t.settings.providersCrudTitle}
        description={t.settings.providersCrudDesc}
      />

      <div className="flex flex-col gap-3 mt-6">
        {providers.map(provider => (
          <ProviderRow
            key={provider.id}
            provider={provider}
            onEdit={() => onEdit(provider)}
            onDelete={() => onDelete(provider.id)}
          />
        ))}
      </div>

      {/* 添加新 Provider 按钮 */}
      <motion.button
        onClick={onAdd}
        className="mt-4 w-full flex items-center justify-center gap-2 py-3 rounded text-xs"
        style={{
          background: "rgba(255,255,255,0.02)",
          border: "1px dashed rgba(96,165,250,0.25)",
          color: "rgba(96,165,250,0.60)",
        }}
        whileHover={{
          background: "rgba(96,165,250,0.05)",
          borderColor: "rgba(96,165,250,0.40)",
          color: "rgba(96,165,250,0.85)",
        }}
        transition={{ duration: 0.12 }}
      >
        <span style={{ fontSize: "16px", lineHeight: 1 }}>+</span>
        <span>{t.settings.addProvider}</span>
      </motion.button>
    </div>
  );
}

function ProviderRow({
  provider,
  onEdit,
  onDelete,
}: {
  provider: ProviderConfig;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useLanguage();

  const TYPE_LABEL: Record<ProviderConfig["type"], string> = {
    "openai-compatible": "OpenAI API",
    "ollama": "Ollama",
    "lm-studio": "LM Studio",
    "custom": "Custom",
  };

  return (
    <div
      className="flex items-center gap-4 px-4 py-3 rounded group"
      style={{
        background: "rgba(15,17,23,0.80)",
        border: "1px solid rgba(255,255,255,0.07)",
      }}
    >
      {/* 健康状态点 */}
      <div
        className="w-2 h-2 rounded-full flex-shrink-0"
        style={{
          background: provider.healthy === true
            ? "#34d399"
            : provider.healthy === false
            ? "#f87171"
            : "#4b5563",
        }}
        title={provider.healthy === true ? "Healthy" : provider.healthy === false ? "Unreachable" : "Unknown"}
      />

      {/* 名称和 URL */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium" style={{ color: "rgba(255,255,255,0.75)" }}>
            {provider.name}
          </span>
          {provider.isDefault && (
            <span
              className="text-2xs px-1.5 py-0.5 rounded-sm"
              style={{
                background: "rgba(96,165,250,0.10)",
                border: "1px solid rgba(96,165,250,0.25)",
                color: "rgba(96,165,250,0.70)",
              }}
            >
              {t.common.default}
            </span>
          )}
          {provider.model && (
            <span className="text-2xs font-mono" style={{ color: "rgba(255,255,255,0.30)" }}>
              {provider.model}
            </span>
          )}
        </div>
        <p className="text-2xs font-mono mt-0.5 truncate" style={{ color: "rgba(255,255,255,0.25)" }}>
          {provider.baseUrl}
        </p>
      </div>

      {/* 类型标签 */}
      <span className="text-2xs flex-shrink-0" style={{ color: "rgba(255,255,255,0.30)" }}>
        {TYPE_LABEL[provider.type]}
      </span>

      {/* 编辑/删除按钮（hover 时显示） */}
      <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={onEdit}
          className="p-1.5 rounded"
          style={{ background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.50)" }}
          title={t.common.edit}
        >
          {/* 铅笔图标 */}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
        <button
          onClick={onDelete}
          className="p-1.5 rounded"
          style={{ background: "rgba(248,113,113,0.08)", color: "rgba(248,113,113,0.60)" }}
          title={t.common.delete}
        >
          {/* 垃圾桶图标 */}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            <path d="M10 11v6M14 11v6"/>
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Provider 添加/编辑表单抽屉（右侧滑入）
// ─────────────────────────────────────────────

function ProviderFormDrawer({
  initial,
  onSave,
  onClose,
}: {
  initial: ProviderConfig | null;
  onSave: (config: ProviderConfig) => void;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const isEdit = initial !== null;

  // useState 初始值只在首次 mount 生效；用 useEffect 监听 initial 变化重置所有字段
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<ProviderConfig["type"]>(initial?.type ?? "openai-compatible");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [model, setModel] = useState(initial?.model ?? "");
  const [isDefault, setIsDefault] = useState(initial?.isDefault ?? false);
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState("");

  // 每次 initial 变化（新建/切换编辑对象）时重置表单字段
  useEffect(() => {
    setName(initial?.name ?? "");
    setType(initial?.type ?? "openai-compatible");
    setBaseUrl(initial?.baseUrl ?? "");
    setApiKey(initial?.apiKey ?? "");
    setModel(initial?.model ?? "");
    setIsDefault(initial?.isDefault ?? false);
    setShowKey(false);
    setError("");
  }, [initial]);

  // 根据类型预填 baseUrl 提示
  const URL_PLACEHOLDER: Record<ProviderConfig["type"], string> = {
    "openai-compatible": "https://api.openai.com/v1",
    "ollama": "http://localhost:11434",
    "lm-studio": "http://localhost:1234/v1",
    "custom": "https://your-api.com/v1",
  };

  const MODEL_PLACEHOLDER: Record<ProviderConfig["type"], string> = {
    "openai-compatible": "gpt-4o",
    "ollama": "llama3.2",
    "lm-studio": "lmstudio-community/llama-3.2-1b-instruct",
    "custom": "model-name",
  };

  const handleSave = () => {
    if (!name.trim()) { setError(t.settings.nameRequired); return; }
    if (!baseUrl.trim()) { setError(t.settings.urlRequired); return; }
    setError("");

    const config: ProviderConfig = {
      id: initial?.id ?? `provider-${Date.now()}`,
      name: name.trim(),
      type,
      baseUrl: baseUrl.trim(),
      ...(apiKey.trim() && { apiKey: apiKey.trim() }),
      ...(model.trim() && { model: model.trim() }),
      isDefault,
    };
    onSave(config);
  };

  return (
    <>
      {/* 背景遮罩：z-50 确保盖住父 SettingsPage 的所有内容 */}
      <motion.div
        className="absolute inset-0 z-50"
        style={{ background: "rgba(0,0,0,0.55)" }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      />

      {/* 表单面板（右侧滑入）：z-[60] 在遮罩之上 */}
      <motion.div
        className="absolute right-0 top-0 bottom-0 z-[60] flex flex-col overflow-hidden"
        style={{
          width: "360px",
          background: "rgba(12,14,20,0.98)",
          borderLeft: "1px solid rgba(255,255,255,0.08)",
        }}
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
      >
        {/* 头部 */}
        <div
          className="flex items-center justify-between px-6 py-4 flex-shrink-0"
          style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
        >
          <h3 className="text-sm font-medium" style={{ color: "rgba(255,255,255,0.80)" }}>
            {isEdit ? t.settings.editProvider : t.settings.addProviderTitle}
          </h3>
          <button
            onClick={onClose}
            className="text-sm"
            style={{ color: "rgba(255,255,255,0.35)" }}
          >
            ✕
          </button>
        </div>

        {/* 表单内容（可滚动） */}
        <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-4">

          {/* 类型选择 */}
          <div>
            <label className="block text-2xs mb-2" style={{ color: "rgba(255,255,255,0.45)" }}>
              {t.settings.providerType}
            </label>
            <div className="grid grid-cols-2 gap-2">
              {(["openai-compatible", "ollama", "lm-studio", "custom"] as const).map(ptype => (
                <button
                  key={ptype}
                  onClick={() => setType(ptype)}
                  className="py-2 px-3 rounded text-xs text-left transition-colors"
                  style={{
                    background: type === ptype ? "rgba(96,165,250,0.12)" : "rgba(255,255,255,0.04)",
                    border: `1px solid ${type === ptype ? "rgba(96,165,250,0.35)" : "rgba(255,255,255,0.08)"}`,
                    color: type === ptype ? "rgba(96,165,250,0.90)" : "rgba(255,255,255,0.45)",
                  }}
                >
                  {{ "openai-compatible": "OpenAI API", "ollama": "Ollama", "lm-studio": "LM Studio", "custom": "Custom" }[ptype]}
                </button>
              ))}
            </div>
          </div>

          {/* Provider 名称 */}
          <FormField
            label={t.settings.providerName}
            value={name}
            onChange={setName}
            placeholder={`${type === "ollama" ? "Ollama 本地" : type === "openai-compatible" ? "OpenAI" : "My Provider"}`}
          />

          {/* Base URL */}
          <FormField
            label="Base URL"
            value={baseUrl}
            onChange={setBaseUrl}
            placeholder={URL_PLACEHOLDER[type]}
            monospace
          />

          {/* API Key（Ollama 不需要） */}
          {type !== "ollama" && (
            <div>
              <label className="block text-2xs mb-2" style={{ color: "rgba(255,255,255,0.45)" }}>
                {t.settings.providerApiKey}
                <span className="ml-1" style={{ color: "rgba(255,255,255,0.25)" }}>{t.settings.providerApiKeyOptional}</span>
              </label>
              <div className="flex items-center rounded overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.10)" }}>
                <input
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="flex-1 bg-transparent px-3 py-2 text-xs outline-none font-mono"
                  style={{ color: "rgba(255,255,255,0.70)", background: "rgba(255,255,255,0.03)" }}
                />
                {/* 眼睛图标：切换显示/隐藏 */}
                <button
                  onClick={() => setShowKey(!showKey)}
                  className="px-3 py-2 flex-shrink-0"
                  style={{ background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.35)" }}
                  title={showKey ? "隐藏" : "显示"}
                >
                  {showKey ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                      <line x1="1" y1="1" x2="23" y2="23"/>
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                      <circle cx="12" cy="12" r="3"/>
                    </svg>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* 默认模型 */}
          <FormField
            label={t.settings.providerModel}
            value={model}
            onChange={setModel}
            placeholder={MODEL_PLACEHOLDER[type]}
            optional
            monospace
          />

          {/* 设为默认 */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs" style={{ color: "rgba(255,255,255,0.60)" }}>{t.settings.setDefault}</p>
              <p className="text-2xs mt-0.5" style={{ color: "rgba(255,255,255,0.28)" }}>{t.settings.setDefaultDesc}</p>
            </div>
            <Toggle enabled={isDefault} onToggle={() => setIsDefault(!isDefault)} />
          </div>

          {/* 错误提示 */}
          {error && (
            <p className="text-xs px-3 py-2 rounded" style={{ background: "rgba(248,113,113,0.08)", color: "rgba(248,113,113,0.80)", border: "1px solid rgba(248,113,113,0.18)" }}>
              {error}
            </p>
          )}
        </div>

        {/* 底部按钮 */}
        <div
          className="flex items-center justify-end gap-3 px-6 py-4 flex-shrink-0"
          style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}
        >
          <button
            onClick={onClose}
            className="px-4 py-2 rounded text-xs"
            style={{
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.10)",
              color: "rgba(255,255,255,0.45)",
            }}
          >
            {t.settings.cancel}
          </button>
          <motion.button
            onClick={handleSave}
            className="px-4 py-2 rounded text-xs font-medium"
            style={{
              background: "rgba(96,165,250,0.18)",
              border: "1px solid rgba(96,165,250,0.35)",
              color: "rgba(96,165,250,0.90)",
            }}
            whileHover={{ background: "rgba(96,165,250,0.28)" }}
            whileTap={{ scale: 0.97 }}
          >
            {isEdit ? t.settings.save : t.settings.add}
          </motion.button>
        </div>
      </motion.div>
    </>
  );
}

/** 通用表单字段组件 */
function FormField({
  label, value, onChange, placeholder, optional, monospace,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  optional?: boolean;
  monospace?: boolean;
}) {
  return (
    <div>
      <label className="block text-2xs mb-2" style={{ color: "rgba(255,255,255,0.45)" }}>
        {label}
        {optional && <span className="ml-1" style={{ color: "rgba(255,255,255,0.25)" }}>(可选)</span>}
      </label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-transparent px-3 py-2 text-xs rounded outline-none"
        style={{
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.10)",
          color: "rgba(255,255,255,0.70)",
          fontFamily: monospace ? "monospace" : undefined,
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────
// Plugins 面板
// ─────────────────────────────────────────────

const PLUGIN_TYPE_COLOR: Record<PluginConfig["type"], string> = {
  TOOL:     "rgba(251,113,133,0.70)",   // rose
  SKILL:    "rgba(167,139,250,0.70)",   // violet
  PROVIDER: "rgba(96,165,250,0.70)",    // blue
  SUBAGENT: "rgba(52,211,153,0.70)",    // emerald
};

function PluginsPanel({
  plugins,
  onToggle,
}: {
  plugins: PluginConfig[];
  onToggle: (id: string) => void;
}) {
  const { t } = useLanguage();

  return (
    <div>
      <SectionHeader
        title={t.settings.pluginsTitle}
        description={t.settings.pluginsDesc2}
      />

      <div className="flex flex-col gap-3 mt-6">
        {plugins.map(plugin => (
          <PluginRow key={plugin.id} plugin={plugin} onToggle={() => onToggle(plugin.id)} />
        ))}
      </div>
    </div>
  );
}

function PluginRow({
  plugin,
  onToggle,
}: {
  plugin: PluginConfig;
  onToggle: () => void;
}) {
  const typeColor = PLUGIN_TYPE_COLOR[plugin.type];

  return (
    <div
      className="px-4 py-3 rounded transition-opacity"
      style={{
        background: "rgba(15,17,23,0.80)",
        border: "1px solid rgba(255,255,255,0.07)",
        opacity: plugin.enabled ? 1 : 0.55,
      }}
    >
      {/* 顶行 */}
      <div className="flex items-center gap-3 mb-2">
        {/* 类型标签 */}
        <span
          className="text-2xs px-1.5 py-0.5 rounded-sm font-medium flex-shrink-0"
          style={{
            background: `${typeColor.replace("0.70", "0.10")}`,
            border: `1px solid ${typeColor.replace("0.70", "0.25")}`,
            color: typeColor,
          }}
        >
          {plugin.type}
        </span>

        {/* 名称 */}
        <span className="text-xs font-medium flex-1" style={{ color: "rgba(255,255,255,0.75)" }}>
          {plugin.displayName}
        </span>

        {/* 版本 */}
        <span className="text-2xs font-mono" style={{ color: "rgba(255,255,255,0.22)" }}>
          v{plugin.version}
        </span>

        {/* Toggle */}
        <Toggle enabled={plugin.enabled} onToggle={onToggle} />
      </div>

      {/* 描述 */}
      <p className="text-xs mb-2" style={{ color: "rgba(255,255,255,0.38)" }}>
        {plugin.description}
      </p>

      {/* 权限标签 */}
      {plugin.permissions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {plugin.permissions.map(perm => (
            <span
              key={perm}
              className="text-2xs px-1.5 py-0.5 rounded-sm font-mono"
              style={{
                background: "rgba(251,191,36,0.08)",
                border: "1px solid rgba(251,191,36,0.20)",
                color: "rgba(251,191,36,0.60)",
              }}
            >
              {perm}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// MCP 面板（新增）
// ─────────────────────────────────────────────

function McpPanel({
  connected,
  allowedDir,
  tools,
  onSetDir,
}: {
  connected: boolean;
  allowedDir: string;
  tools: Array<{ name: string; description: string }>;
  onSetDir: () => void;
}) {
  const { t } = useLanguage();

  return (
    <div>
      <SectionHeader
        title={t.settings.mcpTitle}
        description={t.settings.mcpDesc2}
      />

      <div className="flex flex-col gap-4 mt-6">
        {/* Filesystem MCP Server 卡片 */}
        <div
          className="px-4 py-4 rounded"
          style={{
            background: "rgba(15,17,23,0.80)",
            border: "1px solid rgba(255,255,255,0.07)",
          }}
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              {/* 连接状态指示灯 */}
              <motion.div
                className="w-2 h-2 rounded-full"
                style={{ background: connected ? "#34d399" : "#6b7280" }}
                animate={connected ? { opacity: [0.6, 1, 0.6] } : { opacity: 1 }}
                transition={connected ? { duration: 2, repeat: Infinity } : {}}
              />
              <div>
                <p className="text-xs font-medium" style={{ color: "rgba(255,255,255,0.75)" }}>
                  Filesystem MCP Server
                </p>
                <p className="text-2xs mt-0.5" style={{ color: "rgba(255,255,255,0.30)" }}>
                  @modelcontextprotocol/server-filesystem
                </p>
              </div>
            </div>

            {/* 状态标签 */}
            <span
              className="text-2xs px-2 py-0.5 rounded-sm"
              style={{
                background: connected ? "rgba(52,211,153,0.10)" : "rgba(107,114,128,0.10)",
                border: `1px solid ${connected ? "rgba(52,211,153,0.25)" : "rgba(107,114,128,0.20)"}`,
                color: connected ? "rgba(52,211,153,0.80)" : "rgba(107,114,128,0.70)",
              }}
            >
              {connected ? t.settings.mcpConnected : t.settings.mcpDisconnected}
            </span>
          </div>

          {/* 允许目录配置 */}
          <div className="flex items-center gap-3 mb-3">
            <div className="flex-1 min-w-0">
              <p className="text-2xs mb-1" style={{ color: "rgba(255,255,255,0.35)" }}>
                {t.settings.mcpAllowedDir}
              </p>
              <p className="text-xs font-mono truncate" style={{ color: "rgba(255,255,255,0.50)" }}>
                {allowedDir || t.settings.mcpDirNotSet}
              </p>
            </div>
            <motion.button
              onClick={onSetDir}
              className="flex-shrink-0 px-3 py-1.5 rounded text-xs"
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.10)",
                color: "rgba(255,255,255,0.45)",
              }}
              whileHover={{ background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.70)" }}
            >
              {t.settings.mcpChangeDir}
            </motion.button>
          </div>
        </div>

        {/* 可用工具列表 */}
        <div>
          <p className="text-xs mb-3" style={{ color: "rgba(255,255,255,0.35)" }}>
            {t.settings.mcpAvailableTools}
            <span className="ml-2 text-2xs" style={{ color: "rgba(255,255,255,0.20)" }}>
              {tools.length > 0 ? `${tools.length} ${t.settings.mcpToolsReady}` : t.settings.mcpToolsEmpty}
            </span>
          </p>
          <div className="flex flex-col gap-2">
            {tools.length > 0 ? (
              tools.map(tool => (
                <div
                  key={tool.name}
                  className="flex items-start gap-3 px-3 py-2.5 rounded"
                  style={{
                    background: "rgba(255,255,255,0.02)",
                    border: "1px solid rgba(255,255,255,0.06)",
                  }}
                >
                  {/* 工具图标 */}
                  <div
                    className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0 mt-0.5"
                    style={{ background: "rgba(251,113,133,0.10)", border: "1px solid rgba(251,113,133,0.20)" }}
                  >
                    <span style={{ fontSize: "10px", color: "rgba(251,113,133,0.70)" }}>⚙</span>
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-mono" style={{ color: "rgba(255,255,255,0.65)" }}>
                      {tool.name}
                    </p>
                    <p className="text-2xs mt-0.5 leading-relaxed" style={{ color: "rgba(255,255,255,0.30)" }}>
                      {tool.description}
                    </p>
                  </div>
                </div>
              ))
            ) : (
              /* 占位：显示预期的 filesystem 工具 */
              [
                { name: "read_file", desc: "读取文件内容" },
                { name: "write_file", desc: "写入文件内容" },
                { name: "list_directory", desc: "列出目录内容" },
                { name: "create_directory", desc: "创建目录" },
                { name: "move_file", desc: "移动/重命名文件" },
                { name: "search_files", desc: "搜索文件" },
              ].map(toolPlaceholder => (
                <div
                  key={toolPlaceholder.name}
                  className="flex items-center gap-3 px-3 py-2 rounded"
                  style={{
                    background: "rgba(255,255,255,0.01)",
                    border: "1px solid rgba(255,255,255,0.04)",
                    opacity: 0.45,
                  }}
                >
                  <span className="text-xs font-mono" style={{ color: "rgba(255,255,255,0.40)" }}>{toolPlaceholder.name}</span>
                  <span className="text-2xs" style={{ color: "rgba(255,255,255,0.20)" }}>{toolPlaceholder.desc}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* 说明提示 */}
        <div
          className="px-4 py-3 rounded"
          style={{
            background: "rgba(96,165,250,0.04)",
            border: "1px solid rgba(96,165,250,0.12)",
          }}
        >
          <p className="text-xs leading-relaxed" style={{ color: "rgba(255,255,255,0.35)" }}>
            {t.settings.mcpHint}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Appearance 面板
// ─────────────────────────────────────────────

function AppearancePanel() {
  const { t, locale, setLocale } = useLanguage();

  return (
    <div>
      <SectionHeader
        title={t.settings.appearanceTitle}
        description={t.settings.appearanceDesc2}
      />

      <div className="mt-6 flex flex-col gap-4">
        {/* ── 语言切换卡片 ── */}
        <div
          className="px-4 py-4 rounded"
          style={{
            background: "rgba(15,17,23,0.80)",
            border: "1px solid rgba(255,255,255,0.07)",
          }}
        >
          <div className="mb-3">
            <p className="text-xs font-medium mb-0.5" style={{ color: "rgba(255,255,255,0.60)" }}>
              {t.settings.language}
            </p>
            <p className="text-2xs" style={{ color: "rgba(255,255,255,0.28)" }}>
              {t.settings.languageDesc}
            </p>
          </div>
          <div className="flex gap-2">
            {(["zh", "en"] as Locale[]).map((lang) => {
              const isActive = locale === lang;
              const label = lang === "zh" ? "中文" : "English";
              return (
                <motion.button
                  key={lang}
                  onClick={() => setLocale(lang)}
                  className="px-4 py-1.5 rounded text-xs font-medium"
                  style={{
                    background: isActive ? "rgba(96,165,250,0.14)" : "rgba(255,255,255,0.04)",
                    border: isActive
                      ? "1px solid rgba(96,165,250,0.40)"
                      : "1px solid rgba(255,255,255,0.08)",
                    color: isActive ? "rgba(96,165,250,0.90)" : "rgba(255,255,255,0.38)",
                    boxShadow: isActive ? "0 0 8px rgba(96,165,250,0.12)" : "none",
                  }}
                  whileHover={{ opacity: 0.85 }}
                  whileTap={{ scale: 0.96 }}
                  transition={{ duration: 0.10 }}
                >
                  {label}
                </motion.button>
              );
            })}
          </div>
        </div>

        {/* 版本信息卡片 */}
        <div
          className="px-4 py-4 rounded"
          style={{
            background: "rgba(15,17,23,0.80)",
            border: "1px solid rgba(255,255,255,0.07)",
          }}
        >
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium" style={{ color: "rgba(255,255,255,0.60)" }}>
              ICEE Agent
            </span>
            <span
              className="text-2xs px-2 py-0.5 rounded-sm font-mono"
              style={{
                background: "rgba(96,165,250,0.08)",
                border: "1px solid rgba(96,165,250,0.20)",
                color: "rgba(96,165,250,0.70)",
              }}
            >
              v0.1.6
            </span>
          </div>
          <InfoRow label="Runtime" value="Node.js 22 + SQLite" />
          <InfoRow label="UI" value="React 18 + Framer Motion" />
          <InfoRow label="Schema" value="Zod 3 (strict)" />
          <InfoRow label="Build" value="Vite 5 + Turborepo" />
          <InfoRow label="MCP" value="@modelcontextprotocol/sdk" />
        </div>

        {/* 主题说明 */}
        <div
          className="px-4 py-3 rounded"
          style={{
            background: "rgba(255,255,255,0.02)",
            border: "1px dashed rgba(255,255,255,0.08)",
          }}
        >
          <p className="text-xs" style={{ color: "rgba(255,255,255,0.30)" }}>
            {t.settings.currentTheme}
            <span style={{ color: "rgba(255,255,255,0.50)" }}>Quiet Intelligence (Dark)</span>
            {" — "}{t.settings.themeDesc}
          </p>
        </div>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-white/[0.04] last:border-0">
      <span className="text-xs" style={{ color: "rgba(255,255,255,0.30)" }}>{label}</span>
      <span className="text-xs font-mono" style={{ color: "rgba(255,255,255,0.50)" }}>{value}</span>
    </div>
  );
}

/** Toggle 开关组件 */
function Toggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="relative flex-shrink-0 rounded-full transition-colors"
      style={{
        width: "32px",
        height: "18px",
        background: enabled ? "rgba(96,165,250,0.60)" : "rgba(255,255,255,0.10)",
        border: `1px solid ${enabled ? "rgba(96,165,250,0.40)" : "rgba(255,255,255,0.12)"}`,
      }}
    >
      <motion.div
        className="absolute top-0.5 rounded-full"
        style={{
          width: "14px",
          height: "14px",
          background: enabled ? "rgba(255,255,255,0.90)" : "rgba(255,255,255,0.40)",
        }}
        animate={{ left: enabled ? "15px" : "2px" }}
        transition={{ duration: 0.15, ease: "easeOut" }}
      />
    </button>
  );
}

// ─────────────────────────────────────────────
// 公共子组件
// ─────────────────────────────────────────────

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="pb-4 border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
      <h2 className="text-base font-semibold mb-1.5" style={{ color: "rgba(255,255,255,0.82)" }}>
        {title}
      </h2>
      <p className="text-xs leading-relaxed" style={{ color: "rgba(255,255,255,0.38)" }}>
        {description}
      </p>
    </div>
  );
}
