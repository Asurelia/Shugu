/**
 * Layer 1 — Transport: barrel export
 */

export { MiniMaxClient, MINIMAX_MODELS, DEFAULT_MODEL, type ClientConfig, type StreamOptions } from './client.js';
export { resolveAuth, type AuthConfig } from './auth.js';
export { parseSSEStream, accumulateStream, type AccumulatedResponse, type StreamCallbacks } from './stream.js';
export {
  TransportError,
  RateLimitError,
  ContextTooLongError,
  AuthenticationError,
  StreamTimeoutError,
  ModelFallbackError,
  withRetry,
  type RetryConfig,
} from './errors.js';
