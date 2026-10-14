/**
 * Type definitions for OpenAI-compatible API responses
 */

export interface OpenAIModel {
  id: string;
  name?: string;
  object: string;
  created: number;
  owned_by: string;
  /** vLLM, LiteLLM */
  max_model_len?: number;
  /** Ollama, LocalAI, LM Studio */
  context_length?: number;
  /** llama.cpp */
  context_window?: number;
  /**
   * Routermod capabilities block. Carries contextWindow,
   * maxOutput, vision, tools, reasoning, search, and other feature flags.
   */
  capabilities?: {
    vision?: boolean;
    pdf?: boolean;
    audioInput?: boolean;
    videoInput?: boolean;
    imageOutput?: boolean;
    audioOutput?: boolean;
    search?: boolean;
    tools?: boolean;
    reasoning?: boolean;
    thinkingFormat?: string;
    thinkingCanDisable?: boolean;
    thinkingRange?: unknown;
    /**
     * Allowed `reasoning_effort` levels for the OpenAI-style picker. The
     * server may emit this as a list of accepted values (e.g. GitHub
     * Copilot's `/models` `capabilities.supports.reasoning_effort`,
     * Routermod's `capabilities.reasoningEffort`); when present the model
     * picker prefers it verbatim over the per-format heuristic. Not all
     * upstreams surface the list — the picker falls back to a per-format
     * default in {@link resolveReasoningEffortSchema}.
     */
    reasoningEffort?: string[];
    /**
     * Whether the model accepts an OpenAI-style `reasoning_effort` level at
     * all. Mirrors Routermod's `thinkingEffortSupported` field; used by the
     * model-info builder to gate the "Thinking Effort" picker on
     * formats that only honour the field on newer server versions
     * (e.g. zai/GLM-5.2+ — older GLM silently ignores `reasoning_effort`).
     */
    thinkingEffortSupported?: boolean;
    contextWindow?: number;
    maxOutput?: number;
  };
  /**
   * llama.cpp nests model metadata here. `n_ctx` is the actual serving
   * context (`-c`); `n_ctx_train` the model's training context. In
   * llama-server router mode these appear only while the model is loaded
   * (issue #55).
   */
  meta?: {
    n_ctx?: number;
    n_ctx_train?: number;
    [key: string]: unknown;
  };
}

export interface OpenAIModelsResponse {
  object: string;
  data: OpenAIModel[];
}

/**
 * Wire-format message sent to an OpenAI-compatible chat endpoint.
 *
 * Typed loosely because we pass through a handful of provider-specific
 * variants (content can be string OR an array of text/image parts, tool
 * results appear as `role: 'tool'` messages, etc.). Treat it as the shape
 * that JSON.stringify will be called on.
 */
export type OpenAIMessage = Record<string, unknown>;

export interface OpenAIToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  tools?: OpenAIToolDefinition[];
  tool_choice?: 'auto' | 'required' | 'none';
  parallel_tool_calls?: boolean;
  [key: string]: unknown;
}

/**
 * Legacy `/v1/completions` request. Used by the experimental inline-completion
 * provider for fill-in-the-middle (FIM): `prompt` is the text before the
 * cursor and `suffix` the text after, which FIM-capable servers (vLLM,
 * llama.cpp, LM Studio, …) splice into the model's FIM template.
 */
export interface OpenAICompletionRequest {
  model: string;
  prompt: string;
  suffix?: string;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  stop?: string[];
  [key: string]: unknown;
}

export interface OpenAICompletionResponse {
  id?: string;
  object?: string;
  choices?: Array<{
    text?: string;
    index?: number;
    finish_reason?: string | null;
  }>;
}

/**
 * OpenAI-compatible token usage stats. `prompt_tokens_details.cached_tokens`
 * is supported by OpenAI and a growing set of compatible servers; absent
 * elsewhere, we default to 0 when surfacing to VS Code.
 */
export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}
