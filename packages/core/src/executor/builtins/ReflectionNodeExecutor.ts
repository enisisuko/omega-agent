import { NodeType } from "@icee/shared";
import type { NodeDefinition, LLMNodeConfig } from "@icee/shared";
import { BaseNodeExecutor } from "../NodeExecutor.js";
import type { NodeContext, NodeResult } from "../NodeExecutor.js";
import { createLogger } from "../../logger.js";

const log = createLogger("ReflectionNodeExecutor");

/** invokeProvider 函数类型（与 LLMNodeExecutor 共用相同签名） */
type LLMInvoker = (
  config: LLMNodeConfig,
  input: unknown
) => Promise<{ text: string; tokens: number; costUsd: number; providerMeta: NodeResult["providerMeta"] }>;

/**
 * REFLECTION 节点执行器（v0.3.1 重写）
 *
 * 原版 REFLECTION 节点只返回固定的"acceptable"结果，无法真正审查质量。
 * 重写后与 LLMNodeExecutor 行为完全一致：
 * - 接受 invokeProvider 依赖注入
 * - 读取 config.systemPrompt / promptTemplate / temperature / maxTokens
 * - 渲染模板并调用 LLM，输出文本作为下游节点的 previousOutput
 *
 * 在 6 节点链式思考图中，REFLECTION 节点扮演"质量审查专家"，
 * 接收 Executor 输出，审查并整合后输出最终优化版本。
 */
export class ReflectionNodeExecutor extends BaseNodeExecutor {
  readonly nodeType = NodeType.REFLECTION;

  constructor(private readonly invokeProvider: LLMInvoker) {
    super();
  }

  async execute(node: NodeDefinition, ctx: NodeContext): Promise<NodeResult> {
    const config = node.config as LLMNodeConfig | undefined;

    if (!config) {
      throw new Error(`Reflection node "${node.id}" missing config entirely`);
    }

    // 渲染 Prompt 模板
    log.debug(
      { nodeId: node.id, template: config.promptTemplate, previousOutput: ctx.previousOutput },
      "ReflectionNode rendering prompt template"
    );
    const renderedPrompt = this.renderTemplate(
      config.promptTemplate ?? "",
      ctx.previousOutput,
      ctx.globalInput,
      ctx.runMemory
    );
    log.debug({ nodeId: node.id, renderedPrompt: renderedPrompt.slice(0, 200) }, "ReflectionNode rendered prompt");

    const result = await this.invokeProvider(
      { ...config, promptTemplate: renderedPrompt },
      ctx.previousOutput
    );

    log.info({ nodeId: node.id, tokens: result.tokens }, "ReflectionNode completed");

    return {
      output: result.text,
      renderedPrompt,
      tokens: result.tokens,
      costUsd: result.costUsd,
      providerMeta: result.providerMeta,
    };
  }

  /**
   * 渲染 Prompt 模板
   * 支持 {{input.xxx}}、{{output.xxx}}、{{memory.xxx}} 三种占位符
   */
  private renderTemplate(
    template: string,
    previousOutput: unknown,
    globalInput?: Record<string, unknown>,
    runMemory?: Map<string, unknown>
  ): string {
    return template.replace(/\{\{(\w+)\.(\w+)\}\}/g, (_match, namespace: string, key: string) => {
      if (namespace === "input") {
        const input = (globalInput ?? {}) as Record<string, unknown>;
        return String(input[key] ?? "");
      }
      if (namespace === "memory") {
        return String(runMemory?.get(key) ?? "");
      }
      if (namespace === "output") {
        if (typeof previousOutput === "string") {
          return key === "text" ? previousOutput : "";
        }
        if (typeof previousOutput === "object" && previousOutput !== null) {
          return String((previousOutput as Record<string, unknown>)[key] ?? "");
        }
        return "";
      }
      return "";
    });
  }
}
