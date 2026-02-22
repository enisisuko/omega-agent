import { nanoid } from "nanoid";
import { createLogger } from "../logger.js";
import type { AgentLoopConfig, AgentStep } from "@omega/shared";
import {
  estimateTokens,
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

/**
 * ask_followup_question 回调（Cline 风格的 Human-in-the-loop）
 * 当 AI 调用 ask_followup_question 工具时触发，返回用户的回答
 * 主进程通过 IPC 将问题推送到 UI，并等待用户输入后 resolve
 */
export type AskFollowupCallback = (
  runId: string,
  question: string,
  options?: string[]  // 可选的选项列表（供 UI 显示快速选项按钮）
) => Promise<string>;

/** 多模态内容块（OpenAI vision 格式） */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

/** 聊天消息格式（支持纯文本 string 或多模态 ContentPart[]） */
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string | ContentPart[];
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

// ─── 核心工具函数（Cline 风格）─────────────────────────────────────────────

/**
 * 安全提取 XML 标签内容（Cline 风格）
 * 使用 indexOf + lastIndexOf 而非非贪婪正则
 * lastIndexOf 保证即使内容里含有同名闭合标签也能正确提取全量内容
 */
function extractBetweenTags(text: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start === -1 || end === -1 || end <= start) return undefined;
  return text.slice(start + open.length, end).trim();
}

/**
 * 提取参数标签内容（用于 tool_use 块内的各参数）
 * 同样使用 indexOf + lastIndexOf 保证贪婪匹配
 */
function extractParam(inputBlock: string, paramName: string): string | undefined {
  const open = `<${paramName}>`;
  const close = `</${paramName}>`;
  const start = inputBlock.indexOf(open);
  const end = inputBlock.lastIndexOf(close);
  if (start === -1 || end === -1 || end <= start) return undefined;
  return inputBlock.slice(start + open.length, end).trim();
}

/**
 * Cline 风格的上下文截断范围计算
 * 永远保留 index 0（用户任务原始消息）和 index 1（首次助手回应）
 * 从 index 2 起按比例成对删除（保持 user-assistant 结构）
 *
 * @param messages 当前消息列表
 * @param keep "half" 删除中间1/2，"quarter" 删除中间3/4（上下文严重超出时）
 * @returns [startIdx, endIdx] 闭区间，这个范围内的消息会被删除
 */
function getTruncationRange(
  messages: ChatMessage[],
  keep: "half" | "quarter"
): [number, number] | null {
  // 消息数量不足时不截断（至少要有 5 条才值得截断）
  if (messages.length <= 4) return null;

  const startOfMiddle = 2; // 固定保留前2条（index 0 和 1）
  const available = messages.length - startOfMiddle;

  // 计算要删除的对数（user+assistant 是一对，成对删除保持结构）
  let pairsToRemove: number;
  if (keep === "half") {
    pairsToRemove = Math.floor(available / 4); // 删 1/2（每4条删2条=1对）
  } else {
    pairsToRemove = Math.floor((available * 3) / 8); // 删 3/4
  }

  if (pairsToRemove <= 0) return null;

  const removeCount = pairsToRemove * 2;
  let endIdx = startOfMiddle + removeCount - 1;

  // 确保被删除的最后一条是 assistant 消息（保持 user-assistant 结构）
  if (messages[endIdx]?.role !== "assistant" && endIdx > startOfMiddle) {
    endIdx -= 1;
  }

  if (endIdx < startOfMiddle) return null;
  return [startOfMiddle, endIdx];
}

// ─── System Prompt 构建 ───────────────────────────────────────────────────

/**
 * 将工具 Schema 列表动态生成为 System Prompt 内的工具说明块
 * 使用 Cline 的直接标签格式（<tool_name><param>value</param></tool_name>）
 * 比嵌套格式更简洁，LLM 更容易正确输出
 */
