import { nanoid } from "nanoid";
import { createLogger } from "../logger.js";
import type { AgentLoopConfig, AgentStep } from "@icee/shared";
import {
  compressContext,
  estimateTokens,
  retryWithBackoff,
  formatOutput,
} from "../skills/AgentSkills.js";

const log = createLogger("AgentLoopExecutor");

// ─── 类型定义 ──────────────────────────────────────────────────────────────

/** LLM 调用函数签名（由 main/index.ts 注入） */
export type AgentLLMInvoker = (
  systemPrompt: string,
  messages: ChatMessage[],
  options?: { temperature?: number; maxTokens?: number }
) => Promise<{ text: string; tokens: number; costUsd: number }>;

/** MCP 工具调用函数签名（由 main/index.ts 注入） */
export type AgentToolInvoker = (
  toolName: string,
  toolInput: unknown
) => Promise<string>;

/** 步骤事件回调（每次迭代完成都会触发，供 UI 实时更新） */
export type AgentStepCallback = (
  runId: string,
  step: AgentStep
) => void;

/** 聊天消息格式 */
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** AgentLoopResult — 完整循环的返回值 */
export interface AgentLoopResult {
  finalAnswer: string;
  steps: AgentStep[];
  totalTokens: number;
  totalCostUsd: number;
  iterations: number;
}

