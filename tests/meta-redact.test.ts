import { describe, it, expect } from 'vitest';
import { redactMessages, redactTraceEvents } from '../src/meta/redact.js';
import type { Message } from '../src/protocol/messages.js';
import type { TraceEvent } from '../src/utils/tracer.js';

describe('redactMessages', () => {
  it('redacts API keys from string content', () => {
    const messages: Message[] = [
      { role: 'user', content: 'My api_key=sk_test_abcdefghijklmnop12345 is secret' },
    ];
    const redacted = redactMessages(messages);
    expect(redacted[0]!.content).not.toContain('sk_test_abcdefghijklmnop12345');
    expect(redacted[0]!.content).toContain('[REDACTED]');
  });

  it('redacts AWS access keys', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Found key: AKIAIOSFODNN7EXAMPLE' },
    ];
    const redacted = redactMessages(messages);
    expect(redacted[0]!.content).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts Bearer tokens', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc' },
    ];
    const redacted = redactMessages(messages);
    expect(redacted[0]!.content).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc');
  });

  it('redacts credential file paths', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Vault at ~/.pcc/credentials/vault.json' },
    ];
    const redacted = redactMessages(messages);
    expect(redacted[0]!.content).toContain('[REDACTED:path]');
    expect(redacted[0]!.content).not.toContain('.pcc/credentials/vault.json');
  });

  it('preserves non-sensitive content', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Please fix the bug in src/utils/helper.ts' },
    ];
    const redacted = redactMessages(messages);
    expect(redacted[0]!.content).toBe('Please fix the bug in src/utils/helper.ts');
  });

  it('handles block-based assistant content', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Found secret: api_key=supersecretkey1234567890123' },
        ],
      },
    ];
    const redacted = redactMessages(messages);
    const block = (redacted[0]!.content as any[])[0];
    expect(block.text).toContain('[REDACTED]');
    expect(block.text).not.toContain('supersecretkey1234567890123');
  });

  it('does not mutate original messages', () => {
    const original: Message[] = [
      { role: 'user', content: 'api_key=mysecretkey1234567890123456' },
    ];
    const originalContent = original[0]!.content;
    redactMessages(original);
    expect(original[0]!.content).toBe(originalContent);
  });
});

describe('redactTraceEvents', () => {
  it('redacts string values in trace event data', () => {
    const events: TraceEvent[] = [
      {
        traceId: 'test',
        spanId: 'span1',
        type: 'tool_result',
        timestamp: new Date().toISOString(),
        data: {
          content: 'token=ghp_abcdefghijklmnopqrstuvwxyz1234567890',
        },
      },
    ];
    const redacted = redactTraceEvents(events);
    expect(redacted[0]!.data.content).toContain('[REDACTED]');
    expect(redacted[0]!.data.content).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz1234567890');
  });

  it('preserves non-string data values', () => {
    const events: TraceEvent[] = [
      {
        traceId: 'test',
        spanId: 'span1',
        type: 'model_call',
        timestamp: new Date().toISOString(),
        data: { turnIndex: 5, model: 'MiniMax-M2.7' },
      },
    ];
    const redacted = redactTraceEvents(events);
    expect(redacted[0]!.data.turnIndex).toBe(5);
    expect(redacted[0]!.data.model).toBe('MiniMax-M2.7');
  });
});
