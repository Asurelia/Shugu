/**
 * Layer 1 — Transport: MiniMax Anthropic-compatible HTTP client
 *
 * Single point of network contact. The rest of the system NEVER talks to MiniMax directly.
 *
 * Uses the Anthropic Messages API format natively:
 * POST {baseUrl}/messages
 * Headers: x-api-key, anthropic-version, content-type
 *
 * MiniMax quirks handled here:
 * - reasoning_split: true (always, reasoning is mandatory)
 * - temperature: forced > 0 (range (0.0, 1.0], default 1.0)
 * - Full assistant responses preserved in multi-turn (including reasoning)
 */

import type { Message, SystemPrompt, Usage } from '../protocol/messages.js';
import { tracer } from '../utils/tracer.js';
import { logger } from '../utils/logger.js';
import type { ToolDefinition } from '../protocol/tools.js';
import type { ThinkingConfig } from '../protocol/thinking.js';
import type { StreamEvent } from '../protocol/events.js';
import { resolveAuth, type AuthConfig } from './auth.js';
import { parseSSEStream, accumulateStream, type AccumulatedResponse, type StreamCallbacks } from './stream.js';
import { classifyHttpError, withRetry, ModelNotFoundError, ModelFallbackError, type RetryConfig, DEFAULT_RETRY_CONFIG } from './errors.js';
import { getBreaker, CircuitOpenError } from './breaker.js';

// ─── Models ─────────────────────────────────────────────

export const MINIMAX_MODELS = {
  'best': 'MiniMax-M2.7-highspeed',
  'balanced': 'MiniMax-M2.7',
  'fast': 'MiniMax-M2.5-highspeed',
} as const;

export const DEFAULT_MODEL = MINIMAX_MODELS.best;

// ─── Client Configuration ───────────────────────────────

export interface ClientConfig {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  thinkingConfig?: ThinkingConfig;
  retryConfig?: RetryConfig;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

const DEFAULT_MAX_TOKENS = 16384;
const DEFAULT_TEMPERATURE = 1.0;
const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes for streaming
const ANTHROPIC_VERSION = '2023-06-01';

// ─── Request Types ──────────────────────────────────────

interface ApiTool {
  name: string;
  description: string;
  input_schema: ToolDefinition['inputSchema'];
}

interface MessagesRequest {
  model: string;
  max_tokens: number;
  messages: Message[];
  system?: SystemPrompt;
  tools?: ApiTool[];
  temperature: number;
  stream: boolean;
  // MiniMax-specific
  reasoning_split?: boolean;
}

// ─── Client ─────────────────────────────────────────────

export class MiniMaxClient {
  private auth: AuthConfig;
  private config: Required<Pick<ClientConfig, 'model' | 'maxTokens' | 'temperature' | 'timeoutMs'>> & {
    retryConfig: RetryConfig;
    thinkingConfig: ThinkingConfig;
  };

  constructor(config: ClientConfig = {}) {
    this.auth = resolveAuth();
    this.config = {
      model: config.model ?? DEFAULT_MODEL,
      maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: Math.max(0.01, config.temperature ?? DEFAULT_TEMPERATURE), // MiniMax: must be > 0
      thinkingConfig: config.thinkingConfig ?? { showThinking: true },
      retryConfig: config.retryConfig ?? DEFAULT_RETRY_CONFIG,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
  }

  /** Model fallback chain: best → balanced → fast */
  private static readonly FALLBACK_CHAIN: string[] = [
    MINIMAX_MODELS.best,
    MINIMAX_MODELS.balanced,
    MINIMAX_MODELS.fast,
  ];

  /**
   * Stream a message completion from MiniMax.
   * Returns an async generator of raw SSE events.
   *
   * Fallback chain: on ModelNotFoundError (404) or ModelFallbackError
   * (3 consecutive 529 overloads), downgrades to the next model in
   * best → balanced → fast order.
   */
  async *stream(
    messages: Message[],
    options: StreamOptions = {},
  ): AsyncGenerator<StreamEvent> {
    const body = this.buildRequestBody(messages, options);

    let response: Response;
    try {
      response = await withRetry(
        (_attempt) => this.makeRequest(body, options.abortSignal),
        this.config.retryConfig,
      );
    } catch (err) {
      if (err instanceof ModelNotFoundError || err instanceof ModelFallbackError) {
        response = await this.attemptFallback(body, err, options.abortSignal);
      } else {
        throw err;
      }
    }

    if (!response.body) {
      throw new Error('Response body is null — streaming not supported?');
    }

    // Idle timeout for SSE streaming phase (separate from connection timeout)
    const streamController = new AbortController();
    const STREAM_IDLE_TIMEOUT = 120_000; // 2 minutes idle = stale stream
    let idleTimer = setTimeout(() => streamController.abort(), STREAM_IDLE_TIMEOUT);

    // Combine user abort signal with stream idle controller
    if (options.abortSignal) {
      options.abortSignal.addEventListener('abort', () => streamController.abort(), { once: true });
    }

    try {
      for await (const event of parseSSEStream(response.body, streamController.signal)) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => streamController.abort(), STREAM_IDLE_TIMEOUT);
        yield event;
      }
    } finally {
      clearTimeout(idleTimer);
    }
  }

