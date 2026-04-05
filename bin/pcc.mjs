#!/usr/bin/env node

// Auto-load .env from project root or ~/.pcc/.env
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

function loadEnv(path) {
  try {
    const content = readFileSync(path, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
    return true;
  } catch { return false; }
}

// Priority: cwd/.env > ~/.pcc/.env > package root/.env
loadEnv(join(process.cwd(), '.env'));
loadEnv(join(homedir(), '.pcc', '.env'));
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv(join(__dirname, '..', '.env'));

import('../dist/entrypoints/cli.js');
