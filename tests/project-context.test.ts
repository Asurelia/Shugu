import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProjectContext } from '../src/context/workspace/project.js';

describe('getProjectContext', () => {
  let projectDir = '';

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'project-context-'));
  });

  afterEach(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('detects .NET projects from csproj files in the workspace root', async () => {
    await writeFile(join(projectDir, 'App.csproj'), '<Project />', 'utf-8');

    const context = await getProjectContext(projectDir);

    expect(context.type).toBe('dotnet');
    expect(context.configFiles).toContain('App.csproj');
  });

  it('loads SHUGU.md as custom instructions when present', async () => {
    await mkdir(join(projectDir, '.pcc'), { recursive: true });
    await writeFile(join(projectDir, 'SHUGU.md'), '# Instructions', 'utf-8');

    const context = await getProjectContext(projectDir);

    expect(context.customInstructions).toContain('Instructions');
  });
});
