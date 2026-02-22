import { app, BrowserWindow, ipcMain, shell, dialog } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { nanoid } from "nanoid";
import { McpClientManager } from "./mcp/McpClientManager.js";
import { BUILTIN_TOOLS, getBuiltinToolInfos, callBuiltinTool } from "./mcp/BuiltinMcpTools.js";

// ── 静态导入所有运行时模块（避免打包后动态 import 路径失效）──────────
import { getDatabase, RunRepository, StepRepository, EventRepository } from "@icee/db";
import {
  GraphRuntime,
  GraphNodeRunner,
  NodeExecutorRegistry,
  InputNodeExecutor,
  OutputNodeExecutor,
  LLMNodeExecutor,
  ToolNodeExecutor,
  ReflectionNodeExecutor,
  MemoryNodeExecutor,
  PlanningNodeExecutor,
  AgentLoopExecutor,
  buildAgentSystemPrompt,
} from "@icee/core";
import { OllamaProvider, OpenAICompatibleProvider } from "@icee/providers";
import { GraphDefinitionSchema } from "@icee/shared";

// vite-plugin-electron 将 main 打包为 ESM，需要手动重建 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── 判断是否开发模式 ────────────────────────────
const isDev = process.env["NODE_ENV"] !== "production";
const VITE_DEV_URL = "http://localhost:5173";

// ── 全局 MCP 管理器（进程级单例）───────────────
const mcpManager = new McpClientManager();

// ── 延迟加载运行时模块（仅首次 IPC 调用时初始化）───
let runtimeReady = false;

// ── 模块级 Provider 引用容器 ─────────────────────
// 提升到模块顶层，使得 provider IPC handler（早于 initRuntime 注册）
// 和 LLMNodeExecutor 闭包（initRuntime 内部）都能引用同一个对象
// initRuntime 运行后填充 instance；reload-provider handler 随时可以替换
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const globalProviderRef: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  instance: any | null;
  model: string;
  url: string;
  type: string;    // DB 中的 provider type 字符串（如 "ollama"/"openai-compatible"/"lm-studio"）
  healthy: boolean;
  win: BrowserWindow | null;
} = {
  instance: null,
  model: "llama3.2",
  url: "http://localhost:11434",
  type: "ollama",  // 默认值
  healthy: false,
  win: null,
};

// ── 模块级 DB 容器（早于 initRuntime 打开，供 provider IPC 使用）─
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const earlyDbRef: { db: any | null } = { db: null };

/**
 * 确保 DB 已初始化（幂等）
 * 在 provider IPC handler 调用时按需打开，供 initRuntime 内共享同一单例
 *
 * 每次首次打开后，立即强制执行 providers 表列迁移：
 * 旧版 DB 文件可能缺少 api_key / model 列，ALTER TABLE 是幂等的（列已存在时 catch 忽略）。
 * 这是修复 save-provider INSERT 因列不存在而静默失败的关键。
 */
async function ensureEarlyDb(): Promise</* IceeDatabase */ { instance: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (earlyDbRef.db) return earlyDbRef.db;
  // getDatabase 已从顶部静态导入
  const dbPath = path.join(app.getPath("userData"), "icee.db");
  console.log(`[ICEE DB] Opening database at: ${dbPath}`);

  // ── 从旧路径自动迁移 DB 文件（一次性）────────────────────────────────
  // 以前 userData 路径不固定（Electron/ 或 @icee\desktop/ 等），用户保存的配置
  // 可能存在旧路径里。
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  earlyDbRef.db = getDatabase(dbPath);

  // ── 强制列迁移：确保 api_key 和 model 列存在 ───────────────────
  const migrations = [
    { col: "api_key", sql: "ALTER TABLE providers ADD COLUMN api_key TEXT" },
    { col: "model",   sql: "ALTER TABLE providers ADD COLUMN model TEXT" },
  ];
  for (const m of migrations) {
    try {
      earlyDbRef.db.instance.exec(m.sql);
      console.log(`[ICEE DB] Migration applied: providers.${m.col} column added`);
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (msg.includes("duplicate column")) {
        console.log(`[ICEE DB] Migration skipped (column already exists): providers.${m.col}`);
      } else {
        console.error(`[ICEE DB] Migration FAILED for providers.${m.col}:`, e);
      }
    }
  }

  // ── 创建 user_settings 表（存储用户 Rules 等 KV 配置）──────────
  try {
    earlyDbRef.db.instance.exec(`
      CREATE TABLE IF NOT EXISTS user_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("[ICEE DB] user_settings table ready");
  } catch (e) {
    console.warn("[ICEE DB] Failed to create user_settings table:", e);
  }

  // ── 从旧 DB 路径迁移 providers 数据（一次性）──────────────────────
  // 检查当前 DB 是否有 provider 数据，若没有则从已知旧路径导入
  try {
    const existingCount = (earlyDbRef.db.instance.prepare("SELECT COUNT(*) as c FROM providers").get() as { c: number }).c;
    if (existingCount === 0) {
      const oldPaths = [
        path.join(app.getPath("appData"), "Electron", "icee.db"),
        path.join(app.getPath("appData"), "@icee", "desktop", "icee.db"),
      ];
      for (const oldPath of oldPaths) {
        if (fs.existsSync(oldPath) && oldPath !== dbPath) {
          try {
            // 用 ATTACH 从旧 DB 复制 providers 数据
            earlyDbRef.db.instance.exec(`ATTACH DATABASE '${oldPath.replace(/'/g, "''")}' AS old_db`);
            const oldCount = (earlyDbRef.db.instance.prepare("SELECT COUNT(*) as c FROM old_db.providers").get() as { c: number }).c;
            if (oldCount > 0) {
              earlyDbRef.db.instance.exec(`
                INSERT OR IGNORE INTO providers (id, name, type, base_url, api_key, model, is_default, created_at, updated_at)
                SELECT id, name, type, base_url, api_key, model, is_default, created_at, updated_at FROM old_db.providers
              `);
              console.log(`[ICEE DB] Migrated ${oldCount} provider(s) from old DB: ${oldPath}`);
            }
            earlyDbRef.db.instance.exec("DETACH DATABASE old_db");
            if (oldCount > 0) break; // 迁移成功则不再尝试其他旧路径
          } catch (e) {
            console.warn(`[ICEE DB] Failed to migrate providers from ${oldPath}:`, e);
            try { earlyDbRef.db.instance.exec("DETACH DATABASE old_db"); } catch { /* ignore */ }
          }
        }
      }
    }
  } catch (e) {
    console.warn("[ICEE DB] Provider migration check failed:", e);
  }

  return earlyDbRef.db;
}

/**
 * 从 DB 查询当前有效的默认 Provider 行
 * 优先返回 is_default=1 的记录，若不存在则 fallback 到第一条（避免唯一 provider 未设默认时失效）
 */
function getEffectiveDefaultProvider(db: { instance: any }): // eslint-disable-line @typescript-eslint/no-explicit-any
  { id: string; name: string; type: string; base_url: string; api_key?: string; model?: string } | undefined {
  const row = db.instance.prepare(
    "SELECT id, name, type, base_url, api_key, model FROM providers WHERE is_default = 1 LIMIT 1"
  ).get() as { id: string; name: string; type: string; base_url: string; api_key?: string; model?: string } | undefined;
  if (row) return row;
  // fallback：取任意第一条（按 created_at 升序，即最早创建的）
  const fallback = db.instance.prepare(
    "SELECT id, name, type, base_url, api_key, model FROM providers ORDER BY created_at ASC LIMIT 1"
  ).get() as { id: string; name: string; type: string; base_url: string; api_key?: string; model?: string } | undefined;
  if (fallback) {
    console.log(`[ICEE DB] No default provider found, falling back to: ${fallback.name} (${fallback.type})`);
    // 顺便修复：把这条记录设为默认，避免下次再 fallback
    try {
      db.instance.prepare("UPDATE providers SET is_default = 1 WHERE id = ?").run(fallback.id);
    } catch { /* ignore */ }
  }
  return fallback;
}

