/**
 * Build the `LanguageModelChatInformation` object that VS Code's model picker
 * renders. Kept as its own module so the picker-facing shape (especially the
 * first-party-style `detail`/`multiplierNumeric` fields) can be unit-tested
 * without standing up the full provider.
 */

import type { LanguageModelConfigurationSchema } from 'vscode';
import { OpenAIModel } from '../api/types';
import { describeModel, friendlyModelName, inferModelFamily, parseModelId } from './modelDisplay';
import { serverReportedContext } from '../chat/contextWindow';
import { TOKEN_CONSTANTS } from '../chat/tokenBudget';

/**
 * Grey right-hand label rendered in the VS Code chat model picker. Matches the
 * shape native Copilot Chat BYOK providers use (e.g. `detail: 'Anthropic'`),
 * which is what visually groups all of our models under the provider.
 */
export const PROVIDER_DETAIL_LABEL = 'Routermod';

/**
 * Cost-tier multiplier surfaced to Copilot Chat. Set to 0 so BYOK / self-hosted
 * models don't appear to consume Copilot premium request quota.
 */
export const PROVIDER_MULTIPLIER_NUMERIC = 0;

/**
 * Reasoning-effort levels offered in the Copilot Chat picker for the
 * different thinking formats. Mirrors what Routermod (and the upstream
 * OpenAI/Anthropic APIs it routes to) accept on `reasoning_effort`. Kept
 * as `readonly` tuples so the property is `as const`-friendly.
 */
const OPENAI_EFFORTS = ['low', 'medium', 'high'] as const;
const CLAUDE_ADAPTIVE_EFFORTS = ['low', 'medium', 'high', 'max', 'xhigh'] as const;
const CLAUDE_BUDGET_EFFORTS = ['low', 'medium', 'high', 'max'] as const;
const DEEPSEEK_EFFORTS = ['low', 'high', 'max'] as const;
const ZAI_EFFORTS = ['low', 'medium', 'high'] as const;
const KIMI_EFFORTS = ['low', 'medium', 'high'] as const;
const MINIMAX_EFFORTS = ['low', 'medium', 'high'] as const;
const QWEN_EFFORTS = ['low', 'medium', 'high'] as const;
const GEMINI_EFFORTS = ['low', 'medium', 'high'] as const;

export interface ModelCapabilities {
  readonly imageInput?: boolean;
  readonly toolCalling?: boolean | number;
}

export interface BuildModelInfoInput {
  readonly model: OpenAIModel;
  readonly defaultMaxTokens: number;
  readonly defaultMaxOutputTokens: number;
  readonly capabilities: ModelCapabilities;
  /**
   * User-configured context window for this model (from the
   * `modelContextWindows` setting). Wins over everything else.
   */
  readonly contextOverride?: number;
  /**
   * Context discovered from the backend (Ollama `/api/show`: runtime
   * `num_ctx`, else the model's trained context length). Sits below the user
   * override but above the OpenAI `/v1/models` value, which Ollama omits.
   */
  readonly discoveredContext?: number;
}

/**
 * Picker-facing fields plus the resolved total context size. Total context is
 * returned separately because the chat-response path uses it to budget output
 * tokens — relying on `maxInputTokens` alone would double-count.
 */
export interface BuildModelInfoResult {
  readonly info: {
    readonly id: string;
    readonly name: string;
    readonly family: string;
    readonly version: string;
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number;
    readonly capabilities: ModelCapabilities;
    readonly detail: string;
    readonly tooltip: string;
    readonly description?: string;
    readonly isUserSelectable: true;
    readonly multiplierNumeric: number;
    /**
     * Sub-picker schema for the Copilot Chat model picker. Populated when
     * the model advertises (or we heuristically infer) supported reasoning
     * effort levels — drives the "Thinking Effort" dropdown that landed in
     * microsoft/vscode#315181. The chosen value flows into
     * `options.modelConfiguration.reasoningEffort` on the chat request.
     */
    readonly configurationSchema?: LanguageModelConfigurationSchema;
  };
  readonly totalContext: number;
  readonly hasServerReportedContext: boolean;
}

/**
 * Translate a raw `/v1/models` entry into the picker-facing model info plus
 * the resolved total context.
 *
 * `maxInputTokens` is intentionally set to the full server-reported context so
 * the picker shows the true window size. Output-token budgeting uses
 * `totalContext` separately so the math doesn't double-count.
 */
