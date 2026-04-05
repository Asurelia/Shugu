/**
 * Layer 6 — Integrations: CLI Discovery
 *
 * Auto-detects installed CLIs and loads project-level pcc-tools.yaml.
 * Returns a list of available adapters with their hints for prompt injection.
 */

import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { CliAdapter, ProjectToolConfig } from './adapter.js';
import { mergeProjectTools } from './adapter.js';

// ─── Builtin Adapters ───────────────────────────────────

/**
 * Hardcoded builtin adapters — no YAML parsing needed for these.
 * Kept in code for zero-dependency boot.
 */
const BUILTIN_ADAPTERS: CliAdapter[] = [
  {
    name: 'git',
    description: 'Git version control',
    detect: 'git --version',
    hint: `Use Bash for git commands. Key commands:
  - git status, git diff, git log --oneline -10
  - git add <file>, git commit -m "message"
  - git branch, git checkout -b <name>
  - git push, git pull, git stash
  Do NOT use: git push --force, git reset --hard, git clean -f (destructive)`,
  },
  {
    name: 'node',
    description: 'Node.js runtime',
    detect: 'node --version',
    hint: `Node.js available. Use Bash for:
  - node <script.js>, node -e "code"
  - npm install, npm run <script>, npm test
  - npx <package> for one-off commands`,
  },
  {
    name: 'gh',
    description: 'GitHub CLI',
    detect: 'gh --version',
    hint: `GitHub CLI available. Use Bash for:
  - gh pr list, gh pr view <n>, gh pr create
  - gh issue list, gh issue create --title "..." --body "..."
  - gh repo view, gh release list
  - gh api <endpoint> for raw API calls
  Auth: gh auth login`,
  },
  {
    name: 'docker',
    description: 'Docker container management',
    detect: 'docker --version',
    hint: `Docker available. Use Bash for:
  - docker ps, docker images, docker logs <container>
  - docker compose up -d, docker compose down
  - docker build -t <name> ., docker run <image>`,
  },
  {
    name: 'python3',
    description: 'Python 3 runtime',
    detect: 'python3 --version',
    hint: `Python 3 available. Use Bash for:
  - python3 <script.py>, python3 -c "code"
  - pip install <package>, pip list
  - python3 -m venv .venv for virtual environments`,
  },
  {
    name: 'cargo',
    description: 'Rust package manager',
    detect: 'cargo --version',
    hint: `Cargo (Rust) available. Use Bash for:
  - cargo build, cargo run, cargo test
  - cargo add <crate>, cargo check
  - rustc --edition 2021 <file.rs>`,
  },
  {
    name: 'go',
    description: 'Go programming language',
    detect: 'go version',
    hint: `Go available. Use Bash for:
  - go build, go run ., go test ./...
  - go mod init, go mod tidy, go get <pkg>`,
  },
  {
    name: 'kubectl',
    description: 'Kubernetes CLI',
    detect: 'kubectl version --client',
    hint: `kubectl available. Use Bash for:
  - kubectl get pods, kubectl get services
  - kubectl logs <pod>, kubectl describe <resource>
  - kubectl apply -f <file>, kubectl delete -f <file>`,
  },
  {
    name: 'rg',
    description: 'ripgrep (fast search)',
    detect: 'rg --version',
    hint: `ripgrep available for fast content search. Prefer Grep tool over Bash+rg.`,
  },
];

// ─── Discovery ──────────────────────────────────────────

/**
 * Discover all available CLI tools.
 * 1. Check builtin adapters against installed CLIs
 * 2. Load project-level pcc-tools.yaml if it exists
 * 3. Merge and return
 */
export async function discoverTools(cwd: string): Promise<CliAdapter[]> {
  // Detect which builtins are installed (in parallel)
  const detectedBuiltins = await Promise.all(
    BUILTIN_ADAPTERS.map(async (adapter) => ({
      ...adapter,
      installed: await isCliInstalled(adapter.detect),
    })),
  );

  // Load project-level tools config
  const projectTools = await loadProjectTools(cwd);

  // Merge
  const merged = mergeProjectTools(detectedBuiltins, projectTools);

  // Re-detect any new tools added by project config
  const finalAdapters = await Promise.all(
    merged.map(async (adapter) => {
      if (adapter.installed !== undefined) return adapter;
      return {
        ...adapter,
        installed: await isCliInstalled(adapter.detect),
      };
    }),
  );

  return finalAdapters;
}

/**
 * Get a summary of discovered tools for display.
 */
export function getDiscoverySummary(adapters: CliAdapter[]): string {
  const installed = adapters.filter((a) => a.installed);
  if (installed.length === 0) return 'No CLI tools detected';
  return installed.map((a) => a.name).join(', ');
}

// ─── CLI Detection ──────────────────────────────────────

async function isCliInstalled(detectCommand: string): Promise<boolean> {
  const [cmd, ...args] = detectCommand.split(/\s+/);
  if (!cmd) return false;

  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

// ─── Project Tools Loading ──────────────────────────────

async function loadProjectTools(cwd: string): Promise<ProjectToolConfig[]> {
  const possiblePaths = [
    join(cwd, 'pcc-tools.yaml'),
    join(cwd, 'pcc-tools.yml'),
    join(cwd, '.pcc', 'tools.yaml'),
    join(cwd, '.pcc', 'tools.yml'),
  ];

  for (const path of possiblePaths) {
    try {
      const content = await readFile(path, 'utf-8');
      const parsed = parseYaml(content) as { tools?: ProjectToolConfig[] };
      return parsed?.tools ?? [];
    } catch {
      // File doesn't exist, try next
    }
  }

  return [];
}
