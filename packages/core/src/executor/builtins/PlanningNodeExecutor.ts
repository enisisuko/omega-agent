import { NodeType } from "@icee/shared";
import type { NodeDefinition, LLMNodeConfig } from "@icee/shared";
import { BaseNodeExecutor } from "../NodeExecutor.js";
import type { NodeContext, NodeResult } from "../NodeExecutor.js";
import { createLogger } from "../../logger.js";

const log = createLogger("PlanningNodeExecutor");

/** invokeProvider 函数类型（与 LLMNodeExecutor 共用相同签名） */
type LLMInvoker = (
  config: LLMNodeConfig,
  input: unknown
) => Promise<{ text: string; tokens: number; costUsd: number; providerMeta: NodeResult["providerMeta"] }>;

/**
 * PLANNING 节点执行器（v0.3.1 重写）
 *
 * 原版 PLANNING 节点只能生成固定结构的静态计划，无法真正理解任务。
 * 重写后与 LLMNodeExecutor 行为完全一致：
 * - 接受 invokeProvider 依赖注入
 * - 读取 config.systemPrompt / promptTemplate / temperature / maxTokens
 * - 渲染模板并调用 LLM，输出文本作为下游节点的 previousOutput
 *
 * 在 6 节点链式思考图中，PLANNING 节点扮演"任务规划专家"，
 * 接收用户原始输入，将任务分解为 3 步计划传给后续节点。
 */
export class PlanningNodeExecutor extends BaseNodeExecutor {
  readonly nodeType = NodeType.PLANNING;

  constructor(private readonly invokeProvider: LLMInvoker) {
    super();
  }

  async execute(node: NodeDefinition, ctx: NodeContext): Promise<NodeResult> {
    const config = node.config as LLMNodeConfig | undefined;

    if (!config) {
      throw new Error(`Planning node "${node.id}" missing config entirely`);
    }

    // 渲染 Prompt 模板
    log.debug(
      { nodeId: node.id, template: config.promptTemplate, globalInput: ctx.globalInput },
      "PlanningNode rendering prompt template"
    );
    const renderedPrompt = this.renderTemplate(
      config.promptTemplate ?? "",
      ctx.previousOutput,
      ctx.globalInput,
      ctx.runMemory
    );
    log.debug({ nodeId: node.id, renderedPrompt: renderedPrompt.slice(0, 200) }, "PlanningNode rendered prompt");

    const result = await this.invokeProvider(
      { ...config, promptTemplate: renderedPrompt },
      ctx.previousOutput
    );

    log.info({ nodeId: node.id, tokens: result.tokens }, "PlanningNode completed");

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
