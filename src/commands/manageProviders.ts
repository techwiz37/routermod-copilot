/**
 * Interactive management commands for Routermod profiles.
 *
 * Provides flows for:
 * - Add Provider (name, serverUrl, apiKey, customHeaders)
 * - Manage Providers (quick-pick hub to list, inspect, edit, toggle, delete)
 * - Pick Provider helper (for commands when > 1 profile is configured)
 */

import * as vscode from 'vscode';
import { GatewayProvider } from '../provider/gatewayProvider';
import { ProfileStore } from '../profiles/profileStore';
import { Profile, ProfileDraft, DEFAULT_PROFILE_NAME, DEFAULT_PROFILE_URL } from '../profiles/profileTypes';
import { editProfileCustomHeadersFlow } from './customHeaders';

interface ProviderQuickPickItem extends vscode.QuickPickItem {
  action: 'add' | 'select' | 'refresh' | 'openSettings';
  profile?: Profile;
}

/**
 * Main management flow, registered as `routermod-for-github-copilot.manage`
 * (called from VS Code's "Add Models..." dropdown or command palette).
 */
export async function manageProvidersFlow(
  provider: GatewayProvider,
  refreshStatusBar: () => Promise<void>
): Promise<void> {
  const store = provider.getProfileStore();

  while (true) {
    const profiles = store.getProfiles();
    const snapshot = provider.getStatusSnapshot();

    const items: ProviderQuickPickItem[] = [
      {
        label: '$(add) Add Provider...',
        description: 'Connect a new OpenAI-compatible inference server',
        action: 'add',
      },
      {
        label: '$(sync) Refresh All Models',
        description: 'Reload model catalogs from all active servers',
        action: 'refresh',
      },
      {
        label: '',
        kind: vscode.QuickPickItemKind.Separator,
        action: 'openSettings',
      },
    ];

    for (const p of profiles) {
      const summary = snapshot.profiles?.find((s) => s.id === p.id);
      let stateIcon = '$(vm-active)';
      let statusInfo = '';

      if (!p.enabled) {
        stateIcon = '$(circle-slash)';
        statusInfo = ' · (disabled)';
      } else if (summary?.errorMessage) {
        stateIcon = '$(error)';
        statusInfo = ` · Error: ${summary.errorMessage}`;
      } else if (summary && summary.modelCount > 0) {
        stateIcon = '$(check)';
        statusInfo = ` · ${summary.modelCount} model(s)`;
      } else if (summary?.connectionState === 'noModels') {
        stateIcon = '$(warning)';
        statusInfo = ' · 0 models';
      }

      const feats = summary?.features;
      const featBadges: string[] = [];
      if (feats?.toolCalling) {
        featBadges.push('tools');
      }
      if (feats?.imageInput) {
        featBadges.push('vision');
      }
      if (feats?.inlineCompletion) {
        featBadges.push('inline');
      }
      const featInfo = featBadges.length > 0 ? ` · [${featBadges.join(', ')}]` : '';

      const headerCount = Object.keys(p.customHeaders ?? {}).length;
      const headersInfo = headerCount > 0 ? ` · ${headerCount} header(s)` : '';
      items.push({
        label: `${stateIcon} ${p.name}`,
        description: `${p.serverUrl}${statusInfo}${featInfo}${headersInfo}`,
        action: 'select',
        profile: p,
      });
    }

    items.push(
      {
        label: '',
        kind: vscode.QuickPickItemKind.Separator,
        action: 'openSettings',
      },
      {
        label: '$(gear) Extension Settings...',
        description: 'Timeouts, token budgets, tool calling, perModelOptions',
        action: 'openSettings',
      }
    );

    const pick = await vscode.window.showQuickPick(items, {
      title: 'Routermod — Manage Providers',
      placeHolder: 'Select a provider to edit, or add a new one',
      ignoreFocusOut: true,
    });

    if (!pick) {
      return;
    }

    if (pick.action === 'add') {
      await addProviderFlow(store, provider, refreshStatusBar);
    } else if (pick.action === 'refresh') {
      provider.refreshModels();
      await refreshStatusBar();
      vscode.window.setStatusBarMessage('Routermod: Refreshed all provider model catalogs.', 3000);
    } else if (pick.action === 'openSettings') {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'routermod-for-github-copilot'
      );
      return;
    } else if (pick.action === 'select' && pick.profile) {
      const shouldContinue = await editProviderFlow(
        pick.profile,
        store,
        provider,
        refreshStatusBar
      );
      if (!shouldContinue) {
        return;
      }
    }
  }
}