function buildToolDescriptions(
  availableTools: string[],
  toolSchemas: ToolSchemaInfo[] = [],
  lang: "zh" | "en" = "zh"
): string {
  if (availableTools.length === 0) {
    return lang === "zh"
      ? "（当前无可用工具，请直接用你的知识回答。即使没有工具，任务完成后仍必须使用 attempt_completion 标签提交结果。）"
      : "(No tools available — answer from your knowledge. You must still use attempt_completion when done.)";
  }

  // 建立 name → schema 的 Map
  const schemaMap = new Map<string, ToolSchemaInfo>(
    toolSchemas.map(s => [s.name, s])
  );

  const lines: string[] = [];

  for (const toolName of availableTools) {
    const schema = schemaMap.get(toolName);

    if (schema) {
      lines.push(`## ${schema.name}`);
      lines.push(lang === "zh"
        ? `**描述：** ${schema.description}`
        : `**Description:** ${schema.description}`);

      const props = schema.inputSchema.properties ?? {};
      const required = new Set(schema.inputSchema.required ?? []);
      const paramEntries = Object.entries(props);

      if (paramEntries.length > 0) {
        lines.push(lang === "zh" ? "**参数：**" : "**Parameters:**");
        for (const [paramName, paramInfo] of paramEntries) {
          const req = required.has(paramName)
            ? (lang === "zh" ? "（必填）" : "(required)")
            : (lang === "zh" ? "（可选）" : "(optional)");
          lines.push(`- \`${paramName}\` ${req}: ${paramInfo.description ?? paramInfo.type}`);
        }

        lines.push(lang === "zh" ? "**用法：**" : "**Usage:**");
        lines.push(`<${schema.name}>`);
        for (const [paramName, paramInfo] of paramEntries) {
          lines.push(`<${paramName}>${paramInfo.description ?? "value"}</${paramName}>`);
        }
        lines.push(`</${schema.name}>`);
      } else {
        lines.push(lang === "zh" ? "**用法（无参数）：**" : "**Usage (no parameters):**");
        lines.push(`<${schema.name}></${schema.name}>`);
      }
    } else {
      // 没有 schema 信息的工具（MCP 动态工具）
      lines.push(`## ${toolName}`);
      lines.push(lang === "zh" ? "**用法：**" : "**Usage:**");
      lines.push(`<${toolName}>`);
      lines.push(`<input>parameters here</input>`);
      lines.push(`</${toolName}>`);
    }
    lines.push("");
  }

  return lines.join("\n");
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
    sections.push(lang === "zh"
      ? `## 用户自定义规则（最高优先级）\n\n${userRules.trim()}`
      : `## User Custom Rules (Highest Priority)\n\n${userRules.trim()}`);
  }

  if (projectRules?.trim()) {
    sections.push(lang === "zh"
      ? `## 项目规则（.omega/rules.md）\n\n${projectRules.trim()}`
      : `## Project Rules (.omega/rules.md)\n\n${projectRules.trim()}`);
  }

  return sections.join("\n\n---\n\n");
}

/**
 * 构建 AgentLoop 的 System Prompt（完全对齐 Cline 结构）
 *
 * 章节顺序（与 Cline system.ts 一致）：
 * 1. 角色定义（basePrompt）
 * 2. TOOL USE 章节（格式说明 + 6条使用指南 + 工具定义列表）
 * 3. attempt_completion 独立章节（不在工具列表里，强调"必须用"）
 * 4. RULES 章节（具体禁令和约束）
 * 5. OBJECTIVE 章节（5步方法论）
 * 6. 用户/项目 Rules
 */
