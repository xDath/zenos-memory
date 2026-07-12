import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

function routeFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...routeFiles(target));
    else if (entry.name === 'route.ts') files.push(target);
  }
  return files;
}

test('the complete Memory API surface is explicitly public, retired, or authenticated', () => {
  const apiRoot = path.resolve('app', 'api');
  const routes = routeFiles(apiRoot);
  assert.ok(routes.length >= 50, `Expected the full API surface, found ${routes.length} routes`);
  const publicRoutes = new Set([
    path.normalize('health/route.ts'),
    path.normalize('memory/public-status/route.ts'),
  ]);
  const retiredPrefix = path.normalize('memory/runtime/');
  const failures: string[] = [];

  for (const file of routes) {
    const relative = path.relative(apiRoot, file);
    const source = fs.readFileSync(file, 'utf8');
    if (publicRoutes.has(relative)) {
      if (!/no-store/i.test(source)) failures.push(`${relative}: public response is not explicitly non-cacheable`);
      continue;
    }
    if (relative.startsWith(retiredPrefix)) {
      if (!/status:\s*410/.test(source) || !/no-store/i.test(source)) failures.push(`${relative}: retired Runtime shim must stay 410 and non-cacheable`);
      continue;
    }
    if (!/validateApiKey|authenticateTokenExchange/.test(source)) {
      failures.push(`${relative}: protected route has no explicit authentication marker`);
    }
  }

  assert.deepEqual(failures, []);
});
