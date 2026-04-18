/**
 * Layer 0 — Protocol: Tool types
 *
 * Defines the contract between the engine and tool implementations.
 * Tools are decoupled from transport — they never see MiniMax directly.
 */

// ─── Tool Definition ────────────────────────────────────

export interface ToolDefinition {
  /** Unique tool name (e.g., "Bash", "FileRead") */
  name: string;

  /** Human-readable description for the model */
  description: string;

  /** JSON Schema for the tool's input parameters */
  inputSchema: ToolInputSchema;

  /** Whether this tool can be run concurrently with other tool calls */
  concurrencySafe?: boolean;

  /** Whether to defer loading this tool (for tool search) */
  deferLoading?: boolean;

  /** Capability categories for dynamic tool routing */
  categories?: string[];

  /**
   * Per-tool execution timeout in ms. Overrides the engine's default wrapper
   * (300_000ms / 5min). Use a larger value for tools that legitimately run
   * long (e.g. Agent sub-loops, which bound themselves via maxTurns/maxBudget).
   * Hard upper bound is enforced by the loop; treat this as a soft hint.
   */
  timeoutMs?: number;
}

export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

// ─── Tool Execution ─────────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  tool_use_id: string;
  content: string | ToolResultContent[];
  is_error?: boolean;
}

export interface ToolResultContent {
  type: 'text' | 'image';
  text?: string;
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

// ─── Tool Interface ─────────────────────────────────────

export interface Tool {
  definition: ToolDefinition;

  /**
   * Execute the tool with the given input.
   * Returns a ToolResult or throws on unrecoverable error.
   */
  execute(call: ToolCall, context: ToolContext): Promise<ToolResult>;

  /**
   * Optional: validate input before execution.
   * Return null if valid, error string if not.
   */
  validateInput?(input: Record<string, unknown>): string | null;
}

// ─── Tool Context ───────────────────────────────────────

export interface ToolContext {
  /** Current working directory */
  cwd: string;

  /** Abort signal for cancellation */
  abortSignal: AbortSignal;

  /** Permission mode */
  permissionMode: PermissionMode;

  /** Callback to ask user for confirmation */
  askPermission: (tool: string, action: string) => Promise<boolean>;

  /** Callback to report progress */
  onProgress?: (progress: ToolProgress) => void;

  /** Tracks files read during this session — used by FileEditTool to enforce read-before-edit */
  readTracker?: import('../context/read-tracker.js').ReadTracker;

  /**
   * Optional regex patterns that block Bash commands before execution.
   * Used by restricted agents (e.g. `socratic`) to enforce read-only
   * shell access. Matched against the raw command string with `.test()`.
   * Empty or undefined = no restriction.
   */
  bashDenylist?: RegExp[];
}

export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'fullAuto' | 'bypass';

export interface ToolProgress {
  type: 'stdout' | 'stderr' | 'status' | 'file';
  content: string;
}

// ─── Tool Registry Types ────────────────────────────────

export interface ToolRegistry {
  /** Get all registered tools */
  getAll(): Tool[];

  /** Get a tool by name */
  get(name: string): Tool | undefined;

  /** Register a tool */
  register(tool: Tool): void;

  /** Unregister a tool by name (for plugin cleanup) */
  unregister(name: string): boolean;

  /** Get tool definitions for the API (what the model sees) */
  getDefinitions(): ToolDefinition[];
}
