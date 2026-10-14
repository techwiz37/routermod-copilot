/**
 * Migrates existing single-provider configuration (settings + legacy secrets)
 * into the unified multi-profile SecretStorage blob.
 *
 * Keeps legacy settings working transparently on upgrade:
 * 1. Read existing SecretStorage keys (SECRET_KEYS.apiKey, SECRET_KEYS.customHeaders).
 * 2. Read existing workspace setting (`routermod-for-github-copilot.serverUrl`).
 * 3. If any values exist and no profile blob exists yet, initialize the 'default'
 *    profile with these values.
 * 4. Also runs the older plain-text settings -> legacy secret keys migration
 *    first so users upgrading from very old versions don't lose anything.
 */

import {
    LegacyConfigAccessor,
    SECRET_KEYS,
    SecretAccessor,
    migrateLegacySecrets,
    parseCustomHeadersJson,
} from '../config/secretMigration';
import {
    DEFAULT_PROFILE_ID,
    DEFAULT_PROFILE_NAME,
    DEFAULT_PROFILE_URL,
    PROFILES_SECRET_KEY,
    Profile,
} from './profileTypes';

export interface ProfileMigrationResult {
    migrated: boolean;
    profileCreated?: Profile;
}

/**
 * Perform end-to-end migration into the profiles secret blob.
 * Pure-ish: uses SecretAccessor and LegacyConfigAccessor interfaces for unit testability.
 */
export async function migrateToProfiles(
    config: LegacyConfigAccessor,
    secrets: SecretAccessor,
    log: (msg: string) => void = () => { /* no-op */ }
): Promise<ProfileMigrationResult> {
    const existingBlob = await secrets.get(PROFILES_SECRET_KEY);
    if (existingBlob) {
        return { migrated: false };
    }

    try {
        await migrateLegacySecrets(config, secrets, log);
    } catch (error) {
        log(`Warning: legacy secret migration step encountered an error: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Step 2: Harvest legacy values
    const legacyApiKey = (await secrets.get(SECRET_KEYS.apiKey)) ?? '';
    const legacyHeadersRaw = await secrets.get(SECRET_KEYS.customHeaders);
    const legacyHeaders = parseCustomHeadersJson(legacyHeadersRaw, log);
    const legacyServerUrl = config.get<string>('serverUrl', DEFAULT_PROFILE_URL);

    const defaultProfile: Profile = {
        id: DEFAULT_PROFILE_ID,
        name: DEFAULT_PROFILE_NAME,
        serverUrl: legacyServerUrl.trim() || DEFAULT_PROFILE_URL,
        apiKey: legacyApiKey.trim(),
        customHeaders: legacyHeaders,
        enabled: true,
        createdAt: Date.now(),
    };

    await secrets.store(PROFILES_SECRET_KEY, JSON.stringify([defaultProfile]));
    log(`Migrated legacy server configuration to default profile (${defaultProfile.serverUrl}).`);

    // Clean up legacy secret entries now that they are captured in the profile
    try {
        await secrets.delete(SECRET_KEYS.apiKey);
        await secrets.delete(SECRET_KEYS.customHeaders);
    } catch {
        // Non-fatal if delete fails
    }

    return { migrated: true, profileCreated: defaultProfile };
}