export function buildAgentSystemPrompt(
  basePrompt: string,
  availableTools: string[],
  lang: "zh" | "en" = "zh",
  toolSchemas: ToolSchemaInfo[] = [],
  userRules?: string,
  projectRules?: string,
): string {
  const toolDesc = buildToolDescriptions(availableTools, toolSchemas, lang);
  const hasTools = availableTools.length > 0;
  const rulesSection = buildRulesSection(userRules, projectRules, lang);

  if (lang === "zh") {
    return `${basePrompt}

====

# 工具使用（TOOL USE）

你有工具可以帮你完成任务。工具调用使用 XML 风格的直接标签格式。

## 工具使用格式

工具调用格式如下（工具名直接作为 XML 标签，参数在其中）：

<工具名>
<参数名>参数值</参数名>
</工具名>

例如使用 web_search：
<web_search>
<query>搜索关键词</query>
</web_search>

## 工具使用指南

1. 在 <thinking> 标签中评估当前已有信息和所需信息，决定下一步行动
2. 选择最适合当前步骤的工具
3. **每次响应只能调用一个工具**，不要在一次响应中调用多个工具
4. 等待用户（系统）返回工具执行结果后，再决定下一步
5. 工具调用必须使用正确的 XML 格式，参数名必须精确
6. 绝对不要假设工具执行成功——必须等待实际结果后再继续

## 可用工具

${toolDesc}

====

# 向用户提问（ASK_FOLLOWUP_QUESTION）

当你需要更多信息才能继续时，使用此格式向用户提问。**不要猜测**，直接问。

<ask_followup_question>
<question>你的问题（清晰、具体）</question>
<options>
<option>选项1（可选，提供建议选项让用户更方便作答）</option>
<option>选项2</option>
</options>
</ask_followup_question>

**注意：** options 是可选的。如果有明确的选项可供选择，提供它们。

====

# 任务完成协议（ATTEMPT_COMPLETION）

当你确认任务已完全完成后，必须使用以下格式提交最终结果：

<attempt_completion>
<result>
[完整的最终结果，面向用户，清晰可读。不得以问句或"还需要帮助吗"结尾。]
</result>
</attempt_completion>

**重要约束（必须遵守）：**
- 在确认所有工具调用都已成功之前，**禁止**使用 attempt_completion
- 使用前必须在 <thinking> 中自问：我是否已确认每一步都成功了？
- result 必须完整、详细，不得截断，不得以问句结尾
- 这是任务的**唯一合法终止方式**

====

# 规则（RULES）

### 工具使用规则
${hasTools ? `- 必须等待每个工具的执行结果，不得假设结果
- 每次只调用一个工具，调用后必须等待结果再继续
- 缺少必填参数时，不得调用工具——应该向用户提问获取缺失信息
- 工具执行失败时，分析错误原因，尝试修复后重试` : `- 当前无可用工具，请直接基于知识回答`}

### 任务执行规则
- 逐步完成任务，每一步都基于上一步的**实际结果**
- 第一次响应（Iteration 1）：只分析和规划，绝对禁止直接生成代码或最终内容
  - 在 <thinking> 中：① 将任务拆解为 3-7 个子步骤 ② 每步用的工具 ③ 潜在风险
  - 然后调用第一个信息收集工具（如 web_search、fs_read），或如无需工具则输出详细执行计划
- 从第二次响应起：每次只执行一个步骤（一个工具调用），基于上一步实际结果推进
- 必须等待工具结果再继续，绝对不要预测或假设工具输出

### 输出规则
- 禁止以"好的"、"当然"、"明白了"、"没问题"、"当然可以"等闲聊性语句开头
- attempt_completion 的 result 不得以问句或邀请用户进一步对话结尾
- 使用与用户相同的语言（用户用中文，就用中文）
- 代码必须完整、可直接运行，不得截断或省略

====

# 目标（OBJECTIVE）

你的目标是以迭代、有条不紊的方式完成用户交代的任务。

1. **分析任务**：仔细阅读任务，设定清晰可达的子目标，按逻辑优先级排序
2. **顺序推进**：每次响应只用一个工具，每步都基于上一步的实际结果
3. **先思考后行动**：每次工具调用前，在 <thinking> 标签内：
   - 分析当前已有信息
   - 思考哪个工具最适合这一步
   - 逐一确认所有必填参数都已知（有缺失则用 ask_followup_question 询问）
4. **及时终止**：任务完成后**立刻**使用 attempt_completion 提交结果，不要拖延
5. **基于反馈改进**：如果用户对结果不满意，根据反馈改进，不要无意义地重复

====

${rulesSection}`;
  }

  // ── 英文版 ──────────────────────────────────────────────────────────────
  return `${basePrompt}

====

# TOOL USE

You have access to tools that help you complete tasks. Tool calls use direct XML-style tags.

## Tool Use Formatting

Tool use is formatted as follows (tool name is the XML tag, parameters are inside):

<tool_name>
<param_name>param_value</param_name>
</tool_name>

Example using web_search:
<web_search>
<query>search keywords</query>
</web_search>

## Tool Use Guidelines

1. Assess your current state and what information you need in <thinking> tags before calling a tool
2. Choose the most appropriate tool for the current step
3. **Use only ONE tool per response** — never call multiple tools in a single response
4. Wait for the tool result (returned by the user/system) before deciding your next action
5. Tool calls must use the correct XML format with exact parameter names
6. NEVER assume a tool succeeded — wait for the actual result before continuing

## Available Tools

${toolDesc}

====

# ASKING THE USER (ASK_FOLLOWUP_QUESTION)

When you need more information to continue, use this format to ask the user. **Don't guess** — ask directly.

<ask_followup_question>
<question>Your question (clear and specific)</question>
<options>
<option>Option 1 (optional — provide suggested choices to make it easier for the user)</option>
<option>Option 2</option>
</options>
</ask_followup_question>

**Note:** The options element is optional. Provide it when there are clear choices the user can pick from.

====

# TASK COMPLETION PROTOCOL (ATTEMPT_COMPLETION)

When you have confirmed the task is fully complete, submit your final result using:

<attempt_completion>
<result>
[Complete final result, user-facing, clear and readable. Do NOT end with a question or "Is there anything else I can help you with?"]
</result>
</attempt_completion>

**IMPORTANT CONSTRAINTS (must follow):**
- This tool CANNOT be used until you've confirmed all previous tool uses were successful
- Before using it, ask yourself in <thinking>: Have I confirmed every step succeeded?
- The result must be complete, detailed, and not truncated — never end with a question
- This is the **ONLY legitimate way to end a task**

====

# RULES

### Tool Use Rules
${hasTools ? `- MUST wait for each tool's result before continuing — never assume the outcome
- Use only ONE tool per response, then wait for the result
- If required parameters are missing, do NOT call the tool — ask the user with ask_followup_question
- If a tool fails, analyze the error and attempt a fix before retrying` : `- No tools available — answer directly from your knowledge`}

### Task Execution Rules
- Work through tasks step-by-step, each step informed by the previous **actual result**
- First response (Iteration 1): ONLY analyze and plan — NEVER generate code or final content directly
  - In <thinking>: ① Break task into 3-7 sub-steps ② Tool for each step ③ Potential risks
  - Then call the first information-gathering tool (e.g. web_search, fs_read), or output a detailed plan if no tools needed
- From the second response onward: execute ONE step at a time, based on the actual result of the previous step
- NEVER predict or assume tool output — wait for the actual result

### Output Rules
- NEVER start responses with "Great", "Certainly", "Of course", "Sure", or other filler phrases
- attempt_completion result MUST NOT end with a question or invitation for further conversation
- Match the user's language
- Code must be complete and runnable — no truncation or omission

====

# OBJECTIVE

Your goal is to accomplish the user's task iteratively and methodically.

1. **Analyze the task**: Read carefully, set clear achievable sub-goals in logical priority order
2. **Progress sequentially**: Use one tool per response, each step based on the previous actual result
3. **Think before acting**: Before each tool call, use <thinking> to:
   - Assess your current state
   - Determine which tool best fits this step
   - Verify all required parameters are known (if missing, use ask_followup_question)
4. **Complete promptly**: Use attempt_completion immediately when done — don't delay
5. **Improve from feedback**: If the user is unsatisfied, improve based on feedback — avoid meaningless repetition

====

${rulesSection}`;
}

// ─── 响应解析（完整 Cline 风格）──────────────────────────────────────────

