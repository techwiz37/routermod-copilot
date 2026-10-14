/**
 * Helpers for turning raw OpenAI `/v1/models` entries into the shape that the
 * VS Code Copilot Chat model picker renders nicely.
 *
 * Kept as its own module so it can be unit-tested without VS Code.
 */

import { OpenAIModel } from '../api/types';
import { serverReportedContext } from '../chat/contextWindow';

/**
 * Produce a display-friendly short name for a model ID.
 *
 * Gateway-style IDs like `ocg/deepseek-v4-pro` become
 * `Deepseek V4 Pro (ocg)`. Hugging-Face-style IDs like
 * `Qwen/Qwen3-8B` also get the same treatment: `Qwen3 8B (Qwen)`.
 * IDs without a slash are prettified in-place: `gpt-4o-mini` →
 * `Gpt 4o Mini`.
 */
export function friendlyModelName(id: string, rawName?: string): string {
  return parseModelId(id, rawName).displayName;
}

/** Parsed components of a model ID. */
export interface ParsedModelId {
  /** Provider prefix before the last `/`, or undefined if no slash. */
  provider?: string;
  /** Model portion after the last `/` (or the whole ID if no slash). */
  modelPart: string;
  /** Prettified display name: `Deepseek V4 Pro (ocg)`. */
  displayName: string;
}

/**
 * Split a model ID into provider, model part, and a human-friendly
 * display name. Converts dash-separated tokens to Title Case and
 * appends the provider in parentheses when present.
 */
export function parseModelId(id: string, rawName?: string): ParsedModelId {
  const slash = id.lastIndexOf('/');
  let provider: string | undefined;
  let modelPart: string;

  if (slash >= 0 && slash < id.length - 1) {
    provider = id.slice(0, slash);
    modelPart = id.slice(slash + 1);
  } else {
    modelPart = id;
  }

  const prettyModel = rawName || modelPart
    .split('-')
    .map(seg => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join(' ');

  const displayName = provider && !prettyModel.includes(`(${provider})`)
    ? `${prettyModel} (${provider})`
    : prettyModel;

  return { provider, modelPart, displayName };
}

const FAMILY_KEYWORDS: Array<{ match: RegExp; family: string }> = [
  { match: /qwen/i, family: 'qwen' },
  { match: /llama/i, family: 'llama' },
  { match: /mistral/i, family: 'mistral' },
  { match: /mixtral/i, family: 'mixtral' },
  { match: /deepseek/i, family: 'deepseek' },
  { match: /phi/i, family: 'phi' },
  { match: /gemma/i, family: 'gemma' },
  { match: /gpt-?oss/i, family: 'gpt-oss' },
  { match: /yi[-_]/i, family: 'yi' },
  { match: /command[-_]?r/i, family: 'command-r' },
];

/**
 * Infer a VS Code `family` value from the model ID. Falls back to
 * `'routermod'` so the picker still groups all gateway models together when
 * the family can't be determined.
 */
export function inferModelFamily(id: string): string {
  for (const { match, family } of FAMILY_KEYWORDS) {
    if (match.test(id)) { return family; }
  }
  return 'routermod';
}

/**
 * Build a short description string highlighting context size and owner.
 * Used as the `detail` shown under the model name in the picker.
 */
export function describeModel(model: OpenAIModel): string {
  const context = serverReportedContext(model);
  const parts: string[] = [];
  if (context) {
    parts.push(`${formatTokens(context)} ctx`);
  }
  if (model.owned_by && model.owned_by !== 'organization-owner') {
    parts.push(model.owned_by);
  }
  return parts.join(' • ');
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) { return `${Math.round(n / 1_000_000)}M`; }
  if (n >= 1_000) { return `${Math.round(n / 1_000)}K`; }
  return String(n);
}

/**
 * Deduplicate a list of models by `id`, preserving first-seen order. Servers
 * occasionally return the same id twice (e.g. LoRA adapters sharing a base
 * model id); the picker shouldn't show duplicates.
 */
export function dedupeModels(models: readonly OpenAIModel[]): OpenAIModel[] {
  const seen = new Set<string>();
  const result: OpenAIModel[] = [];
  for (const model of models) {
    if (!seen.has(model.id)) {
      seen.add(model.id);
      result.push(model);
    }
  }
  return result;
}
