/**
 * Layer 7 — Commands: /team — Agent team dispatch
 */

import type { Command, CommandContext, CommandResult } from './registry.js';
import type { AgentOrchestrator } from '../agents/orchestrator.js';
import { AgentTeam, TEAM_TEMPLATES } from '../agents/teams.js';

export function createTeamCommand(orchestrator: AgentOrchestrator): Command {
  return {
    name: 'team',
    description: 'Run a task with a coordinated agent team',
    usage: '/team <task> | /team --parallel <task> | /team --review <task> | /team list',
    async execute(args: string, ctx: CommandContext): Promise<CommandResult> {
      if (!args.trim()) {
        return { type: 'error', message: 'Usage: /team <task> or /team list' };
      }

      if (args.trim() === 'list') {
        const lines = ['Available team templates:'];
        for (const [key, tmpl] of Object.entries(TEAM_TEMPLATES)) {
          lines.push(`  ${key}: ${tmpl.name} (${tmpl.members.length} members, ${tmpl.mode})`);
          for (const m of tmpl.members) {
            lines.push(`    - ${m.role} (${m.agentType})`);
          }
        }
        ctx.info(lines.join('\n'));
        return { type: 'handled' };
      }

      // Determine template
      let templateName = 'default';
      let task = args;
      if (args.startsWith('--parallel ')) {
        templateName = 'parallel';
        task = args.slice('--parallel '.length);
      } else if (args.startsWith('--review ')) {
        templateName = 'review';
        task = args.slice('--review '.length);
      }

      const template = TEAM_TEMPLATES[templateName];
      if (!template) {
        return { type: 'error', message: `Unknown team template: ${templateName}` };
      }

      ctx.info(`Dispatching to "${template.name}" team (${template.members.length} members, ${template.mode})...`);
      const team = new AgentTeam(orchestrator, template);
      const result = await team.dispatch(task, (role, event) => {
        ctx.info(`  [${role}] ${event}`);
      });

      ctx.info(result.summary);
      if (result.cleanupWarnings.length > 0) {
        ctx.info(`Warnings: ${result.cleanupWarnings.join(', ')}`);
      }
      return { type: 'handled' };
    },
  };
}
