/**
 * Layer 9 — Automation: barrel export
 */

export {
  Scheduler,
  parseCron,
  cronMatches,
  type ScheduledJob,
  type JobExecutor,
} from './scheduler.js';

export {
  DaemonController,
  DaemonWorker,
  type DaemonConfig,
  type DaemonState,
  type DaemonMessage,
} from './daemon.js';

export {
  BackgroundManager,
  type BackgroundSession,
} from './background.js';

export {
  TriggerServer,
  type TriggerDefinition,
  type TriggerRequest,
  type TriggerExecutor,
} from './triggers.js';

export {
  ProactiveLoop,
  type ProactiveConfig,
  type ProactiveResult,
} from './proactive.js';

export {
  runVaultMaintenance,
  ensureSchema,
  archiveStaleNotes,
  generateDigest,
  type MaintenanceResult,
} from './obsidian-agent.js';

export {
  Kairos,
  type KairosState,
  type KairosNotification,
} from './kairos.js';

export {
  DreamConsolidationService,
  type ConsolidationResult,
  type DreamConfig,
} from './dream.js';
