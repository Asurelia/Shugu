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

const tasks = new Map<string, Task>();
let nextId = 1;

export function getTaskStore(): Map<string, Task> {
  return tasks;
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

  async execute(call: ToolCall): Promise<ToolResult> {
    const id = String(nextId++);
    const task: Task = {
      id,
      subject: call.input['subject'] as string,
      description: call.input['description'] as string,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    tasks.set(id, task);
    return { tool_use_id: call.id, content: `Task #${id} created: ${task.subject}` };
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

  async execute(call: ToolCall): Promise<ToolResult> {
    const taskId = call.input['taskId'] as string;
    const status = call.input['status'] as Task['status'];
    const task = tasks.get(taskId);

    if (!task) {
      return { tool_use_id: call.id, content: `Task #${taskId} not found`, is_error: true };
    }

    task.status = status;
    task.updatedAt = new Date().toISOString();
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

  async execute(call: ToolCall): Promise<ToolResult> {
    if (tasks.size === 0) {
      return { tool_use_id: call.id, content: 'No tasks.' };
    }

    const lines = Array.from(tasks.values()).map((t) => {
      const icon = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'working' : 'todo';
      return `#${t.id} [${icon}] ${t.subject}`;
    });

    return { tool_use_id: call.id, content: lines.join('\n') };
  }
}
