import { NextRequest, NextResponse } from 'next/server';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) {
    return unauthorizedResponse();
  }

  try {
    const body = await request.json();
    const { id, namespace } = body;

    if (!id) {
      return NextResponse.json({ error: 'id required' }, { status: 400 });
    }

    const engine = getMemoryEngine();
    const success = await engine.forget(id, namespace);

    return NextResponse.json({ success, id });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
