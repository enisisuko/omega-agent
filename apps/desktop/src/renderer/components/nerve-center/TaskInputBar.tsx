import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { OrchestratorData, AttachmentItem, ProviderConfig } from "../../types/ui.js";
import { useLanguage } from "../../i18n/LanguageContext.js";

interface TaskInputBarProps {
  /** 当前 Orchestrator 状态，用于判断是否显示输入框 */
  orchestratorState: OrchestratorData["state"];
  /** 用户提交新任务的回调（含附件列表和选中模型） */
  onSubmit: (task: string, attachments: AttachmentItem[], model?: string) => void;
  /** 停止当前 Run 的回调 */
  onStop?: () => void;
  /** 可用的 Provider 列表（用于模型选择下拉） */
  providers?: ProviderConfig[];
  /** 当前选中的模型（格式: "providerId::modelName" 或 "modelName"） */
  selectedModel?: string;
  /** 模型变更回调 */
  onModelChange?: (model: string) => void;
}

/**
 * TaskInputBar — 任务输入栏 (v0.1.7)
 *
 * 布局：全宽横向 = [模型选择器(左侧独立)] + [输入框(flex-1)]
 * - 模型选择器在输入框左侧，下拉向上展开
 * - 输入框占满剩余宽度，支持多行、拖拽、粘贴附件
 * - running/paused 模式下显示状态条
 */
