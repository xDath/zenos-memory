import { z } from 'zod';
import { QuotaError } from './errors';

export const MemoryOperationModeSchema = z.enum(['zero_cost', 'opportunistic_free', 'premium_optional']);
export type MemoryOperationMode = z.infer<typeof MemoryOperationModeSchema>;

export const ResourceUsageSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  drive_writes: z.number().int().nonnegative(),
  llm_tokens: z.number().int().nonnegative(),
  storage_bytes_written: z.number().int().nonnegative(),
  updated_at: z.string().datetime(),
});
export type ResourceUsage = z.infer<typeof ResourceUsageSchema>;

export type ResourceReservation = {
  driveWrites?: number;
  llmTokens?: number;
  storageBytesWritten?: number;
};

export type DriveStorageQuota = {
  limitBytes?: number;
  usageBytes?: number;
  freeBytes?: number;
};

function nonnegativeEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

export function memoryOperationMode(): MemoryOperationMode {
  return MemoryOperationModeSchema.catch('opportunistic_free').parse(
    (process.env.ZENOS_MEMORY_OPERATION_MODE || 'opportunistic_free').trim().toLowerCase(),
  );
}

export function resourceLimits() {
  return {
    maxDailyDriveWrites: nonnegativeEnv('ZENOS_MEMORY_MAX_DAILY_DRIVE_WRITES', 10_000),
    maxDailyLlmTokens: nonnegativeEnv('ZENOS_MEMORY_MAX_DAILY_LLM_TOKENS', 250_000),
    maxStorageBytes: nonnegativeEnv('ZENOS_MEMORY_MAX_STORAGE_BYTES', 10 * 1024 * 1024 * 1024),
    minFreeStorageBytes: nonnegativeEnv('ZENOS_MEMORY_MIN_FREE_STORAGE_BYTES', 512 * 1024 * 1024),
    degradationMode: (process.env.ZENOS_MEMORY_DEGRADATION_MODE || 'deterministic').trim().toLowerCase(),
  };
}

export function emptyDailyUsage(date = new Date().toISOString().slice(0, 10)): ResourceUsage {
  return ResourceUsageSchema.parse({
    date,
    drive_writes: 0,
    llm_tokens: 0,
    storage_bytes_written: 0,
    updated_at: new Date().toISOString(),
  });
}

export function evaluateResourceReservation(input: {
  current: ResourceUsage;
  reservation: ResourceReservation;
  storage?: DriveStorageQuota;
}): ResourceUsage {
  const limits = resourceLimits();
  const mode = memoryOperationMode();
  const driveWrites = Math.max(0, Math.floor(input.reservation.driveWrites || 0));
  const llmTokens = Math.max(0, Math.floor(input.reservation.llmTokens || 0));
  const storageBytesWritten = Math.max(0, Math.floor(input.reservation.storageBytesWritten || 0));
  if (mode === 'zero_cost' && llmTokens > 0) {
    throw new QuotaError('LLM usage is disabled in zero_cost mode', { mode, degradation: limits.degradationMode });
  }
  if (mode === 'opportunistic_free' && limits.maxDailyLlmTokens === 0 && llmTokens > 0) {
    throw new QuotaError('No free LLM token budget remains; deterministic degradation is required', {
      mode,
      degradation: limits.degradationMode,
    });
  }
  const next = ResourceUsageSchema.parse({
    date: input.current.date,
    drive_writes: input.current.drive_writes + driveWrites,
    llm_tokens: input.current.llm_tokens + llmTokens,
    storage_bytes_written: input.current.storage_bytes_written + storageBytesWritten,
    updated_at: new Date().toISOString(),
  });
  if (limits.maxDailyDriveWrites && next.drive_writes > limits.maxDailyDriveWrites) {
    throw new QuotaError('Daily Google Drive write budget exceeded', {
      requested: driveWrites,
      used: input.current.drive_writes,
      limit: limits.maxDailyDriveWrites,
      degradation: limits.degradationMode,
    });
  }
  if (limits.maxDailyLlmTokens && next.llm_tokens > limits.maxDailyLlmTokens) {
    throw new QuotaError('Daily Memory LLM token budget exceeded', {
      requested: llmTokens,
      used: input.current.llm_tokens,
      limit: limits.maxDailyLlmTokens,
      degradation: limits.degradationMode,
    });
  }
  if (limits.maxStorageBytes && input.storage?.usageBytes !== undefined
    && input.storage.usageBytes + storageBytesWritten > limits.maxStorageBytes) {
    throw new QuotaError('Configured Memory storage ceiling would be exceeded', {
      requested: storageBytesWritten,
      used: input.storage.usageBytes,
      limit: limits.maxStorageBytes,
    });
  }
  if (limits.minFreeStorageBytes && input.storage?.freeBytes !== undefined
    && input.storage.freeBytes - storageBytesWritten < limits.minFreeStorageBytes) {
    throw new QuotaError('Minimum free Google Drive storage reserve would be violated', {
      requested: storageBytesWritten,
      free: input.storage.freeBytes,
      minimum_free: limits.minFreeStorageBytes,
    });
  }
  return next;
}

export function shouldUseLlmWithinPolicy(): boolean {
  const mode = memoryOperationMode();
  if (mode === 'zero_cost') return false;
  const limits = resourceLimits();
  return mode === 'premium_optional'
    ? process.env.ZENOS_MEMORY_PREMIUM_BUDGET_APPROVED === 'true'
    : limits.maxDailyLlmTokens > 0;
}
