/**
 * Layer 5 — Context: Project detection
 *
 * Detects project type, configuration files, and loads CLAUDE.md/PCC.md
 * for injection into the system prompt.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { fileExists } from '../../utils/fs.js';

export interface ProjectContext {
  name: string;
  type: ProjectType;
  configFiles: string[];
  customInstructions?: string;
}

export type ProjectType =
  | 'node'
  | 'python'
  | 'rust'
  | 'go'
  | 'java'
  | 'dotnet'
  | 'ruby'
  | 'unknown';

/**
 * Detect project context from the working directory.
 */
export async function getProjectContext(cwd: string): Promise<ProjectContext> {
  const name = basename(cwd);
  const configFiles: string[] = [];

  // Detect project type by config files
  const typeDetectors: Array<{ file: string; type: ProjectType }> = [
    { file: 'package.json', type: 'node' },
    { file: 'pyproject.toml', type: 'python' },
    { file: 'Cargo.toml', type: 'rust' },
    { file: 'go.mod', type: 'go' },
    { file: 'pom.xml', type: 'java' },
    { file: 'build.gradle', type: 'java' },
    { file: 'Gemfile', type: 'ruby' },
  ];

  let projectType: ProjectType = 'unknown';
  for (const { file, type } of typeDetectors) {
    if (await fileExists(join(cwd, file))) {
      projectType = type;
      configFiles.push(file);
    }
  }

  try {
    const dotnetProjects = (await readdir(cwd))
      .filter((file) => file.endsWith('.csproj'));
    if (dotnetProjects.length > 0) {
      projectType = 'dotnet';
      configFiles.push(...dotnetProjects);
    }
  } catch {
    // Ignore unreadable directories
  }

  // Check for other common config files
  const commonConfigs = [
    'tsconfig.json', '.eslintrc.json', '.prettierrc',
    'Makefile', 'Dockerfile', 'docker-compose.yml',
    '.env.example', 'README.md',
  ];
  for (const file of commonConfigs) {
    if (await fileExists(join(cwd, file))) {
      configFiles.push(file);
    }
  }

  // Load and merge ALL instruction files (not first-match-wins)
  const instructionFiles = ['SHUGU.md', 'AGENTS.md', 'CLAUDE.md', 'PCC.md', '.claude/CLAUDE.md', '.pcc/instructions.md'];
  const instructionParts: string[] = [];
  for (const file of instructionFiles) {
    try {
      const content = await readFile(join(cwd, file), 'utf-8');
      instructionParts.push(`# ${file}\n${content.slice(0, 3000)}`);
    } catch {
      // Not found, skip
    }
  }
  // Cap total to ~10K chars
  let customInstructions: string | undefined;
  if (instructionParts.length > 0) {
    let merged = instructionParts.join('\n\n---\n\n');
    if (merged.length > 10_000) {
      merged = merged.slice(0, 10_000) + '\n\n[... truncated]';
    }
    customInstructions = merged;
  }

  return { name, type: projectType, configFiles, customInstructions };
}

/**
 * Load and merge ALL instruction files relevant for code review.
 * Unlike the old first-match-wins approach, this merges all sources
 * so review agents see the full picture (SHUGU.md + AGENTS.md + CLAUDE.md etc.).
 */
export async function loadReviewRules(cwd: string): Promise<string> {
  const ruleFiles = [
    'SHUGU.md', 'AGENTS.md', 'CLAUDE.md', 'PCC.md',
    '.claude/CLAUDE.md', '.pcc/instructions.md', '.pcc/review-rules.md',
  ];
  const parts: string[] = [];
  for (const file of ruleFiles) {
    try {
      const content = await readFile(join(cwd, file), 'utf-8');
      parts.push(`# Rules from ${file}\n${content.slice(0, 2000)}`);
    } catch { /* not found, skip */ }
  }
  if (parts.length === 0) return '';
  let merged = parts.join('\n\n---\n\n');
  if (merged.length > 6000) {
    merged = merged.slice(0, 6000) + '\n\n[... truncated]';
  }
  return `\n\n# Project Review Rules:\n${merged}`;
}

/**
 * Format project context for system prompt injection.
 */
export function formatProjectContext(project: ProjectContext): string {
  const lines: string[] = [];
  lines.push(`  - Project: ${project.name} (${project.type})`);

  if (project.configFiles.length > 0) {
    lines.push(`  - Config files: ${project.configFiles.join(', ')}`);
  }

  return lines.join('\n');
}