/**
 * Add a new provider profile wizard.
 */
export async function addProviderFlow(
  store: ProfileStore,
  provider: GatewayProvider,
  refreshStatusBar: () => Promise<void>
): Promise<Profile | undefined> {
  const name = await vscode.window.showInputBox({
    title: 'Routermod — Provider Name',
    prompt: 'Enter a friendly display name for this provider (e.g. Local Ollama, Cloud vLLM)',
    placeHolder: DEFAULT_PROFILE_NAME,
    value: '',
    ignoreFocusOut: true,
    validateInput: (val) => (val.trim().length === 0 ? 'Name cannot be empty' : undefined),
  });
  if (!name) {
    return undefined;
  }

  const serverUrl = await vscode.window.showInputBox({
    title: `Routermod [${name.trim()}] — Server URL`,
    prompt: 'Enter the inference server URL (OpenAI-compatible endpoint)',
    value: DEFAULT_PROFILE_URL,
    placeHolder: DEFAULT_PROFILE_URL,
    ignoreFocusOut: true,
    validateInput: (value) => URL.canParse(value) ? undefined : 'Please enter a valid URL',
  });
  if (!serverUrl) {
    return undefined;
  }

  const apiKey = await vscode.window.showInputBox({
    title: `Routermod [${name.trim()}] — API Key`,
    prompt: "Enter the API key / token — saved to VS Code's secret storage (leave empty for local servers)",
    password: true,
    placeHolder: 'Optional',
    ignoreFocusOut: true,
  });
  if (apiKey === undefined) {
    return undefined;
  }

  const draft: ProfileDraft = {
    name: name.trim(),
    serverUrl: serverUrl.trim(),
    apiKey: apiKey.trim(),
    enabled: true,
  };

  const created = await store.saveProfile(draft);
  provider.refreshModels();
  await refreshStatusBar();

  // Offer optional custom headers
  const configureHeaders = await vscode.window.showQuickPick(
    [
      { label: 'Finish', description: 'Provider ready to use' },
      { label: 'Add Custom Headers...', description: 'Add HTTP headers (e.g. Authorization, Anthropic-Version)' },
    ],
    {
      title: `Routermod — "${created.name}" created`,
      placeHolder: 'Add custom headers now?',
      ignoreFocusOut: true,
    }
  );

  if (configureHeaders?.label.startsWith('Add Custom Headers')) {
    await editProfileCustomHeadersFlow(store, created);
    provider.refreshModels();
    await refreshStatusBar();
  }

  vscode.window.showInformationMessage(`Routermod: Provider "${created.name}" added successfully.`);
  return created;
}

/**
 * Edit an existing provider profile.
 */
