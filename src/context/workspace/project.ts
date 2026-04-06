/**
 * Layer 5 — Context: Project detection
 *
 * Detects project type, configuration files, and loads CLAUDE.md/PCC.md
 * for injection into the system prompt.
 */

import { readFile } from 'node:fs/promises';
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
    { file: '*.csproj', type: 'dotnet' },
    { file: 'Gemfile', type: 'ruby' },
  ];

  let projectType: ProjectType = 'unknown';
  for (const { file, type } of typeDetectors) {
    if (await fileExists(join(cwd, file))) {
      projectType = type;
      configFiles.push(file);
    }
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

  // Load custom instructions from CLAUDE.md or PCC.md
  let customInstructions: string | undefined;
  for (const instructionFile of ['SHUGU.md', 'CLAUDE.md', 'PCC.md', '.claude/CLAUDE.md', '.pcc/instructions.md']) {
    try {
      const content = await readFile(join(cwd, instructionFile), 'utf-8');
      customInstructions = content.slice(0, 5000); // Cap at 5K chars
      break;
    } catch {
      // Not found, try next
    }
  }

  return { name, type: projectType, configFiles, customInstructions };
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

