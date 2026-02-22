/**
 * BuiltinMcpTools — 内置 MCP 工具集
 *
 * 这些工具不依赖外部 MCP 服务器进程，直接在 Electron 主进程中实现。
 * 包含：
 *   - web_search: 用 DuckDuckGo Lite API 搜索（无 API Key 要求）
 *   - http_fetch: 抓取任意 URL 的文本内容
 *   - browser_open: 用系统默认浏览器打开 URL
 *   - clipboard_read: 读取剪贴板文本
 *   - clipboard_write: 写入剪贴板文本
 *   - fs_write: 写入文件（自动创建目录）
 *   - fs_read: 读取文件内容
 *   - code_exec: 执行 JavaScript / Python / Bash 代码
 */

import { clipboard, shell } from "electron";
import fs from "fs";
import path from "path";
import { execFile, exec } from "child_process";
import { McpToolInfo } from "./McpClientManager.js";

// ─────────────────────────────────────────────────────────────
// 工具定义（schema + handler）
// ─────────────────────────────────────────────────────────────

export interface BuiltinToolHandler {
  info: McpToolInfo;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  call: (args: Record<string, any>) => Promise<string>;
}

// ── web_search ──────────────────────────────────────────────
const webSearch: BuiltinToolHandler = {
  info: {
    name: "web_search",
    description:
      "Search the web using DuckDuckGo. Returns a list of search result titles and URLs. Use this to find information you don't know.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query string",
        },
        max_results: {
          type: "number",
          description: "Maximum number of results to return (default: 8)",
        },
      },
      required: ["query"],
    },
  },
  call: async (args) => {
    const query = String(args["query"] ?? "");
    const maxResults = Number(args["max_results"] ?? 8);

    if (!query) return "Error: query is required";

    console.log(`[BuiltinMcp:web_search] Searching: "${query}"`);

    try {
      // 使用 DuckDuckGo Lite HTML（不需要 API Key）
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
          Accept: "text/html",
        },
      });

      if (!res.ok) {
        return `Error: HTTP ${res.status} from DuckDuckGo`;
      }

      const html = await res.text();

      // 从 HTML 中提取结果（简单正则解析 DuckDuckGo Lite 结构）
      const results: Array<{ title: string; url: string; snippet: string }> = [];

      // DuckDuckGo Lite 结构: <a class="result__a" href="...">title</a>
      const linkPattern = /href="([^"]+)"[^>]*class="result__a"[^>]*>([^<]+)<\/a>/g;
      const snippetPattern = /class="result__snippet"[^>]*>([^<]+)</g;

      const links: Array<{ url: string; title: string }> = [];
      let m;
      while ((m = linkPattern.exec(html)) !== null && links.length < maxResults) {
        const href = m[1] ?? "";
        const title = m[2] ?? "";
        if (href.startsWith("http")) {
          links.push({ url: href, title: title.trim() });
        }
      }

      const snippets: string[] = [];
      let sn;
      while ((sn = snippetPattern.exec(html)) !== null) {
        snippets.push((sn[1] ?? "").trim());
      }

      for (let i = 0; i < Math.min(links.length, maxResults); i++) {
        results.push({
          title: links[i]!.title,
          url: links[i]!.url,
          snippet: snippets[i] ?? "",
        });
      }

      if (results.length === 0) {
        return `No results found for: "${query}"`;
      }

      const formatted = results
        .map(
          (r, i) =>
            `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   ${r.snippet}`
        )
        .join("\n\n");

      console.log(`[BuiltinMcp:web_search] Found ${results.length} results`);
      return `Web search results for "${query}":\n\n${formatted}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[BuiltinMcp:web_search] Error:`, msg);
      return `Error performing web search: ${msg}`;
    }
  },
};

// ── http_fetch ───────────────────────────────────────────────
const httpFetch: BuiltinToolHandler = {
  info: {
    name: "http_fetch",
    description:
      "Fetch the text content of a URL. Useful for reading web pages, API responses, or documentation. Returns plain text (HTML stripped).",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch",
        },
        max_chars: {
          type: "number",
          description: "Maximum characters to return (default: 4000)",
        },
      },
      required: ["url"],
    },
  },
  call: async (args) => {
    const url = String(args["url"] ?? "");
    const maxChars = Number(args["max_chars"] ?? 4000);

    if (!url) return "Error: url is required";

    console.log(`[BuiltinMcp:http_fetch] Fetching: ${url}`);

    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        },
      });

      if (!res.ok) {
        return `Error: HTTP ${res.status} ${res.statusText}`;
      }

      const contentType = res.headers.get("content-type") ?? "";
      let text = await res.text();

      // 如果是 HTML，提取可读文本
      if (contentType.includes("html")) {
        // 去除 script/style 标签及内容
        text = text
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s{2,}/g, " ")
          .trim();
      }

      if (text.length > maxChars) {
        text = text.slice(0, maxChars) + `\n\n[... content truncated at ${maxChars} chars ...]`;
      }

      console.log(
        `[BuiltinMcp:http_fetch] Fetched ${text.length} chars from ${url}`
      );
      return `Content from ${url}:\n\n${text}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[BuiltinMcp:http_fetch] Error:`, msg);
      return `Error fetching URL: ${msg}`;
    }
  },
};

