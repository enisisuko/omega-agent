/**
 * BuiltinMcpTools — 内置 MCP 工具集
 *
 * 这些工具不依赖外部 MCP 服务器进程，直接在 Electron 主进程中实现。
 * 包含：
 *   - web_search: 用 DuckDuckGo Lite API 搜索（无 API Key 要求）
 *   - browser_open: 用系统默认浏览器打开 URL
 *   - clipboard_read: 读取剪贴板文本
 *   - clipboard_write: 写入剪贴板文本
 *   - http_fetch: 抓取任意 URL 的文本内容
 */

import { clipboard, shell } from "electron";
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
