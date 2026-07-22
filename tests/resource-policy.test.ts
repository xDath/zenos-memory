import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyDailyUsage,
  evaluateResourceReservation,
  memoryOperationMode,
  shouldUseLlmWithinPolicy,
} from '../app/lib/resource-policy';

function withEnv(values: Record<string, string | undefined>, operation: () => void) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    operation();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('zero_cost mode blocks LLM reservations while preserving durable Drive writes', () => {
  withEnv({
    ZENOS_MEMORY_OPERATION_MODE: 'zero_cost',
    ZENOS_MEMORY_MAX_DAILY_DRIVE_WRITES: '10',
    ZENOS_MEMORY_MAX_DAILY_LLM_TOKENS: '0',
    ZENOS_MEMORY_MIN_FREE_STORAGE_BYTES: '1024',
  }, () => {
    assert.equal(memoryOperationMode(), 'zero_cost');
    assert.equal(shouldUseLlmWithinPolicy(), false);
    const write = evaluateResourceReservation({
      current: emptyDailyUsage('2026-07-22'),
      reservation: { driveWrites: 2, storageBytesWritten: 1_024 },
      storage: { usageBytes: 1_000, freeBytes: 10_000_000 },
    });
    assert.equal(write.drive_writes, 2);
    assert.throws(() => evaluateResourceReservation({
      current: write,
      reservation: { llmTokens: 1 },
    }), /zero_cost/i);
  });
});

test('daily write, token, storage, and free-space guards fail before overcommit', () => {
  withEnv({
    ZENOS_MEMORY_OPERATION_MODE: 'opportunistic_free',
    ZENOS_MEMORY_MAX_DAILY_DRIVE_WRITES: '5',
    ZENOS_MEMORY_MAX_DAILY_LLM_TOKENS: '100',
    ZENOS_MEMORY_MAX_STORAGE_BYTES: '2000',
    ZENOS_MEMORY_MIN_FREE_STORAGE_BYTES: '500',
  }, () => {
    const current = {
      ...emptyDailyUsage('2026-07-22'),
      drive_writes: 4,
      llm_tokens: 90,
    };
    assert.throws(() => evaluateResourceReservation({ current, reservation: { driveWrites: 2 } }), /Drive write budget/i);
    assert.throws(() => evaluateResourceReservation({ current, reservation: { llmTokens: 11 } }), /LLM token budget/i);
    assert.throws(() => evaluateResourceReservation({
      current,
      reservation: { storageBytesWritten: 600 },
      storage: { usageBytes: 1_500, freeBytes: 10_000 },
    }), /storage ceiling/i);
    assert.throws(() => evaluateResourceReservation({
      current,
      reservation: { storageBytesWritten: 600 },
      storage: { usageBytes: 100, freeBytes: 1_000 },
    }), /free Google Drive storage/i);
  });
});

test('premium_optional requires explicit budget approval before an LLM call', () => {
  withEnv({
    ZENOS_MEMORY_OPERATION_MODE: 'premium_optional',
    ZENOS_MEMORY_PREMIUM_BUDGET_APPROVED: undefined,
  }, () => assert.equal(shouldUseLlmWithinPolicy(), false));
  withEnv({
    ZENOS_MEMORY_OPERATION_MODE: 'premium_optional',
    ZENOS_MEMORY_PREMIUM_BUDGET_APPROVED: 'true',
  }, () => assert.equal(shouldUseLlmWithinPolicy(), true));
});
