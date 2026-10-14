import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  VENDOR_ID,
  hasChatLanguageModelsGroups,
  getChatLanguageModelsGroupsForVendor,
  getChatLanguageModelsPath,
} from '../groupSync';

describe('groupSync', () => {
  it('identifies vendor id correctly', () => {
    assert.strictEqual(VENDOR_ID, 'routermod-github-copilot');
  });

  it('locates user config path', () => {
    const configPath = getChatLanguageModelsPath();
    assert.ok(configPath.includes('chatLanguageModels.json'));
  });

  it('checks hasChatLanguageModelsGroups without crashing', () => {
    const hasGroups = hasChatLanguageModelsGroups();
    assert.strictEqual(typeof hasGroups, 'boolean');
  });

  it('retrieves group names without crashing', () => {
    const groups = getChatLanguageModelsGroupsForVendor();
    assert.ok(Array.isArray(groups));
  });
});
