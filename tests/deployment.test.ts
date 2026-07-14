import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Memory deployment activates the release only after preparation completes', () => {
  const installer = readFileSync('deploy/install-local-service.sh', 'utf8');
  const releaseCreated = installer.indexOf('mv "${STAGING}" "${RELEASE_ROOT}"');
  const credentialPrepared = installer.indexOf('prepare-service-environment.mjs');
  const pluginInstalled = installer.indexOf('install-hermes-plugin.sh');
  const unitInstalled = installer.indexOf('deploy/zenos-memory.service');
  const releaseActivated = installer.indexOf('ln -sfn "${RELEASE_ROOT}" /opt/zenos-memory/current');
  const serviceRestarted = installer.indexOf('systemctl restart zenos-memory.service', releaseActivated);

  assert.ok(releaseCreated >= 0);
  assert.ok(credentialPrepared > releaseCreated);
  assert.ok(pluginInstalled > credentialPrepared);
  assert.ok(unitInstalled > pluginInstalled);
  assert.ok(releaseActivated > unitInstalled);
  assert.ok(serviceRestarted > releaseActivated);
});
