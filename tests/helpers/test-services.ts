/**
 * Test Helper — RuntimeServices mock factory
 *
 * Creates a RuntimeServices with sensible mocks for unit/integration tests.
 * Override any service by passing Partial<RuntimeServices>.
 */

import type { RuntimeServices } from '../../src/entrypoints/services.js';

/**
 * Create a mock RuntimeServices for testing.
 * All services are minimal no-op implementations unless overridden.
 */
export function createTestServices(overrides?: Partial<RuntimeServices>): RuntimeServices {
  const defaults: RuntimeServices = {
    client: {
      model: 'M2.7-test',
      baseUrl: 'https://test.api',
      complete: async () => ({ message: { role: 'assistant', content: [] }, usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: 'end_turn' }),
      stream: async function* () { /* empty */ },
    } as unknown as RuntimeServices['client'],

    registry: {
      getAll: () => [],
      getDefinitions: () => [],
      register: () => {},
      get: () => undefined,
    } as unknown as RuntimeServices['registry'],

    toolContext: {
      cwd: process.cwd(),
      abortSignal: new AbortController().signal,
      permissionMode: 'default' as const,
      askPermission: async () => true,
    },

    permResolver: {
      resolve: () => ({ decision: 'allow' as const, reason: 'test' }),
      getMode: () => 'default' as const,
      setMode: () => {},
    } as unknown as RuntimeServices['permResolver'],

    hookRegistry: {
      runPreToolUse: async () => ({ allowed: true }),
      runPostToolUse: async () => ({}),
      register: () => {},
    } as unknown as RuntimeServices['hookRegistry'],

    skillRegistry: {
      match: () => null,
      getAll: () => [],
      register: () => {},
    } as unknown as RuntimeServices['skillRegistry'],

    commands: {
      dispatch: async () => null,
      register: () => {},
      getAll: () => [],
    } as unknown as RuntimeServices['commands'],

    sessionMgr: {
      createSession: () => ({ id: 'test-session', messages: [], turnCount: 0, totalUsage: { input_tokens: 0, output_tokens: 0 }, projectDir: process.cwd(), model: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
      save: async () => {},
      load: async () => null,
      loadLatest: async () => null,
      listRecent: async () => [],
    } as unknown as RuntimeServices['sessionMgr'],

    bgManager: {} as unknown as RuntimeServices['bgManager'],

    scheduler: {
      stop: () => {},
      schedule: () => '',
      unschedule: () => {},
      getJobs: () => [],
    } as unknown as RuntimeServices['scheduler'],

    memoryAgent: {
      loadIndex: async () => {},
      flushIndex: async () => {},
      getStartupContext: () => null,
      getRelevantContext: async () => '',
      save: async () => {},
      saveLLMExtracted: async () => 0,
      maintenance: async () => {},
    } as unknown as RuntimeServices['memoryAgent'],

    obsidianVault: null,
    credentialProvider: undefined,

    kairos: {
      onUserInput: () => null,
      shouldInjectTimeContext: () => false,
      getTimeContext: () => '',
      getSessionSummary: () => '',
    } as unknown as RuntimeServices['kairos'],

    renderer: {
      info: () => {},
      error: () => {},
      usage: () => {},
      statusBar: { update: () => {}, render: () => '', redraw: () => {}, stop: () => {} },
      loopEnd: () => {},
      richBanner: () => {},
      endStream: () => {},
      printStatusBar: () => {},
      startStream: () => {},
      streamText: () => {},
      permissionPrompt: async () => true,
      permissionDenied: () => {},
    } as unknown as RuntimeServices['renderer'],

    dispose: async () => {},
  };

  return { ...defaults, ...overrides };
}
