import { NextRequest, NextResponse } from 'next/server';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { buildEpisodes } from '../../../lib/episode-builder';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';

export async function GET(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();

  const { searchParams } = new URL(request.url);
  const namespace = searchParams.get('namespace') || 'zenos';
  const memoryLimit = Math.min(1000, Math.max(1, Number(searchParams.get('memory_limit') || 500)));
  const episodeLimit = Math.min(100, Math.max(1, Number(searchParams.get('limit') || 20)));
  const engine = getMemoryEngine();
  const memories = await engine.list(namespace, memoryLimit);
  const episodes = buildEpisodes(memories, episodeLimit);

  return NextResponse.json({ success: true, namespace, count: episodes.length, episodes });
}
