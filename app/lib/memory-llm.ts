export interface MemoryLLMResult {
  ok: boolean;
  model?: string;
  content?: string;
  parsed?: any;
  error?: string;
}

function stripJsonFence(text: string): string {
  return text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
}

function safeJsonParse(text: string): any | null {
  const clean = stripJsonFence(text);
  try {
    return JSON.parse(clean);
  } catch {
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(clean.slice(start, end + 1)); } catch {}
    }
    return null;
  }
}

export function hasMemoryLLM(): boolean {
  return !!(process.env.MEMORY_LLM_BASE_URL && process.env.MEMORY_LLM_API_KEY && process.env.MEMORY_LLM_MODEL);
}

async function callModel(model: string, messages: Array<{ role: string; content: string }>): Promise<MemoryLLMResult> {
  const baseUrl = (process.env.MEMORY_LLM_BASE_URL || '').replace(/\/$/, '');
  const apiKey = process.env.MEMORY_LLM_API_KEY || '';
  if (!baseUrl || !apiKey) return { ok: false, model, error: 'MEMORY_LLM_BASE_URL/API_KEY not configured' };

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.15,
      max_tokens: 1200,
    }),
  });

  const raw = await res.text();
  if (!res.ok) return { ok: false, model, error: `HTTP ${res.status}: ${raw.slice(0, 800)}` };

  let data: any;
  try { data = JSON.parse(raw); } catch { return { ok: false, model, error: `Invalid JSON response: ${raw.slice(0, 500)}` }; }

  const content = data?.choices?.[0]?.message?.content || '';
  return { ok: true, model, content, parsed: safeJsonParse(content) };
}

export async function callMemoryLLM(messages: Array<{ role: string; content: string }>): Promise<MemoryLLMResult> {
  const primary = process.env.MEMORY_LLM_MODEL || '';
  const fallback = process.env.MEMORY_LLM_FALLBACK_MODEL || '';

  if (!primary) return { ok: false, error: 'MEMORY_LLM_MODEL not configured' };

  try {
    const result = await callModel(primary, messages);
    if (result.ok) return result;
    if (fallback && fallback !== primary) {
      const fallbackResult = await callModel(fallback, messages);
      if (fallbackResult.ok) return fallbackResult;
      return { ok: false, model: fallback, error: `${result.error}; fallback: ${fallbackResult.error}` };
    }
    return result;
  } catch (error: any) {
    if (fallback && fallback !== primary) {
      try { return await callModel(fallback, messages); } catch (fallbackError: any) {
        return { ok: false, model: fallback, error: `${error.message}; fallback: ${fallbackError.message}` };
      }
    }
    return { ok: false, model: primary, error: error.message || String(error) };
  }
}

export async function extractWithLLM(text: string): Promise<MemoryLLMResult> {
  return callMemoryLLM([
    {
      role: 'system',
      content: 'You are Zenos Memory extraction worker. Return JSON only with keys: facts, preferences, decisions, tasks, questions, artifacts, entities, summary. Keep it concise and faithful. Do not include secrets.',
    },
    { role: 'user', content: text.slice(0, 16000) },
  ]);
}

export async function compactWithLLM(text: string): Promise<MemoryLLMResult> {
  return callMemoryLLM([
    {
      role: 'system',
      content: 'You are Zenos Memory compaction worker. Create a structured handoff JSON only: current_goal, active_state, key_decisions, user_preferences, important_facts, completed_work, pending_work, blockers, files_artifacts, recovery_instructions. Be concise and faithful. Do not include secrets.',
    },
    { role: 'user', content: text.slice(0, 24000) },
  ]);
}
