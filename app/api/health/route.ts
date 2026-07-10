export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({
    status: 'ok',
    service: 'zenos-memory',
    version: '2.1.2',
    role: 'liveness',
    timestamp: new Date().toISOString(),
  }, {
    headers: { 'cache-control': 'no-store' },
  });
}