export function buildModelInfo({
  model,
  defaultMaxTokens,
  defaultMaxOutputTokens,
  capabilities,
  contextOverride,
  discoveredContext,
}: BuildModelInfoInput): BuildModelInfoResult {
  const serverContext = serverReportedContext(model);
  const totalContext =
    contextOverride ?? discoveredContext ?? serverContext ?? defaultMaxTokens;
  // Routermod `capabilities.maxOutput` is an authoritative ceiling (issue #199).
  const modelMaxOutput = model.capabilities?.maxOutput;
  const computedMaxOutput = Math.min(
    defaultMaxOutputTokens,
    Math.max(
      TOKEN_CONSTANTS.MIN_OUTPUT_TOKENS,
      totalContext - TOKEN_CONSTANTS.ADJUST_TOKEN_BUFFER
    )
  );
  const maxOutputTokens = modelMaxOutput !== undefined && modelMaxOutput > 0
    ? Math.min(modelMaxOutput, computedMaxOutput)
    : computedMaxOutput;

  const description = describeModel(model);
  const { provider } = parseModelId(model.id, model.name);
  const friendlyName = friendlyModelName(model.id, model.name);

  const tooltipParts: string[] = [];
  if (provider) {
    tooltipParts.push(`**Provider:** ${provider}`);
  }
  tooltipParts.push(`**Model ID:** \`${model.id}\``);
  tooltipParts.push(`**Name:** ${friendlyName}`);
  const tooltip = tooltipParts.join('  \n');

  // Build the "Thinking Effort" sub-picker for reasoning-capable models.
  // The schema follows microsoft/vscode#315181: the picker renders a
  // dropdown of `enum` values with the `default` pre-selected, and the
  // chosen value arrives on the request as
  // `options.modelConfiguration.reasoningEffort`.
  const configurationSchema = resolveReasoningEffortSchema(model, friendlyName);

  const info: BuildModelInfoResult['info'] = {
    id: model.id,
    name: friendlyName,
    family: inferModelFamily(model.id),
    version: friendlyName,
    maxInputTokens: totalContext,
    maxOutputTokens,
    capabilities,
    detail: PROVIDER_DETAIL_LABEL,
    tooltip,
    isUserSelectable: true,
    multiplierNumeric: PROVIDER_MULTIPLIER_NUMERIC,
    ...(description ? { description } : {}),
    ...(configurationSchema ? { configurationSchema } : {}),
  };

  return {
    info,
    totalContext,
    hasServerReportedContext: serverContext !== undefined,
  };
}

/**
 * Build the `configurationSchema` for a model when it advertises reasoning
 * support. Mirrors the Copilot Chat BYOK behaviour in
 * microsoft/vscode#315181: a `reasoningEffort` string enum with a sensible
 * default. Returns `undefined` when the model doesn't support thinking,
 * so the picker doesn't render an empty dropdown.
 */
export function resolveReasoningEffortSchema(
  model: OpenAIModel,
  friendlyName: string
): LanguageModelConfigurationSchema | undefined {
  if (!model.capabilities?.reasoning) {
    return undefined;
  }
  // Some providers bake the reasoning tier into the model id itself
  // (e.g. `cu/claude-4.5-opus-high-thinking`). For those the picker is
  // noise — the tier is already fixed by the model entry, and the
  // upstream ignores any `reasoning_effort` we'd forward. Skip the
  // schema entirely before any format-based enum logic runs.
  if (hasReasoningTierInName(model.id)) {
    return undefined;
  }
  // Server-advertised list wins verbatim. Filters out empty strings and
  // non-string entries defensively — some servers embed the list inside
  // a wrapper object by mistake.
  const explicit = model.capabilities.reasoningEffort;
  const efforts =
    Array.isArray(explicit) && explicit.length > 0
      ? explicit.filter((value): value is string => typeof value === 'string' && value.length > 0)
      : pickEffortsForFormat(model);
  if (!efforts || efforts.length === 0) {
    return undefined;
  }
  const defaultEffort = pickDefaultEffort(friendlyName, model.id, efforts);
  return {
    group: 'navigation',
    properties: {
      reasoningEffort: {
        type: 'string',
        enum: efforts,
        // Drop `default` when the preferred value isn't in the supported
        // list, so the picker falls back to "no selection" instead of
        // emitting an out-of-range default.
        ...(defaultEffort !== undefined ? { default: defaultEffort } : {}),
        description: 'Reasoning effort forwarded to the model as `reasoning_effort`.',
        group: 'navigation',
      },
    },
  };
}

function pickDefaultEffort(
  friendlyName: string,
  modelId: string,
  efforts: readonly string[]
): string | undefined {
  // Claude family uses `high` as the preferred default per the upstream
  // Copilot BYOK heuristic in microsoft/vscode#315181. Everything else
  // uses `medium`. Strip the "Claude" provider suffix from the friendly
  // name so `claude-opus-4.7 (anthropic)` still matches.
  const lower = friendlyName.toLowerCase();
  const isClaude = /(^|\s)claude(\s|$|[-_])/.test(lower) || /claude/i.test(modelId);
  const preferred = isClaude ? 'high' : 'medium';
  return efforts.includes(preferred) ? preferred : undefined;
}