  /**
   * Try the next model in the fallback chain after a model error.
   * Throws the original error if no fallback is available.
   */
  private async attemptFallback(
    body: MessagesRequest,
    originalError: Error,
    abortSignal?: AbortSignal,
  ): Promise<Response> {
    const currentModel = body.model;
    const chainIdx = MiniMaxClient.FALLBACK_CHAIN.indexOf(currentModel);
    const nextModel = chainIdx >= 0 && chainIdx < MiniMaxClient.FALLBACK_CHAIN.length - 1
      ? MiniMaxClient.FALLBACK_CHAIN[chainIdx + 1]
      : undefined;

    if (!nextModel) {
      throw originalError;
    }

    tracer.log('decision', { action: 'model_fallback', from: currentModel, to: nextModel, reason: originalError.message });
    logger.warn(`Model fallback: ${currentModel} → ${nextModel} (${originalError.message})`);
    this.setModel(nextModel);
    body.model = nextModel;
    return withRetry(
      (_attempt) => this.makeRequest(body, abortSignal),
      this.config.retryConfig,
    );
  }

  /**
   * Send a message and accumulate the full response.
   * Convenience wrapper around stream() for simpler use cases.
   */
  async complete(
    messages: Message[],
    options: StreamOptions & { callbacks?: StreamCallbacks } = {},
  ): Promise<AccumulatedResponse> {
    const eventStream = this.stream(messages, options);
    return accumulateStream(eventStream, options.callbacks);
  }

  // ─── Request Building ───────────────────────────────

  private buildRequestBody(
    messages: Message[],
    options: StreamOptions,
  ): MessagesRequest {
    const body: MessagesRequest = {
      model: options.model ?? this.config.model,
      max_tokens: options.maxTokens ?? this.config.maxTokens,
      messages,
      temperature: Math.max(0.01, options.temperature ?? this.config.temperature),
      stream: true,
      // MiniMax: reasoning is MANDATORY, always split it out
      reasoning_split: this.config.thinkingConfig.showThinking,
    };

    if (options.systemPrompt) {
      body.system = options.systemPrompt;
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }

    return body;
  }

  // ─── HTTP ───────────────────────────────────────────

  private async makeRequest(
    body: MessagesRequest,
    abortSignal?: AbortSignal,
  ): Promise<Response> {
    const url = `${this.auth.baseUrl}/messages`;
    const breaker = getBreaker(url);

    // Route through the breaker. CircuitOpenError short-circuits retries
    // because it is non-TransportError and withRetry only retries
    // TransportErrors with retryable=true. classifyHttpError rethrows it
    // unchanged. Result: breaker-open calls fail fast without burning
    // retry budget.
    return breaker.execute(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

      // Combine user abort signal with timeout
      if (abortSignal) {
        abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
      }

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.auth.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorBody = await response.text();
          throw classifyHttpError(response.status, errorBody, response.headers.get('retry-after'));
        }

        return response;
      } finally {
        clearTimeout(timeoutId);
      }
    });
  }

  // ─── Model Switching ────────────────────────────────

  /**
   * Change the active model mid-session.
   * Used by /model and /fast commands, and by the fallback chain.
   */
  setModel(model: string): void {
    this.config.model = model;
  }

  // ─── Getters ────────────────────────────────────────

  get model(): string {
    return this.config.model;
  }

  get baseUrl(): string {
    return this.auth.baseUrl;
  }
}

// ─── Stream Options ─────────────────────────────────────

export interface StreamOptions {
  model?: string;
  maxTokens?: number;
  /** Override temperature for this request (MiniMax: must be > 0, range (0, 1]) */
  temperature?: number;
  systemPrompt?: SystemPrompt;
  tools?: ToolDefinition[];
  abortSignal?: AbortSignal;
}
