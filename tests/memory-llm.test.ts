import test from 'node:test';
import assert from 'node:assert/strict';
import { compactWithLLM } from '../app/lib/memory-llm';

test('Gemini compaction reserves reasoning space and retries truncated structured output', async () => {
  const originalFetch = globalThis.fetch;
  const original = {
    baseUrl: process.env.MEMORY_LLM_BASE_URL,
    apiKey: process.env.MEMORY_LLM_API_KEY,
    model: process.env.MEMORY_LLM_MODEL,
    fallback: process.env.MEMORY_LLM_FALLBACK_MODEL,
    timeout: process.env.MEMORY_LLM_TIMEOUT_MS,
    total: process.env.MEMORY_LLM_TOTAL_BUDGET_MS,
  };
  process.env.MEMORY_LLM_BASE_URL = 'http://router.test/v1';
  process.env.MEMORY_LLM_API_KEY = 'test-key';
  process.env.MEMORY_LLM_MODEL = 'ag/gemini-pro-agent';
  process.env.MEMORY_LLM_FALLBACK_MODEL = 'ag/gemini-3.5-flash-low';
  process.env.MEMORY_LLM_TIMEOUT_MS = '5000';
  process.env.MEMORY_LLM_TOTAL_BUDGET_MS = '12000';
  const calls: Array<{ model: string; max_tokens: number }> = [];

  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; max_tokens: number };
    calls.push(body);
    if (calls.length === 1) {
      return Response.json({
        choices: [{ message: { content: '{"current_goal":"' }, finish_reason: 'max_tokens' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      });
    }
    return Response.json({
      choices: [{
        message: { content: JSON.stringify({
          current_goal: 'Ship the production upgrade',
          active_state: 'Validation is in progress',
          key_decisions: ['Use Gemini for high-value compaction'],
          user_preferences: ['Prefer measured token economy'],
          important_facts: [],
          completed_work: [],
          pending_work: ['Run live smoke'],
          blockers: [],
          open_questions: [],
          files_artifacts: ['/opt/zenos-memory/current'],
          recovery_instructions: 'Resume from the live validation step',
        }) },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 120, completion_tokens: 180, total_tokens: 300 },
    });
  };

  try {
    const result = await compactWithLLM('A bounded synthetic production status transcript.');
    assert.equal(result.ok, true);
    assert.equal(result.model, 'ag/gemini-3.5-flash-low');
    assert.equal(result.fallback_used, true);
    assert.equal(result.parsed?.user_preferences.preference_1, 'Prefer measured token economy');
    assert.match(result.attempts?.[0]?.error || '', /truncated/i);
    assert.deepEqual(calls.map((call) => call.model), ['ag/gemini-pro-agent', 'ag/gemini-3.5-flash-low']);
    assert.ok(calls.every((call) => call.max_tokens >= 2_600));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries({
      MEMORY_LLM_BASE_URL: original.baseUrl,
      MEMORY_LLM_API_KEY: original.apiKey,
      MEMORY_LLM_MODEL: original.model,
      MEMORY_LLM_FALLBACK_MODEL: original.fallback,
      MEMORY_LLM_TIMEOUT_MS: original.timeout,
      MEMORY_LLM_TOTAL_BUDGET_MS: original.total,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
