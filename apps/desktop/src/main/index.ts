import { app, BrowserWindow, ipcMain, shell, dialog } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { McpClientManager } from "./mcp/McpClientManager.js";

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
  healthy: boolean;
  win: BrowserWindow | null;
} = {
  instance: null,
  model: "llama3.2",
  url: "http://localhost:11434",
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
  const { getDatabase } = await import("@icee/db");
  const dbPath = path.join(app.getPath("userData"), "icee.db");
  console.log(`[ICEE DB] Opening database at: ${dbPath}`);
  earlyDbRef.db = getDatabase(dbPath);

  // ── 强制列迁移：确保 api_key 和 model 列存在 ───────────────────
  // 无论 DB 是新建还是旧文件，都执行一次 ALTER TABLE。
  // 列已存在时 SQLite 会抛 "duplicate column name" 错误，catch 忽略即可。
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
        // 真正的迁移失败（权限问题、磁盘满等），打印完整错误
        console.error(`[ICEE DB] Migration FAILED for providers.${m.col}:`, e);
      }
    }
  }

  return earlyDbRef.db;
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
      console.log(`[ICEE Main] save-provider OK: ${config.name} (${config.type})`);
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
      const RunRepository = (await import("@icee/db")).RunRepository;
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
      const newRow = db.instance.prepare(
        "SELECT type, base_url, api_key, model FROM providers WHERE is_default = 1 LIMIT 1"
      ).get() as { type: string; base_url: string; api_key?: string; model?: string } | undefined;

      if (!newRow) {
        globalProviderRef.win?.webContents.send("icee:ollama-status", { healthy: false, url: "no provider" });
        return { ok: true, message: "No default provider found" };
      }

      // 更新 globalProviderRef 中的 model 和 url（即使 instance 尚未就绪也要更新，
      // 以便 initRuntime 启动时读取到正确的值）
      const newModel = newRow.model ?? (newRow.type === "ollama" ? "llama3.2" : "gpt-4o-mini");
      const newUrl = newRow.base_url;
      globalProviderRef.model = newModel;
      globalProviderRef.url = newUrl;

      // 如果 runtime 已就绪（instance 存在），替换实例并做健康检查
      if (globalProviderRef.instance !== null) {
        const { OllamaProvider } = await import("@icee/providers");
        const { OpenAICompatibleProvider } = await import("@icee/providers");

        if (newRow.type === "openai-compatible" || newRow.type === "lm-studio" || newRow.type === "custom") {
          globalProviderRef.instance = new OpenAICompatibleProvider({
            baseUrl: newUrl,
            ...(newRow.api_key && { apiKey: newRow.api_key }),
            ...(newRow.model && { defaultModel: newRow.model }),
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
      console.log(`[ICEE Main] reload-provider: runtime not ready yet, queued model=${newModel}`);
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

async function initRuntime(win: BrowserWindow) {
  if (runtimeReady) return;
  runtimeReady = true;

  // 保存 win 引用到 globalProviderRef，供 reload-provider handler 发送事件使用
  globalProviderRef.win = win;

  try {
    // 动态导入运行时（避免影响窗口启动速度）
    const { RunRepository, StepRepository, EventRepository } =
      await import("@icee/db");
    const {
      GraphRuntime,
      GraphNodeRunner,
      NodeExecutorRegistry,
      InputNodeExecutor,
      OutputNodeExecutor,
      LLMNodeExecutor,
      ToolNodeExecutor,
      MemoryNodeExecutor,
      ReflectionNodeExecutor,
      PlanningNodeExecutor,
    } = await import("@icee/core");
    const { OllamaProvider, OpenAICompatibleProvider } = await import("@icee/providers");

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
    try {
      const defaultRow = iceeDb.instance.prepare(
        "SELECT type, base_url, api_key, model FROM providers WHERE is_default = 1 LIMIT 1"
      ).get() as { type: string; base_url: string; api_key?: string; model?: string } | undefined;
      if (defaultRow) {
        providerTypeInDb = defaultRow.type;
        providerBaseUrlInDb = defaultRow.base_url;
        providerApiKeyInDb = defaultRow.api_key ?? null;
        providerModelInDb = defaultRow.model ?? null;
        console.log(`[ICEE Main] DB default provider: type=${providerTypeInDb} url=${providerBaseUrlInDb}`);
      }
    } catch {
      console.log("[ICEE Main] providers table not ready yet, using Ollama default");
    }

    // ── 初始化 globalProviderRef.instance ─────────────────────
    // 如果 reload-provider 在 initRuntime 前被调用过，globalProviderRef.model/url 可能已经更新；
    // 优先使用 DB 读取值（更权威），globalProviderRef 字段会在下方被覆盖
    if (providerTypeInDb === "openai-compatible" || providerTypeInDb === "lm-studio" || providerTypeInDb === "custom") {
      globalProviderRef.instance = new OpenAICompatibleProvider({
        baseUrl: providerBaseUrlInDb ?? "https://api.openai.com/v1",
        ...(providerApiKeyInDb && { apiKey: providerApiKeyInDb }),
        ...(providerModelInDb && { defaultModel: providerModelInDb }),
      });
      globalProviderRef.url = providerBaseUrlInDb ?? "https://api.openai.com/v1";
      globalProviderRef.model = providerModelInDb ?? "gpt-4o-mini";
    } else {
      const ollamaBase = (providerTypeInDb === "ollama" && providerBaseUrlInDb)
        ? providerBaseUrlInDb
        : ollamaUrl;
      globalProviderRef.instance = new OllamaProvider({ baseUrl: ollamaBase });
      globalProviderRef.url = ollamaBase;
      globalProviderRef.model = providerModelInDb ?? "llama3.2";
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
    const defaultMcpDir = app.getPath("documents");
    try {
      await mcpManager.connect([defaultMcpDir]);
      win.webContents.send("icee:step-event", {
        type: "SYSTEM",
        message: `✅ MCP Filesystem Server connected (${defaultMcpDir})`,
      });
    } catch (mcpErr) {
      console.warn("[ICEE Main] MCP init failed (non-fatal):", mcpErr);
      win.webContents.send("icee:step-event", {
        type: "SYSTEM",
        message: `⚠️ MCP Server not available: ${(mcpErr as Error).message}`,
      });
    }

    // ── 注册节点执行器 ─────────────────────────
    const registry = new NodeExecutorRegistry();
    registry.register(new InputNodeExecutor());
    registry.register(new OutputNodeExecutor());
    registry.register(new MemoryNodeExecutor());

    registry.register(
      new LLMNodeExecutor(async (config, _input) => {
        // ── 每次 LLM 调用时，从 DB 实时读取最新的默认 Provider ──────────
        // 这样用户在 Settings 里修改 Provider 后，无需重启即刻生效，
        // 也不依赖 globalProviderRef 是否被正确热重载
        let liveProvider = globalProviderRef.instance;
        let liveModel = globalProviderRef.model;

        try {
          const liveDb = await ensureEarlyDb();
          const liveRow = liveDb.instance.prepare(
            "SELECT type, base_url, api_key, model FROM providers WHERE is_default = 1 LIMIT 1"
          ).get() as { type: string; base_url: string; api_key?: string; model?: string } | undefined;

          if (liveRow) {
            liveModel = liveRow.model ?? (liveRow.type === "ollama" ? "llama3.2" : "gpt-4o-mini");
            const liveUrl = liveRow.base_url;

            console.log(`[ICEE LLM] Live provider from DB: type=${liveRow.type} url=${liveUrl} model=${liveModel}`);

            // 如果 URL 或类型与 globalProviderRef 不同，新建一次性 provider 实例
            if (liveUrl !== globalProviderRef.url || liveRow.type !== (globalProviderRef.instance?.constructor?.name ?? "")) {
              if (liveRow.type === "openai-compatible" || liveRow.type === "lm-studio" || liveRow.type === "custom") {
                liveProvider = new OpenAICompatibleProvider({
                  baseUrl: liveUrl,
                  ...(liveRow.api_key && { apiKey: liveRow.api_key }),
                  ...(liveRow.model && { defaultModel: liveRow.model }),
                });
              } else {
                liveProvider = new OllamaProvider({ baseUrl: liveUrl });
              }
              // 同步更新 globalProviderRef，供下次快速读取
              globalProviderRef.instance = liveProvider;
              globalProviderRef.model = liveModel;
              globalProviderRef.url = liveUrl;
              console.log(`[ICEE LLM] Provider instance updated to ${liveRow.type} @ ${liveUrl}`);
            }
          } else {
            console.log(`[ICEE LLM] No default provider in DB, using cached: url=${globalProviderRef.url} model=${liveModel}`);
          }
        } catch (e) {
          console.warn("[ICEE LLM] Failed to read live provider from DB, using cached:", e);
        }

        if (!liveProvider) {
          throw new Error("No LLM provider available. Please configure a provider in Settings.");
        }

        // config.model 若为空/undefined，则 fallback 到从 DB 读取的 liveModel
        const resolvedModel = (config.model && config.model.trim()) ? config.model : liveModel;

        console.log(`[ICEE LLM] Calling provider with model=${resolvedModel}`);

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
      })
    );

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

    registry.register(
      new PlanningNodeExecutor(async (goal, _mode) => ({
        tasks: [{ id: "task-1", description: String(goal), priority: 1 }],
        totalSteps: 1,
        strategy: "sequential" as const,
      }))
    );

    registry.register(
      new ReflectionNodeExecutor(async (input, threshold) => ({
        shouldRetry: false,
        confidence: (threshold ?? 0.6) + 0.1,
        reasoning: "Output quality is acceptable",
        modifiedOutput: input,
      }))
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

    // ── IPC: run-graph ─────────────────────────
    // 接收 renderer 的任务提交请求（新增附件和 providerId 参数）
    ipcMain.handle(
      "icee:run-graph",
      async (
        _event,
        graphJson: string,
        inputJson: string,
        _attachmentsJson?: string  // 附件列表（JSON 字符串）
      ) => {
        const { GraphDefinitionSchema } = await import("@icee/shared");

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
    ipcMain.handle("icee:cancel-run", async (_event, runId: string) => {
      runtime.cancelRun(runId);
      return { ok: true };
    });

    // ── IPC: fork-run ──────────────────────────
    // 从指定 Step 开始重新执行（用于节点 Rerun 功能）
    // parentRunId: 原始 Run ID；fromStepId: 从哪个步骤开始；
    // graphJson: 图定义；inputOverrideJson: 覆盖的输入（含编辑后 Prompt）
    ipcMain.handle(
      "icee:fork-run",
      async (_event, parentRunId: string, fromStepId: string, graphJson: string, inputOverrideJson?: string) => {
        try {
          const { GraphDefinitionSchema } = await import("@icee/shared");

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
      const tools = mcpManager.connected
        ? await mcpManager.refreshTools()
        : mcpManager.cachedTools;
      return {
        connected: mcpManager.connected,
        allowedDir: mcpManager.allowedDirs[0] ?? "",
        tools,
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

      // 重新连接 MCP Server 到新目录
      try {
        await mcpManager.connect([targetDir]);
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
