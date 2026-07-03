import { NextRequest, NextResponse } from 'next/server';
import { EditRequestSchema } from '../../../lib/schema';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) {
    return unauthorizedResponse();
  }

  try {
    const body = await request.json();
    const parsed = EditRequestSchema.parse(body);

    const engine = getMemoryEngine();
    const updated = await engine.edit(
      parsed.id, 
      { content: parsed.content, metadata: parsed.metadata as any }, 
      parsed.namespace
    );

    if (!updated) {
      return NextResponse.json({ error: 'Memory not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, memory: updated });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
