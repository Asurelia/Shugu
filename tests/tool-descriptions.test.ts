/**
 * Tests for enriched tool descriptions.
 * Ensures descriptions contain prescriptive guidance that prevents common model mistakes.
 */
import { describe, it, expect } from 'vitest';
import { BashToolDefinition } from '../src/tools/bash/BashTool.js';
import { FileEditToolDefinition } from '../src/tools/files/FileEditTool.js';
import { FileWriteToolDefinition } from '../src/tools/files/FileWriteTool.js';
import { FileReadToolDefinition } from '../src/tools/files/FileReadTool.js';
import { AgentToolDefinition } from '../src/tools/agents/AgentTool.js';
import { GlobToolDefinition } from '../src/tools/search/GlobTool.js';
import { GrepToolDefinition } from '../src/tools/search/GrepTool.js';
import { WebFetchToolDefinition } from '../src/tools/web/WebFetchTool.js';
import { WebSearchToolDefinition } from '../src/tools/web/WebSearchTool.js';
import { REPLToolDefinition } from '../src/tools/repl/REPLTool.js';
import { TaskCreateDefinition, TaskUpdateDefinition, TaskListDefinition } from '../src/tools/tasks/TaskTools.js';
import { SleepToolDefinition } from '../src/tools/utility/SleepTool.js';
import { SemSearchToolDefinition } from '../src/tools/search/SemSearchTool.js';

// ─── BashTool ──────────────────────────────────────────

describe('BashTool description', () => {
  const desc = BashToolDefinition.description;

  it('should warn against using Bash for file operations', () => {
    expect(desc).toContain('Read');
    expect(desc).toContain('Grep');
    expect(desc).toContain('Glob');
    expect(desc).toContain('Write');
  });

  it('should include git safety protocol', () => {
    expect(desc).toContain('NEVER');
    expect(desc).toContain('force');
    expect(desc).toContain('hooks');
  });

  it('should include commit workflow with HEREDOC', () => {
    expect(desc).toContain('HEREDOC');
    expect(desc).toContain('Co-Authored-By');
  });

  it('should warn against interactive flags', () => {
    expect(desc).toContain('-i flag');
  });

  it('should include PR workflow', () => {
    expect(desc).toContain('gh pr create');
  });

  it('should have description parameter in inputSchema', () => {
    expect(BashToolDefinition.inputSchema.properties['description']).toBeDefined();
  });
});

// ─── FileEditTool ──────────────────────────────────────

describe('FileEditTool description', () => {
  const desc = FileEditToolDefinition.description;

  it('should require Read before Edit', () => {
    expect(desc).toContain('Read tool');
    expect(desc).toContain('before');
  });

  it('should mention indentation preservation', () => {
    expect(desc).toContain('indentation');
  });

  it('should mention uniqueness requirement', () => {
    expect(desc).toContain('unique');
  });

  it('should mention replace_all', () => {
    expect(desc).toContain('replace_all');
  });
});

// ─── FileWriteTool ─────────────────────────────────────

describe('FileWriteTool description', () => {
  const desc = FileWriteToolDefinition.description;

  it('should prefer Edit over Write for existing files', () => {
    expect(desc).toContain('Edit');
    expect(desc).toContain('Prefer');
  });

  it('should warn against unnecessary documentation files', () => {
    expect(desc).toContain('documentation');
  });

  it('should require Read first for existing files', () => {
    expect(desc).toContain('Read tool first');
  });
});

// ─── FileReadTool ──────────────────────────────────────

describe('FileReadTool description', () => {
  const desc = FileReadToolDefinition.description;

  it('should specify absolute path requirement', () => {
    expect(desc).toContain('absolute path');
  });

  it('should mention line numbering format', () => {
    expect(desc).toContain('cat -n');
  });

  it('should mention offset/limit for large files', () => {
    expect(desc).toContain('offset');
    expect(desc).toContain('limit');
  });

  it('should say not to re-read after Edit', () => {
    expect(desc).toContain('re-read');
  });
});