/**
 * 注册 Provider CRUD + reload IPC handler
 * 必须在 app.whenReady 后、窗口创建前调用，确保渲染进程一启动就能使用
 * 不依赖 initRuntime 是否完成
 */
function registerProviderHandlers() {

  // ── IPC: list-providers ────────────────────────────────────────
  ipcMain.handle("icee:list-providers", async () => {
    try {
      const db = await ensureEarlyDb();
      const rows = db.instance.prepare(
        "SELECT * FROM providers ORDER BY is_default DESC, created_at DESC"
      ).all() as Array<{
        id: string; name: string; type: string; base_url: string;
        api_key?: string; model?: string; is_default: number;
      }>;
      return rows.map(r => ({
        id: r.id,
        name: r.name,
        type: r.type,
        baseUrl: r.base_url,
        ...(r.api_key && { apiKey: r.api_key }),
        ...(r.model && { model: r.model }),
        isDefault: r.is_default === 1,
      }));
    } catch (e) {
      console.error("[ICEE Main] list-providers error:", e);
      return [];
    }
  });

  // ── IPC: save-provider ─────────────────────────────────────────
  ipcMain.handle("icee:save-provider", async (_event, config: {
    id: string; name: string; type: string; baseUrl: string;
    apiKey?: string; model?: string; isDefault: boolean;
  }) => {
    try {
      const db = await ensureEarlyDb();
      if (config.isDefault) {
        db.instance.prepare("UPDATE providers SET is_default = 0").run();
      }
      db.instance.prepare(`
        INSERT OR REPLACE INTO providers
          (id, name, type, base_url, api_key, model, is_default, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?,
          COALESCE((SELECT created_at FROM providers WHERE id = ?), CURRENT_TIMESTAMP),
          CURRENT_TIMESTAMP)
      `).run(
        config.id, config.name, config.type, config.baseUrl,
        config.apiKey ?? null, config.model ?? null,
        config.isDefault ? 1 : 0, config.id,
      );

      // 如果 providers 表里只有一条记录（刚刚保存的），自动设为默认
      // 避免"唯一的 provider 因未勾选 isDefault 而永远找不到"的问题
      const total = (db.instance.prepare("SELECT COUNT(*) as c FROM providers").get() as { c: number }).c;
      const defaultCount = (db.instance.prepare("SELECT COUNT(*) as c FROM providers WHERE is_default = 1").get() as { c: number }).c;
      if (total === 1 && defaultCount === 0) {
        db.instance.prepare("UPDATE providers SET is_default = 1 WHERE id = ?").run(config.id);
        console.log(`[ICEE Main] Auto-set provider as default (only one provider): ${config.name}`);
      }

      console.log(`[ICEE Main] save-provider OK: ${config.name} (${config.type}) isDefault=${config.isDefault}`);
      return { ok: true };
    } catch (e) {
      console.error("[ICEE Main] save-provider error:", e);
      return { error: (e as Error).message };
    }
  });

  // ── IPC: delete-provider ───────────────────────────────────────
  ipcMain.handle("icee:delete-provider", async (_event, id: string) => {
    try {
      const db = await ensureEarlyDb();
      db.instance.prepare("DELETE FROM providers WHERE id = ?").run(id);
      return { ok: true };
    } catch (e) {
      console.error("[ICEE Main] delete-provider error:", e);
      return { error: (e as Error).message };
    }
  });

  // ── IPC: list-runs（早期注册版本，runtime 未就绪时返回空数组）─────
  // renderer 在启动时立即调用此 IPC，所以必须提前注册；
  // initRuntime 就绪后会重新 handle（ipcMain.removeHandler + re-register）以返回真实数据
  ipcMain.handle("icee:list-runs", async () => {
    try {
      // 如果 earlyDb 已就绪则尝试从 DB 读取 run 历史
      const db = await ensureEarlyDb();
      // RunRepository 已从顶部静态导入
      const runRepo = new RunRepository(db.instance);
      return runRepo.findAll(20);
    } catch {
      // runtime 尚未就绪或 DB 尚未初始化，返回空数组
      return [];
    }
  });

  // ── IPC: reload-provider ──────────────────────────────────────
  // 前端保存 Provider 后调用，主进程重新读取默认 Provider 并重建实例
  // globalProviderRef 由 initRuntime 填充；若 runtime 尚未就绪，跳过实例替换只返回 DB 状态
  ipcMain.handle("icee:reload-provider", async () => {
    try {
      const db = await ensureEarlyDb();
      const newRow = getEffectiveDefaultProvider(db);

      if (!newRow) {
        globalProviderRef.win?.webContents.send("icee:ollama-status", { healthy: false, url: "no provider" });
        return { ok: true, message: "No default provider found" };
      }

      // 更新 globalProviderRef 中的 model、url 和 type（即使 instance 尚未就绪也要更新，
      // 以便 initRuntime 启动时读取到正确的值）
      const newModel = newRow.model ?? (newRow.type === "ollama" ? "llama3.2" : "gpt-4o-mini");
      const newUrl = newRow.base_url;
      globalProviderRef.model = newModel;
      globalProviderRef.url = newUrl;
      globalProviderRef.type = newRow.type;

      // 如果 runtime 已就绪（instance 存在），替换实例并做健康检查
      // OllamaProvider / OpenAICompatibleProvider 已从顶部静态导入
      if (globalProviderRef.instance !== null) {

        if (newRow.type === "openai-compatible" || newRow.type === "lm-studio" || newRow.type === "custom") {
          globalProviderRef.instance = new OpenAICompatibleProvider({
            id: newRow.id,
            name: newRow.name,
            baseUrl: newUrl,
            ...(newRow.api_key && { apiKey: newRow.api_key }),
          });
        } else {
          globalProviderRef.instance = new OllamaProvider({ baseUrl: newUrl });
        }

        const healthy = await globalProviderRef.instance.healthCheck();
        globalProviderRef.healthy = healthy;
        globalProviderRef.win?.webContents.send("icee:ollama-status", { healthy, url: newUrl });
        console.log(`[ICEE Main] Provider reloaded: ${newRow.type} @ ${newUrl} model=${newModel} — ${healthy ? "✅" : "❌"}`);
        return { ok: true, healthy, url: newUrl };
      }

      // runtime 还未就绪，只更新了 globalProviderRef 字段，initRuntime 启动时会使用新值
      console.log(`[ICEE Main] reload-provider: runtime not ready yet, queued model=${newModel} type=${newRow.type}`);
      return { ok: true, healthy: false, url: newUrl };
    } catch (e) {
      console.error("[ICEE Main] reload-provider error:", e);
      return { error: (e as Error).message };
    }
  });

  // ── IPC: list-mcp-tools（早期注册版本，runtime 未就绪时返回空列表）──
  // renderer 在 Settings 页面挂载时就调用，必须提前注册；
  // initRuntime 就绪后通过 removeHandler + re-register 覆盖为真实数据版本
  ipcMain.handle("icee:list-mcp-tools", async () => {
    // runtime 就绪前返回未连接状态
    return { connected: false, allowedDir: "", tools: [] };
  });

  // ── IPC: run-graph（早期占位版本，runtime 未就绪时返回明确错误）──────
  ipcMain.handle("icee:run-graph", async () => {
    return { error: "Runtime is still initializing, please wait a moment and try again." };
  });

  // ── IPC: get-rules（读取用户全局 Rules）──────────────────────────
  ipcMain.handle("icee:get-rules", async () => {
    try {
      const db = await ensureEarlyDb();
      const row = db.instance.prepare(
        "SELECT value FROM user_settings WHERE key = 'userRules' LIMIT 1"
      ).get() as { value: string } | undefined;
      return { userRules: row?.value ?? "" };
    } catch (e) {
      console.warn("[ICEE Main] get-rules error:", e);
      return { userRules: "" };
    }
  });

  // ── IPC: save-rules（保存用户全局 Rules）──────────────────────────
  ipcMain.handle("icee:save-rules", async (_event, userRules: string) => {
    try {
      const db = await ensureEarlyDb();
      db.instance.prepare(`
        INSERT OR REPLACE INTO user_settings (key, value, updated_at)
        VALUES ('userRules', ?, CURRENT_TIMESTAMP)
      `).run(userRules ?? "");
      console.log("[ICEE Main] save-rules OK, length:", userRules?.length ?? 0);
      return { ok: true };
    } catch (e) {
      console.error("[ICEE Main] save-rules error:", e);
      return { error: (e as Error).message };
    }
  });

  // ── IPC: get-project-rules（读取 .icee/rules.md）────────────────
  ipcMain.handle("icee:get-project-rules", async (_event, dirPath: string) => {
    try {
      const rulesPath = path.join(dirPath || app.getPath("documents"), ".icee", "rules.md");
      if (fs.existsSync(rulesPath)) {
        const content = fs.readFileSync(rulesPath, "utf-8");
        return { content, path: rulesPath };
      }
      return { content: "", path: rulesPath };
    } catch (e) {
      return { content: "", path: "", error: (e as Error).message };
    }
  });

  // ── IPC: save-project-rules（写入 .icee/rules.md）──────────────
  ipcMain.handle("icee:save-project-rules", async (_event, dirPath: string, content: string) => {
    try {
      const rulesDir = path.join(dirPath || app.getPath("documents"), ".icee");
      fs.mkdirSync(rulesDir, { recursive: true });
      const rulesPath = path.join(rulesDir, "rules.md");
      fs.writeFileSync(rulesPath, content, "utf-8");
      console.log("[ICEE Main] save-project-rules OK:", rulesPath);
      return { ok: true, path: rulesPath };
    } catch (e) {
      console.error("[ICEE Main] save-project-rules error:", e);
      return { error: (e as Error).message };
    }
  });

  // ── IPC: cancel-run（早期占位，runtime 未就绪时忽略）────────────────
  ipcMain.handle("icee:cancel-run", async () => {
    return { ok: false, error: "Runtime not ready" };
  });

  // ── IPC: fork-run（早期占位，runtime 未就绪时忽略）─────────────────
  ipcMain.handle("icee:fork-run", async () => {
    return { ok: false, error: "Runtime not ready" };
  });
}

