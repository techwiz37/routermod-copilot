import * as vscode from 'vscode';
import {
  FrameworkConfigOverride,
  readFrameworkConfiguration,
  resolveApiKey,
} from '../config/frameworkConfig';
import { estimateTextTokens } from '../chat/tokenBudget';
import { diagnoseModelFetchError } from '../chat/errorDiagnostics';
import { InlineCompletionBackend } from '../completions/inlineCompletionProvider';
import {
  SessionStats,
  TokenUsage,
  accumulateUsage,
  emptySessionStats,
  recordRequest,
} from '../status/sessionStats';
import {
  ConnectionState,
  ModelSummary,
  ProfileSummary,
  StatusSnapshot,
  formatCapabilityLabels,
  formatContextLabel,
} from '../status/statusSnapshot';
import { RequestStateEvent } from './chatRequestHandler';
import { ConfigService } from './configService';
import { ProfileStore } from '../profiles/profileStore';
import { Profile, DEFAULT_PROFILE_ID } from '../profiles/profileTypes';
import { ProfileRuntime } from './profileRuntime';
import { formatExposedModelId, dedupeById, parseModelTarget } from '../profiles/modelNamespace';
import { promptOpenSettings } from './notifications';
import { countMessageTokens } from './vscodeParts';

export type { RequestStateEvent } from './chatRequestHandler';

const MODEL_AFFECTING_KEYS: readonly string[] = [
  'routermod-for-github-copilot.requestTimeout',
  'routermod-for-github-copilot.defaultMaxTokens',
  'routermod-for-github-copilot.defaultMaxOutputTokens',
  'routermod-for-github-copilot.enableImageInput',
  'routermod-for-github-copilot.enableToolCalling',
  'routermod-for-github-copilot.modelContextWindows',
];

