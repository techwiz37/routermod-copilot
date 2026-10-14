import * as vscode from 'vscode';
import { Profile } from '../profiles/profileTypes';
import { ProfileStore } from '../profiles/profileStore';

interface HeaderQuickPickItem extends vscode.QuickPickItem {
  action: 'add' | 'edit' | 'clear' | 'done';
  headerName?: string;
}

/**
 * Quick-pick driven editor for custom headers of a specific profile.
 * Shows only header names (not values) so peeking at someone else's screen
 * doesn't leak credentials, and supports add / edit / delete / clear-all.
 */
export async function editProfileCustomHeadersFlow(
  profileStore: ProfileStore,
  profile: Profile
): Promise<void> {
  while (true) {
    const currentProfile = profileStore.getProfile(profile.id) ?? profile;
    const headers = currentProfile.customHeaders ?? {};
    const headerNames = Object.keys(headers).sort((a, b) => a.localeCompare(b));
    const items = buildHeaderQuickPickItems(headerNames);

    const pick = await vscode.window.showQuickPick(items, {
      title: `Routermod [${currentProfile.name}] — Custom Headers (${headerNames.length})`,
      placeHolder:
        headerNames.length === 0
          ? 'No custom headers yet. Add one or close.'
          : 'Select a header to edit, or add a new one',
      ignoreFocusOut: true,
    });
    if (!pick || pick.action === 'done') {
      return;
    }

    if (pick.action === 'add') {
      await addHeader(profileStore, currentProfile, headers);
    } else if (pick.action === 'clear') {
      await confirmAndClearHeaders(profileStore, currentProfile, headerNames.length);
    } else if (pick.action === 'edit' && pick.headerName) {
      await editOrDeleteHeader(profileStore, currentProfile, headers, pick.headerName);
    }
  }
}

function buildHeaderQuickPickItems(headerNames: readonly string[]): HeaderQuickPickItem[] {
  const items: HeaderQuickPickItem[] = [
    { label: 'Done', description: 'Save and close', action: 'done' },
    { label: '$(add) Add header...', description: 'Add a new header', action: 'add' },
  ];
  if (headerNames.length === 0) {
    return items;
  }
  items.push(
    {
      label: '$(trash) Clear all headers',
      description: 'Remove every custom header',
      action: 'clear',
    },
    {
      label: '',
      kind: vscode.QuickPickItemKind.Separator,
      action: 'done',
    },
    ...headerNames.map<HeaderQuickPickItem>((name) => ({
      label: name,
      description: 'Edit or remove (value hidden)',
      action: 'edit',
      headerName: name,
    }))
  );
  return items;
}

async function confirmAndClearHeaders(
  profileStore: ProfileStore,
  profile: Profile,
  count: number
): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    `Remove all ${count} custom header(s) from "${profile.name}"?`,
    { modal: true },
    'Remove'
  );
  if (confirm === 'Remove') {
    await profileStore.setCustomHeaders(profile.id, {});
  }
}

async function addHeader(
  profileStore: ProfileStore,
  profile: Profile,
  current: Record<string, string>
): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: `Routermod [${profile.name}] — New header name`,
    prompt: 'e.g. Authorization, Anthropic-Version, HTTP-Referer',
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (value.trim().length === 0) {
        return 'Header name cannot be empty';
      }
      if (/[^\w-]/.test(value)) {
        return 'Header names typically only contain letters, digits, and dashes';
      }
      return undefined;
    },
  });
  if (!name) {
    return;
  }
  const value = await vscode.window.showInputBox({
    title: `Routermod [${profile.name}] — Value for ${name}`,
    prompt: "Saved to VS Code's secret storage",
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) {
    return;
  }
  await profileStore.setCustomHeaders(profile.id, {
    ...current,
    [name.trim()]: value,
  });
}

async function editOrDeleteHeader(
  profileStore: ProfileStore,
  profile: Profile,
  current: Record<string, string>,
  name: string
): Promise<void> {
  const action = await vscode.window.showQuickPick(
    [
      { label: 'Edit value', description: 'Replace the current value' },
      { label: 'Remove header', description: 'Delete this header entirely' },
    ],
    {
      title: `Routermod [${profile.name}] — ${name}`,
      placeHolder: 'Choose an action',
      ignoreFocusOut: true,
    }
  );
  if (!action) {
    return;
  }

  if (action.label === 'Remove header') {
    const next = { ...current };
    delete next[name];
    await profileStore.setCustomHeaders(profile.id, next);
  } else if (action.label === 'Edit value') {
    const value = await vscode.window.showInputBox({
      title: `Routermod [${profile.name}] — New value for ${name}`,
      prompt: "Saved to VS Code's secret storage",
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) {
      return;
    }
    await profileStore.setCustomHeaders(profile.id, {
      ...current,
      [name]: value,
    });
  }
}
