import test from 'node:test';
import assert from 'node:assert/strict';
import { runIntelligenceAmplificationEval } from '../app/lib/intelligence-eval';

test('internal intelligence evaluation includes a deterministic 100-case golden counterfactual gate', () => {
  const first = runIntelligenceAmplificationEval();
  const second = runIntelligenceAmplificationEval();
  const golden = first.cases.find((item) => item.name === 'golden_100_retrieval_replay_and_counterfactual');
  assert.equal(first.success, true, JSON.stringify(first, null, 2));
  assert.equal(golden?.passed, true, JSON.stringify(golden, null, 2));
  assert.equal(golden?.details.dataset_size, 100);
  assert.equal(golden?.details.recall_at_3, 1);
  assert.equal(golden?.details.deterministic_replay, true);
  assert.equal(golden?.details.counterfactual_supported_answer_uplift, 1);
  assert.deepEqual(first.cases.map((item) => ({ name: item.name, passed: item.passed })),
    second.cases.map((item) => ({ name: item.name, passed: item.passed })));
});
