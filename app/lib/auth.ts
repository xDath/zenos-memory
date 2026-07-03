export function validateApiKey(request: Request): boolean {
  const apiKey = process.env.ZENOS_MEMORY_API_KEY;
  if (!apiKey) {
    console.warn('[ZenosMemory] No API key set in env - allowing all (dev only)');
    return true;
  }

  const authHeader = request.headers.get('authorization') || '';
  const providedKey = authHeader.replace('Bearer ', '').trim() || 
                      request.headers.get('x-api-key') || '';

  return providedKey === apiKey;
}

export function unauthorizedResponse() {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}
