/**
 * AgentSkills — 内置 Agent 技能集
 *
 * 这些 Skills 是不依赖外部 MCP 的纯逻辑能力，由 AgentLoopExecutor 在执行时自动调用。
 *
 * 包含：
 *   - ContextCompressor: 上下文压缩（超出 token 限制时自动摘要历史消息）
 *   - RetryWithBackoff: 带退避的自动重试（LLM/Tool 调用失败时）
 *   - OutputFormatter: 格式化最终输出（Markdown 清理、代码块检测）
 *   - WebSearchSkill: 纯 JS 的搜索技能包装（与 web_search MCP 配合）
 */

// ─────────────────────────────────────────────────────────────
// ContextCompressor — 上下文压缩技能
// ─────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/**
 * 估算消息列表的 token 数（粗略估算：4 字符 ≈ 1 token）
 */
export function estimateTokens(messages: ChatMessage[]): number {
  const totalChars = messages.reduce(
    (sum, m) => sum + m.content.length,
    0
  );
  return Math.ceil(totalChars / 4);
}

/**
 * 压缩历史消息：
 * - 保留系统提示（system）
 * - 保留最近 N 轮对话（近期记忆）
 * - 将中间过多的历史合并为摘要块
 *
 * @param messages 当前消息列表
 * @param maxTokens 最大 token 上限（超过时触发压缩）
 * @param keepRecentRounds 保留最近几轮（每轮 = user+assistant，默认 3）
 * @returns 压缩后的消息列表（包含 wasCompressed 标记）
 */
export function compressContext(
  messages: ChatMessage[],
  maxTokens: number = 6000,
  keepRecentRounds: number = 3
): { messages: ChatMessage[]; wasCompressed: boolean; savedTokens: number } {
  const currentTokens = estimateTokens(messages);

  // 未超过上限，不压缩
  if (currentTokens <= maxTokens) {
    return { messages, wasCompressed: false, savedTokens: 0 };
  }

  console.log(
    `[ContextCompressor] Context too large: ~${currentTokens} tokens > ${maxTokens}. Compressing...`
  );

  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  // 保留最后 keepRecentRounds * 2 条（每轮 user+assistant）
  const keepCount = keepRecentRounds * 2;
  const recentMessages = nonSystemMessages.slice(-keepCount);
  const historicalMessages = nonSystemMessages.slice(0, -keepCount);

  if (historicalMessages.length === 0) {
    // 没有历史可压缩，直接截断
    const truncated = [...systemMessages, ...recentMessages];
    return {
      messages: truncated,
      wasCompressed: true,
      savedTokens: currentTokens - estimateTokens(truncated),
    };
  }

  // 将历史消息合并为一段摘要
  const summaryLines = historicalMessages
    .map((m) => {
      const role = m.role === "user" ? "User" : "Assistant";
      const preview = m.content.slice(0, 200);
      return `[${role}]: ${preview}${m.content.length > 200 ? "..." : ""}`;
    })
    .join("\n");

  const summaryMessage: ChatMessage = {
    role: "system",
    content: `[Context Summary - Earlier conversation compressed]\n${summaryLines}\n[End of Summary]`,
  };

  const compressed = [...systemMessages, summaryMessage, ...recentMessages];
  const newTokens = estimateTokens(compressed);

  console.log(
    `[ContextCompressor] Compressed: ${currentTokens} → ~${newTokens} tokens (saved ~${currentTokens - newTokens})`
  );

  return {
    messages: compressed,
    wasCompressed: true,
    savedTokens: currentTokens - newTokens,
  };
}

// ─────────────────────────────────────────────────────────────
// RetryWithBackoff — 带退避的自动重试技能
// ─────────────────────────────────────────────────────────────

export interface RetryOptions {
  /** 最大重试次数（默认 3） */
  maxRetries?: number;
  /** 初始等待时间 ms（默认 1000） */
  initialDelayMs?: number;
  /** 退避倍数（默认 2，即每次翻倍） */
  backoffMultiplier?: number;
  /** 最大等待时间 ms（默认 10000） */
  maxDelayMs?: number;
  /** 是否在控制台打印重试日志 */
  verbose?: boolean;
}

/**
 * 带指数退避的自动重试包装器
 *
 * @param fn 要执行的异步函数
 * @param opts 重试选项
 * @returns fn 的返回值
 * @throws 超过最大重试次数后抛出最后一次错误
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelayMs = 1000,
    backoffMultiplier = 2,
    maxDelayMs = 10000,
    verbose = true,
  } = opts;

  let lastError: unknown;
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const result = await fn();
      if (attempt > 1 && verbose) {
        console.log(`[RetryWithBackoff] Succeeded on attempt ${attempt}`);
      }
      return result;
    } catch (err) {
      lastError = err;
      if (attempt > maxRetries) break;

      const waitMs = Math.min(delay, maxDelayMs);
      if (verbose) {
        console.warn(
          `[RetryWithBackoff] Attempt ${attempt} failed: ${(err as Error).message}. Retrying in ${waitMs}ms...`
        );
      }

      await new Promise((res) => setTimeout(res, waitMs));
      delay = Math.min(delay * backoffMultiplier, maxDelayMs);
    }
  }

  throw lastError;
}

// ─────────────────────────────────────────────────────────────
// OutputFormatter — 输出格式化技能
// ─────────────────────────────────────────────────────────────

export interface FormatOptions {
  /** 是否确保代码块有语言标记（默认 true） */
  fixCodeBlocks?: boolean;
  /** 是否去除多余空行（默认 true） */
  normalizeWhitespace?: boolean;
  /** 最大输出字符数（超出则截断，默认不限制） */
  maxLength?: number;
  /** 是否在末尾添加分隔线（默认 false） */
  addSeparator?: boolean;
}