// ── browser_open ─────────────────────────────────────────────
const browserOpen: BuiltinToolHandler = {
  info: {
    name: "browser_open",
    description:
      "Open a URL in the user's default system browser. Use this to show web pages or open external links.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to open in the browser",
        },
      },
      required: ["url"],
    },
  },
  call: async (args) => {
    const url = String(args["url"] ?? "");
    if (!url) return "Error: url is required";

    console.log(`[BuiltinMcp:browser_open] Opening: ${url}`);
    try {
      await shell.openExternal(url);
      return `Successfully opened ${url} in the default browser.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error opening browser: ${msg}`;
    }
  },
};

// ── clipboard_read ───────────────────────────────────────────
const clipboardRead: BuiltinToolHandler = {
  info: {
    name: "clipboard_read",
    description:
      "Read the current text content from the system clipboard. Returns the clipboard text.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  call: async (_args) => {
    console.log("[BuiltinMcp:clipboard_read] Reading clipboard");
    try {
      const text = clipboard.readText();
      if (!text) return "Clipboard is empty or contains non-text content.";
      return `Clipboard content:\n${text}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error reading clipboard: ${msg}`;
    }
  },
};

// ── clipboard_write ──────────────────────────────────────────
const clipboardWrite: BuiltinToolHandler = {
  info: {
    name: "clipboard_write",
    description:
      "Write text to the system clipboard. Use this to copy results or generated content for the user.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The text to write to clipboard",
        },
      },
      required: ["text"],
    },
  },
  call: async (args) => {
    const text = String(args["text"] ?? "");
    if (!text) return "Error: text is required";

    console.log(
      `[BuiltinMcp:clipboard_write] Writing ${text.length} chars to clipboard`
    );
    try {
      clipboard.writeText(text);
      return `Successfully wrote ${text.length} characters to clipboard.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error writing to clipboard: ${msg}`;
    }
  },
};

// ── fs_write ─────────────────────────────────────────────────
const fsWrite: BuiltinToolHandler = {
  info: {
    name: "fs_write",
    description:
      "Write content to a file on the local filesystem. Creates the file and any missing directories automatically. Use this to save code, text, or any generated content to disk.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative file path to write to (e.g. C:\\Users\\user\\Desktop\\hello.html)",
        },
        content: {
          type: "string",
          description: "The complete content to write to the file. Must include ALL content — no truncation.",
        },
      },
      required: ["path", "content"],
    },
  },
  call: async (args) => {
    const filePath = String(args["path"] ?? "");
    const content = String(args["content"] ?? "");

    if (!filePath) return "Error: path is required";

    console.log(`[BuiltinMcp:fs_write] Writing to: ${filePath} (${content.length} chars)`);

    try {
      // 自动创建目录
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });

      // 写入文件
      fs.writeFileSync(filePath, content, "utf-8");

      console.log(`[BuiltinMcp:fs_write] Successfully wrote ${content.length} chars to: ${filePath}`);
      return `Successfully wrote ${content.length} characters to: ${filePath}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[BuiltinMcp:fs_write] Error:`, msg);
      return `Error writing file: ${msg}`;
    }
  },
};

// ── fs_read ──────────────────────────────────────────────────
const fsRead: BuiltinToolHandler = {
  info: {
    name: "fs_read",
    description:
      "Read the content of a local file. Returns the file content as text. Useful for reading existing files before modifying them.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative file path to read",
        },
        max_chars: {
          type: "number",
          description: "Maximum characters to return (default: 8000)",
        },
      },
      required: ["path"],
    },
  },
  call: async (args) => {
    const filePath = String(args["path"] ?? "");
    const maxChars = Number(args["max_chars"] ?? 8000);

    if (!filePath) return "Error: path is required";

    console.log(`[BuiltinMcp:fs_read] Reading: ${filePath}`);

    try {
      if (!fs.existsSync(filePath)) {
        return `Error: File not found: ${filePath}`;
      }

      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        // 如果是目录，列出内容
        const entries = fs.readdirSync(filePath, { withFileTypes: true });
        const listing = entries.map(e => `${e.isDirectory() ? "[DIR] " : "      "}${e.name}`).join("\n");
        return `Directory listing for ${filePath}:\n\n${listing}`;
      }

      let content = fs.readFileSync(filePath, "utf-8");
      if (content.length > maxChars) {
        content = content.slice(0, maxChars) + `\n\n[... file truncated at ${maxChars} chars, total size: ${stat.size} bytes ...]`;
      }

      console.log(`[BuiltinMcp:fs_read] Read ${content.length} chars from: ${filePath}`);
      return `File content of ${filePath}:\n\n${content}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[BuiltinMcp:fs_read] Error:`, msg);
      return `Error reading file: ${msg}`;
    }
  },
};

