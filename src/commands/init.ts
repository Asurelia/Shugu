/**
 * /init command — Project initialization
 *
 * Analyzes the current working directory deeply and generates a rich SHUGU.md
 * project instruction file + creates .pcc/ directory.
 *
 * Detection covers: Node.js, Python, Rust, Go, Java/Kotlin, .NET, Ruby,
 * Elixir, PHP, Dart/Flutter, Swift, C/C++, and fallback via file extensions.
 */

import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { Command, CommandContext, CommandResult } from './registry.js';
import { fileExists } from '../utils/fs.js';

// ─── Project Detection ────────────────────────────────

interface ProjectInfo {
  name: string;
  languages: string[];
  framework?: string;
  buildCmd?: string;
  testCmd?: string;
  lintCmd?: string;
  packageManager?: string;
  structure: string[];
  lockfiles: string[];
  envVars: string[];
  testFramework?: string;
  hasCi: boolean;
  hasDocker: boolean;
  hasGit: boolean;
}

async function detectProject(cwd: string): Promise<ProjectInfo> {
  const name = cwd.split(/[\\/]/).pop() ?? 'project';
  const info: ProjectInfo = {
    name,
    languages: [],
    structure: [],
    lockfiles: [],
    envVars: [],
    hasCi: false,
    hasDocker: false,
    hasGit: false,
  };

  // Read directory contents once
  let entries: string[] = [];
  try {
    entries = await readdir(cwd);
  } catch {
    return info;
  }

  // ── Detect structure ──
  const dirs = ['src', 'lib', 'app', 'tests', 'test', '__tests__', 'spec',
    'docs', 'scripts', 'config', 'public', 'static', 'assets', 'components',
    'pages', 'api', 'server', 'client', 'packages', 'modules', 'services'];
  for (const d of dirs) {
    if (entries.includes(d)) {
      try {
        const s = await stat(join(cwd, d));
        if (s.isDirectory()) info.structure.push(d);
      } catch { /* skip */ }
    }
  }

  // ── Infrastructure detection ──
  info.hasGit = entries.includes('.git');
  info.hasDocker = entries.includes('Dockerfile') || entries.includes('docker-compose.yml') || entries.includes('docker-compose.yaml');
  info.hasCi = entries.includes('.github') || entries.includes('.gitlab-ci.yml') || entries.includes('.circleci') || entries.includes('Jenkinsfile');

  // ── Lockfile detection ──
  const lockfiles: Record<string, string> = {
    'package-lock.json': 'npm', 'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn',
    'bun.lockb': 'bun', 'Cargo.lock': 'cargo', 'go.sum': 'go',
    'Gemfile.lock': 'bundler', 'poetry.lock': 'poetry', 'Pipfile.lock': 'pipenv',
    'composer.lock': 'composer', 'pubspec.lock': 'pub', 'mix.lock': 'mix',
    'Package.resolved': 'swift-pm',
  };
  for (const [file, mgr] of Object.entries(lockfiles)) {
    if (entries.includes(file)) {
      info.lockfiles.push(file);
      if (!info.packageManager) info.packageManager = mgr;
    }
  }

  // ── Environment variable detection ──
  for (const envFile of ['.env.example', '.env.sample', '.env.template']) {
    if (await fileExists(join(cwd, envFile))) {
      try {
        const content = await readFile(join(cwd, envFile), 'utf-8');
        const vars = content.split('\n')
          .filter(l => l.includes('=') && !l.startsWith('#'))
          .map(l => l.split('=')[0]!.trim())
          .filter(v => v.length > 0)
          .slice(0, 20);
        info.envVars.push(...vars);
      } catch { /* skip */ }
      break;
    }
  }

  // ── Language & Framework detection ──

  // Node.js / JavaScript / TypeScript
  if (entries.includes('package.json')) {
    try {
      const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf-8'));
      info.languages.push('JavaScript');
      if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript || entries.includes('tsconfig.json')) {
        info.languages.push('TypeScript');
      }
      // Frameworks
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (allDeps.next) info.framework = 'Next.js';
      else if (allDeps.nuxt) info.framework = 'Nuxt';
      else if (allDeps['@angular/core']) info.framework = 'Angular';
      else if (allDeps.svelte || allDeps['@sveltejs/kit']) info.framework = 'Svelte/SvelteKit';
      else if (allDeps.react) info.framework = 'React';
      else if (allDeps.vue) info.framework = 'Vue';
      else if (allDeps.express) info.framework = 'Express';
      else if (allDeps.fastify) info.framework = 'Fastify';
      else if (allDeps.hono) info.framework = 'Hono';
      else if (allDeps.astro) info.framework = 'Astro';
      // Commands
      info.buildCmd = pkg.scripts?.build ? `${info.packageManager ?? 'npm'} run build` : undefined;
      info.testCmd = pkg.scripts?.test ? `${info.packageManager ?? 'npm'} test` : undefined;
      info.lintCmd = pkg.scripts?.lint ? `${info.packageManager ?? 'npm'} run lint` : undefined;
      // Test framework
      if (allDeps.vitest) info.testFramework = 'Vitest';
      else if (allDeps.jest) info.testFramework = 'Jest';
      else if (allDeps.mocha) info.testFramework = 'Mocha';
      else if (allDeps.playwright || allDeps['@playwright/test']) info.testFramework = 'Playwright';
    } catch { /* skip */ }
  }

  // Python
  if (entries.includes('pyproject.toml') || entries.includes('setup.py') || entries.includes('setup.cfg') || entries.includes('requirements.txt') || entries.includes('Pipfile')) {
    if (!info.languages.includes('Python')) info.languages.push('Python');
    if (!info.testCmd) info.testCmd = 'pytest';
    if (!info.lintCmd) info.lintCmd = 'ruff check .';
    if (entries.includes('pyproject.toml')) {
      try {
        const content = await readFile(join(cwd, 'pyproject.toml'), 'utf-8');
        if (content.includes('django')) info.framework = 'Django';
        else if (content.includes('fastapi')) info.framework = 'FastAPI';
        else if (content.includes('flask')) info.framework = 'Flask';
      } catch { /* skip */ }
    }
    if (!info.testFramework) info.testFramework = 'pytest';
  }

  // Rust
  if (entries.includes('Cargo.toml')) {
    info.languages.push('Rust');
    info.buildCmd = 'cargo build';
    info.testCmd = 'cargo test';
    info.lintCmd = 'cargo clippy';
    info.testFramework = 'cargo test';
  }

  // Go
  if (entries.includes('go.mod')) {
    info.languages.push('Go');
    info.buildCmd = 'go build ./...';
    info.testCmd = 'go test ./...';
    info.lintCmd = 'golangci-lint run';
    info.testFramework = 'go test';
  }

  // Java / Kotlin
  if (entries.includes('pom.xml')) {
    info.languages.push('Java');
    info.buildCmd = 'mvn compile';
    info.testCmd = 'mvn test';
    info.packageManager = 'maven';
  } else if (entries.includes('build.gradle') || entries.includes('build.gradle.kts')) {
    info.languages.push(entries.includes('build.gradle.kts') ? 'Kotlin' : 'Java');
    info.buildCmd = './gradlew build';
    info.testCmd = './gradlew test';
    info.packageManager = 'gradle';
  }

  // .NET / C#
  const csproj = entries.find(e => e.endsWith('.csproj'));
  const sln = entries.find(e => e.endsWith('.sln'));
  if (csproj || sln) {
    info.languages.push('C#');
    info.buildCmd = 'dotnet build';
    info.testCmd = 'dotnet test';
    info.framework = '.NET';
  }

  // Ruby
  if (entries.includes('Gemfile')) {
    info.languages.push('Ruby');
    info.testCmd = 'bundle exec rspec';
    info.testFramework = 'RSpec';
    if (entries.includes('config.ru') || entries.includes('Rakefile')) info.framework = 'Rails';
  }

  // Elixir
  if (entries.includes('mix.exs')) {
    info.languages.push('Elixir');
    info.buildCmd = 'mix compile';
    info.testCmd = 'mix test';
    if (entries.includes('lib') && entries.includes('config')) info.framework = 'Phoenix';
  }

  // PHP
  if (entries.includes('composer.json')) {
    info.languages.push('PHP');
    info.testCmd = 'vendor/bin/phpunit';
    try {
      const content = await readFile(join(cwd, 'composer.json'), 'utf-8');
      if (content.includes('laravel')) info.framework = 'Laravel';
      else if (content.includes('symfony')) info.framework = 'Symfony';
    } catch { /* skip */ }
  }

  // Dart / Flutter
  if (entries.includes('pubspec.yaml')) {
    info.languages.push('Dart');
    if (entries.includes('lib') && entries.includes('android')) info.framework = 'Flutter';
    info.testCmd = info.framework === 'Flutter' ? 'flutter test' : 'dart test';
  }

  // Swift
  if (entries.includes('Package.swift')) {
    info.languages.push('Swift');
    info.buildCmd = 'swift build';
    info.testCmd = 'swift test';
  }

  // C / C++
  if (entries.includes('CMakeLists.txt')) {
    info.languages.push('C/C++');
    info.buildCmd = 'cmake --build build';
    info.testCmd = 'ctest --test-dir build';
  } else if (entries.includes('Makefile') && info.languages.length === 0) {
    info.languages.push('C/C++');
    info.buildCmd = 'make';
    info.testCmd = 'make test';
  }

  // ── Fallback: scan file extensions ──
  if (info.languages.length === 0) {
    const extCounts = new Map<string, number>();
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const ext = extname(entry).toLowerCase();
      if (ext) extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
    }
    // Also scan src/ if it exists
    if (info.structure.includes('src')) {
      try {
        const srcEntries = await readdir(join(cwd, 'src'));
        for (const entry of srcEntries) {
          const ext = extname(entry).toLowerCase();
          if (ext) extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
        }
      } catch { /* skip */ }
    }

    const extToLang: Record<string, string> = {
      '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript',
      '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.java': 'Java', '.kt': 'Kotlin',
      '.cs': 'C#', '.rb': 'Ruby', '.ex': 'Elixir', '.exs': 'Elixir', '.php': 'PHP',
      '.dart': 'Dart', '.swift': 'Swift', '.c': 'C', '.cpp': 'C++', '.h': 'C/C++',
      '.lua': 'Lua', '.zig': 'Zig', '.scala': 'Scala', '.clj': 'Clojure',
      '.r': 'R', '.R': 'R', '.jl': 'Julia', '.sh': 'Shell', '.bash': 'Shell',
    };

    const sorted = [...extCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [ext] of sorted.slice(0, 3)) {
      const lang = extToLang[ext];
      if (lang && !info.languages.includes(lang)) info.languages.push(lang);
    }
  }

  return info;
}

