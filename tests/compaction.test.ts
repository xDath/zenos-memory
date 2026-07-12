import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDagCompactSnapshot,
  CompactRequestSchema,
} from '../app/lib/compaction';

test('compact contract separates large bounded input from small durable output', () => {
  const parsed = CompactRequestSchema.parse({
    messages: [{ role: 'user', content: 'Preserve the active goal.' }],
    input_max_chars: 500_000,
    max_chars: 10_000,
    mode: 'dag',
  });

  assert.equal(parsed.input_max_chars, 500_000);
  assert.equal(parsed.max_chars, 10_000);
  assert.throws(() => CompactRequestSchema.parse({
    messages: [{ role: 'user', content: 'too large' }],
    input_max_chars: 500_001,
  }));
});

test('DAG compaction preserves active tasks decisions questions and artifacts within the output budget', () => {
  const messages = Array.from({ length: 260 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `Routine message ${index}`,
  }));
  messages.push(
    { role: 'user', content: 'Gass implement Host context compression and push to GitHub?' },
    { role: 'assistant', content: 'Final decision: use Zenos Memory handoff and keep recent raw context.' },
    { role: 'user', content: 'Pending task: update app/lib/gateway-orchestration.ts and run tests.' },
  );

  const compact = buildDagCompactSnapshot(CompactRequestSchema.parse({
    messages,
    session_id: 'long-session',
    approx_tokens: 190_000,
    max_chars: 8_000,
    input_max_chars: 240_000,
    mode: 'dag',
  }));

  assert.ok(compact.content.length <= 8_000);
  assert.ok(compact.blocks.tasks.some((item) => /gateway-orchestration/i.test(item)));
  assert.ok(compact.blocks.decisions.some((item) => /Zenos Memory handoff/i.test(item)));
  assert.ok(compact.blocks.questions.some((item) => /GitHub/i.test(item)));
  assert.ok((compact.blocks.artifacts || []).some((item) => /app\/lib\/gateway-orchestration\.ts/i.test(item)));
  assert.ok((compact.blocks.compaction_nodes || []).length > 1);
});
