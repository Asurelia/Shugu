/**
 * Layer 4 — Policy: Bash risk classifier
 *
 * Classifies shell commands by risk level for the fullAuto permission mode.
 * Adapted from OpenClaude's concept in yoloClassifier.ts, but without
 * the LLM-based classification — this is pure pattern matching.
 *
 * Risk levels:
 * - low:    Read-only commands, safe utilities
 * - medium: Commands that modify files or state but are reversible
 * - high:   Destructive, network-altering, or privilege-escalating commands
 */

// ─── Risk Classification ────────────────────────────────

export type RiskLevel = 'low' | 'medium' | 'high';

export interface RiskClassification {
  level: RiskLevel;
  reason: string;
  patterns: string[];
}

/**
 * Classify a bash command by risk level.
 *
 * Strategy: check all sub-commands in the pipeline and return the
 * HIGHEST risk found. This prevents evasion via pipes, &&, $(), etc.
 */
export function classifyBashRisk(command: string): RiskClassification {
  const trimmed = command.trim();
  const lower = trimmed.toLowerCase();

  // First pass: check the full command against high/medium risk patterns.
  // This catches patterns that span the full command (redirections, pipes).
  for (const pattern of HIGH_RISK_PATTERNS) {
    if (pattern.test.test(lower)) {
      return {
        level: 'high',
        reason: pattern.reason,
        patterns: [pattern.test.source],
      };
    }
  }

  for (const pattern of MEDIUM_RISK_PATTERNS) {
    if (pattern.test.test(lower)) {
      return {
        level: 'medium',
        reason: pattern.reason,
        patterns: [pattern.test.source],
      };
    }
  }

  // Second pass: extract ALL sub-commands and check each individually.
  // This catches evasion via pipes, &&, ||, $(), backticks.
  const subCommands = extractAllCommands(lower);
  let maxLevel: RiskLevel = 'low';
  let maxReason = '';

  for (const cmd of subCommands) {
    if (!SAFE_COMMANDS.has(cmd)) {
      if (maxLevel === 'low') {
        maxLevel = 'medium';
        maxReason = `Unknown command in pipeline: ${cmd}`;
      }
    }
  }

  // If all sub-commands are safe, return low
  if (maxLevel === 'low') {
    const firstCmd = subCommands[0] ?? extractFirstCommand(lower);
    return {
      level: 'low',
      reason: `Safe command: ${firstCmd}`,
      patterns: [],
    };
  }

  return {
    level: maxLevel,
    reason: maxReason || 'Unknown command — requesting confirmation',
    patterns: [],
  };
}

// ─── High Risk Patterns ─────────────────────────────────

interface RiskPattern {
  test: RegExp;
  reason: string;
}

