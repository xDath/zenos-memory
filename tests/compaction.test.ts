import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompactionEvidencePacket,
  buildDagCompactSnapshot,
  CompactRequestSchema,
  selectDurableUserGoal,
} from '../app/lib/compaction';
import { computeContinuityPacketHash } from '../app/lib/continuity-packet';

test('ContinuityPacket hash matches the Python and Runtime cross-language fixture', () => {
  const fixture = {
    version: 'continuity-v2' as const,
    sessionId: 'fixture-session',
    turnId: 'fixture-turn',
    sourceCursor: 'msg:3:fixture',
    estimatedTokens: 123456,
    head: [{ role: 'user' as const, content: 'Preserve tujuan utama.', message_id: 'm0' }],
    milestones: [{
      kind: 'decision' as const,
      text: 'Runtime owns checkpoints.',
      sourceMessageIds: ['m1'],
      sourceHash: 'a'.repeat(64),
      occurredAt: '2026-07-21T00:00:00.000Z',
    }],
    recentTail: [{ role: 'user' as const, content: 'Continue validation.', message_id: 'm2' }],
    activeToolState: [],
    openWork: [],
    previousCheckpointId: 'checkpoint-0',
  };
  assert.equal(
    computeContinuityPacketHash({ ...fixture, contentHash: '' }),
    'fa768c2c48eb15230c08088c924926001c71670c650c95f11f8bc533a1ec67d9',
  );
});

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

test('evidence-ranked compaction preserves high-signal middle context and the durable goal', () => {
  const messages = Array.from({ length: 520 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `Routine low-signal message ${index}`,
  }));
  messages[4] = { role: 'user', content: 'Perbaiki Zenos Runtime sampai satu command bisa lanjut melewati compaction tanpa kehilangan task state.' };
  messages[271] = { role: 'assistant', content: 'Final decision: canonical workspace must use /srv/etla/workspaces and never /root/openclaw-projects inside Hermes.' };
  messages[519] = { role: 'user', content: 'lanjut' };

  const packet = buildCompactionEvidencePacket(messages, 18_000);
  assert.match(packet.text, /canonical workspace must use \/srv\/etla\/workspaces/i);
  assert.match(packet.currentGoal, /satu command bisa lanjut melewati compaction/i);
  assert.ok(packet.omittedMessages > 0);
  assert.ok(packet.text.length <= 18_000);
  assert.ok(packet.categoryCoverage.decision > 0);
  assert.equal(selectDurableUserGoal(messages), packet.currentGoal);
});

test('evidence packet respects hard bounds even when protected messages are oversized', () => {
  const messages = [
    { role: 'user', content: `Build the durable task safely. ${'a'.repeat(20_000)}` },
    ...Array.from({ length: 80 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'tool',
      content: `failure decision task artifact ${index} ${'b'.repeat(4_000)}`,
    })),
    { role: 'user', content: `lanjutkan implementasi yang sama ${'c'.repeat(20_000)}` },
  ];
  const packet = buildCompactionEvidencePacket(messages, 8_000);
  assert.ok(packet.text.length <= 8_000);
  assert.match(packet.text, /Build the durable task safely/i);
  assert.match(packet.text, /lanjutkan implementasi yang sama/i);
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
