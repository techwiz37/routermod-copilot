/**
 * Model ID namespacing and parsing for multi-profile support.
 *
 * When only one profile is active, models expose raw IDs (e.g. 'qwen2.5-coder-32b')
 * to remain fully backward-compatible with settings, history, and single-provider users.
 *
 * When two or more profiles are active, models are namespaced as:
 *   `${profileId}/${rawModelId}`
 * e.g. 'local/qwen2.5-coder-32b' vs 'cloud/qwen2.5-coder-32b'.
 *
 * Incoming requests are parsed back into (profileId, rawModelId) using the
 * set of known active profile IDs.
 */

export interface ParsedModelTarget {
  readonly profileId: string;
  readonly rawModelId: string;
}

/**
 * Format a model ID for exposure to VS Code's model picker.
 *
 * Namespaces only when `namespaceEnabled` is true (i.e. more than 1 enabled profile).
 */
export function formatExposedModelId(
  profileId: string,
  rawModelId: string,
  namespaceEnabled: boolean
): string {
  return namespaceEnabled ? `${profileId}/${rawModelId}` : rawModelId;
}

/**
 * Parse an incoming model ID from VS Code back to its target profile and raw model ID.
 *
 * Resolution order:
 * 1. If the ID starts with `${knownProfileId}/`, strip that prefix and route there.
 * 2. If no prefix matches:
 *    a. If there is an active profile with id === fallbackProfileId, route there with rawId = modelId.
 *    b. Otherwise route to the first known profile ID, or return fallbackProfileId.
 */
export function parseModelTarget(
  modelId: string,
  knownProfileIds: readonly string[],
  fallbackProfileId: string
): ParsedModelTarget {
  const trimmed = modelId.trim();
  const slashIndex = trimmed.indexOf('/');

  if (slashIndex > 0) {
    const candidateProfile = trimmed.slice(0, slashIndex);
    if (knownProfileIds.includes(candidateProfile)) {
      return {
        profileId: candidateProfile,
        rawModelId: trimmed.slice(slashIndex + 1),
      };
    }
  }

  // Not namespaced or candidate profile unknown — fallback
  const resolvedProfile = knownProfileIds.includes(fallbackProfileId)
    ? fallbackProfileId
    : knownProfileIds[0] ?? fallbackProfileId;

  return {
    profileId: resolvedProfile,
    rawModelId: trimmed,
  };
}

/**
 * Drop duplicate entries from a model list, keeping the first occurrence.
 *
 * Why this exists: VS Code renders one row per returned entry, keyed by the
 * exposed `id`. Duplicates leak in when (a) two enabled profiles point at the
 * same server and the same raw model appears under each namespace, or (b) a
 * backend lists the same id twice. Either way the picker shows the same model
 * more than once, which reads as a bug to users.
 *
 * `keyOf` defaults to the `id` field but is injectable so the status dialog
 * (which exposes a different shape) can reuse the same logic. Order is
 * preserved so the server's listing order wins.
 */
export function dedupeById<T>(
  items: readonly T[],
  keyOf: (item: T) => string = (item) => (item as { id?: string }).id ?? ''
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (key.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}
