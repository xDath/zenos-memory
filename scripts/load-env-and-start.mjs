#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
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
  if (shutdownSignal) process.exit(0);
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