// ─── SHUGU.md Generation ──────────────────────────────

function generateShuguMd(info: ProjectInfo): string {
  const lines: string[] = [];

  // Header
  lines.push(`# ${info.name}`);
  lines.push('');

  // Project overview
  lines.push('## Project');
  if (info.languages.length > 0) {
    lines.push(`- Language: ${info.languages.join(', ')}`);
  }
  if (info.framework) lines.push(`- Framework: ${info.framework}`);
  if (info.packageManager) lines.push(`- Package manager: ${info.packageManager}`);

  // Architecture
  if (info.structure.length > 0) {
    lines.push('');
    lines.push('## Architecture');
    lines.push(`- Structure: ${info.structure.join(', ')}`);
    if (info.structure.includes('packages') || info.structure.includes('modules')) {
      lines.push('- Type: Monorepo');
    }
  }

  // Commands
  const hasCommands = info.buildCmd || info.testCmd || info.lintCmd;
  if (hasCommands) {
    lines.push('');
    lines.push('## Commands');
    if (info.buildCmd) lines.push(`- Build: \`${info.buildCmd}\``);
    if (info.testCmd) lines.push(`- Test: \`${info.testCmd}\``);
    if (info.lintCmd) lines.push(`- Lint: \`${info.lintCmd}\``);
  }

  // Testing
  if (info.testFramework) {
    lines.push('');
    lines.push('## Testing');
    lines.push(`- Framework: ${info.testFramework}`);
    lines.push('- Run tests after every change');
    lines.push('- Write tests that verify behavior, not just that code runs');
  }

  // Environment
  if (info.envVars.length > 0) {
    lines.push('');
    lines.push('## Environment');
    lines.push('Required variables:');
    for (const v of info.envVars.slice(0, 15)) {
      lines.push(`- \`${v}\``);
    }
  }

  // Infrastructure
  const infraItems: string[] = [];
  if (info.hasDocker) infraItems.push('Docker');
  if (info.hasCi) infraItems.push('CI/CD');
  if (info.hasGit) infraItems.push('Git');
  if (infraItems.length > 0) {
    lines.push('');
    lines.push('## Infrastructure');
    lines.push(`- ${infraItems.join(', ')}`);
  }

  // Conventions
  lines.push('');
  lines.push('## Conventions');
  lines.push('- Write complete implementations — no stubs, no TODOs, no placeholders');
  lines.push('- Test after every change — run the build, run the tests, verify it works');
  lines.push('- Read existing code before modifying — integrate into existing patterns');
  lines.push('- Minimal comments — only when the WHY is non-obvious');

  // Empty project guidance
  if (info.languages.length === 0 && !hasCommands) {
    lines.push('');
    lines.push('## Getting Started');
    lines.push('This appears to be a new project. To help Shugu assist you better:');
    lines.push('1. Describe what you\'re building in this file');
    lines.push('2. List the tech stack you plan to use');
    lines.push('3. Add build/test/lint commands once configured');
    lines.push('4. Run `/init` again after setting up the project to auto-detect');
  }

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
        prompt: 'Read SHUGU.md and suggest improvements based on the current codebase. Show the proposed changes.',
      };
    }

    // Detect project
    ctx.info('  Analyzing project...');
    const info = await detectProject(cwd);

    // Generate SHUGU.md
    const content = generateShuguMd(info);
    await writeFile(shuguPath, content, 'utf-8');

    const langStr = info.languages.length > 0 ? info.languages.join(', ') : 'empty project';
    const fwStr = info.framework ? ` / ${info.framework}` : '';
    ctx.info(`  Created SHUGU.md (${langStr}${fwStr})`);

    // Create .pcc/ directory
    await mkdir(pccDir, { recursive: true });
    await mkdir(join(pccDir, 'memory'), { recursive: true });
    ctx.info('  Created .pcc/ directory');

    if (info.structure.length > 0) {
      ctx.info(`  Detected: ${info.structure.join(', ')}`);
    }

    ctx.info('  Project initialized! Edit SHUGU.md to customize.');
    return { type: 'handled' };
  },
};
