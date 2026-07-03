import { NextRequest, NextResponse } from 'next/server';
import { getMemoryEngine } from '../../../lib/memory-engine';
import { validateApiKey, unauthorizedResponse } from '../../../lib/auth';
import { rateLimit } from '../../../lib/rate-limit';

export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') || 'unknown';
  if (!rateLimit(ip)) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  if (!validateApiKey(request)) {
    return unauthorizedResponse();
  }

  try {
    const body = await request.json();
    const { question, namespace = 'default', limit = 8 } = body;

    if (!question) {
      return NextResponse.json({ error: 'question is required' }, { status: 400 });
    }

    const engine = getMemoryEngine();
    const relevant = await engine.recall({
      query: question,
      namespace,
      limit,
    });

    if (relevant.length === 0) {
      return NextResponse.json({
        success: true,
        answer: 'No relevant memories found.',
        sources: [],
        source_count: 0,
      });
    }

    // Better context compilation for Phase 1
    const groupedByType: Record<string, any[]> = {};
    relevant.forEach(m => {
      if (!groupedByType[m.type]) groupedByType[m.type] = [];
      groupedByType[m.type].push(m);
    });

    let synthesized = `Based on ${relevant.length} relevant memories:\n\n`;

    Object.entries(groupedByType).forEach(([type, mems]) => {
      synthesized += `**${type.toUpperCase()}**:\n`;
      mems.forEach((m, i) => {
        synthesized += `- ${m.content} (conf: ${m.metadata.confidence}, ${new Date(m.created_at).toLocaleDateString()})\n`;
      });
      synthesized += '\n';
    });

    const sources = relevant.map((m, i) => ({
      rank: i + 1,
      id: m.id,
      type: m.type,
      content: m.content,
      confidence: m.metadata.confidence,
      created_at: m.created_at,
      tags: m.metadata.tags,
    }));

    return NextResponse.json({
      success: true,
      answer: synthesized.trim(),
      question,
      sources,
      source_count: relevant.length,
      note: 'Phase 1 RAG: grouped by type + basic synthesis. Full LLM synthesis in later phases.',
    });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
