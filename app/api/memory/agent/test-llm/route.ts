import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey, unauthorizedResponse } from '../../../../lib/auth';
import { compactWithLLM, extractWithLLM, hasMemoryLLM } from '../../../../lib/memory-llm';

export async function POST(request: NextRequest) {
  if (!validateApiKey(request)) return unauthorizedResponse();

  try {
    const body = await request.json().catch(() => ({}));
    const text = body.text || 'User wants Zenos Memory to become a top-tier memory OS with Google Drive OAuth, auto compact, bootstrap recovery, semantic search, temporal graph, and evals.';
    const mode = body.mode || 'extract';

    if (!hasMemoryLLM()) {
      return NextResponse.json({ success: false, error: 'Memory LLM env is not configured' }, { status: 500 });
    }

    const result = mode === 'compact'
      ? await compactWithLLM(text)
      : await extractWithLLM(text);

    return NextResponse.json({ success: result.ok, mode, result });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || String(error) }, { status: 500 });
  }
}
