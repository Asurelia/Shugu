/**
 * Entrypoint — RuntimeServices
 *
 * Single container for all services needed by the CLI entrypoint.
 * Replaces the 15+ positional parameters previously threaded through main → runREPL.
 */

import type { MiniMaxClient } from '../transport/client.js';
import type { ToolRegistryImpl } from '../tools/registry.js';
import type { ToolContext } from '../protocol/tools.js';
import type { PermissionResolver } from '../policy/permissions.js';
import type { HookRegistry } from '../plugins/hooks.js';
import type { SkillRegistry } from '../skills/index.js';
import type { CommandRegistry } from '../commands/registry.js';
import type { SessionManager } from '../context/session/persistence.js';
import type { BackgroundManager } from '../automation/background.js';
import type { Scheduler } from '../automation/scheduler.js';
import type { MemoryAgent } from '../context/memory/agent.js';
import type { ObsidianVault } from '../context/memory/obsidian.js';
import type { CredentialProvider } from '../credentials/provider.js';
import type { Kairos } from '../automation/kairos.js';
import type { TerminalRenderer } from '../ui/renderer.js';

export interface RuntimeServices {
  readonly client: MiniMaxClient;
  readonly registry: ToolRegistryImpl;
  readonly toolContext: ToolContext;
  readonly permResolver: PermissionResolver;
  readonly hookRegistry: HookRegistry;
  readonly skillRegistry: SkillRegistry;
  readonly commands: CommandRegistry;
  readonly sessionMgr: SessionManager;
  readonly bgManager: BackgroundManager;
  readonly scheduler: Scheduler;
  readonly memoryAgent: MemoryAgent;
  readonly obsidianVault: ObsidianVault | null;
  readonly credentialProvider: CredentialProvider;
  readonly kairos: Kairos;
  readonly renderer: TerminalRenderer;

  dispose(): Promise<void>;
}