function pickEffortsForFormat(
  model: OpenAIModel
): readonly string[] | undefined {
  const format = model.capabilities?.thinkingFormat;
  const effortSupported = model.capabilities?.thinkingEffortSupported === true;
  switch (format) {
    case 'openai':
      return OPENAI_EFFORTS;
    case 'claude-adaptive':
      return CLAUDE_ADAPTIVE_EFFORTS;
    case 'claude-budget':
      return CLAUDE_BUDGET_EFFORTS;
    case 'deepseek':
      return DEEPSEEK_EFFORTS;
    case 'zai':
      // Only GLM-5.2+ reads `reasoning_effort` (Routermod capabilities.js
      // gate it on `thinkingEffortSupported`); older zai-format models
      // ignore the field.
      return effortSupported ? ZAI_EFFORTS : undefined;
    case 'kimi':
      return KIMI_EFFORTS;
    case 'minimax':
      return MINIMAX_EFFORTS;
    case 'qwen':
      return QWEN_EFFORTS;
    case 'gemini-level':
    case 'gemini-budget':
      return GEMINI_EFFORTS;
    case undefined:
      // No explicit format — fall back to a model-id hint for the
      // openai family (gpt-5, o-series, codex) which is the most common
      // reason-capable model without a tagged format.
      if (/^(o1|o3|o4|gpt-5|codex)/i.test(stripProviderPrefix(model.id))) {
        return OPENAI_EFFORTS;
      }
      return undefined;
    default:
      return undefined;
  }
}

function stripProviderPrefix(modelId: string): string {
  const slash = modelId.lastIndexOf('/');
  return slash >= 0 && slash < modelId.length - 1 ? modelId.slice(slash + 1) : modelId;
}


/**
 * Reasoning-tier tokens that may appear as a `-` or `_`-separated
 * segment in a model id. Case-insensitive. Exported as an array so
 * it's trivially extensible from tests or future providers — just push
 * more entries. The {@link hasReasoningTierInName} fast-path uses an
 * internal `Set` mirror to avoid the O(n) `Array.includes` scan on
 * each call.
 */
export const REASONING_TIER_KEYWORDS: readonly string[] = [
  'low',
  'medium',
  'high',
  'extra',
  'max',
  'xhigh',
  'thinking',
  'agentic',
];

/** Set mirror of {@link REASONING_TIER_KEYWORDS} for O(1) lookup. */
const REASONING_TIER_KEYWORD_SET: ReadonlySet<string> = new Set(REASONING_TIER_KEYWORDS);

/**
 * Number of trailing segments to inspect for a tier keyword. Providers
 * expose tier-baked models with the tier at the tail — usually a single
 * suffix, sometimes stacked (`high-thinking`, `extra-low`,
 * `thinking-agentic`). Three covers the longest stacked pattern we've
 * seen in practice without re-introducing false positives on
 * mid-name coincidences like `claude-high-preview-4` (where `high`
 * would otherwise be flagged even though it's a version tag).
 */
export const REASONING_TIER_TRAILING_SEGMENTS = 3;

/**
 * Regex used by {@link splitModelSegments} to cut both `-` and `_`
 * boundaries in a single pass. Bracket-class character splitting is
 * faster than running two `split` calls and stitching.
 */
const MODEL_SEGMENT_SPLITTER = /[-_]/;

/**
 * True when any of the last {@link REASONING_TIER_TRAILING_SEGMENTS}
 * segments of the model id (after stripping the provider prefix) matches
 * a reasoning-tier keyword.
 *
 * Matching is whole-segment, case-insensitive. Substring matches are
 * deliberately rejected so tokens like `highlight`, `mediumwave`, or
 * `maximus` do not trip the heuristic.
 *
 * Only the trailing window is inspected so a tier keyword appearing as a
 * middle token — e.g. `claude-high-opus-4-6` where `high` is part of the
 * model name, not a tier — does not false-positive.
 *
 * Tiers may stack — `claude-4.5-opus-high-thinking`,
 * `something-thinking-agentic`, `something-medium-thinking`, and
 * `gemini-3.5-flash-extra-low` all return true.
 *
 * `@example`
 *   hasReasoningTierInName('cu/claude-4.5-opus-high-thinking') // true
 *   hasReasoningTierInName('ag/gemini-3.5-flash-extra-low')    // true
 *   hasReasoningTierInName('gpt-4-highlight-preview')          // false
 *   hasReasoningTierInName('openai/o3')                         // false
 */
export function hasReasoningTierInName(modelId: string): boolean {
  const slash = modelId.indexOf('/');
  const modelPart = slash >= 0 ? modelId.slice(slash + 1) : modelId;
  if (modelPart.length === 0) {
    return false;
  }
  // Iterate the trailing 3 segments via single-pass split. Regex
  // character class + `slice` avoids two-array materialisations.
  const parts = modelPart.split(MODEL_SEGMENT_SPLITTER);
  const start = parts.length > REASONING_TIER_TRAILING_SEGMENTS
    ? parts.length - REASONING_TIER_TRAILING_SEGMENTS
    : 0;
  for (let i = start; i < parts.length; i++) {
    if (REASONING_TIER_KEYWORD_SET.has(parts[i].toLowerCase())) {
      return true;
    }
  }
  return false;
}

/**
 * Split the model portion (post provider prefix) into lowercased
 * segments on `-` and `_`. Exported so tests can inspect the parsed
 * segments.
 */
export function splitModelSegments(modelId: string): readonly string[] {
  const slash = modelId.indexOf('/');
  const modelPart = slash >= 0 ? modelId.slice(slash + 1) : modelId;
  if (modelPart.length === 0) {
    return [];
  }
  return modelPart
    .split(MODEL_SEGMENT_SPLITTER)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());
}