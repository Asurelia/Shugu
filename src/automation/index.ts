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