async function editProviderFlow(
  profile: Profile,
  store: ProfileStore,
  provider: GatewayProvider,
  refreshStatusBar: () => Promise<void>
): Promise<boolean> {
  const current = store.getProfile(profile.id) ?? profile;

  const actions = [
    { label: '$(plug) Test Connection', description: 'Check server reachability and models', action: 'test' },
    { label: '$(sync) Refresh Models', description: 'Invalidate cache and reload models', action: 'reload' },
    { label: '$(edit) Edit Name', action: 'name' },
    { label: '$(link) Edit Server URL', description: current.serverUrl, action: 'url' },
    { label: '$(key) Edit API Key', description: current.apiKey ? '••••••••' : '(none)', action: 'key' },
    {
      label: '$(list-unordered) Edit Custom Headers',
      description: `${Object.keys(current.customHeaders ?? {}).length} configured`,
      action: 'headers',
    },
    {
      label: current.enabled ? '$(circle-slash) Disable Provider' : '$(check) Enable Provider',
      description: current.enabled ? 'Hide models from picker' : 'Show models in picker',
      action: 'toggle',
    },
    { label: '$(trash) Delete Provider', action: 'delete' },
  ];

  const pick = await vscode.window.showQuickPick(actions, {
    title: `Routermod — Provider: ${current.name}`,
    placeHolder: 'Select an option to configure',
    ignoreFocusOut: true,
  });
  if (!pick) {
    return true;
  }

  if (pick.action === 'test') {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Routermod: Testing connection to "${current.name}"...`,
        cancellable: true,
      },
      async (_progress, token) => {
        const cts = new vscode.CancellationTokenSource();
        token.onCancellationRequested(() => cts.cancel());
        try {
          const runtime = provider.getRuntime(current.id);
          if (!runtime) {
            vscode.window.showErrorMessage(`Routermod: Runtime for "${current.name}" not found.`);
            return;
          }
          runtime.catalog.invalidateCache();
          const outcome = await runtime.catalog.getOrFetchModels(cts.token);
          if (outcome.error) {
            const action = await vscode.window.showErrorMessage(
              `Routermod [${current.name}]: Connection failed. ${outcome.error}`,
              'Edit Server URL',
              'Edit API Key'
            );
            if (action === 'Edit Server URL') {
              const nextUrl = await vscode.window.showInputBox({
                title: `Routermod [${current.name}] — Server URL`,
                value: current.serverUrl,
                ignoreFocusOut: true,
                validateInput: (v) => (URL.canParse(v) ? undefined : 'Please enter a valid URL'),
              });
              if (nextUrl) {
                await store.saveProfile({ ...current, serverUrl: nextUrl.trim() });
              }
            } else if (action === 'Edit API Key') {
              const nextKey = await vscode.window.showInputBox({
                title: `Routermod [${current.name}] — API Key`,
                prompt: 'Enter API key',
                password: true,
                ignoreFocusOut: true,
              });
              if (nextKey !== undefined) {
                await store.setApiKey(current.id, nextKey);
              }
            }
          } else {
            vscode.window.showInformationMessage(
              `Routermod [${current.name}]: Successfully connected! Found ${outcome.models.length} model(s).`
            );
          }
        } finally {
          cts.dispose();
        }
      }
    );
  } else if (pick.action === 'reload') {
    provider.invalidateModelCache(current.id);
    provider.refreshModels();
    await refreshStatusBar();
    vscode.window.setStatusBarMessage(`Routermod [${current.name}]: Models refreshed.`, 3000);
  } else if (pick.action === 'name') {
    const nextName = await vscode.window.showInputBox({
      title: 'Routermod — Rename Provider',
      value: current.name,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().length === 0 ? 'Name cannot be empty' : undefined),
    });
    if (nextName) {
      await store.saveProfile({ ...current, name: nextName.trim() });
    }
  } else if (pick.action === 'url') {
    const nextUrl = await vscode.window.showInputBox({
      title: `Routermod [${current.name}] — Server URL`,
      value: current.serverUrl,
      ignoreFocusOut: true,
      validateInput: (value) => URL.canParse(value) ? undefined : 'Please enter a valid URL',
    });
    if (nextUrl) {
      await store.saveProfile({ ...current, serverUrl: nextUrl.trim() });
    }
  } else if (pick.action === 'key') {
    const nextKey = await vscode.window.showInputBox({
      title: `Routermod [${current.name}] — API Key`,
      prompt: "Leave empty to clear stored API key",
      password: true,
      ignoreFocusOut: true,
    });
    if (nextKey !== undefined) {
      await store.setApiKey(current.id, nextKey);
    }
  } else if (pick.action === 'headers') {
    await editProfileCustomHeadersFlow(store, current);
  } else if (pick.action === 'toggle') {
    await store.setProfileEnabled(current.id, !current.enabled);
  } else if (pick.action === 'delete') {
    if (store.getProfiles().length <= 1) {
      vscode.window.showWarningMessage('Routermod: Cannot delete the only remaining provider profile.');
      return true;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Delete provider profile "${current.name}"?`,
      { modal: true },
      'Delete'
    );
    if (confirm === 'Delete') {
      await store.deleteProfile(current.id);
      vscode.window.showInformationMessage(`Routermod: Provider "${current.name}" deleted.`);
    }
  }

  provider.refreshModels();
  await refreshStatusBar();
  return true;
}

/**
 * Prompt user to select a provider profile.
 * - If 0 profiles: returns undefined.
 * - If 1 profile and !allowAll: automatically returns that profile without prompt.
 * - If >1 profiles: prompts with a QuickPick.
 */
export async function pickProvider(
  store: ProfileStore,
  title: string,
  allowAll = false
): Promise<Profile | 'ALL' | undefined> {
  const profiles = store.getProfiles();
  if (profiles.length === 0) {
    return undefined;
  }
  if (profiles.length === 1 && !allowAll) {
    return profiles[0];
  }

  interface PickItem extends vscode.QuickPickItem {
    target: Profile | 'ALL';
  }

  const items: PickItem[] = [];
  if (allowAll) {
    items.push({
      label: '$(layers) All Providers',
      description: `Test all ${profiles.length} provider(s)`,
      target: 'ALL',
    });
  }

  for (const p of profiles) {
    items.push({
      label: p.name,
      description: p.serverUrl,
      target: p,
    });
  }

  const selected = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: 'Select a provider',
    ignoreFocusOut: true,
  });

  return selected?.target;
}
