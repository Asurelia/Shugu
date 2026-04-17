/**
 * Meta-Harness: Dataset Management
 *
 * Loads evaluation task suites and splits them into search/holdout sets.
 * The split is deterministic (hash-based) to ensure reproducibility.
 */

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type { EvalTask, DatasetSplit } from './types.js';
import { containsShellInjection } from './config.js';

// ─── Dataset Loading ──────────────────────────────────

/**
 * Load a dataset from a YAML file and split into search/holdout sets.
 *
 * @param path - Absolute path to the dataset YAML file
 * @param splitRatio - Fraction of tasks in the search set (default: 0.7)
 */
export async function loadDataset(path: string, splitRatio: number = 0.7): Promise<DatasetSplit> {
  const content = await readFile(path, 'utf-8');
  const parsed = parseYaml(content);

  if (!parsed || !Array.isArray(parsed.tasks)) {
    throw new Error(`Invalid dataset format: expected { tasks: [...] } in ${path}`);
  }

  const tasks: EvalTask[] = parsed.tasks;
  validateTasks(tasks, path);

  return splitDataset(tasks, splitRatio);
}

/**
 * Validate that all tasks have required fields and valid scorers.
 */
function validateTasks(tasks: EvalTask[], source: string): void {
  const ids = new Set<string>();

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;

    if (!task.id || typeof task.id !== 'string') {
      throw new Error(`Task at index ${i} in ${source} missing required field "id"`);
    }
    if (ids.has(task.id)) {
      throw new Error(`Duplicate task id "${task.id}" in ${source}`);
    }
    ids.add(task.id);

    if (!task.prompt || typeof task.prompt !== 'string') {
      throw new Error(`Task "${task.id}" in ${source} missing required field "prompt"`);
    }

    if (!task.scorer || typeof task.scorer !== 'object') {
      throw new Error(`Task "${task.id}" in ${source} missing required field "scorer"`);
    }

    const validScorerTypes = ['criteria', 'command', 'llm_judge'];
    if (!validScorerTypes.includes(task.scorer.type)) {
      throw new Error(`Task "${task.id}" in ${source} has invalid scorer type "${task.scorer.type}"`);
    }

    validateShellCommands(task, source);
  }
}

/**
 * Reject shell-injection patterns in dataset commands.
 *
 * Runs on every task loaded from an external YAML source. The same
 * pattern is re-checked at execution time in `evaluator.ts` as a
 * defense-in-depth measure.
 */
function validateShellCommands(task: EvalTask, source: string): void {
  if (typeof task.setupCommand === 'string' && containsShellInjection(task.setupCommand)) {
    throw new Error(
      `Task "${task.id}" in ${source}: setupCommand contains forbidden shell metacharacters (; \` $( \${ ||) outside quotes. ` +
      `Use && for chaining or restructure to a single command.`,
    );
  }

  if (task.scorer.type === 'command' && typeof task.scorer.command === 'string' &&
      containsShellInjection(task.scorer.command)) {
    throw new Error(
      `Task "${task.id}" in ${source}: scorer.command contains forbidden shell metacharacters outside quotes.`,
    );
  }

  if (task.scorer.type === 'criteria' && Array.isArray(task.scorer.criteria)) {
    for (const criterion of task.scorer.criteria) {
      if (criterion.type === 'command_succeeds' && typeof criterion.value === 'string' &&
          containsShellInjection(criterion.value)) {
        throw new Error(
          `Task "${task.id}" in ${source}: criteria command_succeeds contains forbidden shell metacharacters: "${criterion.value.slice(0, 80)}"`,
        );
      }
    }
  }
}

// ─── Deterministic Split ──────────────────────────────

/**
 * Hash-based deterministic assignment of tasks to search/holdout sets.
 * Uses SHA-256 of the task ID to assign consistently across runs.
 */
function hashAssignment(taskId: string): number {
  const hash = createHash('sha256').update(taskId).digest();
  // Use first 4 bytes as a uint32, normalize to [0, 1)
  return hash.readUInt32BE(0) / 0xFFFFFFFF;
}

/**
 * Split tasks into search and holdout sets using deterministic hashing.
 *
 * @param tasks - All tasks
 * @param splitRatio - Fraction assigned to search set (0.0 to 1.0)
 */
export function splitDataset(tasks: EvalTask[], splitRatio: number): DatasetSplit {
  if (splitRatio < 0.1 || splitRatio > 0.95) {
    throw new Error(`splitRatio must be between 0.1 and 0.95, got ${splitRatio}`);
  }

  const searchSet: EvalTask[] = [];
  const holdoutSet: EvalTask[] = [];

  for (const task of tasks) {
    if (hashAssignment(task.id) < splitRatio) {
      searchSet.push(task);
    } else {
      holdoutSet.push(task);
    }
  }

  // Ensure both sets are non-empty
  if (searchSet.length === 0 && tasks.length > 0) {
    searchSet.push(holdoutSet.pop()!);
  }
  if (holdoutSet.length === 0 && tasks.length > 1) {
    holdoutSet.push(searchSet.pop()!);
  }

  return { searchSet, holdoutSet };
}

