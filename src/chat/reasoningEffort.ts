/**
 * Reasoning-effort resolution helpers.
 *
 * Kept in their own module so the chat request handler can stay focused on
 * streaming, and so the resolution rules can be unit-tested without
 * standing up the full `vscode` runtime (the chat handler imports many
 * `vscode` symbols that the test runner doesn't load).
 *
 * The picker drives this by setting `modelConfiguration.reasoningEffort` on
 * the chat request — that's the field Copilot Chat writes when the user
 * picks a value in the "Thinking Effort" sub-selector rendered from the
 * `configurationSchema` we attach to `LanguageModelChatInformation` (see
 * microsoft/vscode#315181). The chat handler reads it back out here and
 * forwards the result on the OpenAI request body as `reasoning_effort`.
 * The value is also accepted as `modelOptions.reasoningEffort`,
 * `modelOptions.reasoning_effort` (snake_case), and via
 * `perModelOptions` / `extraModelOptions` to preserve the existing
 * settings.json escape hatch.
 *
 * Valid values mirror the GitHub Copilot SDK's `ReasoningEffort` union
 * added in https://github.com/github/copilot-sdk/pull/302 — only
 * `low / medium / high / xhigh` are forwarded. Anything outside that set
 * is dropped so the request never trips a 400 on the upstream provider.
 */

/**
 * Mirrors `ReasoningEffort` from `github/copilot-sdk` PR #302. Forwarded on
 * the request body as `reasoning_effort`; any value outside this set is
 * treated as "not specified" and the field is omitted.
 */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * `vscode.ProvideLanguageModelChatResponseOptions.modelOptions` /
 * `modelConfiguration` shape, as loose as it is: VS Code's typings don't
 * enumerate what variants or callers may inject, so we duck-type it.
 */
export interface ReasoningEffortSources {
    /**
     * The `modelConfiguration` object the Copilot Chat picker fills in
     * when the user picks a value in the "Thinking Effort" sub-selector
     * (microsoft/vscode#315181). This is the highest-priority source
     * because it represents the user's direct, in-flight choice.
     */
    readonly modelConfiguration?: Record<string, unknown> | undefined;
    /** Fallback for any other caller that sets `modelOptions.reasoningEffort`. */
    readonly optionsModelOptions?: Record<string, unknown> | undefined;
    readonly perModelOptions?: Record<string, unknown> | undefined;
    readonly extraModelOptions?: Record<string, unknown> | undefined;
}

/**
 * Pick the reasoning-effort level the user (or settings) wants for this
 * request, or `undefined` when none should be forwarded.
 *
 * Precedence: `modelConfiguration` (the picker) > `optionsModelOptions` >
 * `perModelOptions` > `extraModelOptions`. Both `reasoningEffort` (camelCase,
 * matches the Copilot SDK's `SessionConfig.reasoningEffort` field) and
 * `reasoning_effort` (snake_case, the raw wire-format key) are accepted so
 * the value can be set via either the picker or a `perModelOptions`
 * override.
 *
 * The returned value is the canonical wire form: lowercase, drawn from the
 * {@link ReasoningEffort} union. The literal strings `"none"`, `"off"`, and
 * any other value outside the union are dropped — GitHub Copilot's
 * `/v1/chat/completions` returns 400 on `"none"` for models that don't
 * accept it, and Routermod itself strips it (decolua/routermod PR #791).
 */
export function pickReasoningEffort(sources: ReasoningEffortSources): ReasoningEffort | undefined {
    const candidate =
        pickString(sources.optionsModelOptions?.reasoningEffort) ??
        pickString(sources.modelConfiguration?.reasoningEffort) ??
        pickString(sources.perModelOptions?.reasoningEffort) ??
        pickString(sources.extraModelOptions?.reasoningEffort) ??
        pickString(sources.optionsModelOptions?.reasoning_effort) ??
        pickString(sources.modelConfiguration?.reasoning_effort) ??
        pickString(sources.perModelOptions?.reasoning_effort) ??
        pickString(sources.extraModelOptions?.reasoning_effort);
    if (!candidate) {
        return undefined;
    }
    const lowered = candidate.toLowerCase();
    return REASONING_EFFORT_VALUES.has(lowered) ? (lowered as ReasoningEffort) : undefined;
}

/** All values accepted on the wire. Frozen for `Set.has` fast-path. */
const REASONING_EFFORT_VALUES: ReadonlySet<string> = new Set([
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
]);

function pickString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