const HIGH_RISK_PATTERNS: RiskPattern[] = [
  // Destructive file operations
  { test: /\brm\s+(-[a-z]*f|-[a-z]*r)/, reason: 'Recursive/forced deletion' },
  { test: /\brm\s+-rf\b/, reason: 'Recursive forced deletion' },
  { test: /\brmdir\b/, reason: 'Directory deletion' },

  // Disk operations
  { test: /\bmkfs\b/, reason: 'Filesystem formatting' },
  { test: /\bdd\b.*\bof=/, reason: 'Raw disk write' },
  { test: /\bfdisk\b/, reason: 'Disk partitioning' },

  // Privilege escalation
  { test: /\bsudo\b/, reason: 'Privilege escalation' },
  { test: /\bsu\s+-?\s/, reason: 'User switching' },
  { test: /\bchmod\s+[0-7]*7[0-7]*\b/, reason: 'World-writable permissions' },
  { test: /\bchown\b/, reason: 'Ownership change' },

  // Network/system modification
  { test: /\biptables\b/, reason: 'Firewall modification' },
  { test: /\bsystemctl\s+(start|stop|restart|disable|enable)\b/, reason: 'Service management' },
  { test: /\bkill\s+-9\b/, reason: 'Force kill process' },
  { test: /\bpkill\b/, reason: 'Process killing' },
  { test: /\breboot\b/, reason: 'System reboot' },
  { test: /\bshutdown\b/, reason: 'System shutdown' },

  // Data exfiltration
  { test: /\bcurl\b.*\b-d\b/, reason: 'HTTP POST (potential data exfiltration)' },
  { test: /\bwget\b.*\b-O\b/, reason: 'Download to specific file' },
  { test: /\bnc\b.*\b-e\b/, reason: 'Netcat with execution' },

  // Git destructive
  { test: /\bgit\s+push\s+.*--force\b/, reason: 'Force push' },
  { test: /\bgit\s+reset\s+--hard\b/, reason: 'Hard reset' },
  { test: /\bgit\s+clean\s+-[a-z]*f/, reason: 'Force clean' },

  // Environment modification
  { test: /\bexport\s+PATH=/, reason: 'PATH modification' },
  { test: />\s*\/etc\//, reason: 'Writing to /etc/' },
  { test: />\s*~\/\.bashrc/, reason: 'Modifying shell config' },
  { test: />\s*~\/\.profile/, reason: 'Modifying shell config' },

  // Dynamic code execution / shell injection
  { test: /\beval\b/, reason: 'Dynamic code execution via eval' },
  { test: /\bexec\b/, reason: 'Process replacement via exec' },
  { test: /\bsource\b/, reason: 'Shell script sourcing' },
  { test: /\bbash\s+-c\b/, reason: 'Subprocess shell execution' },
  { test: /\bsh\s+-c\b/, reason: 'Subprocess shell execution' },

  // Chained destructive via xargs
  { test: /\bxargs\b.*\b(rm|mv|dd|mkfs|chmod|chown)\b/, reason: 'Destructive command via xargs' },

  // Redirect to .env (upgrade from medium to high)
  { test: />\s*\.env\b/, reason: 'Redirect to .env file' },
  { test: />\s*\.env\./, reason: 'Redirect to .env file' },

  // Curl pipe to shell (code execution from network)
  { test: /\bcurl\b.*\|\s*(ba)?sh\b/, reason: 'Remote code execution via curl|sh' },
  { test: /\bwget\b.*\|\s*(ba)?sh\b/, reason: 'Remote code execution via wget|sh' },
];

// ─── Medium Risk Patterns ───────────────────────────────

const MEDIUM_RISK_PATTERNS: RiskPattern[] = [
  // File modifications
  { test: /\bmv\b/, reason: 'File move/rename' },
  { test: /\bcp\s+-r/, reason: 'Recursive copy' },
  { test: /\bchmod\b/, reason: 'Permission change' },

  // Package management
  { test: /\bnpm\s+(install|uninstall|update)\b/, reason: 'Package management' },
  { test: /\byarn\s+(add|remove)\b/, reason: 'Package management' },
  { test: /\bpip\s+install\b/, reason: 'Python package install' },
  { test: /\bapt\b/, reason: 'System package management' },
  { test: /\bbrew\s+install\b/, reason: 'Homebrew install' },

  // Git state changes
  { test: /\bgit\s+commit\b/, reason: 'Git commit' },
  { test: /\bgit\s+push\b/, reason: 'Git push' },
  { test: /\bgit\s+merge\b/, reason: 'Git merge' },
  { test: /\bgit\s+rebase\b/, reason: 'Git rebase' },
  { test: /\bgit\s+checkout\b/, reason: 'Git checkout' },
  { test: /\bgit\s+branch\s+-[dD]\b/, reason: 'Git branch deletion' },
  { test: /\bgit\s+stash\s+drop\b/, reason: 'Git stash drop' },

  // Process management
  { test: /\bkill\b/, reason: 'Process termination' },

  // Write to files via redirection
  { test: />\s*\S+/, reason: 'File redirection (write)' },
  { test: /\btee\b/, reason: 'File write via tee' },
  { test: /\bsed\s+-i\b/, reason: 'In-place file modification' },
];

// ─── Safe Commands ──────────────────────────────────────

const SAFE_COMMANDS = new Set([
  // Read-only
  'ls', 'dir', 'cat', 'head', 'tail', 'less', 'more',
  'wc', 'sort', 'uniq', 'diff', 'file', 'stat',
  'find', 'locate', 'which', 'where', 'whereis', 'type',
  'echo', 'printf', 'true', 'false',

  // Information
  'pwd', 'whoami', 'hostname', 'uname', 'date', 'uptime',
  'id', 'groups',
  'df', 'du', 'free', 'top', 'ps', 'pgrep',

  // Git read-only
  'git', // git without subcommand is safe; specific subcommands checked above

  // Development tools (read-only mode)
  'ruby', 'go', 'rustc', 'cargo',
  'tsc', 'npx', 'tsx',
  'rg', 'grep', 'awk', 'sed', 'tr', 'cut', 'paste',
  'jq', 'yq', 'xmllint',

  // Testing
  'jest', 'vitest', 'pytest', 'mocha', 'bun',
]);

// ─── Helpers ────────────────────────────────────────────

/**
 * Extract all command names from a shell command line.
 * Splits on: pipe |, logical && ||, semicolon ;, subshell $(), backticks `.
 * Returns the first non-assignment token of each segment.
 */
function extractAllCommands(command: string): string[] {
  // Split on: |, &&, ||, ;, $( (subshell), ` (backtick)
  const segments = command.split(/\s*(?:\|\||&&|[|;])\s*|\$\(|`/);
  const commands: string[] = [];

  for (const seg of segments) {
    const trimmed = seg.trim().replace(/\)$/, ''); // strip trailing ) from $()
    if (!trimmed) continue;

    const parts = trimmed.split(/\s+/);
    for (const part of parts) {
      // Skip env var assignments (VAR=val)
      if (!part.includes('=') && part.length > 0) {
        commands.push(part);
        break;
      }
    }
  }

  return commands;
}

function extractFirstCommand(command: string): string {
  const cmds = extractAllCommands(command);
  return cmds[0] ?? '';
}
