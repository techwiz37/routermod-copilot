/**
 * Synchronize Routermod profile groups with VS Code's `chatLanguageModels.json`.
 *
 * Why this is needed:
 * VS Code's "Manage Language Models" editor only creates separate table sections
 * and group headers when groups are listed in `chatLanguageModels.json` for that vendor.
 * Without entries in this file, VS Code groups all models under a single vendor row.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Profile } from './profileTypes';

export const VENDOR_ID = 'routermod-github-copilot';

/**
 * Locate VS Code user directory containing `chatLanguageModels.json`.
 */
export function getChatLanguageModelsPath(): string {
  const platform = process.platform;
  let userDir: string;
  if (platform === 'darwin') {
    userDir = path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User');
  } else if (platform === 'win32') {
    userDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Code', 'User');
  } else {
    userDir = path.join(os.homedir(), '.config', 'Code', 'User');
  }
  return path.join(userDir, 'chatLanguageModels.json');
}

interface ChatLanguageModelsGroup {
  name: string;
  vendor: string;
  profileId?: string;
  settings?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Check whether `chatLanguageModels.json` currently contains any groups for this vendor.
 */
export function hasChatLanguageModelsGroups(): boolean {
  try {
    const configPath = getChatLanguageModelsPath();
    if (!fs.existsSync(configPath)) {
      return false;
    }
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return false;
    }
    return parsed.some((g) => g && typeof g === 'object' && g.vendor === VENDOR_ID);
  } catch {
    return false;
  }
}

/**
 * Return the list of group names defined for this vendor in `chatLanguageModels.json`.
 */
export function getChatLanguageModelsGroupsForVendor(): string[] {
  try {
    const configPath = getChatLanguageModelsPath();
    if (!fs.existsSync(configPath)) {
      return [];
    }
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((g) => g && typeof g === 'object' && g.vendor === VENDOR_ID && typeof g.name === 'string')
      .map((g) => (g as { name: string }).name);
  } catch {
    return [];
  }
}

/**
 * Sync active profiles into `chatLanguageModels.json` so VS Code renders
 * each profile as its own section in Manage Language Models.
 */
export async function syncChatLanguageModelsGroups(
  profiles: readonly Profile[],
  log?: (msg: string) => void
): Promise<void> {
  try {
    const configPath = getChatLanguageModelsPath();
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      return;
    }

    let existing: ChatLanguageModelsGroup[] = [];
    if (fs.existsSync(configPath)) {
      try {
        const raw = await fs.promises.readFile(configPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          existing = parsed;
        }
      } catch {
        existing = [];
      }
    }

    // Keep all other vendors intact
    const otherVendors = existing.filter((g) => g.vendor !== VENDOR_ID);

    // Enabled profiles become our vendor's groups (keyed by profile.name without profileId)
    const enabledProfiles = profiles.filter((p) => p.enabled);

    const ourGroups: ChatLanguageModelsGroup[] = enabledProfiles.map((p) => {
      const match = existing.find(
        (g) => g.vendor === VENDOR_ID && (g.name === p.name || g.profileId === p.id)
      );
      return {
        name: p.name,
        vendor: VENDOR_ID,
        profileId: p.id,
        ...(match?.settings ? { settings: match.settings } : {}),
      };
    });

    const updated = [...otherVendors, ...ourGroups];

    // Check if there are actual changes before writing to avoid unnecessary re-triggers
    if (JSON.stringify(existing) !== JSON.stringify(updated)) {
      await fs.promises.writeFile(configPath, JSON.stringify(updated, null, '\t'), 'utf8');
      log?.(`Synced ${ourGroups.length} group(s) to chatLanguageModels.json.`);
    }
  } catch (error) {
    log?.(`Failed to sync chatLanguageModels.json: ${error instanceof Error ? error.message : String(error)}`);
  }
}