/**
 * 格式化 LLM 最终输出文本
 *
 * @param text 原始输出文本
 * @param opts 格式化选项
 * @returns 格式化后的文本
 */
export function formatOutput(text: string, opts: FormatOptions = {}): string {
  const {
    fixCodeBlocks = true,
    normalizeWhitespace = true,
    maxLength,
    addSeparator = false,
  } = opts;

  let result = text;

  // 1. 修复无语言标记的代码块（``` 后跟换行，猜测语言）
  if (fixCodeBlocks) {
    result = result.replace(/```\s*\n([\s\S]*?)```/g, (match, code: string) => {
      // 如果代码块开头没有语言标记，尝试检测
      const trimmed = code.trim();
      if (trimmed.startsWith("import ") || trimmed.startsWith("const ") || trimmed.includes("=>")) {
        return "```typescript\n" + code + "```";
      }
      if (trimmed.startsWith("def ") || trimmed.startsWith("class ") || trimmed.includes("print(")) {
        return "```python\n" + code + "```";
      }
      if (trimmed.startsWith("<") && trimmed.includes(">")) {
        return "```html\n" + code + "```";
      }
      return match; // 无法识别，保持原样
    });
  }

  // 2. 规范化空行（最多 2 个连续空行）
  if (normalizeWhitespace) {
    result = result.replace(/\n{3,}/g, "\n\n").trim();
  }

  // 3. 截断过长输出
  if (maxLength && result.length > maxLength) {
    result =
      result.slice(0, maxLength) +
      `\n\n...[Output truncated at ${maxLength} characters]`;
  }

  // 4. 末尾分隔线
  if (addSeparator) {
    result = result + "\n\n---";
  }

  return result;
}

/**
 * 检测文本是否包含代码块（用于 UI 决定是否使用代码渲染器）
 */
export function containsCode(text: string): boolean {
  return /```[\s\S]*?```/.test(text);
}

// ─────────────────────────────────────────────────────────────
// WebSearchSkill — 搜索技能（纯 JS，不依赖 MCP）
// ─────────────────────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * 使用 DuckDuckGo Instant Answer API 进行快速搜索
 * （无 API Key，返回较少结果，适合辅助判断）
 *
 * @param query 搜索词
 * @returns 搜索结果摘要文本
 */
export async function quickSearch(query: string): Promise<string> {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, {
      headers: { "User-Agent": "ICEE-Agent/0.1" },
    });

    if (!res.ok) return `Search failed: HTTP ${res.status}`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json();
    const lines: string[] = [];

    if (data["AbstractText"]) {
      lines.push(`**Summary**: ${data["AbstractText"]}`);
      if (data["AbstractURL"]) lines.push(`Source: ${data["AbstractURL"]}`);
    }

    if (data["RelatedTopics"] && Array.isArray(data["RelatedTopics"])) {
      const topics = (data["RelatedTopics"] as { Text?: string; FirstURL?: string }[])
        .slice(0, 5)
        .filter((t) => t.Text);
      if (topics.length > 0) {
        lines.push("\n**Related**:");
        topics.forEach((t, i) => {
          lines.push(`${i + 1}. ${t.Text} — ${t.FirstURL ?? ""}`);
        });
      }
    }

    if (lines.length === 0) return `No instant results for: "${query}"`;
    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Search error: ${msg}`;
  }
}

// ─────────────────────────────────────────────────────────────
// 导出所有技能的元信息（用于 UI 的 Skills 面板展示）
// ─────────────────────────────────────────────────────────────

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  category: "context" | "reliability" | "output" | "search";
}

export const BUILTIN_SKILL_INFOS: SkillInfo[] = [
  {
    id: "ContextCompressor",
    name: "ContextCompressor",
    description:
      "Automatically compresses conversation history when context exceeds token limits, keeping recent rounds while summarizing older ones.",
    category: "context",
  },
  {
    id: "RetryWithBackoff",
    name: "RetryWithBackoff",
    description:
      "Automatically retries failed LLM or tool calls with exponential backoff, preventing transient errors from breaking the agent loop.",
    category: "reliability",
  },
  {
    id: "OutputFormatter",
    name: "OutputFormatter",
    description:
      "Formats the agent's final answer: fixes code blocks, normalizes whitespace, and detects programming language for syntax highlighting.",
    category: "output",
  },
  {
    id: "WebSearchSkill",
    name: "WebSearchSkill",
    description:
      "Built-in web search using DuckDuckGo — no API key required. Complements the web_search MCP tool with instant answer lookup.",
    category: "search",
  },
];
