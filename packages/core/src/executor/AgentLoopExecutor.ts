import { nanoid } from "nanoid";
import { createLogger } from "../logger.js";
import type { AgentLoopConfig, AgentStep } from "@icee/shared";

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

// ─── 工具描述构建 ──────────────────────────────────────────────────────────

/**
 * 将可用 MCP 工具列表格式化为 System Prompt 内的工具说明块
 * 参考 Cline 的 XML 风格工具描述
 */
function buildToolDescriptions(availableTools: string[]): string {
  if (availableTools.length === 0) {
    return "（当前无可用工具，请直接用你的知识回答）";
  }

  const knownTools: Record<string, { desc: string; params: string }> = {
    web_search: {
      desc: "搜索互联网获取最新信息",
      params: `<query>搜索关键词</query>`,
    },
    browser_use: {
      desc: "打开网页并读取内容",
      params: `<url>目标网址</url>`,
    },
    fs_read: {
      desc: "读取本地文件内容",
      params: `<path>文件路径</path>`,
    },
    fs_write: {
      desc: "将内容写入本地文件",
      params: `<path>文件路径</path>\n<content>文件内容</content>`,
    },
    code_exec: {
      desc: "执行代码片段并返回输出",
      params: `<language>python|javascript|bash</language>\n<code>代码内容</code>`,
    },
  };

  const lines: string[] = ["你可以使用以下工具完成任务：\n"];
  for (const toolName of availableTools) {
    const info = knownTools[toolName];
    if (info) {
      lines.push(`### ${toolName}`);
      lines.push(`说明：${info.desc}`);
      lines.push(`调用格式：`);
      lines.push(`<tool_use>`);
      lines.push(`<tool_name>${toolName}</tool_name>`);
      lines.push(info.params);
      lines.push(`</tool_use>`);
      lines.push("");
    } else {
      lines.push(`### ${toolName}`);
      lines.push(`调用格式：`);
      lines.push(`<tool_use><tool_name>${toolName}</tool_name><input>参数</input></tool_use>`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

// ─── System Prompt 构建 ───────────────────────────────────────────────────

/**
 * 构建 AgentLoop 的 System Prompt（双语）
 * 参考 Cline 的角色定位 + ReAct 格式规范
 */
export function buildAgentSystemPrompt(
  basePrompt: string,
  availableTools: string[],
  lang: "zh" | "en" = "zh"
): string {
  const toolDesc = buildToolDescriptions(availableTools);

  if (lang === "zh") {
    return `${basePrompt}

## 工具使用
${toolDesc}

## 你的思考和行动格式

每次响应时，你必须遵循以下格式之一：

**格式 A — 需要使用工具时：**
<thought>
[分析当前状态，判断下一步需要做什么，为什么要用这个工具]
</thought>
<tool_use>
<tool_name>[工具名称]</tool_name>
[工具参数]
</tool_use>

**格式 B — 任务已完成，直接给出最终答案时：**
<thought>
[最终分析，确认任务完成]
</thought>
<final_answer>
[完整的最终回答，对用户可见，必须详细完整]
</final_answer>

## 规则
- 每次只调用一个工具
- 使用工具后等待观察结果再决定下一步
- 任务完成时必须使用 <final_answer> 结束
- 如果不需要工具，直接输出 <final_answer>
- 思考要简洁，行动要精准
- 最终答案要完整详细，不要省略`;
  }

  return `${basePrompt}

## Tools
${toolDesc}

## Thought and Action Format

Each response must follow one of these formats:

**Format A — When a tool is needed:**
<thought>
[Analyze current state, determine what to do next and why]
</thought>
<tool_use>
<tool_name>[tool name]</tool_name>
[tool parameters]
</tool_use>

**Format B — When the task is complete:**
<thought>
[Final analysis confirming task completion]
</thought>
<final_answer>
[Complete final answer, visible to user, must be detailed and comprehensive]
</final_answer>

## Rules
- Use only one tool per response
- Wait for observation before deciding next step
- Must end with <final_answer> when done
- Use <final_answer> directly if no tools needed
- Keep thoughts concise, actions precise
- Final answer must be complete and detailed`;
}

// ─── 响应解析 ─────────────────────────────────────────────────────────────

/**
 * 解析 LLM 响应中的结构化内容
 * 提取 <thought>、<tool_use>、<final_answer> 等标签
 */
function parseAgentResponse(text: string): {
  thought?: string;
  toolName?: string;
  toolInput?: unknown;
  finalAnswer?: string;
} {
  // 提取 thought
  const thoughtMatch = text.match(/<thought>([\s\S]*?)<\/thought>/i);
  const thought = thoughtMatch?.[1]?.trim();

  // 提取 final_answer
  const finalMatch = text.match(/<final_answer>([\s\S]*?)<\/final_answer>/i);
  if (finalMatch) {
    return { thought, finalAnswer: finalMatch[1]?.trim() };
  }

  // 提取 tool_use
  const toolUseMatch = text.match(/<tool_use>([\s\S]*?)<\/tool_use>/i);
  if (toolUseMatch) {
    const toolBlock = toolUseMatch[1] ?? "";
    const toolNameMatch = toolBlock.match(/<tool_name>([\s\S]*?)<\/tool_name>/i);
    const toolName = toolNameMatch?.[1]?.trim();

    // 提取工具参数（除 tool_name 以外的所有内容）
    const inputBlock = toolBlock.replace(/<tool_name>[\s\S]*?<\/tool_name>/i, "").trim();
    let toolInput: unknown = inputBlock;

    // 尝试解析各个参数标签
    const paramMap: Record<string, string> = {};
    const paramMatches = inputBlock.matchAll(/<(\w+)>([\s\S]*?)<\/\1>/g);
    for (const m of paramMatches) {
      paramMap[m[1]!] = m[2]?.trim() ?? "";
    }
    if (Object.keys(paramMap).length > 0) {
      toolInput = paramMap;
    }

    return { thought, toolName, toolInput };
  }

  // 没有格式标签：如果文本看起来像最终答案（无工具调用意图），直接当 finalAnswer
  const hasToolIntent = text.toLowerCase().includes("tool_use") ||
    text.toLowerCase().includes("let me search") ||
    text.toLowerCase().includes("我来搜索") ||
    text.toLowerCase().includes("我需要查");

  if (!hasToolIntent && text.trim().length > 20) {
    return { thought: undefined, finalAnswer: text.trim() };
  }

  return { thought };
}

// ─── ReAct 主循环 ─────────────────────────────────────────────────────────

/**
 * AgentLoopExecutor — Cline 风格 ReAct 动态循环执行器
 *
 * 执行流程（完全参考 Cline 的 initiateTaskLoop 机制）：
 *
 * 1. 初始化：构建 system prompt（角色 + 工具说明 + ReAct 格式规范）
 * 2. 开始循环：
 *    a. 发送当前 messages 给 LLM
 *    b. 解析响应：是工具调用？还是最终答案？
 *    c-1. 工具调用 → 执行工具 → 把 Observation 追加进 messages → 回 b
 *    c-2. 最终答案 → 结束循环，返回结果
 *    d. 如果 LLM 没给任何格式化内容 → 提示"请继续或给出最终答案"→ 回 b
 * 3. 超过最大迭代次数：强制总结后输出
 *
 * 每次迭代都通过 onStep 回调通知 UI 实时更新（对应 UI 中的节点卡片）
 */
export class AgentLoopExecutor {
  private runId: string;
  private config: AgentLoopConfig;
  private invokeLLM: AgentLLMInvoker;
  private invokeTool: AgentToolInvoker;
  private onStep: AgentStepCallback;
  private lang: "zh" | "en";

  constructor(opts: {
    runId: string;
    config: AgentLoopConfig;
    invokeLLM: AgentLLMInvoker;
    invokeTool: AgentToolInvoker;
    onStep: AgentStepCallback;
    lang?: "zh" | "en";
  }) {
    this.runId = opts.runId;
    this.config = opts.config;
    this.invokeLLM = opts.invokeLLM;
    this.invokeTool = opts.invokeTool;
    this.onStep = opts.onStep;
    this.lang = opts.lang ?? "zh";
  }

  async execute(task: string): Promise<AgentLoopResult> {
    const { config, runId } = this;
    const systemPrompt = buildAgentSystemPrompt(
      config.systemPrompt,
      config.availableTools,
      this.lang
    );

    // 初始化对话历史
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
      iteration++;
      log.debug({ runId, iteration }, "AgentLoop iteration start");

      const stepId = `step_${iteration}`;
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
        // 调用 LLM
        const result = await this.invokeLLM(systemPrompt, messages, {
          temperature: config.temperature,
          maxTokens: config.maxTokens,
        });
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

      // ── 情况 1：最终答案 → 结束循环 ──────────────────
      if (parsed.finalAnswer) {
        finalAnswer = parsed.finalAnswer;
        continueLoop = false;

        const step: AgentStep = {
          index: stepIndex,
          thought: parsed.thought,
          finalAnswer: parsed.finalAnswer,
          status: "done",
          tokens,
        };
        steps.push(step);
        this.onStep(runId, step);

        log.info({ runId, iteration, tokens }, "AgentLoop: final answer received, loop complete");
        break;
      }

      // ── 情况 2：工具调用 → 执行工具 → 观察结果 ────────
      if (parsed.toolName) {
        // 通知 UI：正在行动（acting 状态）
        const stepActing: AgentStep = {
          index: stepIndex,
          thought: parsed.thought,
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
          thought: parsed.thought,
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

        // 把工具观察结果追加到对话历史，让 LLM 继续分析
        const observationMsg = this.lang === "zh"
          ? `<observation>\n${observation}\n</observation>\n\n请基于以上观察继续分析，决定下一步行动或给出最终答案。`
          : `<observation>\n${observation}\n</observation>\n\nBased on the observation above, decide your next action or provide the final answer.`;
        messages.push({ role: "user", content: observationMsg });

        continue; // 继续下一轮循环
      }

      // ── 情况 3：LLM 没给出格式化内容 → 提示继续 ──────
      log.warn({ runId, iteration, response: llmResponse.slice(0, 100) }, "AgentLoop: no structured response, prompting to continue");

      const nudge = this.lang === "zh"
        ? "请继续完成任务。如果任务已完成，请使用 <final_answer> 给出完整答案；如果还需要工具，请使用 <tool_use> 调用。"
        : "Please continue the task. If complete, use <final_answer>. If you need a tool, use <tool_use>.";
      messages.push({ role: "user", content: nudge });

      const nudgeStep: AgentStep = {
        index: stepIndex,
        thought: parsed.thought || llmResponse.slice(0, 200),
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
        ? "你已达到最大迭代次数。请立刻用 <final_answer> 给出你目前得到的最佳答案，即使不完整也要给出。"
        : "You have reached the maximum number of iterations. Please immediately provide your best answer using <final_answer>, even if incomplete.";
      messages.push({ role: "user", content: forceMsg });

      try {
        const result = await this.invokeLLM(systemPrompt, messages, {
          temperature: 0.3,
          maxTokens: 1024,
        });
        const parsed = parseAgentResponse(result.text);
        finalAnswer = parsed.finalAnswer ?? result.text;
        totalTokens += result.tokens;
        totalCostUsd += result.costUsd;

        const forcedStep: AgentStep = {
          index: iteration + 1,
          thought: "达到最大迭代次数，强制输出最终答案",
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
          || "（Agent 运行超时，无法生成最终答案）";
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
