/**
 * Tests for unattended-context permission degradation.
 *
 * `/bg` and `/proactive` run without a human in the loop between
 * iterations. Inheriting `fullAuto` or `bypass` from the parent session
 * in that context means N tool calls × M iterations of unchecked
 * auto-approval. The degradation downgrades both to `acceptEdits`,
 * preserving file-write ergonomics while re-prompting on Bash.
 */

import { describe, it, expect } from 'vitest';
import { degradeForUnattended } from '../src/policy/modes.js';
import type { PermissionMode } from '../src/protocol/tools.js';

describe('degradeForUnattended', () => {
  it('degrades fullAuto to acceptEdits', () => {
    expect(degradeForUnattended('fullAuto')).toBe('acceptEdits');
  });

  it('degrades bypass to acceptEdits', () => {
    expect(degradeForUnattended('bypass')).toBe('acceptEdits');
  });

  it('preserves acceptEdits', () => {
    expect(degradeForUnattended('acceptEdits')).toBe('acceptEdits');
  });

  it('preserves default', () => {
    expect(degradeForUnattended('default')).toBe('default');
  });

  it('preserves plan', () => {
    expect(degradeForUnattended('plan')).toBe('plan');
  });

  it('is idempotent', () => {
    const modes: PermissionMode[] = ['plan', 'default', 'acceptEdits', 'fullAuto', 'bypass'];
    for (const m of modes) {
      expect(degradeForUnattended(degradeForUnattended(m))).toBe(degradeForUnattended(m));
    }
  });
});

describe('BackgroundManager permission degradation', () => {
  // We inspect the source to verify wiring instead of spawning a full
  // runtime. The presence of `degradeForUnattended` in background.ts and
  // the `options.allowFullAuto` gate is what we're locking in.
  it('background.ts imports degradeForUnattended', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/automation/background.ts', 'utf-8');
    expect(src).toMatch(/import\s*\{[^}]*degradeForUnattended[^}]*\}\s*from\s*'\.\.\/policy\/modes\.js'/);
  });

  it('background.ts start() accepts allowFullAuto option', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/automation/background.ts', 'utf-8');
    expect(src).toMatch(/allowFullAuto\?:\s*boolean/);
    expect(src).toMatch(/options\.allowFullAuto/);
  });

  it('proactive.ts degrades toolContext.permissionMode unless allowFullAuto', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/automation/proactive.ts', 'utf-8');
    expect(src).toMatch(/allowFullAuto\?:\s*boolean/);
    expect(src).toMatch(/degradeForUnattended\(originalCtx\.permissionMode\)/);
  });

  it('/bg command parses --fullauto flag and threads it to start()', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/commands/automation.ts', 'utf-8');
    expect(src).toMatch(/--fullauto/);
    expect(src).toMatch(/allowFullAuto/);
  });
});
