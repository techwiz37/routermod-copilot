import * as vscode from 'vscode';
import { GatewayProvider } from '../provider/gatewayProvider';
import { StatusBarManager } from '../status/statusBarManager';
import { manageProvidersFlow, addProviderFlow, pickProvider } from './manageProviders';
import { editProfileCustomHeadersFlow } from './customHeaders';

/**
 * Register user-facing commands contributed by the extension.
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  provider: GatewayProvider,
  statusManager: StatusBarManager,
  refreshStatusBar: () => Promise<void>
): void {
  const store = provider.getProfileStore();

  context.subscriptions.push(
    // Tooltip's "Show output log" link
    vscode.commands.registerCommand('routermod-for-github-copilot.showOutput', () =>
      provider.showOutput()
    ),

    // "Manage Providers" command — triggered by the
    // "Add Models..." dropdown via the managementCommand contribution,
    // or from the command palette.
    vscode.commands.registerCommand('routermod-for-github-copilot.manage', () =>
      manageProvidersFlow(provider, refreshStatusBar)
    ),

    // Direct command to add a new provider profile
    vscode.commands.registerCommand('routermod-for-github-copilot.addProvider', () =>
      addProviderFlow(store, provider, refreshStatusBar)
    ),

    // Test Connection:
    // If >1 profiles, ask which provider to test (or All).
    // If 1 profile, test immediately.
    vscode.commands.registerCommand(
      'routermod-for-github-copilot.testConnection',
      async () => {
        const selection = await pickProvider(store, 'Routermod: Test Connection', true);
        if (!selection) {
          return;
        }

        const cts = new vscode.CancellationTokenSource();
        try {
          if (selection === 'ALL') {
            const models = await provider.provideLanguageModelChatInformation(
              { silent: false },
              cts.token
            );
            if (models.length > 0) {
              statusManager.setIdle(models.map((m) => m.id));
              vscode.window.showInformationMessage(
                `Routermod: All providers connected! Found ${models.length} model(s).`
              );
            } else {
              statusManager.setNoModels();
              vscode.window.showWarningMessage('Routermod: Connected, but no models found.');
            }
          } else {
            // Test single profile
            provider.invalidateModelCache(selection.id);
            const models = await provider.provideLanguageModelChatInformation(
              { silent: false },
              cts.token
            );
            const profileModels = models.filter((m) => m.detail === selection.name);
            if (profileModels.length > 0) {
              vscode.window.showInformationMessage(
                `Routermod [${selection.name}]: Connected! Found ${profileModels.length} model(s): ${profileModels.map((m) => m.name).join(', ')}`
              );
            } else {
              vscode.window.showWarningMessage(
                `Routermod [${selection.name}]: Connected, but no models reported.`
              );
            }
          }
          await refreshStatusBar();
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          statusManager.setError(msg);
          vscode.window.showErrorMessage(`Routermod: Connection test failed. ${msg}`);
        } finally {
          cts.dispose();
        }
      }
    ),

    // Refresh Models:
    // If >1 profiles, ask which provider to refresh (or All).
    // If 1 profile, refresh immediately.
    vscode.commands.registerCommand(
      'routermod-for-github-copilot.refreshModels',
      async () => {
        const selection = await pickProvider(store, 'Routermod: Refresh Models', true);
        if (!selection) {
          return;
        }

        provider.invalidateModelCache(selection === 'ALL' ? undefined : selection.id);

        provider.refreshModels();
        await refreshStatusBar();
        const targetLabel = selection === 'ALL' ? 'all providers' : selection.name;
        vscode.window.setStatusBarMessage(`Routermod: Refreshed models for ${targetLabel}.`, 3000);
      }
    ),

    // Edit Custom Headers:
    // If >1 profiles, prompt to pick which provider.
    // If 1 profile, open editor directly.
    vscode.commands.registerCommand(
      'routermod-for-github-copilot.editCustomHeaders',
      async () => {
        const target = await pickProvider(store, 'Routermod: Edit Custom Headers', false);
        if (!target || target === 'ALL') {
          return;
        }

        await editProfileCustomHeadersFlow(store, target);
        provider.invalidateModelCache(target.id);
        provider.refreshModels();
        await refreshStatusBar();
      }
    ),

    // Select Inline Completion Model from fetched models
    vscode.commands.registerCommand(
      'routermod-for-github-copilot.selectInlineCompletionModel',
      async () => {
        const cts = new vscode.CancellationTokenSource();
        let models: vscode.LanguageModelChatInformation[];
        try {
          models = await provider.provideLanguageModelChatInformation(
            { silent: false },
            cts.token
          );
        } finally {
          cts.dispose();
        }

        if (models.length === 0) {
          vscode.window.showWarningMessage(
            'Routermod: No models available to select for inline completions.'
          );
          return;
        }

        const items = [
          {
            label: '$(sparkle) Default (First available model)',
            description: 'Automatically pick the first model from the active server',
            modelId: '',
          },
          ...models.map((m) => ({
            label: m.name || m.id,
            description: m.detail ? `(${m.detail})` : m.id,
            detail: m.id,
            modelId: m.id,
          })),
        ];

        const selected = await vscode.window.showQuickPick(items, {
          title: 'Routermod: Select Inline Completion Model',
          placeHolder: 'Choose a model for ghost-text code completions',
        });

        if (selected === undefined) {
          return;
        }

        const config = vscode.workspace.getConfiguration('routermod-for-github-copilot');
        await config.update(
          'inlineCompletionModel',
          selected.modelId,
          vscode.ConfigurationTarget.Global
        );

        const targetDesc = selected.modelId || 'Default (first available)';
        vscode.window.showInformationMessage(
          `Routermod: Inline completion model set to: ${targetDesc}`
        );
        await refreshStatusBar();
      }
    )
  );
}
