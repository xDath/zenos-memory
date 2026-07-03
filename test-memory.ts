import { LocalFileMemoryStore } from './app/lib/drive';
import { MemoryEngine } from './app/lib/memory-engine';
import { v4 as uuidv4 } from 'uuid';

async function test() {
  console.log('=== Zenos Memory Local Test ===');

  // Force local
  process.env.USE_LOCAL_STORE = 'true';
  process.env.LOCAL_MEMORY_DIR = '/tmp/zenos-memory-test';

  const engine = new MemoryEngine();

  // Test remember
  const mem1 = await engine.remember({
    content: "Tuan prefers gass langsung style, no unnecessary questions",
    type: "preference",
    namespace: "zenos",
    metadata: { tags: ["style", "execution"], confidence: 0.95, importance: 9 }
  });
  console.log('Remembered 1:', mem1.id);

  const mem2 = await engine.remember({
    content: "User is building custom memory system using Google Drive + Vercel",
    type: "project",
    namespace: "zenos",
    metadata: { tags: ["project", "memory"], confidence: 0.9 }
  });
  console.log('Remembered 2:', mem2.id);

  // Test recall
  const results = await engine.recall({
    query: "gass langsung style",
    namespace: "zenos",
    limit: 5
  });
  console.log('Recall results:', results.length);
  console.log('Top result content:', results[0]?.content);

  // Stats
  const stats = await engine.getStats("zenos");
  console.log('Stats:', stats);

  // Forget one
  const forgot = await engine.forget(mem2.id, "zenos");
  console.log('Forgot:', forgot);

  console.log('=== Test PASSED ===');
}

test().catch(console.error);
