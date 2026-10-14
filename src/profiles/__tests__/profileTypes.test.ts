import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultProfile,
  slugifyProfileName,
  DEFAULT_PROFILE_ID,
  DEFAULT_PROFILE_NAME,
  DEFAULT_PROFILE_URL,
} from '../profileTypes';

describe('slugifyProfileName', () => {
  test('converts friendly names to clean URL-safe slugs', () => {
    assert.equal(slugifyProfileName('Local Ollama'), 'local-ollama');
    assert.equal(slugifyProfileName('Routermod Cloud (US-East)'), 'routermod-cloud-us-east');
    assert.equal(slugifyProfileName('  My_Custom Server!  '), 'my-custom-server');
  });

  test('falls back to "profile" when input yields empty slug', () => {
    assert.equal(slugifyProfileName('   '), 'profile');
    assert.equal(slugifyProfileName('!!!###'), 'profile');
  });
});

describe('createDefaultProfile', () => {
  test('creates a valid default profile with standard defaults', () => {
    const profile = createDefaultProfile();
    assert.equal(profile.id, DEFAULT_PROFILE_ID);
    assert.equal(profile.name, DEFAULT_PROFILE_NAME);
    assert.equal(profile.serverUrl, DEFAULT_PROFILE_URL);
    assert.equal(profile.apiKey, '');
    assert.deepEqual(profile.customHeaders, {});
    assert.equal(profile.enabled, true);
    assert.ok(profile.createdAt > 0);
  });

  test('accepts partial overrides', () => {
    const profile = createDefaultProfile({
      id: 'custom-id',
      name: 'Custom Server',
      serverUrl: 'http://custom:8080/v1',
      apiKey: 'sk-test',
    });
    assert.equal(profile.id, 'custom-id');
    assert.equal(profile.name, 'Custom Server');
    assert.equal(profile.serverUrl, 'http://custom:8080/v1');
    assert.equal(profile.apiKey, 'sk-test');
    assert.equal(profile.enabled, true);
  });
});
