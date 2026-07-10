import { NextRequest } from 'next/server';
import { unauthorizedResponse, validateApiKey } from '../../../lib/auth';
import { errorResponse, requestId } from '../../../lib/errors';
import { runIntelligenceAmplificationEval } from '../../../lib/intelligence-eval';
import { getMemoryEngine } from '../../../lib/memory-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const id = requestId(request);
  try {
    const deterministic = runIntelligenceAmplificationEval();
    const readiness = await getMemoryEngine().readiness();
    const gates = [
      {
        name: 'contract_regression',
        pass: deterministic.success,
        evidence: { score: deterministic.score, failed: deterministic.failed },
      },
      {
        name: 'sqlite_integrity',
        pass: readiness.storage.ok,
        evidence: { integrity: readiness.storage.integrity, journal_mode: readiness.storage.journal_mode },
      },
      {
        name: 'transactional_primary',
        pass: readiness.storage.journal_mode.toLowerCase() === 'wal',
        evidence: { database: readiness.storage.path.replace(/^\/root\//, '~/') },
      },
      {
        name: 'raw_secret_storage_disabled',
        pass: readiness.security.raw_secret_storage === false,
        evidence: { raw_secret_storage: readiness.security.raw_secret_storage },
      },
      {
        name: 'authentication_fail_closed',
        pass: readiness.security.fail_closed,
        evidence: {
          legacy_hmac_enabled: readiness.security.legacy_hmac_enabled,
          static_api_key_enabled: readiness.security.static_api_key_enabled,
        },
      },
      {
        name: 'backup_policy',
        pass: readiness.backup.healthy,
        evidence: readiness.backup,
      },
    ];
    const passed = gates.filter(gate => gate.pass).length;
    const score = Number((passed / gates.length).toFixed(4));
    return Response.json({
      success: passed === gates.length,
      benchmark: 'zenos-memory-production-gates-v1',
      methodology: 'deterministic contract tests plus live dependency/readiness evidence',
      score,
      passed,
      failed: gates.length - passed,
      gates,
      contract_regression: deterministic,
      request_id: id,
    }, {
      status: passed === gates.length ? 200 : 503,
      headers: { 'cache-control': 'no-store', 'x-request-id': id },
    });
  } catch (error) {
    return errorResponse(error, id);
  }
}
