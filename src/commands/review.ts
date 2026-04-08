/**
 * /review — Parallel code review with 3 specialist agents
 */

import type { Command, CommandContext, CommandResult } from './registry.js';
import type { AgentOrchestrator } from '../agents/orchestrator.js';
import { delegateParallel, type ParallelTask, type ParallelResults } from '../agents/delegation.js';
import { git } from '../utils/git.js';
import { loadReviewRules } from '../context/workspace/project.js';

export function createReviewCommand(orchestrator: AgentOrchestrator, cwd: string): Command {
  return {
    name: 'review',
    description: 'Review code changes with 3 parallel specialist agents (security, logic, architecture)',
    usage: '/review [file or git ref]',
    async execute(args: string, ctx: CommandContext): Promise<CommandResult> {
      // 1. Get diff context
      let diffContext = '';
      try {
        const staged = await git(['diff', '--cached'], ctx.cwd).catch(() => '');
        const unstaged = await git(['diff'], ctx.cwd).catch(() => '');
        diffContext = [staged, unstaged].filter(Boolean).join('\n---\n');
        if (!diffContext.trim()) {
          // Try diff against HEAD~1
          diffContext = await git(['diff', 'HEAD~1'], ctx.cwd).catch(() => '');
        }
      } catch {
        // Non-git or no commits
      }

      if (!diffContext.trim()) {
        return { type: 'error', message: 'No code changes found to review. Stage changes or make commits first.' };
      }

      // Truncate if too large (don't blow context window)
      if (diffContext.length > 15000) {
        diffContext = diffContext.slice(0, 15000) + '\n\n[... truncated — diff too large for full review]';
      }

      // 2. Load repo review rules (merged from all instruction files)
      const repoRules = await loadReviewRules(ctx.cwd);

      ctx.info('Running 3 parallel review agents (security, logic, architecture)...');

      // 3. Build 3 parallel review tasks
      const tasks: ParallelTask[] = [
        {
          id: 'security',
          prompt: `You are a SECURITY code reviewer. Analyze these code changes exclusively for security issues:\n- Injection vulnerabilities (SQL, command, XSS)\n- Credential exposure or hardcoded secrets\n- Authentication/authorization gaps\n- OWASP Top 10 issues\n- Unsafe deserialization\n- Path traversal\n- Silent catch blocks that swallow security-relevant errors\n\nProvide specific findings with file paths and line references. If no issues found, say so clearly.${repoRules}\n\n# Code Changes:\n\`\`\`diff\n${diffContext}\n\`\`\``,
          agentType: 'review',
        },
        {
          id: 'logic',
          prompt: `You are a LOGIC code reviewer. Analyze these code changes exclusively for logic issues:\n- Bugs and incorrect behavior\n- Edge cases not handled\n- Error handling gaps and silent failures\n- Race conditions\n- Off-by-one errors\n- Null/undefined handling\n- Type mismatches\n- Dead code paths\n\nProvide specific findings with file paths and line references. If no issues found, say so clearly.${repoRules}\n\n# Code Changes:\n\`\`\`diff\n${diffContext}\n\`\`\``,
          agentType: 'review',
        },
        {
          id: 'architecture',
          prompt: `You are an ARCHITECTURE code reviewer. Analyze these code changes exclusively for design issues:\n- Naming and readability\n- Code duplication\n- Coupling and cohesion\n- Pattern violations (compared to existing codebase patterns)\n- Missing abstractions or over-abstraction\n- API design issues\n- Performance anti-patterns\n\nProvide specific findings with file paths and line references. If no issues found, say so clearly.${repoRules}\n\n# Code Changes:\n\`\`\`diff\n${diffContext}\n\`\`\``,
          agentType: 'review',
        },
      ];

      // 4. Run parallel
      const results = await delegateParallel(orchestrator, tasks);

      // 5. Format report
      const report = formatReviewReport(results);
      ctx.info(report);

      return { type: 'handled' };
    },
  };
}

function formatReviewReport(results: ParallelResults): string {
  const lines: string[] = ['', '## Code Review Report', ''];
  const sections = ['security', 'logic', 'architecture'] as const;

  for (const section of sections) {
    const result = results.results.get(section);
    if (!result) continue;
    const title = section.charAt(0).toUpperCase() + section.slice(1);
    const status = result.success ? 'Complete' : 'Failed';
    lines.push(`### ${title} Review`);
    lines.push(`*${status} | ${result.turns} turns | $${result.costUsd.toFixed(4)}*`);
    lines.push('');
    lines.push(result.response);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  lines.push(`**Total cost: $${results.totalCostUsd.toFixed(4)} | All passed: ${results.allSucceeded}**`);
  return lines.join('\n');
}
