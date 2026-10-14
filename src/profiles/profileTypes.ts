/**
 * Core types for multi-profile support.
 *
 * A Profile represents one inference backend (e.g. local Ollama, cloud Routermod,
 * remote vLLM). Each profile has its own endpoint, credentials, and custom
 * headers, while workspace-level settings (timeouts, tool calling flags, token
 * budgets) provide global defaults that apply across all profiles.
 */

export interface Profile {
  /** Stable identifier, e.g. 'default', 'ollama-local', 'cloud-routermod'. URL-safe slug. */
  readonly id: string;
  /** Human-readable display name, e.g. 'Local Ollama', 'Routermod Cloud'. */
  readonly name: string;
  /** OpenAI-compatible base URL (e.g. 'http://localhost:20128/v1'). */
  readonly serverUrl: string;
  /** Optional Bearer token. Stored in the profile secret blob. */
  readonly apiKey?: string;
  /** Optional custom HTTP headers (e.g. Anthropic-Version, Authorization override). */
  readonly customHeaders?: Record<string, string>;
  /** When false, models from this profile are excluded from the picker. Default true. */
  readonly enabled: boolean;
  /** Timestamp when created (epoch ms). */
  readonly createdAt: number;
}

/** Input shape for creating or updating a profile. */
export interface ProfileDraft {
  readonly id?: string;
  readonly name: string;
  readonly serverUrl: string;
  readonly apiKey?: string;
  readonly customHeaders?: Record<string, string>;
  readonly enabled?: boolean;
}

export const DEFAULT_PROFILE_ID = 'default';
export const DEFAULT_PROFILE_NAME = 'Default';
export const DEFAULT_PROFILE_URL = 'http://localhost:1337/v1';

/** SecretStorage key under which the JSON array of profiles is persisted. */
export const PROFILES_SECRET_KEY = 'routermod-for-github-copilot.profiles.v1';

/**
 * Generate a URL-safe profile id from a display name.
 * e.g. "My Local vLLM" -> "my-local-vllm"
 */
export function slugifyProfileName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'profile';
}

/** Create a fresh default profile. */
export function createDefaultProfile(overrides?: Partial<Profile>): Profile {
  return {
    id: overrides?.id ?? DEFAULT_PROFILE_ID,
    name: overrides?.name ?? DEFAULT_PROFILE_NAME,
    serverUrl: overrides?.serverUrl ?? DEFAULT_PROFILE_URL,
    apiKey: overrides?.apiKey ?? '',
    customHeaders: overrides?.customHeaders ?? {},
    enabled: overrides?.enabled ?? true,
    createdAt: overrides?.createdAt ?? Date.now(),
  };
}
