/**
 * /init command — Project initialization
 *
 * Analyzes the current working directory and generates a SHUGU.md
 * project instruction file + creates .pcc/ directory.
 * Like Claude Code's /init for CLAUDE.md.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command, CommandContext, CommandResult } from './registry.js';
import { fileExists } from '../utils/fs.js';

// ─── Project Detection ────────────────────────────────

interface ProjectInfo {
  languages: string[];
  framework?: string;
  buildCmd?: string;
  testCmd?: string;
  lintCmd?: string;
  packageManager?: string;
}

async function detectProject(cwd: string): Promise<ProjectInfo> {
  const info: ProjectInfo = { languages: [] };

  // package.json → Node.js
  if (await fileExists(join(cwd, 'package.json'))) {
    try {
      const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf-8'));
      info.languages.push('JavaScript');
      if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript) info.languages.push('TypeScript');
      if (pkg.dependencies?.react || pkg.devDependencies?.react) info.framework = 'React';
      if (pkg.dependencies?.next) info.framework = 'Next.js';
      if (pkg.dependencies?.vue) info.framework = 'Vue';
      if (pkg.dependencies?.express) info.framework = 'Express';
      info.buildCmd = pkg.scripts?.build ? 'npm run build' : undefined;
      info.testCmd = pkg.scripts?.test ? 'npm test' : undefined;
      info.lintCmd = pkg.scripts?.lint ? 'npm run lint' : undefined;
      info.packageManager = await fileExists(join(cwd, 'pnpm-lock.yaml')) ? 'pnpm'
        : await fileExists(join(cwd, 'yarn.lock')) ? 'yarn'
        : await fileExists(join(cwd, 'bun.lockb')) ? 'bun'
        : 'npm';
    } catch { /* skip */ }
  }

  // Cargo.toml → Rust
  if (await fileExists(join(cwd, 'Cargo.toml'))) {
    info.languages.push('Rust');
    info.buildCmd = 'cargo build';
    info.testCmd = 'cargo test';
  }

  // go.mod → Go
  if (await fileExists(join(cwd, 'go.mod'))) {
    info.languages.push('Go');
    info.buildCmd = 'go build ./...';
    info.testCmd = 'go test ./...';
  }

  // requirements.txt / pyproject.toml → Python
  if (await fileExists(join(cwd, 'requirements.txt')) || await fileExists(join(cwd, 'pyproject.toml'))) {
    info.languages.push('Python');
    if (await fileExists(join(cwd, 'pyproject.toml'))) {
      info.testCmd = 'pytest';
      info.lintCmd = 'ruff check .';
    }
  }

  // Fallback
  if (info.languages.length === 0) info.languages.push('Unknown');

  return info;
}

// ─── SHUGU.md Generation ──────────────────────────────

function generateShugeMd(cwd: string, info: ProjectInfo): string {
  const projectName = cwd.split(/[\\/]/).pop() ?? 'project';
  const lines: string[] = [
    `# ${projectName} — Shugu Project Instructions`,
    '',
    '## Project',
    `- Language: ${info.languages.join(', ')}`,
  ];

  if (info.framework) lines.push(`- Framework: ${info.framework}`);
  if (info.packageManager) lines.push(`- Package manager: ${info.packageManager}`);

  lines.push('');
  lines.push('## Commands');
  if (info.buildCmd) lines.push(`- Build: \`${info.buildCmd}\``);
  if (info.testCmd) lines.push(`- Test: \`${info.testCmd}\``);
  if (info.lintCmd) lines.push(`- Lint: \`${info.lintCmd}\``);

  lines.push('');
  lines.push('## Conventions');
  lines.push('- Write complete implementations, no stubs or TODOs');
  lines.push('- Test after every change');
  lines.push('- Follow existing code patterns');

  lines.push('');
  lines.push('## Notes');
  lines.push('- Add project-specific instructions here');
  lines.push('- Shugu reads this file at the start of every session');
  lines.push('');

  return lines.join('\n');
}

// ─── Command ──────────────────────────────────────────

export const initCommand: Command = {
  name: 'init',
  aliases: ['setup'],
  description: 'Initialize project with SHUGU.md and .pcc/ directory',
  async execute(args: string, ctx: CommandContext): Promise<CommandResult> {
    const cwd = ctx.cwd;
    const shuguPath = join(cwd, 'SHUGU.md');
    const pccDir = join(cwd, '.pcc');

    // Check if already initialized
    if (await fileExists(shuguPath)) {
      ctx.info('  SHUGU.md already exists. Use the model to suggest improvements:');
      return {
        type: 'prompt',
        prompt: `Read SHUGU.md and suggest improvements based on the current codebase. Show the proposed changes.`,
      };
    }

    // Detect project
    ctx.info('  Analyzing project...');
    const info = await detectProject(cwd);

    // Generate SHUGU.md
    const content = generateShugeMd(cwd, info);
    await writeFile(shuguPath, content, 'utf-8');
    ctx.info(`  Created SHUGU.md (${info.languages.join(', ')}${info.framework ? ` / ${info.framework}` : ''})`);

    // Create .pcc/ directory
    await mkdir(pccDir, { recursive: true });
    await mkdir(join(pccDir, 'memory'), { recursive: true });
    ctx.info('  Created .pcc/ directory');

    ctx.info('  Project initialized! Edit SHUGU.md to customize instructions.');
    return { type: 'handled' };
  },
};