/**
 * 解析 LLM 响应中的结构化内容
 *
 * Cline 风格改进：
 * 1. 所有 XML 提取使用 indexOf+lastIndexOf（安全贪婪匹配）
 * 2. 支持 <think>/<thinking>/<thought> 三种变体（国产模型常用 <think>）
 * 3. 支持直接标签工具调用格式（<tool_name><param>value</param></tool_name>）
 * 4. 同时兼容旧的 <tool_use> 嵌套格式
 * 5. finalAnswer 用 !== undefined 判断（空字符串也算有效，避免循环不终止）
 */
function parseAgentResponse(
  text: string,
  availableTools: string[] = []
): {
  thinking?: string;
  toolName?: string;
  toolInput?: unknown;
  finalAnswer?: string;
  followupQuestion?: string;   // ask_followup_question 工具的问题内容
  followupOptions?: string[];  // ask_followup_question 的选项列表
} {
  // ── 1. 提取 thinking（支持三种变体）──────────────────────────────────
  // Cline 支持 <thinking>、<thought>、<think> 三种，优先级依次降低
  const thinking =
    extractBetweenTags(text, "thinking") ??
    extractBetweenTags(text, "thought") ??
    extractBetweenTags(text, "think");

  // ── 2. 提取 attempt_completion ────────────────────────────────────────
  // attempt_completion 是唯一合法的任务终止方式
  const completionBlock = extractBetweenTags(text, "attempt_completion");
  if (completionBlock !== undefined) {
    // 从 completion 块内提取 result
    const resultContent = extractBetweenTags(completionBlock, "result");
    // 注意：用 !== undefined 判断，空字符串也是有效的 finalAnswer（修复原 bug）
    const finalAnswer = resultContent !== undefined ? resultContent : completionBlock;
    const result: { thinking?: string; finalAnswer: string } = { finalAnswer };
    if (thinking !== undefined) result.thinking = thinking;
    return result;
  }

  // ── 3. 兼容旧的 <final_answer> 标签 ──────────────────────────────────
  const finalAnswerContent = extractBetweenTags(text, "final_answer");
  if (finalAnswerContent !== undefined) {
    const result: { thinking?: string; finalAnswer: string } = { finalAnswer: finalAnswerContent };
    if (thinking !== undefined) result.thinking = thinking;
    return result;
  }

  // ── 4. 专项解析 ask_followup_question（Cline Human-in-the-loop）────
  // ask_followup_question 可能出现在工具列表中也可能不在，单独解析
  const followupBlock = extractBetweenTags(text, "ask_followup_question");
  if (followupBlock !== undefined) {
    const question = extractParam(followupBlock, "question") ?? followupBlock.trim();
    // 解析 options（格式：<options><option>选项1</option><option>选项2</option></options>）
    const optionsBlock = extractParam(followupBlock, "options");
    const followupOptions: string[] = [];
    if (optionsBlock) {
      const optionRegex = /<option>([\s\S]*?)<\/option>/gi;
      for (const m of optionsBlock.matchAll(optionRegex)) {
        if (m[1]?.trim()) followupOptions.push(m[1].trim());
      }
    }
    const result: ReturnType<typeof parseAgentResponse> = { followupQuestion: question };
    if (thinking !== undefined) result.thinking = thinking;
    if (followupOptions.length > 0) result.followupOptions = followupOptions;
    return result;
  }

  // ── 5. 解析工具调用（优先尝试直接标签格式）──────────────────────────
  // 直接标签格式（Cline 风格）：<tool_name><param>value</param></tool_name>
  if (availableTools.length > 0) {
    for (const toolName of availableTools) {
      const toolBlock = extractBetweenTags(text, toolName);
      if (toolBlock !== undefined) {
        // 找到工具调用！提取参数
        const paramMap: Record<string, string> = {};
        // 找出所有参数名（开始标签）
        const tagNameRegex = /<(\w+)>/g;
        const tagNames = new Set<string>();
        for (const m of toolBlock.matchAll(tagNameRegex)) {
          if (m[1]) tagNames.add(m[1]);
        }
        // 逐参数名提取（使用 indexOf+lastIndexOf 贪婪匹配）
        for (const name of tagNames) {
          const value = extractParam(toolBlock, name);
          if (value !== undefined) paramMap[name] = value;
        }

        const toolInput = Object.keys(paramMap).length > 0 ? paramMap : toolBlock;
        const result: { thinking?: string; toolName: string; toolInput: unknown } = {
          toolName,
          toolInput,
        };
        if (thinking !== undefined) result.thinking = thinking;
        return result;
      }
    }
  }

  // ── 6. 兼容旧的 <tool_use> 嵌套格式 ─────────────────────────────────
  const toolUseStart = text.indexOf("<tool_use>");
  const toolUseEnd = text.lastIndexOf("</tool_use>");
  if (toolUseStart !== -1 && toolUseEnd !== -1 && toolUseEnd > toolUseStart) {
    const toolBlock = text.slice(toolUseStart + "<tool_use>".length, toolUseEnd);
    // 从 toolBlock 内提取 tool_name
    const toolName = extractParam(toolBlock, "tool_name");
    if (toolName) {
      // 提取其他参数（去掉 tool_name 部分）
      const inputBlock = toolBlock
        .replace(/<tool_name>[\s\S]*?<\/tool_name>/i, "")
        .trim();

      const paramMap: Record<string, string> = {};
      const tagNameRegex = /<(\w+)>/g;
      const tagNames = new Set<string>();
      for (const m of inputBlock.matchAll(tagNameRegex)) {
        if (m[1]) tagNames.add(m[1]);
      }
      for (const name of tagNames) {
        const value = extractParam(inputBlock, name);
        if (value !== undefined) paramMap[name] = value;
      }

      const toolInput = Object.keys(paramMap).length > 0 ? paramMap : inputBlock;
      const result: { thinking?: string; toolName: string; toolInput: unknown } = {
        toolName,
        toolInput,
      };
      if (thinking !== undefined) result.thinking = thinking;
      return result;
    }
  }

  // ── 7. 无结构化标签：只返回 thinking（不 fallback 当 finalAnswer）──
  // AgentLoop 会注入 nudge 提示 LLM 重新给出结构化响应
  const fallback: { thinking?: string } = {};
  if (thinking !== undefined) fallback.thinking = thinking;
  return fallback;
}

