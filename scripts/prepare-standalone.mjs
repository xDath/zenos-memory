#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const standalone = path.join(root, '.next', 'standalone');
if (!existsSync(path.join(standalone, 'server.js'))) {
  throw new Error('Next standalone server was not generated');
}

const staticSource = path.join(root, '.next', 'static');
const staticTarget = path.join(standalone, '.next', 'static');
if (existsSync(staticSource)) {
  mkdirSync(path.dirname(staticTarget), { recursive: true });
  cpSync(staticSource, staticTarget, { recursive: true, force: true });
}

const publicSource = path.join(root, 'public');
const publicTarget = path.join(standalone, 'public');
if (existsSync(publicSource)) {
  cpSync(publicSource, publicTarget, { recursive: true, force: true });
}

process.stdout.write('Prepared standalone Zenos Memory bundle\n');