// ─── Default Dataset ──────────────────────────────────

/**
 * Create a minimal default dataset for initial calibration.
 * These are canonical coding tasks that test different Shugu capabilities.
 */
export function createDefaultDataset(): DatasetSplit {
  const tasks: EvalTask[] = [
    {
      id: 'create-file',
      prompt: 'Create a file called hello.ts that exports a function greet(name: string): string which returns "Hello, {name}!"',
      tags: ['basic', 'create'],
      scorer: {
        type: 'criteria',
        criteria: [
          { type: 'file_exists', value: 'hello.ts' },
          { type: 'file_contains', value: 'greet' },
          { type: 'file_contains', value: 'export' },
        ],
      },
    },
    {
      id: 'fix-bug',
      prompt: 'The file buggy.ts has a bug: the function sum(a, b) returns a - b instead of a + b. Fix it.',
      tags: ['basic', 'fix'],
      setupCommand: 'echo "export function sum(a: number, b: number): number { return a - b; }" > buggy.ts',
      scorer: {
        type: 'criteria',
        criteria: [
          { type: 'file_contains', value: 'a + b' },
          { type: 'command_succeeds', value: 'npx tsx -e "import { sum } from \'./buggy\'; process.exit(sum(2,3) === 5 ? 0 : 1)"' },
        ],
      },
    },
    {
      id: 'search-codebase',
      prompt: 'Find all TypeScript files that export a class. List their paths.',
      tags: ['basic', 'search'],
      scorer: {
        type: 'criteria',
        criteria: [
          { type: 'turns_under', value: 5 },
          { type: 'cost_under', value: 0.05 },
        ],
      },
    },
    {
      id: 'refactor-rename',
      prompt: 'Rename the function calculateTotal in calc.ts to computeTotal. Update all references.',
      tags: ['refactor'],
      setupCommand: 'echo "export function calculateTotal(items: number[]): number { return items.reduce((a, b) => a + b, 0); }" > calc.ts && echo "import { calculateTotal } from \'./calc\'; console.log(calculateTotal([1,2,3]));" > main.ts',
      scorer: {
        type: 'criteria',
        criteria: [
          { type: 'file_contains', value: 'computeTotal', weight: 2 },
          { type: 'command_succeeds', value: 'grep -q "computeTotal" main.ts' },
          { type: 'command_succeeds', value: '! grep -q "calculateTotal" calc.ts' },
        ],
      },
    },
    {
      id: 'multi-file-edit',
      prompt: 'Create a simple todo module: types.ts with a Todo interface (id: string, text: string, done: boolean), store.ts with addTodo/toggleTodo/getTodos functions using an in-memory array, and index.ts that exports everything.',
      tags: ['complex', 'create'],
      scorer: {
        type: 'criteria',
        criteria: [
          { type: 'file_exists', value: 'types.ts' },
          { type: 'file_exists', value: 'store.ts' },
          { type: 'file_exists', value: 'index.ts' },
          { type: 'file_contains', value: 'Todo' },
          { type: 'file_contains', value: 'addTodo' },
          { type: 'command_succeeds', value: 'npx tsc --noEmit types.ts store.ts index.ts' },
        ],
      },
    },
    {
      id: 'efficiency-simple',
      prompt: 'What does the function sum do in calc.ts? Answer briefly.',
      tags: ['trivial', 'efficiency'],
      setupCommand: 'echo "export function sum(a: number, b: number): number { return a + b; }" > calc.ts',
      scorer: {
        type: 'criteria',
        criteria: [
          { type: 'turns_under', value: 3 },
          { type: 'cost_under', value: 0.02 },
        ],
      },
    },
    {
      id: 'test-writing',
      prompt: 'Write a test file math.test.ts for the math.ts module. Test the add and multiply functions with at least 3 test cases each.',
      tags: ['test', 'create'],
      setupCommand: 'echo "export function add(a: number, b: number): number { return a + b; }\nexport function multiply(a: number, b: number): number { return a * b; }" > math.ts',
      scorer: {
        type: 'criteria',
        criteria: [
          { type: 'file_exists', value: 'math.test.ts' },
          { type: 'file_contains', value: 'describe' },
          { type: 'file_contains', value: 'expect' },
        ],
      },
    },
    {
      id: 'error-handling',
      prompt: 'The function readConfig in config.ts reads a JSON file but crashes on invalid JSON. Add proper error handling that returns a default config object { port: 3000, host: "localhost" } when the file is missing or invalid.',
      tags: ['fix', 'error-handling'],
      setupCommand: 'echo "import { readFileSync } from \'fs\';\nexport function readConfig(path: string) { return JSON.parse(readFileSync(path, \'utf-8\')); }" > config.ts',
      scorer: {
        type: 'criteria',
        criteria: [
          { type: 'file_contains', value: 'catch' },
          { type: 'file_contains', value: '3000' },
          { type: 'file_contains', value: 'localhost' },
        ],
      },
    },
  ];

  return splitDataset(tasks, 0.7);
}
