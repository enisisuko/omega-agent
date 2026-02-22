import type { LLMRequest, TokenEvent, ProviderInfo } from "@icee/shared";
import type { LLMProvider } from "../LLMProvider.js";
import pino from "pino";

const log = pino({ name: "OpenAICompatibleProvider" });

interface OpenAICompatibleConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  /** 价格表 (每 1000 token 的 USD 成本，用于 cost reporting) */
  pricing?: Record<string, { input: number; output: number }>;
}

/**
 * OpenAI-Compatible Provider 适配器
 * 支持 OpenAI、Azure OpenAI、Together AI、Groq 等兼容 OpenAI API 的服务
 */
export class OpenAICompatibleProvider implements LLMProvider {
  constructor(private readonly config: OpenAICompatibleConfig) {}

  metadata(): ProviderInfo {
    return {
      id: this.config.id,
      name: this.config.name,
      type: "openai-compatible",
      baseUrl: this.config.baseUrl,
      supportsStreaming: true,
      supportsCostReporting: !!this.config.pricing,
    };
  }

  async *generate(request: LLMRequest): AsyncIterable<TokenEvent> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    const body = JSON.stringify({
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
      top_p: request.topP,
      max_tokens: request.maxTokens,
      stream: true,
    });

    log.debug({ model: request.model, baseUrl: this.normalizedBaseUrl }, "Sending request to OpenAI-compatible API");

    const response = await fetch(`${this.normalizedBaseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
    }

    if (!response.body) {
      throw new Error("Response body is null");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let promptTokens = 0;
    let completionTokens = 0;
    let fullText = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") continue;
          if (!trimmed.startsWith("data: ")) continue;

          try {
            const json = JSON.parse(trimmed.slice(6)) as {
              choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
              usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
            };

            // 处理 token
            const content = json.choices?.[0]?.delta?.content ?? "";
            if (content) {
              fullText += content;
              completionTokens++;
              yield { token: content, done: false };
            }

            // 处理 usage (通常在最后一个 chunk)
            if (json.usage) {
              promptTokens = json.usage.prompt_tokens;
              completionTokens = json.usage.completion_tokens;
            }

          } catch {
            // 忽略解析失败的行
          }
        }
      }

      // 计算成本
      const totalTokens = promptTokens + completionTokens;
      const costUsd = this.calculateCost(request.model, promptTokens, completionTokens);

      log.debug({ model: request.model, totalTokens, costUsd }, "Request completed");

      // 最终 done=true 的 token event
      yield {
        token: "",
        done: true,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens,
        },
        costUsd,
      };

    } finally {
      reader.releaseLock();
    }
  }

  async generateComplete(request: LLMRequest): Promise<{
    text: string;
    tokens: number;
    costUsd: number;
    providerMeta: { provider: string; model: string; temperature?: number; topP?: number };
  }> {
    let fullText = "";
    let totalTokens = 0;
    let costUsd = 0;

    for await (const event of this.generate(request)) {
      if (!event.done) {
        fullText += event.token;
      } else {
        totalTokens = event.usage?.totalTokens ?? 0;
        costUsd = event.costUsd ?? 0;
      }
    }

    return {
      text: fullText,
      tokens: totalTokens,
      costUsd,
      providerMeta: {
        provider: this.config.id,
        model: request.model,
        ...(request.temperature !== undefined && { temperature: request.temperature }),
        ...(request.topP !== undefined && { topP: request.topP }),
      },
    };
  }

  /** 获取标准化后的 base URL（末尾含 /v1） */
  private get normalizedBaseUrl(): string {
    return this.config.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1";
  }

  async listModels(): Promise<string[]> {
    try {
      const headers: Record<string, string> = {};
      if (this.config.apiKey) {
        headers["Authorization"] = `Bearer ${this.config.apiKey}`;
      }
      const response = await fetch(`${this.normalizedBaseUrl}/models`, { headers });
      if (!response.ok) return [];
      const json = await response.json() as { data?: Array<{ id: string }> };
      return json.data?.map(m => m.id) ?? [];
    } catch {
      return [];
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const models = await this.listModels();
      return models.length > 0;
    } catch {
      return false;
    }
  }

  private calculateCost(model: string, promptTokens: number, completionTokens: number): number {
    const pricing = this.config.pricing?.[model];
    if (!pricing) return 0;
    return (promptTokens * pricing.input + completionTokens * pricing.output) / 1000;
  }
}