// ── code_exec ─────────────────────────────────────────────────
const codeExec: BuiltinToolHandler = {
  info: {
    name: "code_exec",
    description:
      "Execute code and return the output. Supports JavaScript (Node.js), Python, and Bash/PowerShell. Use this to run, test, or verify code.",
    inputSchema: {
      type: "object",
      properties: {
        language: {
          type: "string",
          description: "The programming language: 'javascript', 'python', or 'bash'",
        },
        code: {
          type: "string",
          description: "The code to execute",
        },
        timeout_ms: {
          type: "number",
          description: "Execution timeout in milliseconds (default: 15000)",
        },
      },
      required: ["language", "code"],
    },
  },
  call: async (args) => {
    const language = String(args["language"] ?? "").toLowerCase();
    const code = String(args["code"] ?? "");
    const timeoutMs = Number(args["timeout_ms"] ?? 15000);

    if (!language) return "Error: language is required";
    if (!code) return "Error: code is required";

    console.log(`[BuiltinMcp:code_exec] Executing ${language} code (${code.length} chars)`);

    return new Promise((resolve) => {
      let cmd: string;
      let cmdArgs: string[];

      if (language === "javascript" || language === "js") {
        // Node.js：通过 -e 直接执行代码片段
        cmd = process.execPath; // Electron 内置的 Node.js
        cmdArgs = ["-e", code];
      } else if (language === "python" || language === "py") {
        // Python：尝试 python3 然后 python
        cmd = process.platform === "win32" ? "python" : "python3";
        cmdArgs = ["-c", code];
      } else if (language === "bash" || language === "shell" || language === "sh") {
        if (process.platform === "win32") {
          // Windows：使用 PowerShell
          cmd = "powershell";
          cmdArgs = ["-Command", code];
        } else {
          cmd = "bash";
          cmdArgs = ["-c", code];
        }
      } else {
        resolve(`Error: Unsupported language "${language}". Supported: javascript, python, bash`);
        return;
      }

      const proc = execFile(
        cmd,
        cmdArgs,
        {
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024, // 1MB 输出上限
          env: { ...process.env },
        },
        (error, stdout, stderr) => {
          const output = stdout.trim();
          const errOutput = stderr.trim();

          if (error) {
            const msg = error.killed
              ? `Execution timed out after ${timeoutMs}ms`
              : `Exit code ${error.code}: ${errOutput || error.message}`;
            console.warn(`[BuiltinMcp:code_exec] ${language} error:`, msg);
            resolve(`Code execution failed:\n${msg}${output ? `\n\nOutput before error:\n${output}` : ""}`);
          } else {
            const result = [
              output && `stdout:\n${output}`,
              errOutput && `stderr:\n${errOutput}`,
            ].filter(Boolean).join("\n\n") || "(no output)";
            console.log(`[BuiltinMcp:code_exec] ${language} execution successful`);
            resolve(`Code execution result:\n\n${result}`);
          }
        }
      );

      // 如果进程启动失败（如 python 未安装）
      proc.on("error", (err) => {
        const msg = err.message.includes("ENOENT")
          ? `${cmd} is not installed or not in PATH. Please install it to use code execution.`
          : err.message;
        resolve(`Error starting ${language} interpreter: ${msg}`);
      });
    });
  },
};

// ─────────────────────────────────────────────────────────────
// 导出所有内置工具
// ─────────────────────────────────────────────────────────────

/** 所有内置工具的 Map（name -> handler） */
export const BUILTIN_TOOLS: Map<string, BuiltinToolHandler> = new Map([
  ["web_search", webSearch],
  ["http_fetch", httpFetch],
  ["browser_open", browserOpen],
  ["clipboard_read", clipboardRead],
  ["clipboard_write", clipboardWrite],
  ["fs_write", fsWrite],
  ["fs_read", fsRead],
  ["code_exec", codeExec],
]);

/** 获取所有内置工具的 info 列表（用于合并到 MCP 工具列表） */
export function getBuiltinToolInfos(): McpToolInfo[] {
  return Array.from(BUILTIN_TOOLS.values()).map((t) => t.info);
}

/**
 * 调用内置工具
 * @param name 工具名
 * @param args 工具参数
 * @returns 工具执行结果字符串
 */
export async function callBuiltinTool(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>
): Promise<string> {
  const handler = BUILTIN_TOOLS.get(name);
  if (!handler) {
    throw new Error(`Builtin tool "${name}" not found`);
  }
  return handler.call(args);
}