// ─── 缺参数检测 ───────────────────────────────────────────────────────────

/**
 * 检测工具调用是否缺少必填参数
 * 返回缺失的参数名列表（空数组表示参数完整）
 */
function getMissingRequiredParams(
  toolName: string,
  toolInput: unknown,
  toolSchemas: ToolSchemaInfo[]
): string[] {
  const schema = toolSchemas.find(s => s.name === toolName);
  if (!schema) return []; // 没有 schema 就不检测

  const required = schema.inputSchema.required ?? [];
  if (required.length === 0) return [];

  const input = (typeof toolInput === "object" && toolInput !== null)
    ? toolInput as Record<string, unknown>
    : {};

  return required.filter(param => {
    const val = input[param];
    return val === undefined || val === null || val === "";
  });
}

// ─── 指数退避重试 ─────────────────────────────────────────────────────────

/**
 * 指数退避重试（Cline 风格）
 * 2s → 4s → 8s，最多3次自动重试，超限抛出
 */
async function withExponentialBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 2000
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxAttempts - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt); // 2000, 4000, 8000
        log.warn({ attempt: attempt + 1, maxAttempts, delay, err: lastError.message }, "[Retry] LLM call failed, retrying after delay");
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

// ─── ReAct 主循环 ─────────────────────────────────────────────────────────

/**
 * AgentLoopExecutor — 完全对齐 Cline 核心设计的 ReAct 执行器
 *
 * 完整移植 Cline 的关键机制：
 * 1. extractBetweenTags：indexOf+lastIndexOf 安全提取（防截断）
 * 2. parseAgentResponse：支持 <think>/<thinking>/<thought> + 直接标签工具格式
 * 3. buildAgentSystemPrompt：Cline 章节结构 + attempt_completion 独立章节
 * 4. consecutiveMistakeCount + nudge 机制：格式错误时引导恢复
 * 5. getNextTruncationRange：永远保留前2条 + 按比例成对删除中间
 * 6. 缺参数检测：必填参数缺失时不调用工具
 * 7. 指数退避重试：API 失败 2s→4s→8s 最多3次
 * 8. 工具结果格式：[Tool Use Result: xxx] 清晰区分工具结果和用户消息
 */
export class AgentLoopExecutor {
  private runId: string;
  private config: AgentLoopConfig;
  private invokeLLM: AgentLLMInvoker;
  private invokeTool: AgentToolInvoker;
  private onStep: AgentStepCallback;
  private onAskFollowup?: AskFollowupCallback;
  private lang: "zh" | "en";
  private toolSchemas: ToolSchemaInfo[];
  private userRules?: string;
  private projectRules?: string;
  private signal?: AbortSignal;

  constructor(opts: {
    runId: string;
    config: AgentLoopConfig;
    invokeLLM: AgentLLMInvoker;
    invokeTool: AgentToolInvoker;
    onStep: AgentStepCallback;
    onAskFollowup?: AskFollowupCallback;  // AI 提问用户的回调
    lang?: "zh" | "en";
    toolSchemas?: ToolSchemaInfo[];
    userRules?: string;
    projectRules?: string;
    signal?: AbortSignal;
  }) {
    this.runId = opts.runId;
    this.config = opts.config;
    this.invokeLLM = opts.invokeLLM;
    this.invokeTool = opts.invokeTool;
    this.onStep = opts.onStep;
    if (opts.onAskFollowup !== undefined) this.onAskFollowup = opts.onAskFollowup;
    this.lang = opts.lang ?? "zh";
    this.toolSchemas = opts.toolSchemas ?? [];
    if (opts.userRules !== undefined) this.userRules = opts.userRules;
    if (opts.projectRules !== undefined) this.projectRules = opts.projectRules;
    if (opts.signal !== undefined) this.signal = opts.signal;
  }

