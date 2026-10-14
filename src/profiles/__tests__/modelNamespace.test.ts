import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatExposedModelId,
  parseModelTarget,
} from '../modelNamespace';

describe('formatExposedModelId', () => {
  test('returns raw ID when namespaceEnabled is false (single provider)', () => {
    assert.equal(
      formatExposedModelId('default', 'qwen2.5-coder-32b', false),
      'qwen2.5-coder-32b'
    );
  });

  test('namespaces ID as profileId/rawModelId when namespaceEnabled is true (multiple providers)', () => {
    assert.equal(
      formatExposedModelId('ollama-local', 'deepseek-r1:14b', true),
      'ollama-local/deepseek-r1:14b'
    );
    assert.equal(
      formatExposedModelId('cloud-routermod', 'gpt-4o', true),
      'cloud-routermod/gpt-4o'
    );
  });
});

describe('parseModelTarget', () => {
  const knownProfiles = ['default', 'ollama-local', 'cloud-routermod'];

  test('parses namespaced model ID matching a known profile', () => {
    const result = parseModelTarget('ollama-local/qwen2.5-coder', knownProfiles, 'default');
    assert.deepEqual(result, {
      profileId: 'ollama-local',
      rawModelId: 'qwen2.5-coder',
    });
  });

  test('handles model IDs containing additional slashes', () => {
    const result = parseModelTarget('cloud-routermod/meta-llama/Llama-3-70b', knownProfiles, 'default');
    assert.deepEqual(result, {
      profileId: 'cloud-routermod',
      rawModelId: 'meta-llama/Llama-3-70b',
    });
  });

  test('falls back to default profile when model ID is not namespaced', () => {
    const result = parseModelTarget('qwen2.5-coder-32b', knownProfiles, 'default');
    assert.deepEqual(result, {
      profileId: 'default',
      rawModelId: 'qwen2.5-coder-32b',
    });
  });

  test('falls back when prefix does not match any known profile', () => {
    const result = parseModelTarget('unknown-provider/model-x', knownProfiles, 'default');
    assert.deepEqual(result, {
      profileId: 'default',
      rawModelId: 'unknown-provider/model-x',
    });
  });

  test('uses first known profile if specified fallback is not in list', () => {
    const result = parseModelTarget('some-model', ['custom-profile'], 'default');
    assert.deepEqual(result, {
      profileId: 'custom-profile',
      rawModelId: 'some-model',
    });
  });
});
