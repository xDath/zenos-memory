import { timingSafeEqual } from 'node:crypto';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { AppError, errorResponse, requestId } from '../../../lib/errors';
import { jsonResponse } from '../../../lib/http';
import { getMemoryEngine } from '../../../lib/memory-engine';

const SchedulerSchema = z.object({
  namespace: z.string().optional().default('zenos'),
  apply_decay: z.boolean().optional().default(true),
  backup: z.boolean().optional().default(true),
  prune: z.boolean().optional().default(true),
  store_report: z.boolean().optional().default(false),
});

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validateScheduler(request: NextRequest): boolean {
  if (validateApiKey(request)) return true;
  const secret = process.env.CRON_SECRET?.trim();
  const authorization = request.headers.get('authorization')?.trim() || '';
  return Boolean(secret && equalSecret(authorization, `Bearer ${secret}`));
}

function queryBoolean(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

async function runMaintenance(request: NextRequest, input: unknown) {
  if (!validateScheduler(request)) return unauthorizedResponse();
  const id = requestId(request);
  const engine = getMemoryEngine();
  let leaseToken: string | null = null;
  let leaseNamespace = 'zenos';
  const resource = 'scheduled-maintenance';
  const owner = `scheduler:${process.env.VERCEL_DEPLOYMENT_ID || process.pid}`;
  try {
    const parsed = SchedulerSchema.parse(input);
    leaseNamespace = parsed.namespace;
    const lease = await engine.acquireLease(resource, owner, parsed.namespace, 90_000);
    if (!lease) {
      throw new AppError('A maintenance run is already active', {
        code: 'MAINTENANCE_ALREADY_RUNNING',
        status: 409,
        expose: true,
      });
    }
    leaseToken = lease.token;

    const cycle = await engine.runMaintenanceCycle({
      namespace: parsed.namespace,
      applyDecay: parsed.apply_decay,
      backup: parsed.backup,
      prune: parsed.prune,
      includeReport: parsed.store_report,
    });

    if (parsed.store_report) {
      const day = new Date().toISOString().slice(0, 10);
      await engine.remember({
        content: JSON.stringify({
          kind: 'scheduled-maintenance',
          generated_at: new Date().toISOString(),
          namespace: parsed.namespace,
          decayed: cycle.decayed,
          health: cycle.health,
          maintenance: cycle.maintenance,
          backup: cycle.backup ? { destination: cycle.backup.destination, verified: cycle.backup.verified } : null,
          retention: cycle.retention,
        }),
        type: 'insight',
        namespace: parsed.namespace,
        metadata: {
          source: 'zenos-scheduler',
          confidence: 1,
          importance: 4,
          tags: ['scheduler', 'maintenance-report'],
        },
        idempotency_key: `scheduler:${parsed.namespace}:${day}`,
      });
    }

    return jsonResponse({
      success: true,
      namespace: cycle.namespace,
      decayed: cycle.decayed,
      backup: cycle.backup,
      retention: cycle.retention,
      health: cycle.health,
      maintenance: cycle.maintenance,
      request_id: id,
    }, { requestId: id });
  } catch (error) {
    return errorResponse(error, id);
  } finally {
    if (leaseToken) {
      await engine.releaseLease(leaseToken, owner, leaseNamespace, resource).catch(() => false);
    }
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  return runMaintenance(request, await request.json().catch(() => ({})));
}

export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  return runMaintenance(request, {
    namespace: params.get('namespace') || 'zenos',
    apply_decay: queryBoolean(params.get('apply_decay'), true),
    backup: queryBoolean(params.get('backup'), true),
    prune: queryBoolean(params.get('prune'), true),
    store_report: queryBoolean(params.get('store_report'), false),
  });
}
