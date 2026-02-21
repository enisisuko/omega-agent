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

  try {
    // 动态导入运行时（避免影响窗口启动速度）
    const { getDatabase, RunRepository, StepRepository, EventRepository } =
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
    const { OllamaProvider } = await import("@icee/providers");

    const dbPath = path.join(app.getPath("userData"), "icee.db");
    const iceeDb = getDatabase(dbPath);
    const runRepo = new RunRepository(iceeDb.instance);
    const stepRepo = new StepRepository(iceeDb.instance);
    const eventRepo = new EventRepository(iceeDb.instance);

    // ── 读取 DB 中的默认 Provider，动态选择真实 Provider ────────
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
      // providers 表可能不存在（冷启动），静默跳过
      console.log("[ICEE Main] providers table not ready yet, using Ollama default");
    }

    // ── 根据 DB 配置选择 Provider ────────────────────────────
    const { OpenAICompatibleProvider } = await import("@icee/providers");

    const ollamaUrl = process.env["OLLAMA_URL"] ?? "http://localhost:11434";

    // 优先使用 DB 中配置的 Provider；若无则 fallback Ollama
    let provider: InstanceType<typeof OllamaProvider> | InstanceType<typeof OpenAICompatibleProvider>;
    let activeProviderUrl = ollamaUrl;
    let useOllamaStyle = true;

    if (providerTypeInDb === "openai-compatible" || providerTypeInDb === "lm-studio" || providerTypeInDb === "custom") {
      provider = new OpenAICompatibleProvider({
        baseUrl: providerBaseUrlInDb ?? "https://api.openai.com/v1",
        ...(providerApiKeyInDb && { apiKey: providerApiKeyInDb }),
        ...(providerModelInDb && { defaultModel: providerModelInDb }),
      });
      activeProviderUrl = providerBaseUrlInDb ?? "https://api.openai.com/v1";
      useOllamaStyle = false;
    } else {
      // ollama 或未配置，使用 Ollama
      const ollamaBase = (providerTypeInDb === "ollama" && providerBaseUrlInDb)
        ? providerBaseUrlInDb
        : ollamaUrl;
      provider = new OllamaProvider({ baseUrl: ollamaBase });
      activeProviderUrl = ollamaBase;
      useOllamaStyle = true;
    }

    const activeModel = providerModelInDb ?? (useOllamaStyle ? "llama3.2" : "gpt-4o-mini");

    console.log(`[ICEE Main] Using provider: type=${providerTypeInDb ?? "ollama(default)"} url=${activeProviderUrl} model=${activeModel}`);

    // ── 健康检查 ─────────────────────────────────────────────
    const ollamaHealthy = await provider.healthCheck();

    win.webContents.send("icee:ollama-status", {
      healthy: ollamaHealthy,
      url: activeProviderUrl,
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
        if (!ollamaHealthy) {
          // Provider 不可用时降级为 mock
          return {
            text: `[Mock] ${config.model ?? activeModel}: Provider not available. Check Settings > Providers.`,
            tokens: 50,
            costUsd: 0,
            providerMeta: { provider: "mock", model: config.model ?? activeModel },
          };
        }

        // 优先使用节点配置的 model，fallback 到当前 Provider 的默认 model
        const resolvedModel = config.model ?? activeModel;

        const result = await provider.generateComplete({
          model: resolvedModel,
          messages: [
            {
              role: "system",
              content:
                config.systemPrompt ?? "You are a helpful assistant.",
            },
            { role: "user", content: config.promptTemplate ?? "" },
          ],
          stream: true,
          ...(config.temperature !== undefined && {
            temperature: config.temperature,
          }),
          ...(config.maxTokens !== undefined && {
            maxTokens: config.maxTokens,
          }),
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

    // ── IPC: list-runs ─────────────────────────
    ipcMain.handle("icee:list-runs", async () => {
      const runs = runRepo.findAll(20);
      return runs;
    });

    // ── IPC: list-providers ────────────────────
    // 从 SQLite providers 表查询（如果不存在，返回空数组）
    ipcMain.handle("icee:list-providers", async () => {
      try {
        const rows = iceeDb.instance.prepare(
          "SELECT * FROM providers ORDER BY is_default DESC, created_at DESC"
        ).all() as Array<{
          id: string;
          name: string;
          type: string;
          base_url: string;
          api_key?: string;
          model?: string;
          is_default: number;
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

    // ── IPC: save-provider ─────────────────────
    // 插入或更新 Provider 配置到 SQLite
    ipcMain.handle("icee:save-provider", async (_event, config: {
      id: string;
      name: string;
      type: string;
      baseUrl: string;
      apiKey?: string;
      model?: string;
      isDefault: boolean;
    }) => {
      try {
        // 如果设为默认，先清除其他 Provider 的 default 标记
        if (config.isDefault) {
          iceeDb.instance.prepare("UPDATE providers SET is_default = 0").run();
        }
        // 使用 UPSERT（INSERT OR REPLACE）
        iceeDb.instance.prepare(`
          INSERT OR REPLACE INTO providers (id, name, type, base_url, api_key, model, is_default, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM providers WHERE id = ?), CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
        `).run(
          config.id,
          config.name,
          config.type,
          config.baseUrl,
          config.apiKey ?? null,
          config.model ?? null,
          config.isDefault ? 1 : 0,
          config.id
        );
        return { ok: true };
      } catch (e) {
        console.error("[ICEE Main] save-provider error:", e);
        return { error: (e as Error).message };
      }
    });

    // ── IPC: delete-provider ───────────────────
    ipcMain.handle("icee:delete-provider", async (_event, id: string) => {
      try {
        iceeDb.instance.prepare("DELETE FROM providers WHERE id = ?").run(id);
        return { ok: true };
      } catch (e) {
        console.error("[ICEE Main] delete-provider error:", e);
        return { error: (e as Error).message };
      }
    });

    // ── IPC: reload-provider ────────────────────
    // 前端保存新 Provider 配置后，触发主进程重新读取默认 Provider 并重新健康检查
    ipcMain.handle("icee:reload-provider", async () => {
      try {
        const newRow = iceeDb.instance.prepare(
          "SELECT type, base_url, api_key, model FROM providers WHERE is_default = 1 LIMIT 1"
        ).get() as { type: string; base_url: string; api_key?: string; model?: string } | undefined;

        if (!newRow) {
          win.webContents.send("icee:ollama-status", { healthy: false, url: "no provider configured" });
          return { ok: true, message: "No default provider found" };
        }

        // 重新构建 Provider 实例
        let newProvider: InstanceType<typeof OllamaProvider> | InstanceType<typeof OpenAICompatibleProvider>;
        let newUrl: string;

        if (newRow.type === "openai-compatible" || newRow.type === "lm-studio" || newRow.type === "custom") {
          newProvider = new OpenAICompatibleProvider({
            baseUrl: newRow.base_url,
            ...(newRow.api_key && { apiKey: newRow.api_key }),
            ...(newRow.model && { defaultModel: newRow.model }),
          });
          newUrl = newRow.base_url;
        } else {
          newProvider = new OllamaProvider({ baseUrl: newRow.base_url });
          newUrl = newRow.base_url;
        }

        const healthy = await newProvider.healthCheck();
        win.webContents.send("icee:ollama-status", { healthy, url: newUrl });

        console.log(`[ICEE Main] Provider reloaded: ${newRow.type} @ ${newUrl} — ${healthy ? "✅" : "❌"}`);
        return { ok: true, healthy, url: newUrl };
      } catch (e) {
        console.error("[ICEE Main] reload-provider error:", e);
        return { error: (e as Error).message };
      }
    });

    // ── IPC: list-mcp-tools ────────────────────
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
