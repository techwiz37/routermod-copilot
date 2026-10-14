/**
 * Store and in-memory cache for profiles backed by VS Code's SecretStorage.
 *
 * Why store all profiles in SecretStorage instead of splitting between settings and secrets?
 * 1. Profiles contain sensitive data (apiKey, auth customHeaders) alongside URLs and names.
 * 2. Storing the whole array as one JSON blob in SecretStorage avoids split-brain updates
 *    and prevents orphaned secret keys (since SecretStorage does not have a "list keys" API).
 * 3. Atomic reads and writes: updating a profile saves URL and token simultaneously.
 */

import * as vscode from 'vscode';
import {
  DEFAULT_PROFILE_ID,
  DEFAULT_PROFILE_NAME,
  DEFAULT_PROFILE_URL,
  PROFILES_SECRET_KEY,
  Profile,
  ProfileDraft,
  createDefaultProfile,
  slugifyProfileName,
} from './profileTypes';
import { migrateToProfiles } from './profileMigration';
import { LegacyConfigAccessor } from '../config/secretMigration';

interface ProfileStoreDeps {
  log: (message: string) => void;
  onDidUpdate: () => void;
}

export class ProfileStore {
  private profiles: Profile[] = [];

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly deps: ProfileStoreDeps
  ) {}

  public getProfiles(): readonly Profile[] {
    return this.profiles;
  }

  public getEnabledProfiles(): readonly Profile[] {
    return this.profiles.filter((p) => p.enabled);
  }

  public getProfile(id: string): Profile | undefined {
    return this.profiles.find((p) => p.id === id);
  }

  public getDefaultProfile(): Profile {
    return (
      this.profiles.find((p) => p.id === DEFAULT_PROFILE_ID) ??
      this.profiles[0] ??
      createDefaultProfile()
    );
  }

  /**
   * Load profiles from SecretStorage, running migration if first-time run.
   */
  public async load(): Promise<void> {
    try {
      await migrateToProfiles(this.legacyConfigAccessor(), this.secrets, this.deps.log);
    } catch (error) {
      this.deps.log(
        `Failed during profile migration: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    await this.refreshCache();
  }

  /**
   * Re-read the secret blob and update memory cache.
   */
  public async refreshCache(): Promise<void> {
    const raw = await this.secrets.get(PROFILES_SECRET_KEY);
    if (!raw) {
      this.profiles = [createDefaultProfile()];
      await this.persist();
      this.deps.onDidUpdate();
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      const valid = Array.isArray(parsed) ? parsed.filter(isValidProfile) : [];
      this.profiles = valid.length > 0 ? valid : [createDefaultProfile()];
    } catch (error) {
      this.deps.log(
        `Failed to parse profiles blob: ${error instanceof Error ? error.message : String(error)}`
      );
      if (this.profiles.length === 0) {
        this.profiles = [createDefaultProfile()];
      }
    }

    this.deps.onDidUpdate();
  }

  /**
   * Check if a SecretStorage key belongs to profile management.
   */
  public ownsSecretKey(key: string): boolean {
    return key === PROFILES_SECRET_KEY;
  }

  /**
   * Save a new profile or update an existing one.
   */
  public async saveProfile(draft: ProfileDraft): Promise<Profile> {
    const existing = draft.id ? this.getProfile(draft.id) : undefined;
    let finalId = draft.id;

    if (!finalId) {
      // Generate unique ID from name
      const baseSlug = slugifyProfileName(draft.name);
      finalId = baseSlug;
      let counter = 1;
      while (this.profiles.some((p) => p.id === finalId)) {
        finalId = `${baseSlug}-${counter++}`;
      }
    }

    const updated: Profile = {
      id: finalId,
      name: draft.name.trim() || DEFAULT_PROFILE_NAME,
      serverUrl: draft.serverUrl.trim() || DEFAULT_PROFILE_URL,
      apiKey: draft.apiKey !== undefined ? draft.apiKey.trim() : existing?.apiKey ?? '',
      customHeaders: draft.customHeaders ?? existing?.customHeaders ?? {},
      enabled: draft.enabled ?? existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? Date.now(),
    };

    const index = this.profiles.findIndex((p) => p.id === finalId);
    if (index >= 0) {
      this.profiles[index] = updated;
    } else {
      this.profiles.push(updated);
    }

    await this.persist();
    this.deps.onDidUpdate();
    return updated;
  }

  /**
   * Delete a profile by ID. Prevents deleting if it is the only profile.
   */
  public async deleteProfile(id: string): Promise<boolean> {
    if (this.profiles.length <= 1) {
      return false;
    }
    const prevLen = this.profiles.length;
    this.profiles = this.profiles.filter((p) => p.id !== id);
    if (this.profiles.length !== prevLen) {
      await this.persist();
      this.deps.onDidUpdate();
      return true;
    }
    return false;
  }

  /**
   * Toggle enabled state of a profile.
   */
  public async setProfileEnabled(id: string, enabled: boolean): Promise<void> {
    const profile = this.getProfile(id);
    if (profile) {
      await this.saveProfile({ ...profile, enabled });
    }
  }

  /**
   * Update API key for a specific profile.
   */
  public async setApiKey(profileId: string, apiKey: string): Promise<void> {
    const profile = this.getProfile(profileId) ?? this.getDefaultProfile();
    await this.saveProfile({ ...profile, apiKey });
  }

  /**
   * Update custom headers for a specific profile.
   */
  public async setCustomHeaders(
    profileId: string,
    customHeaders: Record<string, string>
  ): Promise<void> {
    const profile = this.getProfile(profileId) ?? this.getDefaultProfile();
    await this.saveProfile({ ...profile, customHeaders });
  }

  private async persist(): Promise<void> {
    await this.secrets.store(PROFILES_SECRET_KEY, JSON.stringify(this.profiles));
  }

  private legacyConfigAccessor(): LegacyConfigAccessor {
    const config = vscode.workspace.getConfiguration('routermod-for-github-copilot');
    return {
      get: <T>(section: string, defaultValue: T): T => config.get<T>(section, defaultValue),
      inspect: <T>(section: string) => {
        const inspection = config.inspect<T>(section);
        if (!inspection) {
          return undefined;
        }
        return {
          workspaceValue: inspection.workspaceValue,
          globalValue: inspection.globalValue,
        };
      },
      update: (section: string, value: unknown, target: number) =>
        config.update(
          section,
          value,
          target as vscode.ConfigurationTarget
        ),
    };
  }
}

function isValidProfile(item: unknown): item is Profile {
  if (!item || typeof item !== 'object') {
    return false;
  }
  const p = item as Partial<Profile>;
  return (
    typeof p.id === 'string' &&
    p.id.length > 0 &&
    typeof p.name === 'string' &&
    typeof p.serverUrl === 'string'
  );
}
