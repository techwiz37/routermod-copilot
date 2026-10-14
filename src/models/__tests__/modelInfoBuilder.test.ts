import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_DETAIL_LABEL,
  PROVIDER_MULTIPLIER_NUMERIC,
  REASONING_TIER_KEYWORDS,
  buildModelInfo,
  hasReasoningTierInName,
  splitModelSegments,
} from '../modelInfoBuilder';
import { TOKEN_CONSTANTS } from '../../chat/tokenBudget';
import { OpenAIModel } from '../../api/types';

function baseModel(overrides: Partial<OpenAIModel> = {}): OpenAIModel {
  return {
    id: 'qwen/Qwen3-8B',
    object: 'model',
    created: 0,
    owned_by: 'vllm',
    ...overrides,
  };
}

describe('buildModelInfo first-party look-and-feel fields', () => {
  test('sets detail to the provider label so the picker groups models', () => {
    const { info } = buildModelInfo({
      model: baseModel(),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(info.detail, PROVIDER_DETAIL_LABEL);
    assert.equal(info.detail, 'Routermod');
  });

  test('sets multiplierNumeric to 0 so BYOK models do not appear premium', () => {
    const { info } = buildModelInfo({
      model: baseModel(),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(info.multiplierNumeric, 0);
    assert.equal(info.multiplierNumeric, PROVIDER_MULTIPLIER_NUMERIC);
  });

  test('marks the model user-selectable for the chat picker (1.120 requirement)', () => {
    const { info } = buildModelInfo({
      model: baseModel(),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(info.isUserSelectable, true);
  });
});

describe('buildModelInfo id-derived fields', () => {
  test('uses the friendly (title-cased, provider-suffixed) name', () => {
    const { info } = buildModelInfo({
      model: baseModel({ id: 'meta-llama/Llama-3.1-8B-Instruct' }),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(info.name, 'Llama 3.1 8B Instruct (meta-llama)');
    assert.equal(info.version, 'Llama 3.1 8B Instruct (meta-llama)');
    assert.equal(info.id, 'meta-llama/Llama-3.1-8B-Instruct');
  });

  test('infers a known family when the id matches', () => {
    const { info } = buildModelInfo({
      model: baseModel({ id: 'mistralai/Mistral-7B' }),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(info.family, 'mistral');
  });

  test('falls back to the routermod family for unknown ids', () => {
    const { info } = buildModelInfo({
      model: baseModel({ id: 'unknown-org/unknown-model' }),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(info.family, 'routermod');
  });
});

describe('buildModelInfo context resolution', () => {
  test('prefers max_model_len over the other context fields', () => {
    const { totalContext, info, hasServerReportedContext } = buildModelInfo({
      model: baseModel({
        max_model_len: 131072,
        context_length: 8192,
        context_window: 4096,
      }),
      defaultMaxTokens: 9999,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(totalContext, 131072);
    assert.equal(info.maxInputTokens, 131072);
    assert.equal(hasServerReportedContext, true);
  });

  test('falls back to context_length when max_model_len is absent', () => {
    const { totalContext, hasServerReportedContext } = buildModelInfo({
      model: baseModel({ context_length: 8192 }),
      defaultMaxTokens: 9999,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(totalContext, 8192);
    assert.equal(hasServerReportedContext, true);
  });

  test('falls back to context_window when max_model_len and context_length are absent', () => {
    const { totalContext, hasServerReportedContext } = buildModelInfo({
      model: baseModel({ context_window: 4096 }),
      defaultMaxTokens: 9999,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(totalContext, 4096);
    assert.equal(hasServerReportedContext, true);
  });

  test('falls back to defaultMaxTokens when the server reports no context size', () => {
    const { totalContext, hasServerReportedContext } = buildModelInfo({
      model: baseModel(),
      defaultMaxTokens: 32768,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(totalContext, 32768);
    assert.equal(hasServerReportedContext, false);
  });

  test('reads llama.cpp meta.n_ctx when the flat fields are absent (issue #55)', () => {
    const { totalContext, hasServerReportedContext } = buildModelInfo({
      model: baseModel({ meta: { n_ctx: 123904, n_ctx_train: 262144 } }),
      defaultMaxTokens: 9999,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(totalContext, 123904);
    assert.equal(hasServerReportedContext, true);
  });

  test('a user contextOverride wins over server-reported values', () => {
    const { totalContext, info, hasServerReportedContext } = buildModelInfo({
      model: baseModel({ max_model_len: 131072 }),
      defaultMaxTokens: 9999,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
      contextOverride: 32768,
    });
    assert.equal(totalContext, 32768);
    assert.equal(info.maxInputTokens, 32768);
    // Server still reported a value; the override just outranked it.
    assert.equal(hasServerReportedContext, true);
  });

  test('a user contextOverride also wins over defaultMaxTokens when nothing is reported', () => {
    const { totalContext } = buildModelInfo({
      model: baseModel(),
      defaultMaxTokens: 9999,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
      contextOverride: 16384,
    });
    assert.equal(totalContext, 16384);
  });
});

describe('buildModelInfo output token math', () => {
  test('caps maxOutputTokens at the configured default', () => {
    const { info } = buildModelInfo({
      model: baseModel({ max_model_len: 131072 }),
      defaultMaxTokens: 32768,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(info.maxOutputTokens, 2048);
  });

  test('reduces maxOutputTokens to leave the ADJUST_TOKEN_BUFFER headroom when the window is tight', () => {
    const totalContext = 512;
    const { info } = buildModelInfo({
      model: baseModel({ max_model_len: totalContext }),
      defaultMaxTokens: 32768,
      defaultMaxOutputTokens: 4096,
      capabilities: {},
    });
    assert.equal(info.maxOutputTokens, totalContext - TOKEN_CONSTANTS.ADJUST_TOKEN_BUFFER);
  });

  test('never drops below MIN_OUTPUT_TOKENS', () => {
    const { info } = buildModelInfo({
      model: baseModel({ max_model_len: TOKEN_CONSTANTS.MIN_OUTPUT_TOKENS }),
      defaultMaxTokens: 32768,
      defaultMaxOutputTokens: 4096,
      capabilities: {},
    });
    assert.equal(info.maxOutputTokens, TOKEN_CONSTANTS.MIN_OUTPUT_TOKENS);
  });
});

describe('buildModelInfo description and tooltip', () => {
  test('tooltip shows Provider, Model ID, Name on separate lines', () => {
    const { info } = buildModelInfo({
      model: baseModel({ id: 'ocg/deepseek-v4-pro', max_model_len: 131072, owned_by: 'ocg' }),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(
      info.tooltip,
      '**Provider:** ocg  \n**Model ID:** `ocg/deepseek-v4-pro`  \n**Name:** Deepseek V4 Pro (ocg)'
    );
  });

  test('tooltip omits Provider line when no slash in id', () => {
    const { info } = buildModelInfo({
      model: baseModel({ id: 'gpt-4o-mini', max_model_len: 131072, owned_by: 'openai' }),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(
      info.tooltip,
      '**Model ID:** `gpt-4o-mini`  \n**Name:** Gpt 4o Mini'
    );
  });

  test('includes description when describeModel returns content', () => {
    const { info } = buildModelInfo({
      model: baseModel({ max_model_len: 32768, owned_by: 'vllm' }),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.ok(info.description, 'expected description to be set');
    assert.ok(info.description!.includes('ctx'));
  });

  test('omits description when describeModel returns an empty string', () => {
    const { info } = buildModelInfo({
      // No context fields + filtered-out owned_by leaves describeModel empty.
      model: baseModel({ owned_by: 'organization-owner' }),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(info.description, undefined);
  });
});

describe('buildModelInfo capabilities pass-through', () => {
  test('forwards capabilities as-is', () => {
    const { info } = buildModelInfo({
      model: baseModel(),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: { imageInput: true, toolCalling: 16 },
    });
    assert.deepEqual(info.capabilities, { imageInput: true, toolCalling: 16 });
  });

  test('accepts empty capabilities', () => {
    const { info } = buildModelInfo({
      model: baseModel(),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.deepEqual(info.capabilities, {});
  });
});

describe('buildModelInfo reasoning-effort configurationSchema', () => {
  test('emits a picker schema with the correct enum for openai-format models', () => {
    const { info } = buildModelInfo({
      model: baseModel({
        id: 'cbai/gpt-5.6-luna',
        capabilities: { reasoning: true, thinkingFormat: 'openai' },
      }),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.deepEqual(info.configurationSchema?.properties.reasoningEffort.enum, [
      'low',
      'medium',
      'high',
    ]);
    assert.equal(info.configurationSchema?.properties.reasoningEffort.default, 'medium');
    assert.equal(info.configurationSchema?.properties.reasoningEffort.type, 'string');
  });

  test('emits a Claude-adaptive schema with xhigh and max, defaulting to high', () => {
    const { info } = buildModelInfo({
      model: baseModel({
        id: 'cl/anthropic/claude-opus-4.7',
        capabilities: { reasoning: true, thinkingFormat: 'claude-adaptive' },
      }),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.deepEqual(info.configurationSchema?.properties.reasoningEffort.enum, [
      'low',
      'medium',
      'high',
      'max',
      'xhigh',
    ]);
    // Claude family default = 'high', per the Copilot BYOK heuristic
    // (microsoft/vscode#315181).
    assert.equal(info.configurationSchema?.properties.reasoningEffort.default, 'high');
  });

  test('omits the schema when the model is not reasoning-capable', () => {
    const { info } = buildModelInfo({
      model: baseModel(),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(info.configurationSchema, undefined);
  });

  test('omits the schema for zai-format models without thinkingEffortSupported', () => {
    const { info } = buildModelInfo({
      model: baseModel({
        id: 'cbai/glm-5.1',
        capabilities: { reasoning: true, thinkingFormat: 'zai' },
      }),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(info.configurationSchema, undefined);
  });

  test('emits a zai schema only when thinkingEffortSupported is true', () => {
    const { info } = buildModelInfo({
      model: baseModel({
        id: 'cbai/glm-5.2',
        capabilities: {
          reasoning: true,
          thinkingFormat: 'zai',
          thinkingEffortSupported: true,
        },
      }),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.deepEqual(info.configurationSchema?.properties.reasoningEffort.enum, [
      'low',
      'medium',
      'high',
    ]);
  });

  test('falls back to the openai enum for unknown-format reasoning models in the openai family', () => {
    const { info } = buildModelInfo({
      model: baseModel({
        id: 'cbai/gpt-5.4',
        capabilities: { reasoning: true },
      }),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.deepEqual(info.configurationSchema?.properties.reasoningEffort.enum, [
      'low',
      'medium',
      'high',
    ]);
  });

  test('omits `default` when the preferred level is not in the enum', () => {
    const { info } = buildModelInfo({
      model: baseModel({
        id: 'cl/anthropic/claude-haiku-4.5',
        capabilities: {
          reasoning: true,
          thinkingFormat: 'claude-budget',
          // small enum — no `high` available
        },
      }),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    // claude-budget → ['low','medium','high','max']; preferred is 'high' which IS
    // in the enum, so default should be set. Use a non-Claude name to
    // verify the no-default fallback.
    const fallback = buildModelInfo({
      model: baseModel({
        id: 'cbai/claude-haiku-lite',
        capabilities: {
          reasoning: true,
          thinkingFormat: 'claude-budget',
        },
      }),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    // Both produce schemas — the family detector catches the "claude"
    // substring in either case, so `default` will be `'high'`.
    assert.equal(info.configurationSchema?.properties.reasoningEffort.default, 'high');
    assert.equal(fallback.info.configurationSchema?.properties.reasoningEffort.default, 'high');
  });

  test('places the schema in the `navigation` group', () => {
    const { info } = buildModelInfo({
      model: baseModel({
        id: 'cbai/glm-5.2',
        capabilities: {
          reasoning: true,
          thinkingFormat: 'zai',
          thinkingEffortSupported: true,
        },
      }),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(info.configurationSchema?.group, 'navigation');
    assert.equal(info.configurationSchema?.properties.reasoningEffort.group, 'navigation');
  });

  test('server-advertised capabilities.reasoningEffort wins over the format heuristic', () => {
    const { info } = buildModelInfo({
      model: baseModel({
        id: 'gh/gpt-5.6-luna',
        capabilities: {
          reasoning: true,
          thinkingFormat: 'openai',
          // Server says the model only supports these two — even though
          // the openai heuristic would emit three.
          reasoningEffort: ['low', 'high'],
        },
      }),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.deepEqual(info.configurationSchema?.properties.reasoningEffort.enum, ['low', 'high']);
  });

  test('falls back to the format heuristic when the server list is empty', () => {
    const { info } = buildModelInfo({
      model: baseModel({
        id: 'gh/gpt-5.6-luna',
        capabilities: {
          reasoning: true,
          thinkingFormat: 'openai',
          reasoningEffort: [],
        },
      }),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.deepEqual(info.configurationSchema?.properties.reasoningEffort.enum, [
      'low',
      'medium',
      'high',
    ]);
  });
});

describe('hasReasoningTierInName keyword set', () => {
  test('exports the documented tier tokens as an extensible array', () => {
    assert.ok(Array.isArray(REASONING_TIER_KEYWORDS));
    assert.ok(REASONING_TIER_KEYWORDS.includes('low'));
    assert.ok(REASONING_TIER_KEYWORDS.includes('medium'));
    assert.ok(REASONING_TIER_KEYWORDS.includes('high'));
    assert.ok(REASONING_TIER_KEYWORDS.includes('extra'));
    assert.ok(REASONING_TIER_KEYWORDS.includes('max'));
    assert.ok(REASONING_TIER_KEYWORDS.includes('xhigh'));
    assert.ok(REASONING_TIER_KEYWORDS.includes('thinking'));
    assert.ok(REASONING_TIER_KEYWORDS.includes('agentic'));
  });
});

describe('splitModelSegments', () => {
  test('strips the provider prefix before the first slash', () => {
    assert.deepEqual(
      [...splitModelSegments('cu/claude-4.5-opus-high-thinking')],
      ['claude', '4.5', 'opus', 'high', 'thinking'],
    );
  });

  test('returns the full id when there is no slash', () => {
    assert.deepEqual(
      [...splitModelSegments('openai-o3')],
      ['openai', 'o3'],
    );
  });

  test('falls back to underscore splitting when a segment contains one', () => {
    assert.deepEqual(
      [...splitModelSegments('kr/claude_opus_5_agentic')],
      ['claude', 'opus', '5', 'agentic'],
    );
  });

  test('lowercases segments so the keyword lookup is case-insensitive', () => {
    assert.deepEqual(
      [...splitModelSegments('Claude-Opus-HIGH-Thinking')],
      ['claude', 'opus', 'high', 'thinking'],
    );
  });

  test('skips empty segments from leading or trailing delimiters', () => {
    assert.deepEqual(
      [...splitModelSegments('-claude-opus-')],
      ['claude', 'opus'],
    );
  });
});

describe('hasReasoningTierInName', () => {
  test('flags every tier-baked example from the spec', () => {
    const examples = [
      'cu/claude-4.5-opus-high-thinking',
      'cu/claude-4.5-opus-high',
      'cu/claude-4.5-sonnet-thinking',
      'kr/claude-opus-5-agentic',
      'ag/gemini-3.5-flash-extra-low',
      'ag/claude-opus-4-6-thinking',
      'foo-some-model-max',
      'foo-some-model-medium-thinking',
      'foo-some-model-thinking-agentic',
    ];
    for (const id of examples) {
      assert.equal(hasReasoningTierInName(id), true, `expected tier in ${id}`);
    }
  });

  test('does not flag non-tiered reasoning models', () => {
    const examples = [
      'openai/o3',
      'claude-opus-4-6',
      'deepseek-r1',
      'cbai/gpt-5.6-luna',
    ];
    for (const id of examples) {
      assert.equal(hasReasoningTierInName(id), false, `expected NO tier in ${id}`);
    }
  });

  test('does not match tier keywords embedded inside larger segments', () => {
    // Guards against substring false positives — `high` must not match
    // inside `highlight`, `max` must not match inside `maximus`, etc.
    const examples = [
      'gpt-4-highlight-preview',
      'claude-mediumwave-7',
      'maximus-encoder-v2',
      'tower-orbit-satellite',
      'extraordinary-model',
      'agentless-framework-base',
    ];
    for (const id of examples) {
      assert.equal(hasReasoningTierInName(id), false, `expected NO tier in ${id}`);
    }
  });

  test('ignores tier keywords that appear in the middle of the id', () => {
    // Only the trailing 3 segments are inspected, so a tier keyword
    // buried in the model name itself (e.g. a version tag like
    // `claude-high-opus-4-6`) does not false-positive. Each example
    // has at least 4 model segments so the trailing 3-segment window
    // excludes the tier keyword. Non-keyword segments only — high/max
    // etc. are real tier tokens and would correctly fire.
    const examples = [
      'claude-high-opus-4-6',
      'sunset-radiant-claude-v1',
      'tower-lunar-tower-v2',
    ];
    for (const id of examples) {
      assert.equal(hasReasoningTierInName(id), false, `expected NO tier in ${id}`);
    }
  });

  test('is case-insensitive on the segment side', () => {
    assert.equal(hasReasoningTierInName('Claude-Opus-HIGH-Thinking'), true);
    assert.equal(hasReasoningTierInName('CU/claude-opus-MAX'), true);
    assert.equal(hasReasoningTierInName('ag/claude-opus-4-6-Thinking'), true);
  });

  test('detects stacked tiers in the trailing window', () => {
    assert.equal(hasReasoningTierInName('something-high-thinking'), true);
    assert.equal(hasReasoningTierInName('something-thinking-agentic'), true);
    assert.equal(hasReasoningTierInName('something-medium-thinking'), true);
    // Stacked tier when the third-from-last is also a keyword.
    assert.equal(hasReasoningTierInName('cu/max-thinking-opus'), true);
  });

  test('does not flag models whose id happens to contain a slash but no tier', () => {
    assert.equal(hasReasoningTierInName('foo/bar'), false);
  });
});

describe('buildModelInfo skips picker schema when tier is baked into the id', () => {
  // Every model id here still advertises `reasoning: true` — the
  // short-circuit fires purely on the id, before any format-based enum
  // logic runs.
  const tieredModels = [
    'cu/claude-4.5-opus-high-thinking',
    'cu/claude-4.5-opus-high',
    'cu/claude-4.5-sonnet-thinking',
    'kr/claude-opus-5-agentic',
    'ag/gemini-3.5-flash-extra-low',
    'ag/claude-opus-4-6-thinking',
    'foo-some-model-max',
    'foo-some-model-medium-thinking',
    'foo-some-model-thinking-agentic',
  ];

  for (const id of tieredModels) {
    test(`omits configurationSchema for ${id}`, () => {
      const { info } = buildModelInfo({
        model: baseModel({
          id,
          // Use claude-adaptive so the format heuristic would otherwise
          // emit a 5-value enum — proving the short-circuit fires
          // before the format switch.
          capabilities: { reasoning: true, thinkingFormat: 'claude-adaptive' },
        }),
        defaultMaxTokens: 8192,
        defaultMaxOutputTokens: 2048,
        capabilities: {},
      });
      assert.equal(info.configurationSchema, undefined);
    });
  }

  test('still emits the enum for non-tiered reasoning models', () => {
    const { info } = buildModelInfo({
      model: baseModel({
        id: 'openai/o3',
        capabilities: { reasoning: true, thinkingFormat: 'openai' },
      }),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.deepEqual(info.configurationSchema?.properties.reasoningEffort.enum, [
      'low',
      'medium',
      'high',
    ]);
  });

  test('still emits the enum when a tier-like substring is part of a longer segment', () => {
    // `highlight` is a substring of `high` but is its own segment, so the
    // tier short-circuit must NOT fire and the normal Claude-adaptive
    // enum should still appear.
    const { info } = buildModelInfo({
      model: baseModel({
        id: 'cu/claude-4-5-opus-highlight',
        capabilities: { reasoning: true, thinkingFormat: 'claude-adaptive' },
      }),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.deepEqual(info.configurationSchema?.properties.reasoningEffort.enum, [
      'low',
      'medium',
      'high',
      'max',
      'xhigh',
    ]);
  });

  test('still emits the enum for a reasoning model with the deepseek format and no tier in id', () => {
    const { info } = buildModelInfo({
      model: baseModel({
        id: 'deepseek-r1',
        capabilities: { reasoning: true, thinkingFormat: 'deepseek' },
      }),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.deepEqual(info.configurationSchema?.properties.reasoningEffort.enum, [
      'low',
      'high',
      'max',
    ]);
  });

  test('still emits the enum when a tier keyword is buried mid-name', () => {
    // `high` lives more than 3 segments from the tail, so the trailing
    // window misses it and the picker should still appear.
    const { info } = buildModelInfo({
      model: baseModel({
        id: 'claude-high-opus-4-6',
        capabilities: { reasoning: true, thinkingFormat: 'claude-adaptive' },
      }),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.deepEqual(info.configurationSchema?.properties.reasoningEffort.enum, [
      'low',
      'medium',
      'high',
      'max',
      'xhigh',
    ]);
  });
});