// ─── AgentTool ─────────────────────────────────────────

describe('AgentTool description', () => {
  const desc = AgentToolDefinition.description;

  it('should list all 6 agent types', () => {
    expect(desc).toContain('"general"');
    expect(desc).toContain('"explore"');
    expect(desc).toContain('"code"');
    expect(desc).toContain('"review"');
    expect(desc).toContain('"test"');
    expect(desc).toContain('"verify"');
  });

  it('should include briefing protocol', () => {
    expect(desc).toContain('Brief the agent');
  });

  it('should warn against delegating understanding', () => {
    expect(desc).toContain('Never delegate understanding');
  });

  it('should mention parallel launch', () => {
    expect(desc).toContain('concurrently');
  });

  it('should have isolation parameter in inputSchema', () => {
    expect(AgentToolDefinition.inputSchema.properties['isolation']).toBeDefined();
  });
});

// ─── GlobTool ──────────────────────────────────────────

describe('GlobTool description', () => {
  it('should mention modification time sorting', () => {
    expect(GlobToolDefinition.description).toContain('modification time');
  });

  it('should suggest Agent for complex searches', () => {
    expect(GlobToolDefinition.description).toContain('Agent');
  });
});

// ─── GrepTool ──────────────────────────────────────────

describe('GrepTool description', () => {
  const desc = GrepToolDefinition.description;

  it('should mention regex support', () => {
    expect(desc).toContain('regex');
  });

  it('should warn against using Bash grep', () => {
    expect(desc).toContain('NEVER');
    expect(desc).toContain('Bash');
  });

  it('should mention output modes', () => {
    expect(desc).toContain('content');
    expect(desc).toContain('files_with_matches');
    expect(desc).toContain('count');
  });
});

// ─── WebFetchTool ──────────────────────────────────────

describe('WebFetchTool description', () => {
  it('should mention Markdown conversion', () => {
    expect(WebFetchToolDefinition.description).toContain('Markdown');
  });

  it('should warn against guessing URLs', () => {
    expect(WebFetchToolDefinition.description).toContain('guess');
  });
});

// ─── WebSearchTool ─────────────────────────────────────

describe('WebSearchTool description', () => {
  it('should explain search types', () => {
    expect(WebSearchToolDefinition.description).toContain('code');
    expect(WebSearchToolDefinition.description).toContain('general');
  });
});

// ─── REPLTool ──────────────────────────────────────────

describe('REPLTool description', () => {
  it('should mention async support', () => {
    expect(REPLToolDefinition.description).toContain('async');
  });

  it('should mention stateless execution', () => {
    expect(REPLToolDefinition.description).toContain('stateless');
  });
});

// ─── TaskTools ─────────────────────────────────────────

describe('TaskTools descriptions', () => {
  it('TaskCreate should mention multi-step', () => {
    expect(TaskCreateDefinition.description).toContain('multi-step');
  });

  it('TaskUpdate should mention completion requirement', () => {
    expect(TaskUpdateDefinition.description).toContain('fully finished');
  });

  it('TaskList should mention checking progress', () => {
    expect(TaskListDefinition.description).toContain('progress');
  });
});

// ─── SleepTool ─────────────────────────────────────────

describe('SleepTool description', () => {
  it('should mention max duration', () => {
    expect(SleepToolDefinition.description).toContain('300');
  });

  it('should discourage unnecessary use', () => {
    expect(SleepToolDefinition.description).toContain('sparingly');
  });
});

// ─── SemSearchTool ─────────────────────────────────────

describe('SemSearchTool description', () => {
  it('should mention workspace init requirement', () => {
    expect(SemSearchToolDefinition.description).toContain('/workspace init');
  });

  it('should explain when to use Grep vs SemSearch', () => {
    expect(SemSearchToolDefinition.description).toContain('Grep');
    expect(SemSearchToolDefinition.description).toContain('semantic');
  });
});