/**
 * 附件数据结构（来自 renderer 的 IPC 传参）
 */
interface AttachmentItem {
  name: string;
  type: "image" | "file";
  dataUrl: string;     // base64 data URL
  mimeType: string;
  sizeBytes: number;
}

// ── AgentLoop 取消映射（runId → AbortController）──────────────────────────
// 用于支持用户点击 Stop 后真正终止 LLM 循环
const agentCancelMap = new Map<string, AbortController>();

async function initRuntime(win: BrowserWindow) {
  if (runtimeReady) return;
  runtimeReady = true;

  // 保存 win 引用到 globalProviderRef，供 reload-provider handler 发送事件使用
  globalProviderRef.win = win;

  try {
    // 所有运行时模块已从文件顶部静态导入，无需动态 import
    // （静态 import 在打包后路径稳定，不会因 asar 路径问题失败）

    // 复用 earlyDbRef 中已初始化的 DB（由 registerProviderHandlers 触发的首次 IPC 调用时打开）
    // 若 earlyDbRef.db 还没初始化（极少数情况，如 runtime 先于 provider IPC 被调用），则现在打开
    const iceeDb = await ensureEarlyDb();
    const runRepo = new RunRepository(iceeDb.instance);
    const stepRepo = new StepRepository(iceeDb.instance);
    const eventRepo = new EventRepository(iceeDb.instance);

    // ── 读取 DB 中的默认 Provider ────────────────────────────
    const ollamaUrl = process.env["OLLAMA_URL"] ?? "http://localhost:11434";

    let providerTypeInDb: string | null = null;
    let providerBaseUrlInDb: string | null = null;
    let providerApiKeyInDb: string | null = null;
    let providerModelInDb: string | null = null;
    let providerIdInDb: string | null = null;
    let providerNameInDb: string | null = null;
    try {
      const defaultRow = getEffectiveDefaultProvider(iceeDb);
      if (defaultRow) {
        providerIdInDb = defaultRow.id;
        providerNameInDb = defaultRow.name;
        providerTypeInDb = defaultRow.type;
        providerBaseUrlInDb = defaultRow.base_url;
        providerApiKeyInDb = defaultRow.api_key ?? null;
        providerModelInDb = defaultRow.model ?? null;
        console.log(`[ICEE Main] DB default provider: id=${providerIdInDb} name=${providerNameInDb} type=${providerTypeInDb} url=${providerBaseUrlInDb} model=${providerModelInDb}`);
      } else {
        console.log("[ICEE Main] No providers in DB, using Ollama default");
      }
    } catch (e) {
      console.log("[ICEE Main] providers table not ready yet, using Ollama default:", e);
    }

    // ── 初始化 globalProviderRef.instance ─────────────────────
    // 如果 reload-provider 在 initRuntime 前被调用过，globalProviderRef.model/url 可能已经更新；
    // 优先使用 DB 读取值（更权威），globalProviderRef 字段会在下方被覆盖
    if (providerTypeInDb === "openai-compatible" || providerTypeInDb === "lm-studio" || providerTypeInDb === "custom") {
      globalProviderRef.instance = new OpenAICompatibleProvider({
        id: providerIdInDb ?? "custom",
        name: providerNameInDb ?? "Custom Provider",
        baseUrl: providerBaseUrlInDb ?? "https://api.openai.com/v1",
        ...(providerApiKeyInDb && { apiKey: providerApiKeyInDb }),
      });
      globalProviderRef.url = providerBaseUrlInDb ?? "https://api.openai.com/v1";
      globalProviderRef.model = providerModelInDb ?? "gpt-4o-mini";
      globalProviderRef.type = providerTypeInDb;
    } else {
      const ollamaBase = (providerTypeInDb === "ollama" && providerBaseUrlInDb)
        ? providerBaseUrlInDb
        : ollamaUrl;
      globalProviderRef.instance = new OllamaProvider({ baseUrl: ollamaBase });
      globalProviderRef.url = ollamaBase;
      globalProviderRef.model = providerModelInDb ?? "llama3.2";
      globalProviderRef.type = "ollama";
    }

    console.log(`[ICEE Main] Using provider: type=${providerTypeInDb ?? "ollama(default)"} url=${globalProviderRef.url} model=${globalProviderRef.model}`);

    // ── 健康检查 ─────────────────────────────────────────────
    const ollamaHealthy = await globalProviderRef.instance.healthCheck();
    globalProviderRef.healthy = ollamaHealthy;

    win.webContents.send("icee:ollama-status", {
      healthy: ollamaHealthy,
      url: globalProviderRef.url,
    });

    // ── 初始化 MCP 连接（使用文档目录作为默认允许目录）──
    // 使用 8 秒超时包裹 connect，避免 MCP SDK 内部的 60 秒默认超时阻塞 runtime 初始化
    const defaultMcpDir = app.getPath("documents");
    const MCP_CONNECT_TIMEOUT_MS = 8000;
    try {
      await Promise.race([
        mcpManager.connect([defaultMcpDir]),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`MCP connect timeout after ${MCP_CONNECT_TIMEOUT_MS}ms`)), MCP_CONNECT_TIMEOUT_MS)
        ),
      ]);
      win.webContents.send("icee:step-event", {
        type: "SYSTEM",
        message: `✅ MCP Filesystem Server connected (${defaultMcpDir})`,
      });
    } catch (mcpErr) {
      // MCP 超时/失败是非致命的，内置工具仍然正常工作
      // 静默降级：只打印 console.warn，不推送 UI 错误事件（避免干扰用户）
      console.warn("[ICEE Main] MCP init failed (non-fatal, builtin tools still available):", mcpErr);
    }

    // ── 共享 LLM invokeProvider 闭包 ──────────────────────────────
    // 提取为独立函数，供 LLM / PLANNING / MEMORY / REFLECTION 四种节点共用
    // 每次调用都从 DB 实时读取最新默认 Provider，保证 Settings 里改完即生效
    const sharedInvokeProvider = async (config: import("@icee/shared").LLMNodeConfig, _input: unknown) => {
      let liveProvider = globalProviderRef.instance;
      let liveModel = globalProviderRef.model;

      try {
        const liveDb = await ensureEarlyDb();
        const liveRow = getEffectiveDefaultProvider(liveDb);

        if (liveRow) {
          liveModel = liveRow.model ?? (liveRow.type === "ollama" ? "llama3.2" : "gpt-4o-mini");
          const liveUrl = liveRow.base_url;

          console.log(`[ICEE LLM] Live provider from DB: id=${liveRow.id} type=${liveRow.type} url=${liveUrl} model=${liveModel}`);

          if (liveUrl !== globalProviderRef.url || liveRow.type !== globalProviderRef.type) {
            if (liveRow.type === "openai-compatible" || liveRow.type === "lm-studio" || liveRow.type === "custom") {
              liveProvider = new OpenAICompatibleProvider({
                id: liveRow.id,
                name: liveRow.name,
                baseUrl: liveUrl,
                ...(liveRow.api_key && { apiKey: liveRow.api_key }),
              });
            } else {
              liveProvider = new OllamaProvider({ baseUrl: liveUrl });
            }
            globalProviderRef.instance = liveProvider;
            globalProviderRef.model = liveModel;
            globalProviderRef.url = liveUrl;
            globalProviderRef.type = liveRow.type;
            console.log(`[ICEE LLM] Provider instance updated to ${liveRow.type} @ ${liveUrl} model=${liveModel}`);
          } else {
            console.log(`[ICEE LLM] Provider unchanged (${liveRow.type} @ ${liveUrl}), reusing cached instance`);
          }
        } else {
          console.log(`[ICEE LLM] No default provider in DB, using cached: type=${globalProviderRef.type} url=${globalProviderRef.url} model=${liveModel}`);
        }
      } catch (e) {
        console.warn("[ICEE LLM] Failed to read live provider from DB, using cached:", e);
      }

      if (!liveProvider) {
        throw new Error("No LLM provider available. Please configure a provider in Settings.");
      }

      const resolvedModel = (config.model && config.model.trim()) ? config.model : liveModel;

      console.log(`[ICEE LLM] Calling provider with model=${resolvedModel}`);
      console.log(`[ICEE LLM] systemPrompt="${config.systemPrompt?.slice(0, 60)}"`);
      console.log(`[ICEE LLM] promptTemplate(rendered)="${String(config.promptTemplate).slice(0, 200)}"`);

      const result = await liveProvider.generateComplete({
        model: resolvedModel,
        messages: [
          {
            role: "system",
            content: config.systemPrompt ?? "You are a helpful assistant.",
          },
          { role: "user", content: config.promptTemplate ?? "" },
        ],
        stream: true,
        ...(config.temperature !== undefined && { temperature: config.temperature }),
        ...(config.maxTokens !== undefined && { maxTokens: config.maxTokens }),
      });

      // 实时推送 token 数量更新
      win.webContents.send("icee:token-update", {
        tokens: result.tokens,
        costUsd: result.costUsd,
      });

      return result;
    };

    // ── 注册节点执行器（四种 LLM 型节点均共用 sharedInvokeProvider）─
    const registry = new NodeExecutorRegistry();
    registry.register(new InputNodeExecutor());
    registry.register(new OutputNodeExecutor());

    // LLM 节点：直接执行 LLM 调用
    registry.register(new LLMNodeExecutor(sharedInvokeProvider));

    // PLANNING 节点：任务规划专家，实际调用 LLM 生成步骤计划
    registry.register(new PlanningNodeExecutor(sharedInvokeProvider));

    // MEMORY 节点：上下文分析专家，实际调用 LLM 提取技术要点
    registry.register(new MemoryNodeExecutor(sharedInvokeProvider));

    // REFLECTION 节点：质量审查专家，实际调用 LLM 整合优化输出
    registry.register(new ReflectionNodeExecutor(sharedInvokeProvider));

    // ── 真实 MCP 工具执行器（替换 Mock）─────────
    registry.register(
      new ToolNodeExecutor(async (toolName, _version, toolInput, _timeout) => {
        // 向 TraceLog 发送 MCP 调用事件
        win.webContents.send("icee:step-event", {
          type: "MCP_CALL",
          message: `🔧 Tool: ${toolName}`,
          details: JSON.stringify(toolInput).slice(0, 120),
        });

        if (!mcpManager.connected) {
          // MCP 未连接时，返回说明性错误（不中断整个 run）
          console.warn(`[ICEE Main] MCP tool "${toolName}" called but MCP not connected`);
          return {
            result: `[MCP Unavailable] Tool "${toolName}" requires MCP connection. Check Settings > MCP.`,
          };
        }

        try {
          // 调用真实 MCP 工具
          const result = await mcpManager.callTool(
            toolName,
            toolInput as Record<string, unknown>
          );

          win.webContents.send("icee:step-event", {
            type: "MCP_CALL",
            message: `✓ Tool "${toolName}" completed`,
            details: JSON.stringify(result).slice(0, 120),
          });

          return { result };
        } catch (toolErr) {
          console.error(`[ICEE Main] MCP tool "${toolName}" error:`, toolErr);
          win.webContents.send("icee:step-event", {
            type: "SYSTEM",
            message: `❌ MCP tool "${toolName}" failed: ${(toolErr as Error).message}`,
          });
          return { result: null, error: (toolErr as Error).message };
        }
      })
    );

    const nodeRunner = new GraphNodeRunner(registry);

    // ── 创建 Runtime 并挂载到 ipcMain ──────────
    const runtime = new GraphRuntime(
      nodeRunner,
      runRepo,
      stepRepo,
      eventRepo,
      (event) => {
        // 将所有 runtime 事件推送到 renderer
        win.webContents.send("icee:runtime-event", event);

        // 将关键节点动作转为 step-event（给 TraceLog 用）
        switch (event.type) {
          case "event:run_started":
            win.webContents.send("icee:step-event", {
              type: "SYSTEM",
              message: `Run started: ${event.payload.runId}`,
            });
            break;
          case "event:step_started":
            win.webContents.send("icee:step-event", {
              type: "AGENT_ACT",
              message: `→ [${event.payload.nodeType}] ${event.payload.nodeLabel}`,
              nodeId: event.payload.nodeId,
            });
            break;
          case "event:step_completed":
            win.webContents.send("icee:step-event", {
              type: "AGENT_ACT",
              message: `✓ ${event.payload.nodeId} completed`,
              nodeId: event.payload.nodeId,
            });
            break;
          case "event:run_completed":
            win.webContents.send("icee:step-event", {
              type: "SYSTEM",
              message: `Run ${event.payload.state} — ${event.payload.durationMs}ms / ${event.payload.totalTokens} tokens`,
            });
            win.webContents.send("icee:run-completed", {
              state: event.payload.state,
              durationMs: event.payload.durationMs,
              totalTokens: event.payload.totalTokens,
              totalCostUsd: event.payload.totalCostUsd,
              output: event.payload.output,
            });
            break;
          case "event:error":
            win.webContents.send("icee:step-event", {
              type: "SYSTEM",
              message: `❌ Error: ${event.payload.error.message}`,
            });
            break;
        }
      }
    );

    // ── AgentLoop LLM invoker 工厂（绑定 runId + signal，供 AgentLoopExecutor 使用）──
    // 与 sharedInvokeProvider 不同：接受完整的 ChatMessage[] 数组，支持 ReAct 上下文
    // runId 透传到 icee:token-stream，renderer 过滤时使用；signal 用于中断流式调用
    const makeAgentLLMInvoker = (runId: string, signal: AbortSignal) => async (
      systemPrompt: string,
      messages: Array<{ role: "user" | "assistant" | "system"; content: string }>,
      opts?: { temperature?: number; maxTokens?: number }
    ): Promise<{ text: string; tokens: number; costUsd: number }> => {
      // 在每次 LLM 调用前检查取消状态
      if (signal.aborted) throw new Error("Run cancelled");

      // 实时从 DB 获取最新 provider（与 sharedInvokeProvider 逻辑相同）
      let liveProvider = globalProviderRef.instance;
      let liveModel = globalProviderRef.model;

      try {
        const liveDb = await ensureEarlyDb();
        const liveRow = getEffectiveDefaultProvider(liveDb);
        if (liveRow) {
          liveModel = liveRow.model ?? liveModel;
          const liveUrl = liveRow.base_url;
          if (liveUrl !== globalProviderRef.url || liveRow.type !== globalProviderRef.type) {
            if (liveRow.type === "openai-compatible" || liveRow.type === "lm-studio" || liveRow.type === "custom") {
              liveProvider = new OpenAICompatibleProvider({ id: liveRow.id, name: liveRow.name, baseUrl: liveUrl, ...(liveRow.api_key && { apiKey: liveRow.api_key }) });
            } else {
              liveProvider = new OllamaProvider({ baseUrl: liveUrl });
            }
          }
        }
      } catch { /* 使用缓存的 provider */ }

      if (!liveProvider) throw new Error("No LLM provider available");

      console.log(`[ICEE AgentLoop] LLM call (streaming): runId=${runId} model=${liveModel} msgs=${messages.length} temp=${opts?.temperature ?? 0.5}`);

      // ── 流式调用：使用 generate() AsyncIterable，实时推送 token 到 UI ──
      // 每个 token 通过 icee:token-stream IPC 发送给 renderer（打字机效果）
      // runId 透传，renderer 用于过滤只接受当前活跃 run 的 token
      let fullText = "";
      let totalTokens = 0;

      try {
        const stream = liveProvider.generate({
          model: liveModel,
          messages: [
            { role: "system", content: systemPrompt },
            ...messages,
          ],
          ...(opts?.temperature !== undefined && { temperature: opts.temperature }),
          ...(opts?.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
        });

        for await (const event of stream) {
          // 流式过程中实时检查取消信号
          if (signal.aborted) {
            console.log(`[ICEE AgentLoop] Stream aborted for runId=${runId}`);
            break;
          }
          if (!event.done) {
            // 每个 token 片段
            fullText += event.token;
            // 推送每个 token 到 renderer（流式打字机），携带真实 runId
            win.webContents.send("icee:token-stream", {
              token: event.token,
              runId,
            });
          } else {
            // 最后一个事件（done=true），包含完整的 usage
            if (event.token) fullText += event.token;
            totalTokens = event.usage?.totalTokens ?? totalTokens;
          }
        }
      } catch (streamErr) {
        // 取消引起的中断不视为错误
        if (signal.aborted) throw new Error("Run cancelled");
        // 流式失败时 fallback 到 generateComplete（保持向后兼容）
        console.warn("[ICEE AgentLoop] Streaming failed, falling back to generateComplete:", streamErr);
        const fallbackResult = await liveProvider.generateComplete({
          model: liveModel,
          messages: [
            { role: "system", content: systemPrompt },
            ...messages,
          ],
          ...(opts?.temperature !== undefined && { temperature: opts.temperature }),
          ...(opts?.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
        });
        fullText = fallbackResult.text;
        totalTokens = fallbackResult.tokens;
      }

      const costUsd = 0; // token 成本估算（Ollama/本地模型免费）
      win.webContents.send("icee:token-update", { tokens: totalTokens, costUsd });
      return { text: fullText, tokens: totalTokens, costUsd };
    };

    // ── AgentLoop 工具 invoker（内置工具 + MCP 工具混合调用）────────
    // 优先级：1. 内置工具（BUILTIN_TOOLS）2. MCP filesystem server
    const agentToolInvoker = async (toolName: string, toolInput: unknown): Promise<string> => {
      const inputRecord = (toolInput as Record<string, unknown>) ?? {};

      win.webContents.send("icee:step-event", {
        type: "MCP_CALL",
        message: `🔧 [AgentLoop] Tool: ${toolName}`,
        details: JSON.stringify(toolInput).slice(0, 120),
      });

      // ── 1. 尝试内置工具（web_search / http_fetch / browser_open / clipboard_read / clipboard_write）──
      if (BUILTIN_TOOLS.has(toolName)) {
        console.log(`[ICEE AgentLoop] Using builtin tool: ${toolName}`);
        try {
          const result = await callBuiltinTool(toolName, inputRecord);
          win.webContents.send("icee:step-event", {
            type: "MCP_CALL",
            message: `✓ [AgentLoop] Builtin "${toolName}" done`,
            details: result.slice(0, 120),
          });
          return result;
        } catch (err) {
          const msg = `Builtin tool "${toolName}" failed: ${(err as Error).message}`;
          win.webContents.send("icee:step-event", {
            type: "SYSTEM",
            message: `❌ [AgentLoop] ${msg}`,
          });
          return msg;
        }
      }

      // ── 2. 尝试 MCP filesystem server ─────────────────────────────────
      if (!mcpManager.connected) {
        console.warn(`[ICEE AgentLoop] MCP not connected, tool "${toolName}" unavailable`);
        return `[Tool Unavailable] Tool "${toolName}" is not available. Available builtin tools: ${Array.from(BUILTIN_TOOLS.keys()).join(", ")}`;
      }

      try {
        const result = await mcpManager.callTool(toolName, inputRecord);
        const resultStr = typeof result === "string" ? result : JSON.stringify(result);
        win.webContents.send("icee:step-event", {
          type: "MCP_CALL",
          message: `✓ [AgentLoop] MCP Tool "${toolName}" done`,
          details: resultStr.slice(0, 120),
        });
        return resultStr;
      } catch (err) {
        const msg = `Tool "${toolName}" failed: ${(err as Error).message}`;
        win.webContents.send("icee:step-event", {
          type: "SYSTEM",
          message: `❌ [AgentLoop] ${msg}`,
        });
        return msg;
      }
    };

    // ── IPC: run-agent-loop ─────────────────────────────────────────
    // 新的 ReAct 动态循环 IPC handler（替代固定图 run-graph）
    // 接受任务描述字符串，由 AgentLoopExecutor 动态决定执行步骤
    ipcMain.removeHandler("icee:run-agent-loop");
    ipcMain.handle(
      "icee:run-agent-loop",
      async (
        _event,
        taskJson: string,        // { task: string, lang?: "zh"|"en", attachmentsJson?: string }
      ) => {
        let taskOpts: {
          task: string;
          lang?: "zh" | "en";
          availableTools?: string[];
          attachmentsJson?: string;
        };
        try {
          taskOpts = JSON.parse(taskJson);
        } catch {
          return { error: "Invalid task JSON" };
        }

        // AgentLoopExecutor / buildAgentSystemPrompt / nanoid 已从顶部静态导入

        const runId = nanoid();
        const lang = taskOpts.lang ?? "zh";

        // 获取工具列表：内置工具（始终可用）+ MCP filesystem 工具（连接时可用）
        const builtinToolNames = Array.from(BUILTIN_TOOLS.keys()); // 内置工具始终可用
        const mcpTools = mcpManager.connected
          ? mcpManager.cachedTools.map((t: { name: string }) => t.name)
          : [];
        const availableTools = taskOpts.availableTools ?? [
          ...builtinToolNames,
          ...mcpTools,
        ];
        console.log(`[ICEE AgentLoop] Builtin tools: [${builtinToolNames.join(",")}]`);
        console.log(`[ICEE AgentLoop] MCP tools: [${mcpTools.join(",")}]`);

        console.log(`[ICEE AgentLoop] Starting run ${runId}, lang=${lang}, tools=[${availableTools.join(",")}]`);
        const runStartedAt = new Date().toISOString();

        // ── 写入 DB：Run 开始记录 ─────────────────────────────────────────
        try {
          runRepo.create({
            runId,
            graphId: "agent-loop",          // AgentLoop 特殊 graphId 标识
            graphVersion: "1",
            state: "running",
            totalTokens: 0,
            totalCostUsd: 0,
            input: { task: taskOpts.task.slice(0, 500) }, // 存储任务摘要
            startedAt: runStartedAt,
            createdAt: runStartedAt,
          });
          console.log(`[ICEE AgentLoop DB] Run created: ${runId}`);
        } catch (dbErr) {
          console.warn(`[ICEE AgentLoop DB] Failed to create run record:`, dbErr);
        }

        // 通知 UI：Run 开始
        win.webContents.send("icee:step-event", {
          type: "SYSTEM",
          message: `Run started: ${runId}`,
        });

        // 处理附件
        let task = taskOpts.task;
        if (taskOpts.attachmentsJson) {
          try {
            const attachments: AttachmentItem[] = JSON.parse(taskOpts.attachmentsJson);
            if (attachments.length > 0) {
              const fileCtxParts: string[] = [];
              for (const att of attachments) {
                if (att.type === "file") {
                  const base64 = att.dataUrl.split(",")[1] ?? "";
                  const text = Buffer.from(base64, "base64").toString("utf-8");
                  fileCtxParts.push(`[附件文件: ${att.name}]\n${text.slice(0, 8000)}`);
                }
              }
              if (fileCtxParts.length > 0) {
                task += `\n\n---\n## 附件内容\n${fileCtxParts.join("\n\n")}`;
              }
              win.webContents.send("icee:step-event", {
                type: "SYSTEM",
                message: `📎 Attachments: ${attachments.length} file(s)`,
              });
            }
          } catch { /* ignore */ }
        }

        // ── 读取用户 Rules（localStorage 通过 IPC 传入，此处从 earlyDb 读取）──
        let userRules: string | undefined;
        let projectRules: string | undefined;
        try {
          const rulesDb = await ensureEarlyDb();
          const rulesRow = rulesDb.instance.prepare(
            "SELECT value FROM user_settings WHERE key = 'userRules' LIMIT 1"
          ).get() as { value: string } | undefined;
          userRules = rulesRow?.value || undefined;
        } catch { /* ignore if table doesn't exist yet */ }

        // ── 读取项目 Rules（.icee/rules.md，位于 MCP 允许目录下）──
        try {
          const allowedDir = mcpManager.allowedDirs[0];
          if (allowedDir) {
            const rulesFilePath = path.join(allowedDir, ".icee", "rules.md");
            if (fs.existsSync(rulesFilePath)) {
              projectRules = fs.readFileSync(rulesFilePath, "utf-8");
              console.log(`[ICEE AgentLoop] Loaded project rules from: ${rulesFilePath}`);
            }
          }
        } catch { /* ignore */ }

        // ── 构建工具 Schema 列表（从 BuiltinMcpTools 动态生成，单一数据源）──
        const builtinSchemas = Array.from(BUILTIN_TOOLS.values()).map(t => ({
          name: t.info.name,
          description: t.info.description,
          inputSchema: t.info.inputSchema as {
            type: string;
            properties?: Record<string, { type: string; description?: string }>;
            required?: string[];
          },
        }));
        const mcpSchemas = mcpManager.connected
          ? mcpManager.cachedTools.map((t: { name: string; description: string; inputSchema: unknown }) => ({
              name: t.name,
              description: t.description,
              inputSchema: (t.inputSchema as { type: string; properties?: Record<string, { type: string; description?: string }>; required?: string[] }) ?? { type: "object" },
            }))
          : [];
        const allToolSchemas = [...builtinSchemas, ...mcpSchemas];

        // 构建 AgentLoopConfig（升级：更专业的角色定位，maxIterations 提升到 20）
        const loopConfig = {
          systemPrompt: lang === "zh"
            ? "你是 ICEE，一个经验丰富的 AI 软件工程师和通用助手。\n你擅长编写代码、分析数据、搜索信息、创作内容、解决复杂问题。\n你通过逐步使用工具来完成任务，每步都基于实际工具执行结果做判断。"
            : "You are ICEE, an experienced AI software engineer and general-purpose assistant.\nYou excel at writing code, analyzing data, searching for information, creating content, and solving complex problems.\nYou complete tasks step-by-step using tools, making decisions based on actual tool execution results.",
          availableTools,
          maxIterations: 20,
          maxTokens: 4096,
          temperature: 0.5,
        };

        // 每次迭代步骤回调 → 转换为 step-event 推送到 UI，同时写入 DB
        const onStep = (rId: string, step: import("@icee/shared").AgentStep) => {
          const nodeId = `agent_step_${step.index}`;

          // 通知步骤开始/更新（包含 thinking 内容）
          if (step.status === "thinking") {
            win.webContents.send("icee:step-event", {
              type: "AGENT_ACT",
              message: `→ [思考] 迭代 ${step.index}${step.thought ? ": " + step.thought.slice(0, 60) : ""}`,
              nodeId,
            });
          } else if (step.status === "acting") {
            win.webContents.send("icee:step-event", {
              type: "AGENT_ACT",
              message: `→ [工具] ${step.toolName}`,
              nodeId,
            });
          } else if (step.status === "observing") {
            win.webContents.send("icee:step-event", {
              type: "MCP_CALL",
              message: `✓ [观察] ${step.toolName}: ${(step.observation ?? "").slice(0, 80)}`,
              nodeId,
            });
          } else if (step.status === "done") {
            win.webContents.send("icee:step-event", {
              type: "AGENT_ACT",
              message: `✓ 步骤 ${step.index} 完成`,
              nodeId,
            });
          }

          // 同时把步骤详情通过 icee:agent-step 推送（UI 用于节点卡片渲染）
          win.webContents.send("icee:agent-step", { runId: rId, step });

          // ── 写入 DB：Step 记录（仅 done 状态写一次，避免重复写）────────
          if (step.status === "done" || step.status === "error") {
            const now = new Date().toISOString();
            try {
              stepRepo.create({
                stepId: `${rId}_step_${step.index}`,
                runId: rId,
                nodeId,
                nodeType: step.toolName ? "tool" : "llm",
                nodeLabel: step.toolName ?? `Step ${step.index}`,
                state: step.status === "error" ? "failed" : "completed",
                inherited: false,
                retryCount: 0,
                startedAt: now,
                completedAt: now,
                sequence: step.index,
              });
            } catch (dbErr) {
              // DB 写入失败不影响主流程
              console.warn(`[ICEE AgentLoop DB] Failed to create step record:`, dbErr);
            }
          }
        };

        // ── 创建 AbortController，注册到 cancelMap ────────────────────
        const controller = new AbortController();
        agentCancelMap.set(runId, controller);
        const agentLLMInvoker = makeAgentLLMInvoker(runId, controller.signal);

        const executor = new AgentLoopExecutor({
          runId,
          config: loopConfig,
          invokeLLM: agentLLMInvoker,
          invokeTool: agentToolInvoker,
          onStep,
          lang,
          toolSchemas: allToolSchemas,
          userRules,
          projectRules,
          signal: controller.signal,  // 注入取消信号
        });

        try {
          const result = await executor.execute(task);

          // 清理 cancelMap
          agentCancelMap.delete(runId);

          const wasCancelled = controller.signal.aborted;
          const finalState = wasCancelled ? "CANCELLED" : "COMPLETED";
          const completedAt = new Date().toISOString();
          const durationMs = new Date(completedAt).getTime() - new Date(runStartedAt).getTime();

          // ── 写入 DB：Run 完成 ────────────────────────────────────────────
          try {
            runRepo.complete(runId, {
              state: finalState as "COMPLETED" | "CANCELLED",
              output: { answer: result.finalAnswer.slice(0, 2000) },
              totalTokens: result.totalTokens,
              totalCostUsd: result.totalCostUsd,
              durationMs,
              completedAt,
            });
            console.log(`[ICEE AgentLoop DB] Run ${finalState}: ${runId}`);
          } catch (dbErr) {
            console.warn(`[ICEE AgentLoop DB] Failed to complete run record:`, dbErr);
          }

          // 完成通知
          win.webContents.send("icee:step-event", {
            type: "SYSTEM",
            message: wasCancelled
              ? `Run CANCELLED after ${result.iterations} iterations`
              : `Run COMPLETED — ${result.iterations} iterations / ${result.totalTokens} tokens`,
          });
          win.webContents.send("icee:run-completed", {
            state: finalState,
            durationMs,
            totalTokens: result.totalTokens,
            totalCostUsd: result.totalCostUsd,
            output: result.finalAnswer,
          });

          return { runId, ok: true };
        } catch (e) {
          // 清理 cancelMap
          agentCancelMap.delete(runId);

          const msg = (e as Error).message;
          const wasCancelled = msg === "Run cancelled" || controller.signal.aborted;
          const completedAt = new Date().toISOString();
          const durationMs = new Date(completedAt).getTime() - new Date(runStartedAt).getTime();

          // ── 写入 DB：Run 失败 ────────────────────────────────────────────
          try {
            runRepo.complete(runId, {
              state: wasCancelled ? "CANCELLED" : "FAILED",
              totalTokens: 0,
              totalCostUsd: 0,
              durationMs,
              error: { message: msg },
              completedAt,
            });
          } catch (dbErr) {
            console.warn(`[ICEE AgentLoop DB] Failed to fail run record:`, dbErr);
          }

          win.webContents.send("icee:step-event", {
            type: "SYSTEM",
            message: wasCancelled ? `Run CANCELLED by user` : `❌ Run failed: ${msg}`,
          });
          win.webContents.send("icee:run-completed", {
            state: wasCancelled ? "CANCELLED" : "FAILED",
            durationMs,
            totalTokens: 0,
            totalCostUsd: 0,
            output: undefined,
          });
          return { error: msg };
        }
      }
    );

    // ── IPC: run-graph ─────────────────────────
    // 接收 renderer 的任务提交请求（新增附件和 providerId 参数）
    // 移除早期占位 handler，替换为真实实现
    ipcMain.removeHandler("icee:run-graph");
    ipcMain.handle(
      "icee:run-graph",
      async (
        _event,
        graphJson: string,
        inputJson: string,
        _attachmentsJson?: string  // 附件列表（JSON 字符串）
      ) => {
        // GraphDefinitionSchema 已从顶部静态导入

        let graph;
        try {
          graph = GraphDefinitionSchema.parse(JSON.parse(graphJson));
        } catch (e) {
          return { error: `Invalid graph: ${(e as Error).message}` };
        }

        let input: Record<string, unknown> | undefined;
        try {
          if (inputJson) input = JSON.parse(inputJson) as Record<string, unknown>;
        } catch {
          return { error: "Invalid input JSON" };
        }

        // 处理附件：图片作为多模态内容，文件内容作为系统上下文
        if (_attachmentsJson) {
          try {
            const attachments: AttachmentItem[] = JSON.parse(_attachmentsJson) as AttachmentItem[];
            if (attachments.length > 0) {
              const imageAttachments = attachments.filter(a => a.type === "image");
              const fileAttachments = attachments.filter(a => a.type === "file");

              // 将文件内容（base64 解码后）注入到 input 的附加上下文中
              if (fileAttachments.length > 0) {
                const fileContexts: string[] = fileAttachments.map(f => {
                  try {
                    // 从 data URL 提取 base64 内容并解码
                    const base64 = f.dataUrl.split(",")[1] ?? "";
                    const text = Buffer.from(base64, "base64").toString("utf-8");
                    return `[File: ${f.name}]\n${text.slice(0, 8000)}`; // 限制 8KB
                  } catch {
                    return `[File: ${f.name}] (binary, cannot display)`;
                  }
                });
                input = {
                  ...input,
                  fileContext: fileContexts.join("\n\n---\n\n"),
                };
              }

              // 图片：注入 dataUrl 数组供支持视觉的模型使用
              if (imageAttachments.length > 0) {
                input = {
                  ...input,
                  imageUrls: imageAttachments.map(a => a.dataUrl),
                };
              }

              win.webContents.send("icee:step-event", {
                type: "SYSTEM",
                message: `📎 Attachments: ${attachments.length} file(s) (${imageAttachments.length} images, ${fileAttachments.length} files)`,
              });
            }
          } catch (e) {
            console.warn("[ICEE Main] Failed to parse attachments:", e);
          }
        }

        try {
          const runId = await runtime.startRun(graph, input);
          return { runId };
        } catch (e) {
          return { error: (e as Error).message };
        }
      }
    );

    // ── IPC: cancel-run ────────────────────────
    // 同时支持 AgentLoop（agentCancelMap）和 GraphRuntime（runtime.cancelRun）
    ipcMain.removeHandler("icee:cancel-run");
    ipcMain.handle("icee:cancel-run", async (_event, runId: string) => {
      // 优先取消 AgentLoop（若存在）
      const agentController = agentCancelMap.get(runId);
      if (agentController) {
        agentController.abort();
        agentCancelMap.delete(runId);
        console.log(`[ICEE Main] AgentLoop cancelled: runId=${runId}`);
        return { ok: true };
      }
      // fallback：取消 GraphRuntime run
      runtime.cancelRun(runId);
      return { ok: true };
    });

    // ── IPC: fork-run ──────────────────────────
    // 从指定 Step 开始重新执行（用于节点 Rerun 功能）
    // parentRunId: 原始 Run ID；fromStepId: 从哪个步骤开始；
    // graphJson: 图定义；inputOverrideJson: 覆盖的输入（含编辑后 Prompt）
    ipcMain.removeHandler("icee:fork-run");
    ipcMain.handle(
      "icee:fork-run",
      async (_event, parentRunId: string, fromStepId: string, graphJson: string, inputOverrideJson?: string) => {
        try {
          // GraphDefinitionSchema 已从顶部静态导入

          let graph;
          try {
            graph = GraphDefinitionSchema.parse(JSON.parse(graphJson));
          } catch (e) {
            return { ok: false, error: `Invalid graph: ${(e as Error).message}` };
          }

          let inputOverride: Record<string, unknown> | undefined;
          if (inputOverrideJson) {
            try {
              inputOverride = JSON.parse(inputOverrideJson) as Record<string, unknown>;
            } catch {
              return { ok: false, error: "Invalid inputOverride JSON" };
            }
          }

          const newRunId = await runtime.forkRun(parentRunId, fromStepId, graph, inputOverride);
          console.log(`[ICEE Main] fork-run: parent=${parentRunId} fromStep=${fromStepId} newRun=${newRunId}`);
          return { ok: true, newRunId };
        } catch (e) {
          console.error("[ICEE Main] fork-run error:", e);
          return { ok: false, error: (e as Error).message };
        }
      }
    );

    // ── IPC: list-runs（runtime 就绪后覆盖早期注册的空实现）──────
    // 移除早期 registerProviderHandlers 注册的空实现，替换为真实数据版本
    ipcMain.removeHandler("icee:list-runs");
    ipcMain.handle("icee:list-runs", async () => {
      const runs = runRepo.findAll(20);
      return runs;
    });

    // 注：list-providers / save-provider / delete-provider / reload-provider
    // 已在 registerProviderHandlers() 中提前注册（app.whenReady 时），此处不再重复

    // ── IPC: list-mcp-tools（runtime 就绪后覆盖早期注册的空实现）──────
    ipcMain.removeHandler("icee:list-mcp-tools");
    ipcMain.handle("icee:list-mcp-tools", async () => {
      // 刷新 MCP filesystem 工具（如果已连接），否则用缓存
      const mcpTools = mcpManager.connected
        ? await mcpManager.refreshTools()
        : mcpManager.cachedTools;
      // 合并内置工具（始终返回，不依赖 MCP 连接状态）
      const builtinTools = getBuiltinToolInfos();
      return {
        connected: mcpManager.connected,
        allowedDir: mcpManager.allowedDirs[0] ?? "",
        tools: [...builtinTools, ...mcpTools],
        builtinCount: builtinTools.length,
        mcpCount: mcpTools.length,
      };
    });

    // ── IPC: set-mcp-allowed-dir ───────────────
    // 允许用户通过 Settings UI 更改 MCP 文件系统根目录
    ipcMain.handle("icee:set-mcp-allowed-dir", async (_event, dirOrDialog: string) => {
      let targetDir = dirOrDialog;

      // 特殊值 "__dialog__" 表示打开文件夹选择器
      if (dirOrDialog === "__dialog__") {
        const result = await dialog.showOpenDialog(win, {
          properties: ["openDirectory"],
          title: "选择 MCP 允许目录",
          defaultPath: app.getPath("documents"),
        });
        if (result.canceled || result.filePaths.length === 0) {
          return { connected: mcpManager.connected, tools: mcpManager.cachedTools };
        }
        targetDir = result.filePaths[0]!;
      }

      // 重新连接 MCP Server 到新目录（8秒超时）
      try {
        await Promise.race([
          mcpManager.connect([targetDir]),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("MCP connect timeout after 8000ms")), 8000)
          ),
        ]);
        const tools = await mcpManager.refreshTools();
        win.webContents.send("icee:step-event", {
          type: "SYSTEM",
          message: `✅ MCP 目录已更新: ${targetDir}`,
        });
        return { connected: true, allowedDir: targetDir, tools };
      } catch (e) {
        console.error("[ICEE Main] set-mcp-allowed-dir error:", e);
        return { connected: false, allowedDir: targetDir, tools: [], error: (e as Error).message };
      }
    });

    console.log("[ICEE Main] Runtime initialized. Ollama:", ollamaHealthy ? "✅" : "❌", "| MCP:", mcpManager.connected ? "✅" : "❌");
  } catch (err) {
    console.error("[ICEE Main] Runtime init failed:", err);
    win.webContents.send("icee:step-event", {
      type: "SYSTEM",
      message: `⚠️ Runtime init error: ${(err as Error).message}`,
    });
  }
}

