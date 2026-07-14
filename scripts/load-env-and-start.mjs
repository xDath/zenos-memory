#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { prewarmReadiness } from './prewarm-readiness.mjs';
import { loadZenosRuntimeEnv } from './runtime-env.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
loadZenosRuntimeEnv(projectRoot);

for (const required of ['ETLA_MASTER_SECRET']) {
  if (!process.env[required]) {
    process.stderr.write(`Zenos Memory startup failed: ${required} is not configured\n`);
    process.exit(1);
  }
}

const server = path.join(projectRoot, '.next', 'standalone', 'server.js');
if (!existsSync(server)) {
  process.stderr.write('Zenos Memory startup failed: standalone build is missing; run npm run build\n');
  process.exit(1);
}

const child = spawn(process.execPath, [server], {
  cwd: path.dirname(server),
  env: process.env,
  stdio: 'inherit',
  detached: process.platform !== 'win32',
});

let shutdownSignal = '';
let shutdownExitCode = 0;
let shutdownTimer;
function signalChildTree(signal) {
  if (!child.pid || child.killed) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    if (shutdownSignal) return;
    shutdownSignal = signal;
    signalChildTree(signal);
    shutdownTimer = setTimeout(() => signalChildTree('SIGKILL'), 20_000);
    shutdownTimer.unref();
  });
}

child.on('exit', (code, signal) => {
  if (shutdownTimer) clearTimeout(shutdownTimer);
  if (shutdownSignal) process.exit(shutdownExitCode);
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

if (process.env.NOTIFY_SOCKET) {
  void prewarmReadiness().then(() => {
    const notified = spawnSync('/usr/bin/systemd-notify', [
      '--ready',
      '--status=Drive materialization verified; Zenos Memory ready',
    ], { env: process.env, stdio: 'inherit' });
    if (notified.status !== 0) throw new Error(`systemd-notify exited with status ${notified.status}`);
    process.stdout.write('Zenos Memory Drive readiness cache prewarmed\n');
  }).catch(error => {
    process.stderr.write(`Zenos Memory startup readiness failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    shutdownSignal = 'startup-readiness-failed';
    shutdownExitCode = 1;
    signalChildTree('SIGTERM');
    shutdownTimer = setTimeout(() => signalChildTree('SIGKILL'), 5_000);
    shutdownTimer.unref();
  });
}
