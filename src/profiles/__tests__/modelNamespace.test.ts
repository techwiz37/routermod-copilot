import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatExposedModelId,
  dedupeById,
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

describe('dedupeById', () => {
  test('keeps the first occurrence and preserves order', () => {
    const models = [
      { id: 'a', name: 'First A' },
      { id: 'b', name: 'B' },
      { id: 'a', name: 'Second A' },
    ];
    assert.deepEqual(dedupeById(models), [
      { id: 'a', name: 'First A' },
      { id: 'b', name: 'B' },
    ]);
  });

  test('returns the input untouched when all ids are unique', () => {
    const models = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    assert.deepEqual(dedupeById(models), models);
  });

  test('collapses the same raw model exposed under two profiles', () => {
    const models = [
      { id: 'local/claude-opus-4-5' },
      { id: 'cloud/claude-opus-4-5' },
      { id: 'local/claude-opus-4-5' },
    ];
    assert.deepEqual(dedupeById(models), [
      { id: 'local/claude-opus-4-5' },
      { id: 'cloud/claude-opus-4-5' },
    ]);
  });

  test('drops entries with an empty/missing id', () => {
    const models = [{ id: '' }, { id: 'a' }, {}];
    assert.deepEqual(dedupeById(models), [{ id: 'a' }]);
  });

  test('accepts a custom key selector for other shapes', () => {
    const entries = [
      { exposedId: 'x', label: 'X' },
      { exposedId: 'x', label: 'X again' },
      { exposedId: 'y', label: 'Y' },
    ];
    assert.deepEqual(dedupeById(entries, (e) => e.exposedId), [
      { exposedId: 'x', label: 'X' },
      { exposedId: 'y', label: 'Y' },
    ]);
  });

  test('handles an empty list', () => {
    assert.deepEqual(dedupeById([]), []);
  });
});