// ── 创建主窗口 ──────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    // 无标题栏（匹配 Quiet Intelligence 风格）
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#08090c",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false, // 等内容加载完再显示，避免白屏闪烁
  });

  // 内容加载完后显示窗口
  win.once("ready-to-show", () => {
    win.show();
    // 窗口显示后初始化运行时（不阻塞窗口启动）
    initRuntime(win).catch(console.error);
  });

  // 开发模式：加载 Vite dev server；生产模式：加载打包后文件
  if (isDev) {
    win.loadURL(VITE_DEV_URL).catch(console.error);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(
      path.join(__dirname, "../renderer/index.html")
    ).catch(console.error);
  }

  // 外部链接在系统浏览器中打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(console.error);
    return { action: "deny" };
  });

  return win;
}

// ── 在 whenReady 之前强制设置 userData 路径 ──────
// Electron 在不同运行模式下 userData 路径不一致（开发模式为 Roaming\Electron，
// 生产打包后可能为 Roaming\@icee\desktop 等），导致每次找不到用户保存的配置。
// 统一指定为 Roaming\ICeeAgent，无论开发/生产模式都使用同一个数据库。
app.setPath("userData", path.join(app.getPath("appData"), "ICeeAgent"));

// ── Electron 生命周期 ──────────────────────────
app.whenReady().then(() => {
  // 提前注册 Provider CRUD IPC（不依赖 runtime 就绪）
  // 必须在 createWindow() 之前调用，确保渲染进程一启动就能使用
  registerProviderHandlers();

  createWindow();

  // macOS：点击 Dock 图标时重新打开窗口
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // 关闭时断开 MCP 连接
  mcpManager.disconnect().catch(console.error);

  if (process.platform !== "darwin") {
    app.quit();
  }
});
