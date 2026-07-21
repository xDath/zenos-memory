import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly expose: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    options: {
      code?: string;
      status?: number;
      expose?: boolean;
      cause?: unknown;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.code = options.code || 'INTERNAL_ERROR';
    this.status = options.status || 500;
    this.expose = options.expose ?? this.status < 500;
    this.details = options.details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: 'VALIDATION_ERROR', status: 400, expose: true, details });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'Request body exceeds the allowed size', details?: Record<string, unknown>) {
    super(message, { code: 'PAYLOAD_TOO_LARGE', status: 413, expose: true, details });
  }
}

export class SensitiveDataError extends AppError {
  constructor(message = 'Raw credentials and secrets cannot be stored in Zenos Memory') {
    super(message, { code: 'SENSITIVE_DATA_REJECTED', status: 422, expose: true });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: 'VERSION_CONFLICT', status: 409, expose: true, details });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, { code: 'NOT_FOUND', status: 404, expose: true });
  }
}

export class StorageError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: 'STORAGE_ERROR', status: 503, expose: false, cause });
  }
}

export function requestId(request?: Request): string {
  const existing = request?.headers.get('x-request-id')?.trim();
  return existing && /^[a-zA-Z0-9._:-]{8,128}$/.test(existing) ? existing : randomUUID();
}

function safeLogMetadata(error: unknown): Record<string, unknown> {
  if (error instanceof AppError) {
    return {
      error_name: error.name,
      code: error.code,
      status: error.status,
      message: error.message,
      cause_name: error.cause instanceof Error ? error.cause.name : undefined,
    };
  }
  if (error instanceof ZodError) {
    return {
      error_name: error.name,
      code: 'VALIDATION_ERROR',
      issue_count: error.issues.length,
    };
  }
  if (error instanceof Error) {
    const candidate = error as Error & {
      code?: unknown;
      status?: unknown;
      response?: { status?: unknown };
    };
    const rawStatus = candidate.status ?? candidate.response?.status;
    const providerStatus = Number.isInteger(rawStatus) && Number(rawStatus) >= 400 && Number(rawStatus) <= 599
      ? Number(rawStatus)
      : undefined;
    const providerCode = (
      (typeof candidate.code === 'string' || typeof candidate.code === 'number')
      && /^[A-Z0-9_.:-]{1,48}$/i.test(String(candidate.code))
    ) ? String(candidate.code) : undefined;
    return {
      error_name: error.name,
      code: 'UNEXPECTED_ERROR',
      provider_status: providerStatus,
      provider_code: providerCode,
    };
  }
  return {
    error_name: typeof error,
    code: 'UNEXPECTED_ERROR',
  };
}

export function publicError(error: unknown, id: string = randomUUID()) {
  const appError = error instanceof AppError
    ? error
    : error instanceof ZodError
      ? new ValidationError('Request validation failed', {
          issues: error.issues.map(issue => ({
            path: issue.path.join('.'),
            code: issue.code,
            message: issue.message,
          })),
        })
      : error instanceof SyntaxError
        ? new ValidationError('Request body contains invalid JSON')
        : new AppError('Unexpected server error', { cause: error });

  if (!(error instanceof AppError)) {
    console.error('[ZenosMemory] Unhandled error', {
      request_id: id,
      ...safeLogMetadata(error),
    });
  } else if (appError.status >= 500) {
    console.error('[ZenosMemory] Server error', {
      request_id: id,
      ...safeLogMetadata(appError),
    });
  }

  return {
    status: appError.status,
    body: {
      success: false,
      error: {
        code: appError.code,
        message: appError.expose ? appError.message : 'The service could not complete the request',
        ...(appError.expose && appError.details ? { details: appError.details } : {}),
      },
      request_id: id,
    },
  };
}

export function errorResponse(error: unknown, id: string = randomUUID()): Response {
  const result = publicError(error, id);
  return Response.json(result.body, {
    status: result.status,
    headers: {
      'cache-control': 'no-store',
      'x-request-id': id,
    },
  });
}
