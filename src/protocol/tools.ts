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

  /** Get tool definitions for the API (what the model sees) */
  getDefinitions(): ToolDefinition[];
}
