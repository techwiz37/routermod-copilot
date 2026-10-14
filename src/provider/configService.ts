import * as vscode from 'vscode';
import { GatewayConfig } from '../config/gatewayConfig';
import { TOKEN_CONSTANTS } from '../chat/tokenBudget';
import { Profile } from '../profiles/profileTypes';
import {
  ConfigIssue,
  DEFAULT_REQUEST_TIMEOUT_MS,
  FALLBACK_SERVER_URL,
  validateGatewayConfig,
} from './configValidation';

interface ConfigServiceDeps {
  log: (message: string) => void;
  promptOpenSettings: (message: string) => void;
}

/**
 * Reads the extension's workspace settings and merges them with a specific
 * {@link Profile} into a validated `GatewayConfig`.
 *
 * Workspace-level settings (timeouts, tool calling, token limits, perModelOptions)
 * apply across all profiles, while endpoint, apiKey, and customHeaders come
 * directly from the selected profile.
 */
export class ConfigService {
  /** Tracks the last values we warned about, to avoid notification spam on each keystroke in the settings UI. */
  private lastInvalidUrlNotified?: string;
  private lastOutputTokenAdjustmentNotified?: { output: number; total: number };

  constructor(private readonly deps: ConfigServiceDeps) {}

  /**
   * Load configuration resolved for a given profile.
   */
  public loadForProfile(profile: Profile, apiKeyOverride?: string): GatewayConfig {
    const raw = this.readRawConfig(profile, apiKeyOverride);
    const { config, issues } = validateGatewayConfig(raw);
    this.reportIssues(issues);
    return config;
  }

  private readRawConfig(profile: Profile, apiKeyOverride?: string): GatewayConfig {
    const config = vscode.workspace.getConfiguration('routermod-for-github-copilot');
    return {
      serverUrl: profile.serverUrl || FALLBACK_SERVER_URL,
      apiKey: apiKeyOverride ?? profile.apiKey ?? '',
      requestTimeout: config.get<number>('requestTimeout', DEFAULT_REQUEST_TIMEOUT_MS),
      defaultMaxTokens: config.get<number>('defaultMaxTokens', TOKEN_CONSTANTS.DEFAULT_CONTEXT_TOKENS),
      defaultMaxOutputTokens: config.get<number>(
        'defaultMaxOutputTokens',
        TOKEN_CONSTANTS.FALLBACK_OUTPUT_TOKENS
      ),
      enableImageInput: config.get<boolean>('enableImageInput', true),
      enableToolCalling: config.get<boolean>('enableToolCalling', true),
      parallelToolCalling: config.get<boolean>('parallelToolCalling', true),
      agentTemperature: config.get<number>('agentTemperature', 0),
      verboseLogging: config.get<boolean>('verboseLogging', false),
      customHeaders: { ...(profile.customHeaders ?? {}) },
      extraModelOptions: config.get<Record<string, unknown>>('extraModelOptions', {}) ?? {},
      perModelOptions: config.get<Record<string, unknown>>('perModelOptions', {}) ?? {},
      modelContextWindows: config.get<Record<string, number>>('modelContextWindows', {}) ?? {},
      enableInlineCompletion: config.get<boolean>('enableInlineCompletion', false),
      inlineCompletionProvider: config.get<string>('inlineCompletionProvider', ''),
      inlineCompletionModel: config.get<string>('inlineCompletionModel', ''),
      inlineCompletionMaxTokens: config.get<number>('inlineCompletionMaxTokens', 256),
      inlineCompletionDebounce: config.get<number>('inlineCompletionDebounce', 300),
      inlineCompletionTimeout: config.get<number>('inlineCompletionTimeout', 3000),
      inlineCompletionMaxPrefixChars: config.get<number>('inlineCompletionMaxPrefixChars', 4000),
      inlineCompletionMaxSuffixChars: config.get<number>('inlineCompletionMaxSuffixChars', 1000),
    };
  }

  /**
   * Map validation issues onto output-channel lines and (de-duplicated)
   * toasts, and reset the dedupe keys for anything that is now valid so
   * future regressions are re-surfaced.
   */
  private reportIssues(issues: ConfigIssue[]): void {
    if (!issues.some((i) => i.kind === 'invalidServerUrl')) {
      this.lastInvalidUrlNotified = undefined;
    }
    if (!issues.some((i) => i.kind === 'outputTokensAdjusted')) {
      this.lastOutputTokenAdjustmentNotified = undefined;
    }

    for (const issue of issues) {
      switch (issue.kind) {
        case 'invalidRequestTimeout':
          this.deps.log(
            `ERROR: requestTimeout must be > 0; using default ${DEFAULT_REQUEST_TIMEOUT_MS}`
          );
          break;
        case 'requestTimeoutClamped':
          this.deps.log(
            `WARNING: requestTimeout clamped to maximum supported value`
          );
          break;
        case 'invalidServerUrl':
          this.deps.log(
            `ERROR: serverUrl '${issue.url}' is not a valid URL; falling back to ${FALLBACK_SERVER_URL}`
          );
          if (this.lastInvalidUrlNotified !== issue.url) {
            this.lastInvalidUrlNotified = issue.url;
            this.deps.promptOpenSettings(
              `Routermod: Invalid server URL '${issue.url}'. Please check your settings.`
            );
          }
          break;
        case 'outputTokensAdjusted':
          this.deps.log(
            `WARNING: defaultMaxOutputTokens (${issue.output}) >= defaultMaxTokens (${issue.total}); adjusting to ${issue.adjusted}`
          );
          if (
            !this.lastOutputTokenAdjustmentNotified ||
            this.lastOutputTokenAdjustmentNotified.output !== issue.output ||
            this.lastOutputTokenAdjustmentNotified.total !== issue.total
          ) {
            this.lastOutputTokenAdjustmentNotified = {
              output: issue.output,
              total: issue.total,
            };
            this.deps.promptOpenSettings(
              `Routermod: defaultMaxOutputTokens (${issue.output}) was adjusted to ${issue.adjusted} ` +
                `because it exceeds defaultMaxTokens (${issue.total}).`
            );
          }
          break;
        default: {
          const _never: never = issue;
          throw new Error(`Unexpected config issue: ${JSON.stringify(_never)}`);
        }
      }
    }
  }
}