export function TaskInputBar({ orchestratorState, onSubmit, onStop, providers = [], selectedModel, onModelChange }: TaskInputBarProps) {
  const { t } = useLanguage();
  const [inputValue, setInputValue] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);

  // 从 providers 列表构建模型选项（每个 provider 的 model 字段作为选项）
  const modelOptions: { label: string; value: string; providerName: string }[] = providers
    .filter(p => p.model)
    .map(p => ({
      label: p.model!,
      value: p.model!,
      providerName: p.name,
    }));

  // 当前显示的模型名
  const currentModelLabel = selectedModel
    ? (modelOptions.find(o => o.value === selectedModel)?.label ?? selectedModel)
    : (modelOptions[0]?.label ?? "Default");

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isIdle = orchestratorState === "idle" || orchestratorState === "completed" || orchestratorState === "failed";
  const isRunning = orchestratorState === "running";
  const isPaused = orchestratorState === "paused";

  /** 键盘快捷键：Cmd/Ctrl+K 聚焦输入框 */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        textareaRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  /** textarea 自动伸缩高度（最多 120px） */
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [inputValue]);

  /** 将 File 对象转为 AttachmentItem（读取 base64） */
  const fileToAttachment = useCallback((file: File): Promise<AttachmentItem> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const isImage = file.type.startsWith("image/");
        resolve({
          name: file.name,
          type: isImage ? "image" : "file",
          dataUrl: reader.result as string,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
        });
      };
      reader.readAsDataURL(file);
    });
  }, []);

  /** 批量处理 FileList */
  const processFiles = useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files);
    const valid = arr.filter(f => f.size <= 20 * 1024 * 1024).slice(0, 10);
    const items = await Promise.all(valid.map(fileToAttachment));
    setAttachments(prev => {
      const names = new Set(prev.map(p => p.name));
      const newItems = items.filter(i => !names.has(i.name));
      return [...prev, ...newItems].slice(0, 10);
    });
  }, [fileToAttachment]);

  const handleAttachClick = () => fileInputRef.current?.click();

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files).catch(console.error);
      e.target.value = "";
    }
  };

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragOver(true); };
  const handleDragLeave = () => setIsDragOver(false);
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) processFiles(e.dataTransfer.files).catch(console.error);
  };

  /** 粘贴图片（Ctrl+V） */
  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      processFiles(imageFiles).catch(console.error);
    }
  };

  const removeAttachment = (name: string) => setAttachments(prev => prev.filter(a => a.name !== name));

  /** 格式化文件大小 */
  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  /** 提交 */
  const handleSubmit = () => {
    const trimmed = inputValue.trim();
    if (!trimmed && attachments.length === 0) return;
    const model = selectedModel ?? modelOptions[0]?.value;
    onSubmit(trimmed, attachments, model);
    setInputValue("");
    setAttachments([]);
    setModelDropdownOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const hasContent = inputValue.trim() || attachments.length > 0;

  return (
    <div className="w-full">
      <AnimatePresence mode="wait">

        {/* ── Idle / Input 模式 ── */}
        {isIdle && (
          <motion.div
            key="input-mode"
            initial={{ opacity: 0, y: 4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
          >
            {/* 完成/失败时的提示条 */}
            {orchestratorState === "completed" && (
              <motion.p
                className="text-xs mb-2"
                style={{ color: "rgba(52,211,153,0.60)" }}
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              >
                Run completed — start a new task below
              </motion.p>
            )}
            {orchestratorState === "failed" && (
              <motion.p
                className="text-xs mb-2"
                style={{ color: "rgba(248,113,113,0.60)" }}
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              >
                Run failed — you can retry with a new task
              </motion.p>
            )}

            {/* 附件预览区域 */}
            <AnimatePresence>
              {attachments.length > 0 && (
                <motion.div
                  className="flex flex-wrap gap-2 mb-2"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.15 }}
                >
                  {attachments.map(att => (
                    <motion.div
                      key={att.name}
                      className="relative flex items-center gap-2 pr-2 rounded overflow-hidden"
                      style={{
                        background: "rgba(255,255,255,0.04)",
                        border: "1px solid rgba(255,255,255,0.10)",
                        maxWidth: "140px",
                      }}
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.9 }}
                    >
                      {att.type === "image" ? (
                        <img
                          src={att.dataUrl}
                          alt={att.name}
                          className="w-8 h-8 object-cover flex-shrink-0"
                        />
                      ) : (
                        <div
                          className="w-8 h-8 flex items-center justify-center flex-shrink-0 text-xs"
                          style={{ background: "rgba(96,165,250,0.10)", color: "rgba(96,165,250,0.60)" }}
                        >
                          {att.name.split(".").pop()?.toUpperCase() ?? "FILE"}
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-2xs truncate" style={{ color: "rgba(255,255,255,0.60)" }}>{att.name}</p>
                        <p className="text-2xs" style={{ color: "rgba(255,255,255,0.30)" }}>{formatSize(att.sizeBytes)}</p>
                      </div>
                      <button
                        onClick={() => removeAttachment(att.name)}
                        className="absolute top-0.5 right-0.5 w-3.5 h-3.5 rounded-full flex items-center justify-center text-2xs leading-none"
                        style={{
                          background: "rgba(0,0,0,0.60)",
                          color: "rgba(255,255,255,0.70)",
                          fontSize: "9px",
                        }}
                        title="移除"
                      >
                        ✕
                      </button>
                    </motion.div>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>

            {/* ── 主行：[模型选择器] + [输入框] 全宽横向排列 ── */}
            <div className="flex items-stretch gap-2 w-full">

              {/* 模型选择器（输入框左侧，独立块，固定宽度） */}
              {modelOptions.length > 0 && (
                <div className="relative flex-shrink-0 self-stretch">
                  <motion.button
                    onClick={() => setModelDropdownOpen(prev => !prev)}
                    className="h-full flex items-center gap-1.5 px-3 rounded-lg text-xs"
                    style={{
                      background: modelDropdownOpen ? "rgba(96,165,250,0.10)" : "rgba(255,255,255,0.03)",
                      border: `1px solid ${modelDropdownOpen ? "rgba(96,165,250,0.25)" : "rgba(255,255,255,0.08)"}`,
                      color: "rgba(255,255,255,0.50)",
                      width: "140px",
                    }}
                    whileHover={{ background: "rgba(96,165,250,0.07)", color: "rgba(255,255,255,0.75)", borderColor: "rgba(96,165,250,0.20)" }}
                    transition={{ duration: 0.10 }}
                    title={`模型: ${currentModelLabel}`}
                  >
                    {/* 模型图标 */}
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ opacity: 0.55, flexShrink: 0 }}>
                      <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                      <path d="M2 17l10 5 10-5"/>
                      <path d="M2 12l10 5 10-5"/>
                    </svg>
                    {/* 模型名（截断） */}
                    <span className="font-mono flex-1 truncate text-left" style={{ fontSize: "10px" }}>
                      {currentModelLabel}
                    </span>
                    {/* 展开箭头 */}
                    <svg
                      width="8" height="8" viewBox="0 0 8 8"
                      style={{
                        opacity: 0.35,
                        flexShrink: 0,
                        transform: modelDropdownOpen ? "rotate(180deg)" : "none",
                        transition: "transform 0.15s",
                      }}
                    >
                      <path d="M1 2.5L4 5.5L7 2.5" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round"/>
                    </svg>
                  </motion.button>

                  {/* 下拉菜单（向上展开） */}
                  <AnimatePresence>
                    {modelDropdownOpen && (
                      <motion.div
                        className="absolute bottom-full left-0 mb-1 rounded-lg overflow-hidden"
                        style={{
                          background: "rgba(13,17,23,0.98)",
                          border: "1px solid rgba(255,255,255,0.10)",
                          minWidth: "220px",
                          zIndex: 200,
                          boxShadow: "0 -4px 24px rgba(0,0,0,0.60)",
                        }}
                        initial={{ opacity: 0, y: 6, scale: 0.96 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 6, scale: 0.96 }}
                        transition={{ duration: 0.14 }}
                      >
                        <div className="px-3 py-2" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                          <p className="text-xs font-medium" style={{ color: "rgba(255,255,255,0.40)" }}>选择模型</p>
                        </div>
                        <div className="py-1 max-h-48 overflow-y-auto">
                          {modelOptions.map(opt => {
                            const isSelected = (selectedModel ?? modelOptions[0]?.value) === opt.value;
                            return (
                              <button
                                key={opt.value}
                                className="w-full text-left px-3 py-2 flex items-center gap-2"
                                style={{ background: isSelected ? "rgba(96,165,250,0.10)" : "rgba(0,0,0,0)" }}
                                onClick={() => {
                                  onModelChange?.(opt.value);
                                  setModelDropdownOpen(false);
                                }}
                                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.05)"; }}
                                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = isSelected ? "rgba(96,165,250,0.10)" : "rgba(0,0,0,0)"; }}
                              >
                                <span
                                  className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                                  style={{ background: isSelected ? "rgba(96,165,250,0.80)" : "rgba(255,255,255,0.15)" }}
                                />
                                <div className="flex-1 min-w-0">
                                  <p className="text-xs font-mono truncate" style={{ color: "rgba(255,255,255,0.80)" }}>{opt.label}</p>
                                  <p className="text-2xs truncate" style={{ color: "rgba(255,255,255,0.30)" }}>{opt.providerName}</p>
                                </div>
                                {isSelected && (
                                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ flexShrink: 0, color: "rgba(96,165,250,0.70)" }}>
                                    <path d="M1.5 5L4 7.5L8.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                                  </svg>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}

              {/* 输入框容器（占满剩余宽度，支持拖拽） */}
              <motion.div
                className="flex-1 rounded-lg overflow-visible relative min-w-0"
                animate={{
                  background: isDragOver
                    ? "rgba(96,165,250,0.06)"
                    : isFocused
                    ? "rgba(255,255,255,0.05)"
                    : "rgba(255,255,255,0.02)",
                  borderColor: isDragOver
                    ? "rgba(96,165,250,0.50)"
                    : isFocused
                    ? "rgba(96,165,250,0.35)"
                    : "rgba(255,255,255,0.07)",
                  boxShadow: isFocused
                    ? "0 0 0 1px rgba(96,165,250,0.15), 0 4px 16px rgba(0,0,0,0.30)"
                    : "none",
                }}
                transition={{ duration: 0.15 }}
                style={{ border: "1px solid rgba(255,255,255,0.07)" }}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                {/* 拖拽覆盖提示 */}
                {isDragOver && (
                  <div
                    className="absolute inset-0 flex items-center justify-center z-10 rounded-lg pointer-events-none"
                    style={{ background: "rgba(96,165,250,0.08)" }}
                  >
                    <p className="text-xs" style={{ color: "rgba(96,165,250,0.80)" }}>松开以添加文件</p>
                  </div>
                )}

                {/* 主输入行 */}
                <div className="flex items-end gap-2 px-4 pt-3 pb-2">
                  {/* 前缀提示符 */}
                  <span
                    className="text-xs font-mono flex-shrink-0 mb-0.5 select-none"
                    style={{ color: isFocused ? "rgba(96,165,250,0.60)" : "rgba(255,255,255,0.18)" }}
                  >
                    ⌘
                  </span>

                  {/* 多行文本输入 */}
                  <textarea
                    ref={textareaRef}
                    className="flex-1 bg-transparent outline-none text-sm placeholder:text-white/20 resize-none leading-relaxed"
                    style={{
                      color: "rgba(255,255,255,0.80)",
                      minHeight: "24px",
                      maxHeight: "120px",
                      overflowY: "auto",
                    }}
                    placeholder={t.taskInput.placeholder}
                    value={inputValue}
                    rows={1}
                    onChange={e => setInputValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onFocus={() => setIsFocused(true)}
                    onBlur={() => setIsFocused(false)}
                    onPaste={handlePaste}
                    autoComplete="off"
                    spellCheck={false}
                  />

                  {/* 发送按钮 */}
                  <motion.button
                    onClick={handleSubmit}
                    disabled={!hasContent}
                    className="flex-shrink-0 px-3 py-1 rounded text-xs font-medium mb-0.5"
                    animate={{
                      opacity: hasContent ? 1 : 0.30,
                      background: hasContent
                        ? "rgba(96,165,250,0.18)"
                        : "rgba(96,165,250,0)",
                    }}
                    transition={{ duration: 0.12 }}
                    style={{
                      border: "1px solid rgba(96,165,250,0.20)",
                      color: "rgba(96,165,250,0.80)",
                    }}
                    whileTap={{ scale: 0.95 }}
                  >
                    {t.taskInput.run}
                  </motion.button>
                </div>

                {/* 底部工具栏 */}
                <div className="flex items-center gap-3 px-4 pb-2.5">
                  {/* 回形针按钮 */}
                  <motion.button
                    onClick={handleAttachClick}
                    className="flex items-center gap-1.5 text-2xs rounded px-1.5 py-1"
                    style={{ color: "rgba(255,255,255,0.30)", background: "rgba(0,0,0,0)" }}
                    whileHover={{ color: "rgba(255,255,255,0.60)", background: "rgba(255,255,255,0.05)" }}
                    transition={{ duration: 0.10 }}
                    title="添加文件/图片（最大 20MB）"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                    </svg>
                    <span>{t.taskInput.attach}</span>
                    {attachments.length > 0 && (
                      <span
                        className="px-1 rounded-sm"
                        style={{ background: "rgba(96,165,250,0.20)", color: "rgba(96,165,250,0.80)" }}
                      >
                        {attachments.length}
                      </span>
                    )}
                  </motion.button>

                  <span className="text-2xs" style={{ color: "rgba(255,255,255,0.12)" }}>
                    图片/PDF/txt/json/csv · 最大 20MB
                  </span>

                  {/* 快捷键提示 */}
                  {!isFocused && !inputValue && attachments.length === 0 && (
                    <motion.span
                      className="text-2xs ml-auto select-none"
                      style={{ color: "rgba(255,255,255,0.15)", fontFamily: "monospace" }}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                    >
                      ⌘K
                    </motion.span>
                  )}
                </div>
              </motion.div>
            </div>{/* end 主行 */}

            {/* 隐藏的 file input */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.pdf,.txt,.md,.json,.csv,.ts,.js,.py,.go,.rs"
              className="hidden"
              onChange={handleFileInputChange}
            />

            {/* 底部焦点提示行 */}
            <AnimatePresence>
              {isFocused && (
                <motion.div
                  className="flex items-center gap-4 mt-2 px-1"
                  initial={{ opacity: 0, y: -2 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -2 }}
                  transition={{ duration: 0.12 }}
                >
                  <span className="text-2xs" style={{ color: "rgba(255,255,255,0.18)" }}>
                    <kbd className="font-mono">Enter</kbd> to run
                  </span>
                  <span className="text-2xs" style={{ color: "rgba(255,255,255,0.12)" }}>
                    <kbd className="font-mono">Shift+Enter</kbd> for newline
                  </span>
                  <span className="text-2xs" style={{ color: "rgba(255,255,255,0.10)" }}>
                    Paste image to attach
                  </span>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}

        {/* ── Running 模式 — 状态指示条 ── */}
        {isRunning && (
          <motion.div
            key="running-mode"
            className="flex items-center gap-3 rounded-lg px-4 py-2.5 w-full"
            style={{
              background: "rgba(96,165,250,0.04)",
              border: "1px solid rgba(96,165,250,0.12)",
            }}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
          >
            <motion.div
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ background: "#60a5fa" }}
              animate={{ opacity: [0.4, 1, 0.4] }}
              transition={{ duration: 1.5, repeat: Infinity }}
            />
            <span className="text-xs flex-1" style={{ color: "rgba(255,255,255,0.40)" }}>
              {t.taskInput.running}
            </span>
            {onStop && (
              <motion.button
                onClick={onStop}
                className="text-xs px-2.5 py-1 rounded"
                style={{
                  background: "rgba(248,113,113,0.08)",
                  border: "1px solid rgba(248,113,113,0.18)",
                  color: "rgba(248,113,113,0.70)",
                }}
                whileHover={{ background: "rgba(248,113,113,0.14)", color: "rgba(248,113,113,0.90)" }}
                whileTap={{ scale: 0.95 }}
              >
                {t.taskInput.stop}
              </motion.button>
            )}
          </motion.div>
        )}

        {/* ── Paused 模式 ── */}
        {isPaused && (
          <motion.div
            key="paused-mode"
            className="flex items-center gap-3 rounded-lg px-4 py-2.5 w-full"
            style={{
              background: "rgba(251,191,36,0.04)",
              border: "1px solid rgba(251,191,36,0.12)",
            }}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
          >
            <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: "#fbbf24" }} />
            <span className="text-xs flex-1" style={{ color: "rgba(255,255,255,0.40)" }}>
              {t.taskInput.paused}
            </span>
            {onStop && (
              <button
                onClick={onStop}
                className="text-xs px-2.5 py-1 rounded"
                style={{
                  background: "rgba(248,113,113,0.08)",
                  border: "1px solid rgba(248,113,113,0.18)",
                  color: "rgba(248,113,113,0.70)",
                }}
              >
                {t.taskInput.cancel}
              </button>
            )}
          </motion.div>
        )}

      </AnimatePresence>
    </div>
  );
}