export class GatewayProvider
  implements vscode.LanguageModelChatProvider, InlineCompletionBackend
{
  private readonly outputChannel: vscode.OutputChannel;
  private readonly configService: ConfigService;
  private readonly profileStore: ProfileStore;
  private readonly runtimes: Map<string, ProfileRuntime> = new Map();
  private readonly frameworkOverride: FrameworkConfigOverride = {};

  private readonly _onDidChangeLanguageModelChatInformation = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformation.event;

  private readonly _onDidChangeRequestState = new vscode.EventEmitter<RequestStateEvent>();
  readonly onDidChangeRequestState = this._onDidChangeRequestState.event;

  private readonly _onDidChangeStatusSnapshot = new vscode.EventEmitter<void>();
  readonly onDidChangeStatusSnapshot = this._onDidChangeStatusSnapshot.event;

  private sessionStats: SessionStats = emptySessionStats();
  private lastRequest?: {
    modelId: string;
    modelName: string;
    completedAt: number;
    usage?: TokenUsage;
    profileName?: string;
  };

  constructor(context: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel('Routermod');
    const log = (msg: string): void => this.outputChannel.appendLine(msg);

    this.profileStore = new ProfileStore(context.secrets, {
      log,
      onDidUpdate: () => this.syncRuntimes(),
    });

    this.configService = new ConfigService({
      log,
      promptOpenSettings: (message) => promptOpenSettings(message, log),
    });

    context.subscriptions.push(
      this.outputChannel,
      this._onDidChangeLanguageModelChatInformation,
      this._onDidChangeRequestState,
      this._onDidChangeStatusSnapshot,
      vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
        if (!e.affectsConfiguration('routermod-for-github-copilot')) {
          return;
        }
        this.outputChannel.appendLine('Workspace configuration changed, reloading profiles...');
        this.syncRuntimes();
        if (MODEL_AFFECTING_KEYS.some((key) => e.affectsConfiguration(key))) {
          this._onDidChangeLanguageModelChatInformation.fire();
        }
      }),
      context.secrets.onDidChange((e: vscode.SecretStorageChangeEvent) => {
        if (!this.profileStore.ownsSecretKey(e.key)) {
          return;
        }
        void this.profileStore.refreshCache().catch((err: unknown) => {
          this.outputChannel.appendLine(
            `Failed to refresh profiles after secret change: ${err instanceof Error ? err.message : String(err)}`
          );
        });
      })
    );
  }

  public getProfileStore(): ProfileStore {
    return this.profileStore;
  }

  public getRuntime(profileId: string): ProfileRuntime | undefined {
    return this.runtimes.get(profileId);
  }

  public async loadSecrets(): Promise<void> {
    await this.profileStore.load();
    this.syncRuntimes();
  }

  public syncRuntimes(): void {
    const profiles = this.profileStore.getProfiles();
    const currentIds = new Set(profiles.map((p) => p.id));

    for (const [id] of this.runtimes) {
      if (!currentIds.has(id)) {
        this.runtimes.delete(id);
      }
    }

    for (const profile of profiles) {
      const isDefault = profile.id === DEFAULT_PROFILE_ID;
      const effectiveApiKey = isDefault
        ? resolveApiKey(this.frameworkOverride, profile.apiKey)
        : (profile.apiKey ?? '');

      const effectiveUrl =
        isDefault && this.frameworkOverride.serverUrl
          ? this.frameworkOverride.serverUrl
          : profile.serverUrl;

      const effectiveProfile: Profile = {
        ...profile,
        serverUrl: effectiveUrl,
        apiKey: effectiveApiKey,
      };

      const config = this.configService.loadForProfile(
        effectiveProfile,
        effectiveApiKey
      );

      const existing = this.runtimes.get(profile.id);
      if (existing) {
        existing.update(effectiveProfile, config);
      } else {
        const runtime = new ProfileRuntime(effectiveProfile, config, {
          log: (msg) => this.outputChannel.appendLine(msg),
          showOutput: () => this.outputChannel.show(),
          onRequestState: (event) => this._onDidChangeRequestState.fire(event),
          onCompleted: (modelId, modelName, usage, p) =>
            this.recordCompletedRequest(modelId, modelName, usage, p.name),
          onStatusChanged: () => this._onDidChangeStatusSnapshot.fire(),
        });
        this.runtimes.set(profile.id, runtime);
      }
    }

    this._onDidChangeStatusSnapshot.fire();
  }

  public refreshModels(): void {
    this._onDidChangeLanguageModelChatInformation.fire();
  }

  public invalidateModelCache(profileId?: string): void {
    if (profileId) {
      this.runtimes.get(profileId)?.invalidateCache();
    } else {
      for (const runtime of this.runtimes.values()) {
        runtime.invalidateCache();
      }
    }
  }

  async provideLanguageModelChatInformation(
    options: { silent: boolean; configuration?: { readonly [key: string]: unknown } },
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    this.applyFrameworkConfiguration(options.configuration);

    const enabledProfiles = this.profileStore.getEnabledProfiles();
    if (enabledProfiles.length === 0) {
      return [];
    }

    const namespaceEnabled = enabledProfiles.length > 1;
    const allModels: vscode.LanguageModelChatInformation[] = [];
    const errors: Array<{ profile: Profile; error: string }> = [];

    await Promise.all(
      enabledProfiles.map(async (profile) => {
        const runtime = this.runtimes.get(profile.id);
        if (!runtime) {
          return;
        }

        const outcome = await runtime.catalog.getOrFetchModels(token);
        if (outcome.error) {
          errors.push({ profile, error: outcome.error });
        }

        for (const rawModel of outcome.models) {
          const exposedId = formatExposedModelId(profile.id, rawModel.id, namespaceEnabled);
          allModels.push({
            ...rawModel,
            id: exposedId,
            detail: profile.name,
            tooltip: `${rawModel.tooltip ? `${rawModel.tooltip}\n\n` : ''}**Provider Profile:** ${profile.name}`,
          });
        }
      })
    );

    if (!options.silent && errors.length > 0) {
      for (const { profile, error } of errors) {
        promptOpenSettings(
          `Routermod [${profile.name}]: Failed to fetch models. ${diagnoseModelFetchError(error)}`,
          (msg) => this.outputChannel.appendLine(msg)
        );
      }
    }

    // VS Code renders one picker row per entry keyed by `id`, so a duplicate
    // id (e.g. two enabled profiles pointed at the same server) would show the
    // same model twice. Collapse before handing the list over.
    const deduped = dedupeById(allModels);
    if (deduped.length !== allModels.length) {
      this.outputChannel.appendLine(
        `Collapsed ${allModels.length - deduped.length} duplicate model entry(ies) before exposing them to VS Code.`
      );
    }
    return deduped;
  }

  private applyFrameworkConfiguration(
    configuration: { readonly [key: string]: unknown } | undefined
  ): void {
    const next = readFrameworkConfiguration(configuration);
    let changed = false;

    if (next.apiKey !== undefined && next.apiKey !== this.frameworkOverride.apiKey) {
      this.frameworkOverride.apiKey = next.apiKey;
      changed = true;
    }
    if (next.serverUrl !== undefined && next.serverUrl !== this.frameworkOverride.serverUrl) {
      this.frameworkOverride.serverUrl = next.serverUrl;
      changed = true;
    }

    if (changed) {
      this.outputChannel.appendLine('Profile updated from VS Code framework configuration; reloading.');
      this.syncRuntimes();
      this.refreshModels();
    }
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const enabledProfiles = this.profileStore.getEnabledProfiles();
    const knownIds = enabledProfiles.map((p) => p.id);
    const defaultId = this.profileStore.getDefaultProfile().id;
    const target = parseModelTarget(model.id, knownIds, defaultId);

    const runtime = this.runtimes.get(target.profileId);
    if (!runtime) {
      throw new Error(`Routermod: Profile '${target.profileId}' not found or disabled.`);
    }

    const rawModel: vscode.LanguageModelChatInformation = {
      ...model,
      id: target.rawModelId,
    };

    return runtime.chatHandler.handle(rawModel, messages, options, progress, token);
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    if (typeof text === 'string') {
      return estimateTextTokens(text);
    }
    return countMessageTokens(text);
  }

  private recordCompletedRequest(
    modelId: string,
    modelName: string,
    usage: TokenUsage | undefined,
    profileName: string
  ): void {
    let next = recordRequest(this.sessionStats);
    if (usage) {
      next = accumulateUsage(next, usage);
    }
    this.sessionStats = next;
    this.lastRequest = {
      modelId,
      modelName,
      completedAt: Date.now(),
      profileName,
      ...(usage ? { usage } : {}),
    };
    this._onDidChangeStatusSnapshot.fire();
  }

  public showOutput(): void {
    this.outputChannel.show();
  }

  public getStatusSnapshot(): StatusSnapshot {
    const profiles = this.profileStore.getProfiles();
    const enabledProfiles = profiles.filter((p) => p.enabled);
    const namespaceEnabled = enabledProfiles.length > 1;

    const profileSummaries: ProfileSummary[] = [];
    const allModels: ModelSummary[] = [];

    let hasAnyError = false;
    let anyErrorMessage = '';
    let hasAnySuccess = false;
    let allEmpty = true;
    let anyLastSuccessAt: number | undefined;

    for (const profile of profiles) {
      const runtime = this.runtimes.get(profile.id);
      const cached = runtime?.catalog.getCachedModels() ?? [];
      const lastError = runtime?.catalog.getLastConnectionError();
      const lastSuccess = runtime?.catalog.getLastSuccessfulFetchAt();

      if (lastSuccess && (!anyLastSuccessAt || lastSuccess > anyLastSuccessAt)) {
        anyLastSuccessAt = lastSuccess;
      }
      if (cached.length > 0) {
        allEmpty = false;
      }
      if (lastError) {
        hasAnyError = true;
        anyErrorMessage = `[${profile.name}] ${lastError}`;
      } else if (lastSuccess) {
        hasAnySuccess = true;
      }

      let profileConnState: ConnectionState = 'unknown';
      if (lastError) {
        profileConnState = 'error';
      } else if (lastSuccess === undefined) {
        profileConnState = 'unknown';
      } else if (cached.length === 0) {
        profileConnState = 'noModels';
      } else {
        profileConnState = 'ok';
      }

      profileSummaries.push({
        id: profile.id,
        name: profile.name,
        serverUrl: profile.serverUrl,
        enabled: profile.enabled,
        modelCount: cached.length,
        connectionState: profileConnState,
        errorMessage: lastError,
      });

      if (profile.enabled) {
        for (const m of cached) {
          const totalContext = runtime?.catalog.getContextForModel(m.id);
          const exposedId = formatExposedModelId(profile.id, m.id, namespaceEnabled);
          allModels.push({
            id: exposedId,
            name: namespaceEnabled ? `${profile.name} / ${m.name}` : m.name,
            contextLabel: formatContextLabel(totalContext),
            ...(totalContext !== undefined ? { totalContext } : {}),
            capabilityLabels: formatCapabilityLabels(m.capabilities ?? {}),
          });
        }
      }
    }

    let overallState: ConnectionState = 'unknown';    if (hasAnyError && !hasAnySuccess) {
      overallState = 'error';
    } else if (hasAnySuccess && allEmpty) {
      overallState = 'noModels';
    } else if (hasAnySuccess) {
      overallState = 'ok';
    }

    const defaultProfile = this.profileStore.getDefaultProfile();
    const defaultRuntime = this.runtimes.get(defaultProfile.id);
    const globalConfig = defaultRuntime
      ? defaultRuntime.getConfig()
      : this.configService.loadForProfile(defaultProfile);

    const snapshot: StatusSnapshot = {
      host:
        profiles.length === 1
          ? defaultProfile.serverUrl
          : `${enabledProfiles.length} provider(s)`,
      connection: {
        state: overallState,
        errorMessage: anyErrorMessage || undefined,
      },
      ...(anyLastSuccessAt !== undefined ? { lastSuccessfulFetchAt: anyLastSuccessAt } : {}),
      profiles: profileSummaries,
      models: dedupeById(allModels),
      sessionStats: this.sessionStats,
      ...(this.lastRequest ? { lastRequest: this.lastRequest } : {}),
      features: {
        toolCalling: globalConfig.enableToolCalling,
        imageInput: globalConfig.enableImageInput,
        parallelToolCalling: globalConfig.parallelToolCalling,
        inlineCompletion: globalConfig.enableInlineCompletion,
        inlineCompletionModel: globalConfig.inlineCompletionModel,
        agentTemperature: globalConfig.agentTemperature,
      },
      now: Date.now(),
    };
    return snapshot;
  }

  public isInlineCompletionEnabled(): boolean {
    const defaultProfile = this.profileStore.getDefaultProfile();
    const runtime = this.runtimes.get(defaultProfile.id);
    return runtime?.getConfig().enableInlineCompletion ?? false;
  }

  public getInlineCompletionDebounceMs(): number {
    const defaultProfile = this.profileStore.getDefaultProfile();
    const runtime = this.runtimes.get(defaultProfile.id);
    return runtime?.getConfig().inlineCompletionDebounce ?? 300;
  }

  public async provideInlineCompletion(
    textBefore: string,
    textAfter: string,
    token: vscode.CancellationToken
  ): Promise<string | undefined> {
    const defaultProfile = this.profileStore.getDefaultProfile();
    const defaultRuntime = this.runtimes.get(defaultProfile.id);
    const targetProfileId = defaultRuntime?.getConfig().inlineCompletionProvider?.trim();

    let runtime: ProfileRuntime | undefined;
    if (targetProfileId) {
      runtime = this.runtimes.get(targetProfileId);
    }
    if (!runtime) {
      const firstEnabled = this.profileStore.getEnabledProfiles()[0];
      if (firstEnabled) {
        runtime = this.runtimes.get(firstEnabled.id);
      }
    }

    if (!runtime) {
      return undefined;
    }
    return runtime.inlineCompletions.provideCompletion(textBefore, textAfter, token);
  }
}
