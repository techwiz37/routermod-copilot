import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeModels,
  describeModel,
  friendlyModelName,
  inferModelFamily,
  parseModelId,
} from '../modelDisplay';

describe('parseModelId', () => {
  test('splits provider and model part', () => {
    const parsed = parseModelId('ocg/deepseek-v4-pro');
    assert.equal(parsed.provider, 'ocg');
    assert.equal(parsed.modelPart, 'deepseek-v4-pro');
  });

  test('no slash — no provider', () => {
    const parsed = parseModelId('gpt-4o-mini');
    assert.equal(parsed.provider, undefined);
    assert.equal(parsed.modelPart, 'gpt-4o-mini');
  });

  test('produces title-cased display name with provider', () => {
    assert.equal(
      parseModelId('cx/gpt-5.6-sol').displayName,
      'Gpt 5.6 Sol (cx)'
    );
    assert.equal(
      parseModelId('ocg/deepseek-v4-pro').displayName,
      'Deepseek V4 Pro (ocg)'
    );
  });
});

describe('friendlyModelName', () => {
  test('pretty-prints gateway-style IDs with provider', () => {
    assert.equal(friendlyModelName('cx/gpt-5.6-sol'), 'Gpt 5.6 Sol (cx)');
    assert.equal(friendlyModelName('ocg/deepseek-v4-pro'), 'Deepseek V4 Pro (ocg)');
  });

  test('pretty-prints Hugging-Face org prefix with provider', () => {
    assert.equal(friendlyModelName('Qwen/Qwen3-8B'), 'Qwen3 8B (Qwen)');
    assert.equal(friendlyModelName('meta-llama/Llama-3.1-8B-Instruct'), 'Llama 3.1 8B Instruct (meta-llama)');
  });

  test('pretty-prints slashless IDs in title case', () => {
    assert.equal(friendlyModelName('gpt-4o-mini'), 'Gpt 4o Mini');
  });

  test('handles trailing slash without breaking', () => {
    const parsed = parseModelId('foo/');
    assert.equal(parsed.provider, undefined);
    assert.equal(parsed.modelPart, 'foo/');
  });
});

describe('inferModelFamily', () => {
  test('detects known families', () => {
    assert.equal(inferModelFamily('Qwen/Qwen3-8B'), 'qwen');
    assert.equal(inferModelFamily('meta-llama/Llama-3.1-8B-Instruct'), 'llama');
    assert.equal(inferModelFamily('mistralai/Mistral-7B'), 'mistral');
    assert.equal(inferModelFamily('deepseek-ai/DeepSeek-V3'), 'deepseek');
  });

  test('falls back to routermod for unknown models', () => {
    assert.equal(inferModelFamily('unknown-vendor/UnknownModel'), 'routermod');
  });
});

describe('describeModel', () => {
  test('uses max_model_len when present', () => {
    const detail = describeModel({
      id: 'x', object: 'model', created: 0, owned_by: 'vllm', max_model_len: 32768,
    });
    assert.ok(detail.includes('33K ctx'));
    assert.ok(detail.includes('vllm'));
  });

  test('falls back to context_length', () => {
    const detail = describeModel({
      id: 'x', object: 'model', created: 0, owned_by: 'ollama', context_length: 8192,
    });
    assert.ok(detail.includes('8K ctx'));
  });

  test('omits context when no size is reported', () => {
    const detail = describeModel({ id: 'x', object: 'model', created: 0, owned_by: 'whoever' });
    assert.ok(!detail.includes('ctx'));
    assert.ok(detail.includes('whoever'));
  });
});

describe('dedupeModels', () => {
  test('removes duplicate ids, preserving first-seen order', () => {
    const models = [
      { id: 'a', object: 'model', created: 0, owned_by: 'x' },
      { id: 'b', object: 'model', created: 0, owned_by: 'x' },
      { id: 'a', object: 'model', created: 0, owned_by: 'y' },
    ];
    const result = dedupeModels(models);
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((m) => m.id), ['a', 'b']);
  });

  test('returns the same list when all ids are unique', () => {
    const models = [
      { id: 'a', object: 'model', created: 0, owned_by: 'x' },
      { id: 'b', object: 'model', created: 0, owned_by: 'x' },
    ];
    const result = dedupeModels(models);
    assert.equal(result.length, 2);
  });
});
