/**
 * Tests for shared security utilities (src/utils/security.ts)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  timingSafeCompare,
  buildSafeEnv,
  validateRegexSafety,
  normalizeIPv6MappedIPv4,
  normalizeIPNotation,
} from '../src/utils/security.js';

// ─── timingSafeCompare ─────────────────────────────────

describe('timingSafeCompare', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeCompare('secret-token', 'secret-token')).toBe(true);
  });

  it('returns true for empty strings', () => {
    expect(timingSafeCompare('', '')).toBe(true);
  });

  it('returns false for different strings of same length', () => {
    expect(timingSafeCompare('aaaa', 'bbbb')).toBe(false);
  });

  it('returns false for different lengths', () => {
    expect(timingSafeCompare('short', 'much-longer-string')).toBe(false);
  });

  it('returns false when one string is empty', () => {
    expect(timingSafeCompare('', 'non-empty')).toBe(false);
    expect(timingSafeCompare('non-empty', '')).toBe(false);
  });

  it('handles unicode correctly', () => {
    expect(timingSafeCompare('héllo', 'héllo')).toBe(true);
    expect(timingSafeCompare('héllo', 'hello')).toBe(false);
  });

  it('returns false for strings that differ by one character', () => {
    expect(timingSafeCompare('Bearer abc123', 'Bearer abc124')).toBe(false);
  });

  it('handles long tokens', () => {
    const token = 'a'.repeat(1000);
    expect(timingSafeCompare(token, token)).toBe(true);
    expect(timingSafeCompare(token, token + 'b')).toBe(false);
  });
});

// ─── buildSafeEnv ──────────────────────────────────────

describe('buildSafeEnv', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Inject known test values
    process.env['PATH'] = '/usr/bin:/usr/local/bin';
    process.env['HOME'] = '/home/testuser';
    process.env['LANG'] = 'en_US.UTF-8';
    process.env['TERM'] = 'xterm-256color';
    // Inject secrets that should NOT pass through
    process.env['MINIMAX_API_KEY'] = 'sk-secret-key-12345';
    process.env['PCC_VAULT_PASSWORD'] = 'vault-master-pass';
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-secret';
    process.env['DATABASE_URL'] = 'postgresql://user:pass@host/db';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'aws-secret';
  });

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it('includes safe system variables', () => {
    const env = buildSafeEnv();
    expect(env['PATH']).toBe('/usr/bin:/usr/local/bin');
    expect(env['HOME']).toBe('/home/testuser');
    expect(env['LANG']).toBe('en_US.UTF-8');
    expect(env['TERM']).toBe('xterm-256color');
  });

  it('excludes API keys and secrets', () => {
    const env = buildSafeEnv();
    expect(env['MINIMAX_API_KEY']).toBeUndefined();
    expect(env['PCC_VAULT_PASSWORD']).toBeUndefined();
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['DATABASE_URL']).toBeUndefined();
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
  });

  it('merges caller-specified extras', () => {
    const env = buildSafeEnv({ PCC_DAEMON: '1', CUSTOM_VAR: 'value' });
    expect(env['PCC_DAEMON']).toBe('1');
    expect(env['CUSTOM_VAR']).toBe('value');
    // Safe vars still present
    expect(env['PATH']).toBe('/usr/bin:/usr/local/bin');
  });

  it('extra vars override allowlisted values', () => {
    const env = buildSafeEnv({ PATH: '/custom/path' });
    expect(env['PATH']).toBe('/custom/path');
  });

  it('returns empty-ish env if no allowlisted vars are set', () => {
    // Clear all allowlisted vars
    delete process.env['PATH'];
    delete process.env['HOME'];
    delete process.env['LANG'];
    delete process.env['TERM'];
    delete process.env['USERPROFILE'];
    delete process.env['SYSTEMROOT'];
    delete process.env['TMPDIR'];
    delete process.env['TEMP'];
    delete process.env['TMP'];
    delete process.env['SHELL'];

    const env = buildSafeEnv();
    // Should NOT fall back to including secrets
    expect(env['MINIMAX_API_KEY']).toBeUndefined();
    expect(env['PCC_VAULT_PASSWORD']).toBeUndefined();
  });
});

// ─── validateRegexSafety ───────────────────────────────

describe('validateRegexSafety', () => {
  it('accepts simple, safe patterns', () => {
    expect(validateRegexSafety('^hello$').safe).toBe(true);
    expect(validateRegexSafety('\\d{3}-\\d{4}').safe).toBe(true);
    expect(validateRegexSafety('foo|bar|baz').safe).toBe(true);
    expect(validateRegexSafety('[a-z]+').safe).toBe(true);
  });

  it('rejects nested quantifiers (a+)+', () => {
    const result = validateRegexSafety('(a+)+');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('catastrophic');
  });

  it('rejects nested quantifiers (a*)*', () => {
    expect(validateRegexSafety('(a*)*').safe).toBe(false);
  });

  it('rejects nested quantifiers (a+)*', () => {
    expect(validateRegexSafety('(a+)*').safe).toBe(false);
  });

  it('rejects nested quantifiers (a?)+', () => {
    expect(validateRegexSafety('(a?)+').safe).toBe(false);
  });

  it('rejects quantified alternation (a|a)*', () => {
    expect(validateRegexSafety('(a|a)*').safe).toBe(false);
  });

  it('rejects patterns with backreferences', () => {
    expect(validateRegexSafety('(a)\\1+').safe).toBe(false);
  });

  it('rejects patterns exceeding max length', () => {
    const longPattern = 'a'.repeat(201);
    const result = validateRegexSafety(longPattern);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('max length');
  });

  it('respects custom max length', () => {
    const pattern = 'a'.repeat(50);
    expect(validateRegexSafety(pattern, 100).safe).toBe(true);
    expect(validateRegexSafety(pattern, 30).safe).toBe(false);
  });

  it('rejects invalid regex syntax', () => {
    const result = validateRegexSafety('(unclosed');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('Invalid regex');
  });

  it('rejects quantified group with {n,m}', () => {
    expect(validateRegexSafety('(a+){2,}').safe).toBe(false);
  });
});

// ─── normalizeIPv6MappedIPv4 ───────────────────────────

describe('normalizeIPv6MappedIPv4', () => {
  it('converts dotted decimal form', () => {
    expect(normalizeIPv6MappedIPv4('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeIPv6MappedIPv4('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(normalizeIPv6MappedIPv4('::ffff:169.254.169.254')).toBe('169.254.169.254');
    expect(normalizeIPv6MappedIPv4('::ffff:192.168.1.1')).toBe('192.168.1.1');
  });

  it('handles uppercase FFFF', () => {
    expect(normalizeIPv6MappedIPv4('::FFFF:127.0.0.1')).toBe('127.0.0.1');
  });

  it('converts hex-encoded form', () => {
    // ::ffff:7f00:1 → 127.0.0.1
    expect(normalizeIPv6MappedIPv4('::ffff:7f00:1')).toBe('127.0.0.1');
    // ::ffff:a9fe:a9fe → 169.254.169.254
    expect(normalizeIPv6MappedIPv4('::ffff:a9fe:a9fe')).toBe('169.254.169.254');
    // ::ffff:c0a8:101 → 192.168.1.1
    expect(normalizeIPv6MappedIPv4('::ffff:c0a8:101')).toBe('192.168.1.1');
  });

  it('strips surrounding brackets', () => {
    expect(normalizeIPv6MappedIPv4('[::ffff:127.0.0.1]')).toBe('127.0.0.1');
    expect(normalizeIPv6MappedIPv4('[::ffff:7f00:1]')).toBe('127.0.0.1');
  });

  it('passes through regular IPv4', () => {
    expect(normalizeIPv6MappedIPv4('192.168.1.1')).toBe('192.168.1.1');
    expect(normalizeIPv6MappedIPv4('10.0.0.1')).toBe('10.0.0.1');
  });

  it('passes through regular IPv6', () => {
    expect(normalizeIPv6MappedIPv4('::1')).toBe('::1');
    expect(normalizeIPv6MappedIPv4('fe80::1')).toBe('fe80::1');
  });

  it('strips brackets from regular IPv6', () => {
    expect(normalizeIPv6MappedIPv4('[::1]')).toBe('::1');
  });
});

// ─── normalizeIPNotation ───────────────────────────────

describe('normalizeIPNotation', () => {
  it('converts hex IP notation', () => {
    // 0x7f000001 → 127.0.0.1
    expect(normalizeIPNotation('0x7f000001')).toBe('127.0.0.1');
    expect(normalizeIPNotation('0x7F000001')).toBe('127.0.0.1');
    // 0xa9fea9fe → 169.254.169.254
    expect(normalizeIPNotation('0xa9fea9fe')).toBe('169.254.169.254');
  });

  it('converts decimal IP notation', () => {
    // 2130706433 → 127.0.0.1
    expect(normalizeIPNotation('2130706433')).toBe('127.0.0.1');
  });

  it('converts octal dotted notation', () => {
    // 0177.0.0.1 → 127.0.0.1
    expect(normalizeIPNotation('0177.0.0.1')).toBe('127.0.0.1');
  });

  it('passes through standard dotted-decimal IPv4', () => {
    expect(normalizeIPNotation('192.168.1.1')).toBe('192.168.1.1');
    expect(normalizeIPNotation('127.0.0.1')).toBe('127.0.0.1');
  });

  it('passes through hostnames', () => {
    expect(normalizeIPNotation('example.com')).toBe('example.com');
    expect(normalizeIPNotation('localhost')).toBe('localhost');
  });
});
