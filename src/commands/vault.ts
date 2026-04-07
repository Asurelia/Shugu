/**
 * Layer 7 — Commands: /vault credential management
 *
 * Factory pattern (like createBgCommand in automation.ts) —
 * receives the vault instance from bootstrap.
 */

import type { Command, CommandContext, CommandResult } from './registry.js';
import { CredentialVault } from '../credentials/vault.js';
import { SERVICE_TEMPLATES, type ServiceType, type Credential } from '../credentials/types.js';
import { WrongPasswordError } from '../credentials/errors.js';
import { promptPassword, promptText } from '../credentials/prompt.js';

export function createVaultCommand(vault: CredentialVault): Command {
  return {
    name: 'vault',
    aliases: ['creds'],
    description: 'Manage credential vault',
    usage: '/vault [status|list|add <service>|remove <service> [label]|change-password]',

    async execute(args: string, ctx: CommandContext): Promise<CommandResult> {
      const parts = args.trim().split(/\s+/);
      const subcommand = parts[0]?.toLowerCase() || 'status';

      switch (subcommand) {
        case 'status':
          return vaultStatus(vault, ctx);

        case 'list':
        case 'ls':
          return vaultList(vault, ctx);

        case 'add':
          return vaultAdd(vault, parts.slice(1).join(' '), ctx);

        case 'remove':
        case 'rm':
          return vaultRemove(vault, parts[1], parts[2], ctx);

        case 'change-password':
        case 'passwd':
          return vaultChangePassword(vault, ctx);

        case 'services':
          return vaultServices(ctx);

        default:
          ctx.error(`Unknown vault subcommand: ${subcommand}`);
          ctx.info('Usage: /vault [status|list|add|remove|change-password|services]');
          return { type: 'handled' };
      }
    },
  };
}

// ─── Subcommands ───────────────────────────────────────

async function vaultStatus(vault: CredentialVault, ctx: CommandContext): Promise<CommandResult> {
  ctx.info(`  Status:      ${vault.isUnlocked ? 'unlocked' : 'locked'}`);
  ctx.info(`  Path:        ${vault.path}`);
  if (vault.isUnlocked) {
    const creds = vault.list();
    ctx.info(`  Credentials: ${creds.length}`);
    if (creds.length > 0) {
      ctx.info('');
      for (const c of creds) {
        ctx.info(`    ${c.service} / ${c.label}`);
      }
    }
  }
  return { type: 'handled' };
}

async function vaultList(vault: CredentialVault, ctx: CommandContext): Promise<CommandResult> {
  if (!vault.isUnlocked) {
    ctx.error('Vault is locked.');
    return { type: 'handled' };
  }

  const creds = vault.list();
  if (creds.length === 0) {
    ctx.info('  No credentials stored. Use /vault add <service> to add one.');
    return { type: 'handled' };
  }

  ctx.info(`  ${creds.length} credential(s):`);
  ctx.info('');
  for (const c of creds) {
    ctx.info(`    ${c.service.padEnd(14)} ${c.label.padEnd(20)} added ${c.addedAt.split('T')[0]}`);
  }
  return { type: 'handled' };
}

async function vaultAdd(vault: CredentialVault, serviceName: string, ctx: CommandContext): Promise<CommandResult> {
  if (!vault.isUnlocked) {
    ctx.error('Vault is locked.');
    return { type: 'handled' };
  }

  const service = serviceName.trim().toLowerCase();
  if (!service) {
    ctx.info('  Available services:');
    ctx.info('');
    for (const [key, tpl] of Object.entries(SERVICE_TEMPLATES)) {
      ctx.info(`    ${key.padEnd(14)} ${tpl.description}`);
    }
    ctx.info('');
    ctx.info('  Usage: /vault add <service>');
    return { type: 'handled' };
  }

  const template = SERVICE_TEMPLATES[service];
  if (!template) {
    ctx.error(`  Unknown service: ${service}`);
    ctx.info(`  Available: ${Object.keys(SERVICE_TEMPLATES).join(', ')}`);
    return { type: 'handled' };
  }

  ctx.info(`  Adding: ${template.description}`);
  ctx.info('');

  // Collect field values
  const values: Record<string, string> = {};

  try {
    for (const field of template.fields) {
      const hint = field.hint ? ` (${field.hint})` : '';
      if (field.secret) {
        values[field.key] = await promptPassword({
          prompt: `  ${field.label}${hint}: `,
        });
      } else {
        const val = await promptText(`  ${field.label}${hint}: `);
        if (val) {
          values[field.key] = val;
        }
      }
    }
  } catch {
    ctx.error('  Input cancelled.');
    return { type: 'handled' };
  }

  // Ask for a label
  const label = await promptText(`  Label (e.g. "personal", "work"): `) || 'default';

  const credential: Credential = {
    service: template.service,
    label,
    values,
    addedAt: new Date().toISOString(),
    domains: template.domains,
  };

  await vault.add(credential);
  ctx.info(`  Credential saved: ${template.service} / ${label}`);
  return { type: 'handled' };
}

async function vaultRemove(
  vault: CredentialVault,
  service: string | undefined,
  label: string | undefined,
  ctx: CommandContext,
): Promise<CommandResult> {
  if (!vault.isUnlocked) {
    ctx.error('Vault is locked.');
    return { type: 'handled' };
  }

  if (!service) {
    ctx.error('Usage: /vault remove <service> [label]');
    return { type: 'handled' };
  }

  const removed = await vault.remove(service as ServiceType, label);
  if (removed) {
    ctx.info(`  Removed: ${service}${label ? ` / ${label}` : ''}`);
  } else {
    ctx.error(`  Credential not found: ${service}${label ? ` / ${label}` : ''}`);
  }
  return { type: 'handled' };
}

async function vaultChangePassword(vault: CredentialVault, ctx: CommandContext): Promise<CommandResult> {
  if (!vault.isUnlocked) {
    ctx.error('Vault is locked.');
    return { type: 'handled' };
  }

  try {
    const current = await promptPassword({ prompt: '  Current password: ' });
    const newPass = await promptPassword({
      prompt: '  New password: ',
      confirm: true,
    });
    await vault.changePassword(current, newPass);
    ctx.info('  Password changed successfully. Vault re-encrypted.');
  } catch (err: unknown) {
    if (err instanceof WrongPasswordError) {
      ctx.error('  Current password is incorrect.');
    } else {
      ctx.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { type: 'handled' };
}

async function vaultServices(ctx: CommandContext): Promise<CommandResult> {
  ctx.info('  Available service templates:');
  ctx.info('');
  for (const [key, tpl] of Object.entries(SERVICE_TEMPLATES)) {
    const fields = tpl.fields.map(f => f.key + (f.secret ? '*' : '')).join(', ');
    ctx.info(`    ${key.padEnd(14)} ${tpl.description}`);
    ctx.info(`    ${''.padEnd(14)} fields: ${fields}`);
  }
  ctx.info('');
  ctx.info('  (* = secret field, masked during input)');
  return { type: 'handled' };
}
