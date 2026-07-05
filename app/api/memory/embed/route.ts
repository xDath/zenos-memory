import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';
import { getEmbedding } from '../../../lib/neural-embedding';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();
  const body = await request.json().catch(() => ({}));
  const text = body.text || body.query || '';
  if (!text) return NextResponse.json({ success: false, error: 'text/query required' }, { status: 400 });
  const embedding = await getEmbedding(text);
  return NextResponse.json({ success: true, dimensions: embedding.vector.length, ...embedding, vector: body.include_vector ? embedding.vector : undefined });
}
