/**
 * Layer 3 — Tools: Task management tools
 *
 * In-memory task list with status tracking.
 * Used by the agent to break down complex work into trackable steps.
 * Tasks persist in session state.
 */

import type { Tool, ToolCall, ToolResult, ToolContext, ToolDefinition } from '../../protocol/tools.js';

// ─── Task State (shared across tools) ───────────────────

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed';
  createdAt: string;
  updatedAt: string;
}

export class TaskStore {
  private tasks = new Map<string, Task>();
  private nextId = 1;

  create(subject: string, description?: string): Task {
    const id = String(this.nextId++);
    const task: Task = {
      id,
      subject,
      description: description ?? '',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(id, task);
    return task;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  list(): Task[] {
    return Array.from(this.tasks.values());
  }

  update(id: string, updates: Partial<Task>): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    Object.assign(task, updates, { updatedAt: new Date().toISOString() });
    return task;
  }
}

// Default instance for backward compatibility
const defaultStore = new TaskStore();

export function getTaskStore(): TaskStore {
  return defaultStore;
}

// ─── TaskCreate ─────────────────────────────────────────

export const TaskCreateDefinition: ToolDefinition = {
  name: 'TaskCreate',
  description: 'Create a task to track progress on a multi-step operation.',
  inputSchema: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'Brief task title' },
      description: { type: 'string', description: 'What needs to be done' },
    },
    required: ['subject', 'description'],
  },
  concurrencySafe: true,
};

export class TaskCreateTool implements Tool {
  definition = TaskCreateDefinition;
  private store: TaskStore;

  constructor(store: TaskStore = defaultStore) {
    this.store = store;
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const task = this.store.create(
      call.input['subject'] as string,
      call.input['description'] as string,
    );
    return { tool_use_id: call.id, content: `Task #${task.id} created: ${task.subject}` };
  }
}

// ─── TaskUpdate ─────────────────────────────────────────

export const TaskUpdateDefinition: ToolDefinition = {
  name: 'TaskUpdate',
  description: 'Update a task status (pending → in_progress → completed).',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID to update' },
      status: { type: 'string', description: 'New status: pending, in_progress, completed' },
    },
    required: ['taskId', 'status'],
  },
  concurrencySafe: true,
};

export class TaskUpdateTool implements Tool {
  definition = TaskUpdateDefinition;
  private store: TaskStore;

  constructor(store: TaskStore = defaultStore) {
    this.store = store;
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const taskId = call.input['taskId'] as string;
    const status = call.input['status'] as Task['status'];
    const task = this.store.update(taskId, { status });

    if (!task) {
      return { tool_use_id: call.id, content: `Task #${taskId} not found`, is_error: true };
    }

    return { tool_use_id: call.id, content: `Task #${taskId} updated to ${status}` };
  }
}

// ─── TaskList ───────────────────────────────────────────

export const TaskListDefinition: ToolDefinition = {
  name: 'TaskList',
  description: 'List all tasks with their current status.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  concurrencySafe: true,
};

export class TaskListTool implements Tool {
  definition = TaskListDefinition;
  private store: TaskStore;

  constructor(store: TaskStore = defaultStore) {
    this.store = store;
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const tasks = this.store.list();
    if (tasks.length === 0) {
      return { tool_use_id: call.id, content: 'No tasks.' };
    }

    const lines = tasks.map((t) => {
      const icon = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'working' : 'todo';
      return `#${t.id} [${icon}] ${t.subject}`;
    });

    return { tool_use_id: call.id, content: lines.join('\n') };
  }
}
