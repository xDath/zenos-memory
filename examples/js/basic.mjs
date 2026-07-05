import { ZenosMemoryClient } from '../../sdk/js/zenos-memory-client.mjs';

const memory = new ZenosMemoryClient();

await memory.remember('Zenos Memory JavaScript SDK example ran successfully.', {
  namespace: 'zenos',
  metadata: { source: 'example-js', importance: 4 },
});

const recall = await memory.recall('JavaScript SDK example', { namespace: 'zenos', limit: 3 });
console.log(JSON.stringify({ count: recall.count, first: recall.results?.[0]?.id }, null, 2));