/** 工具 Schema 信息（从 BuiltinMcpTools 动态注入） */
export interface ToolSchemaInfo {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

// ─── 工具描述构建 ──────────────────────────────────────────────────────────

/**
 * 将工具 Schema 列表动态生成为 System Prompt 内的工具说明块
 * 单一数据源：直接消费 BuiltinMcpTools.inputSchema，不再维护独立的 knownTools 字典
 * 参考 Cline 的 XML 风格工具描述，精确到每个参数的类型、是否必填
 */
function buildToolDescriptions(
  availableTools: string[],
  toolSchemas: ToolSchemaInfo[] = []
): string {
  if (availableTools.length === 0) {
    return "（当前无可用工具，请直接用你的知识回答。注意：即使没有工具，你仍然必须用 <attempt_completion> 标签来提交最终答案。）";
  }

  // 建立 name → schema 的 Map（O(1) 查找）
  const schemaMap = new Map<string, ToolSchemaInfo>(
    toolSchemas.map(s => [s.name, s])
  );

  const lines: string[] = [
    "# Tool Use",
    "",
    "You have access to tools that help you complete tasks. Use tools step-by-step — one tool per message.",
    "You will receive the result of each tool use before deciding your next action.",
    "",
    "## Tool Use Formatting",
    "",
    "Tool use is formatted using XML-style tags:",
    "",
    "<tool_use>",
    "<tool_name>tool_name_here</tool_name>",
    "<param1>value1</param1>",
    "<param2>value2</param2>",
    "</tool_use>",
    "",
    "## Available Tools",
    "",
  ];

  for (const toolName of availableTools) {
    const schema = schemaMap.get(toolName);

    if (schema) {
      lines.push(`### ${schema.name}`);
      lines.push(`**Description:** ${schema.description}`);

      const props = schema.inputSchema.properties ?? {};
      const required = new Set(schema.inputSchema.required ?? []);
      const paramEntries = Object.entries(props);

      if (paramEntries.length > 0) {
        lines.push("**Parameters:**");
        for (const [paramName, paramInfo] of paramEntries) {
          const req = required.has(paramName) ? "(required)" : "(optional)";
          lines.push(`- \`${paramName}\` ${req}: ${paramInfo.description ?? paramInfo.type}`);
        }

        lines.push("**Usage:**");
        lines.push("<tool_use>");
        lines.push(`<tool_name>${schema.name}</tool_name>`);
        for (const [paramName, paramInfo] of paramEntries) {
          lines.push(`<${paramName}>${paramInfo.description ?? "value"}</${paramName}>`);
        }
        lines.push("</tool_use>");
      } else {
        lines.push("**Usage:** (no parameters required)");
        lines.push("<tool_use>");
        lines.push(`<tool_name>${schema.name}</tool_name>`);
        lines.push("</tool_use>");
      }
    } else {
      // 没有 schema 信息的工具（MCP 动态工具）
      lines.push(`### ${toolName}`);
      lines.push("**Usage:**");
      lines.push("<tool_use>");
      lines.push(`<tool_name>${toolName}</tool_name>`);
      lines.push("<input>parameters here</input>");
      lines.push("</tool_use>");
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── System Prompt 构建 ───────────────────────────────────────────────────

/**
 * 构建 AgentLoop 的 System Prompt（双语，全面对标 Cline）
 *
 * 改进要点（v0.3.5）：
 * 1. 强化角色定位（专业工程师，不是聊天机器人）
 * 2. 工具使用强制约束：每次只能一个工具，必须等待结果
 * 3. 引入 attempt_completion 作为唯一合法任务终止方式，带安全前置条件
 * 4. thinking 标签强制先评估，再行动
 * 5. 禁止闲聊、禁止推测工具结果、禁止对话性开头结尾
 * 6. 用户 Rules 和项目 Rules 动态注入
 */
export function buildAgentSystemPrompt(
  basePrompt: string,
  availableTools: string[],
  lang: "zh" | "en" = "zh",
  toolSchemas: ToolSchemaInfo[] = [],
  userRules?: string,
  projectRules?: string,
): string {
  const toolDesc = buildToolDescriptions(availableTools, toolSchemas);
  const hasTools = availableTools.length > 0;

  const rulesSection = buildRulesSection(userRules, projectRules, lang);

  if (lang === "zh") {
    return `${basePrompt}

---

${toolDesc}

---

## attempt_completion（任务完成工具）

当你确认任务已经完成时，使用此工具提交最终结果。

**重要约束：**
- 在确认所有工具调用都成功之前，禁止使用此工具
- 在使用此工具前，先在 <thinking> 标签内确认每一步是否已成功
- result 参数必须完整、详细，直接面向用户可读

**用法：**
<attempt_completion>
<result>
[完整的最终结果，包含所有必要内容，不以问句或邀请进一步对话结尾]
</result>
</attempt_completion>

---

## 行为规范（必须遵守）

### 工具使用规范
${hasTools ? `- **每次响应只能调用一个工具**，调用后等待结果，不要假设结果
- 在 <thinking> 中评估当前状态，决定下一步行动
- 工具执行失败时，分析原因并尝试修复，不要直接放弃
- 不要在工具调用前就假设工具会成功` : `- 当前无可用工具，请直接根据知识回答`}

### 任务执行规范
- 逐步完成任务，每一步都基于上一步的实际结果
- 第一次响应必须先在 <thinking> 中分析任务，制定执行计划
- 不要假设工具结果，必须等到实际观察到结果后再继续
- 任务完成后必须使用 <attempt_completion> 提交结果

### 输出规范
- 禁止以"好的"、"当然"、"明白了"等闲聊性语句开头
- 禁止在 attempt_completion 结果末尾以问句或邀请用户进一步对话结尾
- 使用与用户相同的语言（用户用中文，你就用中文）
- 代码块必须完整、可直接运行，不得截断

---

## 响应格式

**需要使用工具时：**
<thinking>
[评估当前信息，分析需要做什么，为什么需要这个工具]
</thinking>
<tool_use>
<tool_name>[工具名]</tool_name>
[参数]
</tool_use>

**任务已完成，提交结果时：**
<thinking>
[确认所有工具调用都已成功，任务目标已达成]
</thinking>
<attempt_completion>
<result>
[完整结果]
</result>
</attempt_completion>

---

${rulesSection}`;
  }

  return `${basePrompt}

---

${toolDesc}

---

## attempt_completion (Task Completion Tool)

Use this tool when you have confirmed the task is fully completed.

**Important constraints:**
- CANNOT be used until you've confirmed all previous tool uses were successful
- Before using, assess in <thinking> whether every step has succeeded
- The result must be complete and directly readable by the user

**Usage:**
<attempt_completion>
<result>
[Complete final result. Do NOT end with a question or invitation for further conversation.]
</result>
</attempt_completion>

---

## Rules (MUST follow)

### Tool Use Rules
${hasTools ? `- **Use only ONE tool per response.** Wait for the result before proceeding
- Before calling a tool, assess your current state in <thinking>
- Do not assume the outcome of any tool use — wait for the actual result
- If a tool fails, analyze the error and attempt a fix` : `- No tools available — answer directly from your knowledge`}

### Task Execution Rules
- Work through tasks step-by-step, each step informed by the previous result
- Your first response MUST analyze the task in <thinking> and plan your approach
- Complete the task iteratively — do not attempt to answer everything at once
- End every task with <attempt_completion>

### Output Rules
- NEVER start with "Great", "Certainly", "Okay", "Sure" or other filler phrases
- NEVER end attempt_completion result with a question or request for further conversation
- Match the user's language
- Code must be complete and runnable — no truncation

---

## Response Format

**When a tool is needed:**
<thinking>
[Assess current state, determine what information is needed and why]
</thinking>
<tool_use>
<tool_name>[tool name]</tool_name>
[parameters]
</tool_use>

**When task is complete:**
<thinking>
[Confirm all tool uses succeeded and task objective is met]
</thinking>
<attempt_completion>
<result>
[Complete result]
</result>
</attempt_completion>

---

${rulesSection}`;
}

/**
 * 构建用户 Rules 和项目 Rules 章节
 */
function buildRulesSection(
  userRules?: string,
  projectRules?: string,
  lang: "zh" | "en" = "zh"
): string {
  const sections: string[] = [];

  if (userRules?.trim()) {
    if (lang === "zh") {
      sections.push(`## 用户自定义规则（优先级最高）\n\n${userRules.trim()}`);
    } else {
      sections.push(`## User Custom Rules (Highest Priority)\n\n${userRules.trim()}`);
    }
  }

  if (projectRules?.trim()) {
    if (lang === "zh") {
      sections.push(`## 项目规则（.icee/rules.md）\n\n${projectRules.trim()}`);
    } else {
      sections.push(`## Project Rules (.icee/rules.md)\n\n${projectRules.trim()}`);
    }
  }

  return sections.join("\n\n---\n\n");
}

// ─── 响应解析 ─────────────────────────────────────────────────────────────

/**
 * 解析 LLM 响应中的结构化内容
 * 提取 <thinking>、<tool_use>、<attempt_completion> 等标签
 *
 * 改进（v0.3.5）：
 * - 支持 attempt_completion 标签（新的任务终止方式）
 * - 同时兼容旧的 <final_answer> 标签
 * - 同时兼容 <thought> 和 <thinking> 两种思考标签
 * - 移除危险的 fallback（>20字直接当 finalAnswer），改为严格解析
 * - tool_use 块使用贪婪匹配的保护版本，避免内容中有 </tool_use> 时截断
 */
function parseAgentResponse(text: string): {
  thinking?: string;
  toolName?: string;
  toolInput?: unknown;
  finalAnswer?: string;
} {
  // ── 提取 thinking / thought（两种标签均支持）──────────────
  const thinkingMatch =
    text.match(/<thinking>([\s\S]*?)<\/thinking>/i) ??
    text.match(/<thought>([\s\S]*?)<\/thought>/i);
  const thinking = thinkingMatch?.[1]?.trim();

  // ── 提取 attempt_completion → result ──────────────────────
  // attempt_completion 是新的、唯一合法的任务终止方式
  const completionMatch = text.match(/<attempt_completion>([\s\S]*?)<\/attempt_completion>/i);
  if (completionMatch) {
    const completionBlock = completionMatch[1] ?? "";
    const resultMatch = completionBlock.match(/<result>([\s\S]*?)<\/result>/i);
    const finalAnswer = resultMatch?.[1]?.trim() ?? completionBlock.trim();
    const result: { thinking?: string; finalAnswer?: string } = {};
    if (thinking !== undefined) result.thinking = thinking;
    if (finalAnswer) result.finalAnswer = finalAnswer;
    return result;
  }

  // ── 兼容旧的 <final_answer> 标签 ──────────────────────────
  const finalMatch = text.match(/<final_answer>([\s\S]*?)<\/final_answer>/i);
  if (finalMatch) {
    const finalAnswer = finalMatch[1]?.trim();
    const result: { thinking?: string; finalAnswer?: string } = {};
    if (thinking !== undefined) result.thinking = thinking;
    if (finalAnswer !== undefined) result.finalAnswer = finalAnswer;
    return result;
  }

  // ── 提取 tool_use ──────────────────────────────────────────
  // 使用最后一个 </tool_use> 作为边界（避免工具参数内含 </tool_use> 时截断）
  const toolUseStart = text.indexOf("<tool_use>");
  const toolUseEnd = text.lastIndexOf("</tool_use>");
  if (toolUseStart !== -1 && toolUseEnd !== -1 && toolUseEnd > toolUseStart) {
    const toolBlock = text.slice(toolUseStart + "<tool_use>".length, toolUseEnd);
    const toolNameMatch = toolBlock.match(/<tool_name>([\s\S]*?)<\/tool_name>/i);
    const toolName = toolNameMatch?.[1]?.trim();

    // 提取工具参数（除 tool_name 以外的所有内容）
    const inputBlock = toolBlock.replace(/<tool_name>[\s\S]*?<\/tool_name>/i, "").trim();
    let toolInput: unknown = inputBlock;

    // 尝试解析各个参数标签
    // ⚠️ 关键：不能用全局非贪婪正则 <(\w+)>([\s\S]*?)<\/\1>
    //   因为当参数值本身含有 XML 标签（如写代码时 content 里有 <div>）时，
    //   非贪婪匹配会在 </div> 处截断，导致参数值残缺
    //
    // 修复方案：先提取所有参数名，再逐参数名查找「第一个开始标签」到「最后一个结束标签」之间的内容
    const paramMap: Record<string, string> = {};
    // 第一步：找出所有出现的参数名（开始标签）
    const tagNameRegex = /<(\w+)>/g;
    const tagNames = new Set<string>();
    for (const m of inputBlock.matchAll(tagNameRegex)) {
      if (m[1] && m[1].toLowerCase() !== "tool_name") {
        tagNames.add(m[1]);
      }
    }
    // 第二步：逐参数名，找第一个 <name> 到最后一个 </name> 之间的内容（贪婪）
    for (const name of tagNames) {
      const openTag = `<${name}>`;
      const closeTag = `</${name}>`;
      const start = inputBlock.indexOf(openTag);
      const end = inputBlock.lastIndexOf(closeTag);
      if (start !== -1 && end !== -1 && end > start) {
        paramMap[name] = inputBlock.slice(start + openTag.length, end).trim();
      }
    }
    if (Object.keys(paramMap).length > 0) {
      toolInput = paramMap;
    }

    const result: { thinking?: string; toolName?: string; toolInput?: unknown } = {
      toolInput,
    };
    if (thinking !== undefined) result.thinking = thinking;
    if (toolName !== undefined) result.toolName = toolName;
    return result;
  }

  // ── 无结构化标签：只返回 thinking（不再 fallback 当 finalAnswer）──
  // 旧版在这里有危险的 fallback（>20字直接当 finalAnswer）
  // 现在只有明确的 <attempt_completion> 或 <final_answer> 标签才会结束循环
  // 没有标签时，AgentLoop 会 nudge LLM 重新给出结构化响应
  const fallback: { thinking?: string } = {};
  if (thinking !== undefined) fallback.thinking = thinking;
  return fallback;
}

// ─── ReAct 主循环 ─────────────────────────────────────────────────────────

/**
 * AgentLoopExecutor — Cline 风格 ReAct 动态循环执行器（v0.3.5）
 *
 * 执行流程：
 * 1. 初始化：构建 system prompt（角色 + 工具说明 + 行为规范）
 * 2. 开始循环：
 *    a. 发送当前 messages 给 LLM
 *    b. 解析响应：工具调用 / attempt_completion / 无结构化内容
 *    c-1. 工具调用 → 执行工具 → Cline 风格格式化结果追加进 messages → 回 b
 *    c-2. attempt_completion → 结束循环，返回结果
 *    c-3. 无结构化 → nudge LLM 重新给出结构化响应 → 回 b
 * 3. 超过最大迭代次数：强制总结后输出
 *
 * 工具结果注入格式（Cline 风格）：
 *   ## Tool Use: {toolName}
 *   Result:
 *   {observation}
 *
 * 上下文截断策略（从中间删，保留首尾）：
 *   保留第一条 user 消息（任务定义）+ 最近 N 条消息
 */
export class AgentLoopExecutor {
  private runId: string;
  private config: AgentLoopConfig;
  private invokeLLM: AgentLLMInvoker;
  private invokeTool: AgentToolInvoker;
  private onStep: AgentStepCallback;
  private lang: "zh" | "en";
  private toolSchemas: ToolSchemaInfo[];
  private userRules?: string;
  private projectRules?: string;
  private signal?: AbortSignal;  // 取消信号（由外部 AbortController 注入）

  constructor(opts: {
    runId: string;
    config: AgentLoopConfig;
    invokeLLM: AgentLLMInvoker;
    invokeTool: AgentToolInvoker;
    onStep: AgentStepCallback;
    lang?: "zh" | "en";
    toolSchemas?: ToolSchemaInfo[];
    userRules?: string;
    projectRules?: string;
    signal?: AbortSignal;  // 可选的取消信号
  }) {
    this.runId = opts.runId;
    this.config = opts.config;
    this.invokeLLM = opts.invokeLLM;
    this.invokeTool = opts.invokeTool;
    this.onStep = opts.onStep;
    this.lang = opts.lang ?? "zh";
    this.toolSchemas = opts.toolSchemas ?? [];
    if (opts.userRules !== undefined) this.userRules = opts.userRules;
    if (opts.projectRules !== undefined) this.projectRules = opts.projectRules;
    if (opts.signal !== undefined) this.signal = opts.signal;
  }

  async execute(task: string): Promise<AgentLoopResult> {
    const { config, runId } = this;
    const systemPrompt = buildAgentSystemPrompt(
      config.systemPrompt,
      config.availableTools,
      this.lang,
      this.toolSchemas,
      this.userRules,
      this.projectRules,
    );

    // 初始化对话历史（首条 user 消息包含完整任务，后续截断时会保留）
    const messages: ChatMessage[] = [
      { role: "user", content: task },
    ];

    const steps: AgentStep[] = [];
    let totalTokens = 0;
    let totalCostUsd = 0;
    let iteration = 0;
    let continueLoop = true;
    let finalAnswer = "";

    log.info({ runId, task: task.slice(0, 80), maxIterations: config.maxIterations }, "AgentLoop started");

    while (continueLoop && iteration < config.maxIterations) {
      // ── 取消检查：每轮循环开始时检查 AbortSignal ──────────────────────
      if (this.signal?.aborted) {
        log.info({ runId, iteration }, "AgentLoop cancelled by AbortSignal");
        finalAnswer = this.lang === "zh" ? "任务已被用户取消。" : "Task cancelled by user.";
        break;
      }

      iteration++;
      log.debug({ runId, iteration }, "AgentLoop iteration start");

      const stepIndex = iteration;

      // 通知 UI：新步骤开始（thinking 状态）
      const stepThinking: AgentStep = {
        index: stepIndex,
        status: "thinking",
        tokens: 0,
      };
      this.onStep(runId, stepThinking);

      let llmResponse: string;
      let tokens = 0;
      let costUsd = 0;

      try {
        // ── ContextCompressor：上下文超出 80% token 限制时自动压缩 ────
        // 改进：从中间截断（保留首条 user 消息 + 最近 N 条），而不是从头删
        const tokenBudget = Math.floor(config.maxTokens * 0.8);
        const currentTokens = estimateTokens(messages);
        if (currentTokens > tokenBudget && messages.length > 4) {
          // 保留首条 user 消息（任务定义）+ 最后 4 条消息（最新上下文）
          const firstMsg = messages[0]!;
          const recentMsgs = messages.slice(-4);
          const truncatedNotice: ChatMessage = {
            role: "user",
            content: this.lang === "zh"
              ? "[上下文已压缩：中间历史记录已移除，保留任务定义和最新操作]"
              : "[Context compressed: middle history removed, keeping task definition and recent actions]",
          };
          messages.length = 0;
          messages.push(firstMsg, truncatedNotice, ...recentMsgs);
          log.warn({ runId, iteration }, "[ContextCompressor] Messages truncated from middle");
        } else if (currentTokens > tokenBudget) {
          // 消息数太少时才用旧的压缩方式
          const compressed = compressContext(messages, tokenBudget, 3);
          if (compressed.wasCompressed) {
            log.warn(
              { runId, iteration, savedTokens: compressed.savedTokens },
              "[ContextCompressor] Context compressed"
            );
            messages.length = 0;
            messages.push(...compressed.messages);
          }
        }

        // ── 取消检查：LLM 调用前再次检查（避免压缩后仍调用）──────────
        if (this.signal?.aborted) {
          log.info({ runId, iteration }, "AgentLoop cancelled before LLM call");
          finalAnswer = this.lang === "zh" ? "任务已被用户取消。" : "Task cancelled by user.";
          continueLoop = false;
          break;
        }

        // ── RetryWithBackoff: 带退避的 LLM 调用 ────────────────────────
        const result = await retryWithBackoff(
          () => this.invokeLLM(systemPrompt, messages, {
            temperature: config.temperature,
            maxTokens: config.maxTokens,
          }),
          { maxRetries: 2, initialDelayMs: 1000, verbose: true }
        );
        llmResponse = result.text;
        tokens = result.tokens;
        costUsd = result.costUsd;
        totalTokens += tokens;
        totalCostUsd += costUsd;
        log.debug({ runId, iteration, tokens, responseLength: llmResponse.length }, "LLM responded");
      } catch (err) {
        log.error({ runId, iteration, err }, "LLM invocation failed in AgentLoop");
        const step: AgentStep = {
          index: stepIndex,
          status: "error",
          thought: `LLM error: ${(err as Error).message}`,
          tokens: 0,
        };
        steps.push(step);
        this.onStep(runId, step);
        throw err;
      }

      // 把 LLM 响应追加到对话历史
      messages.push({ role: "assistant", content: llmResponse });

      // 解析响应
      const parsed = parseAgentResponse(llmResponse);

      // ── 情况 1：attempt_completion / final_answer → 结束循环 ──
      if (parsed.finalAnswer) {
        // OutputFormatter: 格式化最终输出
        finalAnswer = formatOutput(parsed.finalAnswer, {
          fixCodeBlocks: true,
          normalizeWhitespace: true,
        });
        continueLoop = false;

        const step: AgentStep = {
          index: stepIndex,
          thought: parsed.thinking,
          finalAnswer: parsed.finalAnswer,
          status: "done",
          tokens,
        };
        steps.push(step);
        this.onStep(runId, step);

        log.info({ runId, iteration, tokens }, "AgentLoop: task completed via attempt_completion");
        break;
      }

      // ── 情况 2：工具调用 → 执行工具 → 观察结果 ────────
      if (parsed.toolName) {
        // 通知 UI：正在行动（acting 状态）
        const stepActing: AgentStep = {
          index: stepIndex,
          thought: parsed.thinking,
          toolName: parsed.toolName,
          toolInput: parsed.toolInput,
          status: "acting",
          tokens,
        };
        steps.push(stepActing);
        this.onStep(runId, stepActing);

        log.info({ runId, iteration, toolName: parsed.toolName }, "AgentLoop: invoking tool");

        let observation: string;
        try {
          observation = await this.invokeTool(parsed.toolName, parsed.toolInput);
          log.debug({ runId, iteration, toolName: parsed.toolName, observationLength: observation.length }, "Tool returned");
        } catch (err) {
          observation = `Tool "${parsed.toolName}" failed: ${(err as Error).message}`;
          log.warn({ runId, iteration, toolName: parsed.toolName, err }, "Tool invocation failed");
        }

        // 通知 UI：已观察到结果（observing 状态）
        const stepObserving: AgentStep = {
          index: stepIndex,
          thought: parsed.thinking,
          toolName: parsed.toolName,
          toolInput: parsed.toolInput,
          observation,
          status: "observing",
          tokens,
        };
        // 更新步骤为 observing（替换 acting）
        const lastIdx = steps.findIndex(s => s.index === stepIndex);
        if (lastIdx >= 0) {
          steps[lastIdx] = stepObserving;
        } else {
          steps.push(stepObserving);
        }
        this.onStep(runId, stepObserving);

        // ── Cline 风格工具结果格式：## Tool Use / Result ──────────────
        // 让 LLM 清晰区分"用户消息"和"工具执行结果"
        const observationMsg = this.lang === "zh"
          ? `## Tool Use: ${parsed.toolName}\nResult:\n\n${observation}\n\n请基于以上工具结果继续分析，决定下一步行动。如果任务已完成，使用 <attempt_completion> 提交结果。`
          : `## Tool Use: ${parsed.toolName}\nResult:\n\n${observation}\n\nBased on the tool result above, decide your next action. If the task is complete, use <attempt_completion> to submit your result.`;
        messages.push({ role: "user", content: observationMsg });

        continue; // 继续下一轮循环
      }

      // ── 情况 3：LLM 没给出格式化内容 → 提示继续 ──────
      log.warn({ runId, iteration, response: llmResponse.slice(0, 100) }, "AgentLoop: no structured response, prompting to continue");

      const nudge = this.lang === "zh"
        ? `请用规定的格式响应。如果需要使用工具，使用 <tool_use> 格式。如果任务已完成，使用 <attempt_completion><result>最终结果</result></attempt_completion>。\n\n你刚才的回复缺少结构化标签，请重新回复。`
        : `Please respond in the required format. If you need a tool, use the <tool_use> format. If the task is complete, use <attempt_completion><result>final result</result></attempt_completion>.\n\nYour last response was missing structured tags — please reply again.`;
      messages.push({ role: "user", content: nudge });

      const nudgeStep: AgentStep = {
        index: stepIndex,
        thought: parsed.thinking || llmResponse.slice(0, 200),
        status: "thinking",
        tokens,
      };
      steps.push(nudgeStep);
      this.onStep(runId, nudgeStep);
    }

    // ── 超过最大迭代次数：强制总结 ─────────────────────────────
    if (!finalAnswer && iteration >= config.maxIterations) {
      log.warn({ runId, iteration, config: config.maxIterations }, "AgentLoop: max iterations reached, forcing summary");

      const forceMsg = this.lang === "zh"
        ? "你已达到最大迭代次数。请立刻用 <attempt_completion><result>你目前得到的最佳答案</result></attempt_completion> 给出最终结果，即使不完整也要给出。"
        : "Maximum iterations reached. Please immediately provide your best result using <attempt_completion><result>your best answer so far</result></attempt_completion>, even if incomplete.";
      messages.push({ role: "user", content: forceMsg });

      try {
        const result = await this.invokeLLM(systemPrompt, messages, {
          temperature: 0.3,
          maxTokens: 2048,
        });
        const forcedParsed = parseAgentResponse(result.text);
        finalAnswer = forcedParsed.finalAnswer ?? result.text;
        totalTokens += result.tokens;
        totalCostUsd += result.costUsd;

        const forcedStep: AgentStep = {
          index: iteration + 1,
          thought: this.lang === "zh" ? "达到最大迭代次数，强制输出最终答案" : "Max iterations reached, forcing final answer",
          finalAnswer,
          status: "done",
          tokens: result.tokens,
        };
        steps.push(forcedStep);
        this.onStep(runId, forcedStep);
      } catch {
        finalAnswer = steps
          .filter(s => s.observation || s.thought)
          .map(s => s.observation ?? s.thought ?? "")
          .join("\n\n")
          || (this.lang === "zh" ? "（Agent 运行超时，无法生成最终答案）" : "(Agent timed out, could not generate final answer)");
      }
    }

    log.info({
      runId,
      totalIterations: iteration,
      totalTokens,
      stepsCount: steps.length,
    }, "AgentLoop completed");

    return {
      finalAnswer,
      steps,
      totalTokens,
      totalCostUsd,
      iterations: iteration,
    };
  }

  /** 生成步骤唯一 ID */
  static genStepId(runId: string, index: number): string {
    return `${runId}_step${index}_${nanoid(6)}`;
  }
}