  /**
   * 执行 AgentLoop
   *
   * @param task 用户任务描述
   * @param imageUrls 可选的图片 URL 列表（多模态）
   * @param initialMessages 可选的历史对话消息（跨轮次上下文，由主进程注入）
   *   - 这是实现"多轮对话记忆"的关键参数（Cline 风格）
   *   - 主进程为每个 session 维护 ChatMessage[] 历史，每次新任务时追加后传入
   *   - 传入时，新的 user 消息会追加在 initialMessages 末尾
   *   - AgentLoopExecutor 执行完后，主进程负责把新增的 messages 保存回 session 历史
   */
  async execute(
    task: string,
    imageUrls?: string[],
    initialMessages?: ChatMessage[],
  ): Promise<AgentLoopResult & { finalMessages: ChatMessage[] }> {
    const { config, runId } = this;
    const systemPrompt = buildAgentSystemPrompt(
      config.systemPrompt,
      config.availableTools,
      this.lang,
      this.toolSchemas,
      this.userRules,
      this.projectRules,
    );

    // 构建本轮 user 消息（有图片时用多模态格式）
    const newUserContent: ChatMessage["content"] =
      imageUrls && imageUrls.length > 0
        ? [
            { type: "text", text: task },
            ...imageUrls.map((url) => ({
              type: "image_url" as const,
              image_url: { url, detail: "auto" as const },
            })),
          ]
        : task;

    // ── 初始化对话历史 ────────────────────────────────────────────────────
    // 若有历史消息（多轮对话），在末尾追加本轮用户消息；
    // 否则只有本轮用户消息（首次对话）。
    // Cline 风格：每次新任务作为新 user 消息追加，不重置整个 messages 数组。
    const messages: ChatMessage[] = [
      ...(initialMessages ?? []),
      { role: "user", content: newUserContent },
    ];

    log.info(
      { runId, task: task.slice(0, 80), historyCount: initialMessages?.length ?? 0 },
      "AgentLoop execute() — injecting history messages"
    );

    const steps: AgentStep[] = [];
    let totalTokens = 0;
    let totalCostUsd = 0;
    let iteration = 0;
    let continueLoop = true;
    let finalAnswer = "";

    // Cline 风格：连续无效响应计数（达到上限触发特殊处理）
    let consecutiveMistakeCount = 0;
    const MAX_CONSECUTIVE_MISTAKES = 3;

    log.info({ runId, task: task.slice(0, 80), maxIterations: config.maxIterations }, "AgentLoop started");

    while (continueLoop && iteration < config.maxIterations) {
      // ── 取消检查 ───────────────────────────────────────────────────────
      if (this.signal?.aborted) {
        log.info({ runId, iteration }, "AgentLoop cancelled by AbortSignal");
        finalAnswer = this.lang === "zh" ? "任务已被用户取消。" : "Task cancelled by user.";
        break;
      }

      iteration++;
      log.debug({ runId, iteration, consecutiveMistakeCount }, "AgentLoop iteration start");

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
        // ── Cline 风格上下文截断（getNextTruncationRange）─────────────
        const tokenBudget = Math.floor(config.maxTokens * 0.8);
        const currentTokens = estimateTokens(messages);
        log.debug({ runId, iteration, currentTokens, tokenBudget, messageCount: messages.length }, "[Context] Token check");

        if (currentTokens > tokenBudget && messages.length > 4) {
          // 判断严重程度（超出一半时用激进截断）
          const keep = currentTokens > tokenBudget * 2 ? "quarter" : "half";
          const range = getTruncationRange(messages, keep);

          if (range) {
            const [startIdx, endIdx] = range;
            // 成对删除 [startIdx, endIdx] 范围内的消息
            const removed = messages.splice(startIdx, endIdx - startIdx + 1);
            log.warn({ runId, iteration, removed: removed.length, keep, keep_count: messages.length }, "[Context] Truncated middle messages (Cline style)");

            // 在 index 1（首次 assistant 消息）后注入截断说明
            const notice: ChatMessage = {
              role: "assistant",
              content: this.lang === "zh"
                ? "[注意] 为维持最优上下文窗口长度，部分历史对话已被移除。初始用户任务已保留以确保任务连续性，中间的历史操作已删除。"
                : "[NOTE] Some previous conversation history has been removed to maintain optimal context window length. The initial user task has been retained for continuity, while intermediate history has been removed.",
            };
            // 找到第一条 assistant 消息的位置插入说明（通常在 index 1）
            const firstAssistantIdx = messages.findIndex(m => m.role === "assistant");
            if (firstAssistantIdx >= 0) {
              messages.splice(firstAssistantIdx + 1, 0, notice);
            } else {
              messages.splice(1, 0, notice);
            }
          }
        }

        // ── 取消检查（LLM 调用前）──────────────────────────────────────
        if (this.signal?.aborted) {
          log.info({ runId, iteration }, "AgentLoop cancelled before LLM call");
          finalAnswer = this.lang === "zh" ? "任务已被用户取消。" : "Task cancelled by user.";
          continueLoop = false;
          break;
        }

        // ── 指数退避重试 LLM 调用（Cline 风格：2s→4s→8s，最多3次）──
        const result = await withExponentialBackoff(
          () => this.invokeLLM(systemPrompt, messages, {
            temperature: config.temperature,
            maxTokens: config.maxTokens,
          }),
          3,    // 最多3次重试
          2000  // 初始延迟 2000ms
        );
        llmResponse = result.text;
        tokens = result.tokens;
        costUsd = result.costUsd;
        totalTokens += tokens;
        totalCostUsd += costUsd;
        log.debug({ runId, iteration, tokens, responseLength: llmResponse.length }, "LLM responded");
      } catch (err) {
        log.error({ runId, iteration, err }, "LLM invocation failed after all retries");
        const step: AgentStep = {
          index: stepIndex,
          status: "error",
          thought: `LLM error (after 3 retries): ${(err as Error).message}`,
          tokens: 0,
        };
        steps.push(step);
        this.onStep(runId, step);
        throw err;
      }

      // 把 LLM 响应追加到对话历史
      messages.push({ role: "assistant", content: llmResponse });

      // 解析响应（传入 availableTools 以支持直接标签格式检测）
      const parsed = parseAgentResponse(llmResponse, config.availableTools);

      // ── 情况 1：attempt_completion → 终止循环 ─────────────────────
      // 注意：用 !== undefined 判断，空字符串也是有效的 finalAnswer（Cline 修复）
      if (parsed.finalAnswer !== undefined) {
        finalAnswer = formatOutput(parsed.finalAnswer, {
          fixCodeBlocks: true,
          normalizeWhitespace: true,
        });
        continueLoop = false;
        consecutiveMistakeCount = 0; // 重置计数

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

      // ── 情况 2：ask_followup_question → 暂停等待用户回复 ──────────
      if (parsed.followupQuestion !== undefined) {
        consecutiveMistakeCount = 0; // 有效的工具调用，重置计数

        const question = parsed.followupQuestion;
        const options = parsed.followupOptions;
        log.info({ runId, iteration, question: question.slice(0, 80) }, "AgentLoop: ask_followup_question — waiting for user");

        // 通知 UI 显示提问气泡
        const askStep: AgentStep = {
          index: stepIndex,
          thought: parsed.thinking,
          toolName: "ask_followup_question",
          toolInput: { question, options },
          status: "acting",
          tokens,
        };
        steps.push(askStep);
        this.onStep(runId, askStep);

        let userAnswer: string;
        if (this.onAskFollowup) {
          // 通过回调将控制权交给主进程，等待用户在 UI 中输入回答
          try {
            userAnswer = await this.onAskFollowup(runId, question, options);
          } catch {
            // 用户取消或超时
            userAnswer = this.lang === "zh" ? "（用户未作答，请继续）" : "(No answer from user, please proceed)";
          }
        } else {
          // 没有注入回调时（单元测试等场景），自动跳过
          userAnswer = this.lang === "zh" ? "（系统未配置用户交互，请根据最佳判断继续）" : "(User interaction not configured, please use your best judgment to proceed)";
        }

        log.info({ runId, iteration, answerLength: userAnswer.length }, "AgentLoop: user answered followup question");

        // 将用户回答注入到对话历史，继续 loop
        const answerMsg = this.lang === "zh"
          ? `[用户回答 ask_followup_question]\n\n问题：${question}\n\n用户的回答：${userAnswer}\n\n请基于用户的回答继续完成任务。`
          : `[User Answer to ask_followup_question]\n\nQuestion: ${question}\n\nUser's answer: ${userAnswer}\n\nPlease continue completing the task based on the user's answer.`;
        messages.push({ role: "user", content: answerMsg });

        // 更新步骤状态为 observing（显示用户的回答）
        const answerStep: AgentStep = {
          index: stepIndex,
          thought: parsed.thinking,
          toolName: "ask_followup_question",
          toolInput: { question, options },
          observation: userAnswer,
          status: "observing",
          tokens,
        };
        const askStepIdx = steps.findIndex(s => s.index === stepIndex && s.status === "acting");
        if (askStepIdx >= 0) {
          steps[askStepIdx] = answerStep;
        } else {
          steps.push(answerStep);
        }
        this.onStep(runId, answerStep);

        continue; // 继续下一轮循环（携带用户回答）
      }

      // ── 情况 3：工具调用 ────────────────────────────────────────────
      if (parsed.toolName) {
        consecutiveMistakeCount = 0; // 有效的工具调用，重置计数

        // ── 缺参数检测（Cline 风格）──────────────────────────────────
        const missingParams = getMissingRequiredParams(
          parsed.toolName,
          parsed.toolInput,
          this.toolSchemas
        );

        if (missingParams.length > 0) {
          // 缺少必填参数：注入提示，要求 LLM 提供缺失参数或向用户询问
          log.warn({ runId, iteration, toolName: parsed.toolName, missingParams }, "Tool called with missing required params");

          const missingParamMsg = this.lang === "zh"
            ? `工具 "${parsed.toolName}" 被调用时缺少必填参数：${missingParams.join(", ")}。\n请提供这些参数后重新调用，或者使用合理的默认值。如果需要用户提供这些信息，请先向用户提问。`
            : `Tool "${parsed.toolName}" was called without required parameters: ${missingParams.join(", ")}.\nPlease provide these parameters and retry, or use reasonable defaults. If you need the user to provide this information, ask them first.`;
          messages.push({ role: "user", content: missingParamMsg });

          const missingStep: AgentStep = {
            index: stepIndex,
            thought: parsed.thinking,
            toolName: parsed.toolName,
            status: "thinking",
            tokens,
          };
          steps.push(missingStep);
          this.onStep(runId, missingStep);
          consecutiveMistakeCount++; // 缺参数算一次错误
          continue;
        }

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
        const lastIdx = steps.findIndex(s => s.index === stepIndex && s.status === "acting");
        if (lastIdx >= 0) {
          steps[lastIdx] = stepObserving;
        } else {
          steps.push(stepObserving);
        }
        this.onStep(runId, stepObserving);

        // ── 工具结果注入（Cline 风格：[Tool Use Result: xxx]）─────────
        // 比 "## Tool Use:" 格式更清晰地区分工具结果和用户消息
        const observationMsg = this.lang === "zh"
          ? `[工具执行结果: ${parsed.toolName}]\n\n${observation}\n\n基于以上工具执行结果，决定下一步行动。如果任务已完成，使用 attempt_completion 提交最终结果。`
          : `[Tool Use Result: ${parsed.toolName}]\n\n${observation}\n\nBased on the above result, decide your next action. Use attempt_completion if the task is complete.`;
        messages.push({ role: "user", content: observationMsg });

        continue; // 继续下一轮循环
      }

      // ── 情况 4：无结构化输出 → nudge（Cline 风格）─────────────────
      consecutiveMistakeCount++;
      log.warn({
        runId, iteration, consecutiveMistakeCount,
        response: llmResponse.slice(0, 150)
      }, "AgentLoop: no structured response, nudging LLM");

      // 连续错误过多：提示卡住
      if (consecutiveMistakeCount >= MAX_CONSECUTIVE_MISTAKES) {
        log.error({ runId, iteration, consecutiveMistakeCount }, "AgentLoop: too many consecutive mistakes, forcing completion");
        const tooManyMistakesMsg = this.lang === "zh"
          ? `你已经连续 ${consecutiveMistakeCount} 次没有使用工具或 attempt_completion。\n\n请立刻决定：\n1. 如果任务已经完成，使用 attempt_completion 提交结果\n2. 如果还需要工具，使用正确的工具调用格式\n3. 如果需要更多信息，使用 ask_followup_question\n\n不要再输出纯文本——必须使用结构化格式。`
          : `You have failed to use a tool or attempt_completion for ${consecutiveMistakeCount} consecutive responses.\n\nPlease immediately decide:\n1. If the task is complete, use attempt_completion to submit your result\n2. If you need a tool, use the correct tool call format\n3. If you need more information, use ask_followup_question\n\nDo NOT output plain text — you MUST use a structured format.`;
        messages.push({ role: "user", content: tooManyMistakesMsg });
      } else {
        // 普通 nudge（照搬 Cline 的 noToolsUsed() 消息）
        const nudge = this.lang === "zh"
          ? `[错误] 你在上一次响应中没有使用工具！请用工具重试。\n\n# 工具使用格式提醒\n\n使用 XML 风格标签调用工具，工具名直接作为标签：\n\n<web_search>\n<query>关键词</query>\n</web_search>\n\n# 下一步\n- 如果任务已完成，使用 attempt_completion 提交结果\n- 如果需要更多信息，继续使用工具\n- 如果上一步已经完成了所有工作，用 attempt_completion 总结\n\n（这是自动提示消息，请勿以对话方式回应。）`
          : `[ERROR] You did not use a tool in your previous response! Please retry with a tool use.\n\n# Reminder: Tool Use Format\n\nUse XML-style tags with the tool name as the tag:\n\n<web_search>\n<query>keywords</query>\n</web_search>\n\n# Next Steps\n- If task is complete, use attempt_completion\n- If you need more information, use a tool\n- If all work is done, summarize with attempt_completion\n\n(This is an automated message — do not respond conversationally.)`;
        messages.push({ role: "user", content: nudge });
      }

      const nudgeStep: AgentStep = {
        index: stepIndex,
        thought: parsed.thinking || llmResponse.slice(0, 200),
        status: "thinking",
        tokens,
      };
      steps.push(nudgeStep);
      this.onStep(runId, nudgeStep);
    }

    // ── 超过最大迭代次数：强制总结 ─────────────────────────────────────
    if (!finalAnswer && iteration >= config.maxIterations) {
      log.warn({ runId, iteration, maxIterations: config.maxIterations }, "AgentLoop: max iterations reached, forcing summary");

      const forceMsg = this.lang === "zh"
        ? "你已达到最大迭代次数。请立刻使用 attempt_completion 给出目前最好的结果，即使不完整也要给出。\n\n<attempt_completion>\n<result>\n你目前完成的内容...\n</result>\n</attempt_completion>"
        : "Maximum iterations reached. Please immediately use attempt_completion to provide your best result so far, even if incomplete.\n\n<attempt_completion>\n<result>\nYour best result so far...\n</result>\n</attempt_completion>";
      messages.push({ role: "user", content: forceMsg });

      try {
        const result = await withExponentialBackoff(
          () => this.invokeLLM(systemPrompt, messages, {
            temperature: 0.3,
            maxTokens: 12288,
          }),
          2, // 强制总结时只重试2次
          1000
        );
        const forcedParsed = parseAgentResponse(result.text, config.availableTools);
        // 用 !== undefined 判断，兼容空字符串（Cline 风格修复）
        finalAnswer = forcedParsed.finalAnswer !== undefined ? forcedParsed.finalAnswer : result.text;
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
      finalMessagesCount: messages.length,
    }, "AgentLoop completed");

    // 返回完整的对话历史（供主进程保存到 sessionMessages，实现跨轮次记忆）
    return {
      finalAnswer,
      steps,
      totalTokens,
      totalCostUsd,
      iterations: iteration,
      finalMessages: messages,  // ← Cline 风格：执行后的完整 messages 数组
    };
  }

  /** 生成步骤唯一 ID */
  static genStepId(runId: string, index: number): string {
    return `${runId}_step${index}_${nanoid(6)}`;
  }
}
