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
      max_tokens: 1600,
      stream: false,
      response_format: { type: 'json_object' },
    }),
  });

  const raw = await res.text();
  if (!res.ok) return { ok: false, model, error: `HTTP ${res.status}: ${raw.slice(0, 800)}` };

  let content = '';
  try {
    const data = JSON.parse(raw);
    content = data?.choices?.[0]?.message?.content || '';
  } catch {
    const chunks = raw
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('data: '))
      .map(line => line.slice(6))
      .filter(line => line && line !== '[DONE]');
    const parts: string[] = [];
    for (const chunk of chunks) {
      try {
        const data = JSON.parse(chunk);
        const delta = data?.choices?.[0]?.delta?.content || data?.choices?.[0]?.message?.content || '';
        if (delta) parts.push(delta);
      } catch {}
    }
    content = parts.join('');

    if (!content) {
      const match = raw.match(/\"content\"\s*:\s*\"((?:\\\\.|[^\"\\\\])*)\"/);
      if (match) {
        try { content = JSON.parse(`"${match[1]}"`); } catch { content = match[1]; }
      }
    }
  }

  if (!content) return { ok: false, model, error: `No content in LLM response: ${raw.slice(0, 500)}` };
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
      content: `You are Zenos Memory extraction worker. 
Return ONLY valid JSON with these keys: facts, preferences, decisions, tasks, questions, artifacts, entities, contradictions, credentials.

For "credentials": if you detect any API key, token, password, or secret, put them here as array of objects:
[{"service": "vercel", "key": "the-actual-key-or-token", "description": "short desc"}]

Be extremely careful with secrets - only extract if clearly an API key/token.
Do not invent. Be faithful to the text.`,
    },
    { role: 'user', content: text.slice(0, 16000) },
  ]);
}

export async function compactWithLLM(text: string): Promise<MemoryLLMResult> {
  return callMemoryLLM([
    {
      role: 'system',
      content: `You are Zenos Memory compaction worker for structured handoff.
Return ONLY valid JSON with:
{
  "current_goal": "...",
  "active_state": "...",
  "key_decisions": ["..."],
  "user_preferences": {...},
  "important_facts": ["..."],
  "completed_work": ["..."],
  "pending_work": ["..."],
  "blockers": ["..."],
  "files_artifacts": ["..."],
  "recovery_instructions": "...",
  "credentials": [{"service": "...", "key": "...", "description": "..."}]   // if any API keys/tokens are mentioned
}

Preserve any credentials mentioned. Do not leak them elsewhere.`,
    },
    { role: 'user', content: text.slice(0, 24000) },
  ]);
}
