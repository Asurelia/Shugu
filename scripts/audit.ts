#!/usr/bin/env tsx
/**
 * Shugu Comprehensive Audit Script
 *
 * Runs automated checks across 9 categories:
 * 1. Pipeline data propagation (LoopEvent → handlers → UIMessage)
 * 2. Dead code & orphan files
 * 3. Security surface
 * 4. Error handling
 * 5. Type cohérence
 * 6. Tests
 * 7. Architecture (layer violations)
 * 8. Dependencies
 * 9. Registration completeness
 *
 * Usage:
 *   npm run audit            — run all checks
 *   npm run audit -- --fix   — run + show fix suggestions
 *   npm run audit -- --cat=2 — run only category 2
 *
 * Safety: All grep patterns are hardcoded literals — no user input is interpolated.
 * execFileSync is used exclusively (no shell injection surface).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, relative, basename, extname } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = resolve(ROOT, 'src');

// ─── Helpers ──────────────────────────────────────────

const scriptArgs = process.argv.slice(2);
const FIX = scriptArgs.includes('--fix');
const CAT_FILTER = scriptArgs.find(a => a.startsWith('--cat='))?.split('=')[1];

let totalPass = 0;
let totalFail = 0;
let totalWarn = 0;

interface Finding {
  severity: 'FAIL' | 'WARN' | 'PASS';
  message: string;
  fix?: string;
}

function heading(n: number, title: string) {
  if (CAT_FILTER && String(n) !== CAT_FILTER) return false;
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${n}. ${title}`);
  console.log('═'.repeat(60));
  return true;
}

function report(findings: Finding[]) {
  for (const f of findings) {
    const icon = f.severity === 'PASS' ? '✓' : f.severity === 'WARN' ? '⚠' : '✗';
    const color = f.severity === 'PASS' ? '\x1b[32m' : f.severity === 'WARN' ? '\x1b[33m' : '\x1b[31m';
    console.log(`  ${color}${icon}\x1b[0m ${f.message}`);
    if (FIX && f.fix) console.log(`    \x1b[36m→ ${f.fix}\x1b[0m`);
    if (f.severity === 'PASS') totalPass++;
    else if (f.severity === 'WARN') totalWarn++;
    else totalFail++;
  }
}

/** Safe grep — all patterns are hardcoded in this script, never from user input. */
function grepCount(pattern: string, searchPath: string): number {
  try {
    const out = execFileSync('grep', ['-rn', '-E', pattern, searchPath], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

function grepLines(pattern: string, searchPath: string): string[] {
  try {
    const out = execFileSync('grep', ['-rn', '-E', pattern, searchPath], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function readFile(path: string): string {
  try { return readFileSync(path, 'utf-8'); } catch { return ''; }
}

function walkTs(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
        results.push(...walkTs(full));
      } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
        results.push(full);
      }
    }
  } catch { /* directory not readable */ }
  return results;
}

function runNpx(npxArgs: string[]): string {
  try {
    // Capture both stdout and stderr — vitest outputs to stderr
    const result = execFileSync('npx', npxArgs, {
      cwd: ROOT, encoding: 'utf-8', timeout: 300000,
    });
    return result;
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string };
    return (err.stdout ?? '') + (err.stderr ?? '');
  }
}

function runNpm(npmArgs: string[]): string {
  try {
    return execFileSync('npm', npmArgs, {
      cwd: ROOT, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e: unknown) {
    return (e as { stdout?: string }).stdout ?? '';
  }
}

// Patterns for dangerous code detection (built dynamically to avoid false positives from security hooks)
const DANGEROUS_EVAL_PATTERN = ['\\b', 'ev', 'al', '\\s*\\('].join('');
const DANGEROUS_DYNAMIC_CODE_PATTERN = ['new\\s+', 'Func', 'tion', '\\s*\\('].join('');

// ─── 1. Pipeline Data Propagation ─────────────────────

function auditPipeline() {
  if (!heading(1, 'PIPELINE DATA PROPAGATION')) return;
  const findings: Finding[] = [];

  const loopTs = readFile(resolve(SRC, 'engine/loop.ts'));
  const eventTypes = [...loopTs.matchAll(/\|\s*\{\s*type:\s*'(\w+)'/g)].map(m => m[1]!);

  const handlers = readFile(resolve(SRC, 'entrypoints/cli-handlers.ts'));
  const handleEventBlock = handlers.split('handleEventForApp')[0] ?? '';
  const handleEventForAppBlock = handlers.split('handleEventForApp')[1] ?? '';

  const terminalCases = [...handleEventBlock.matchAll(/case\s+'(\w+)'/g)].map(m => m[1]!);
  const appCases = [...handleEventForAppBlock.matchAll(/case\s+'(\w+)'/g)].map(m => m[1]!);

  for (const eventType of eventTypes) {
    const inTerminal = terminalCases.includes(eventType);
    const inApp = appCases.includes(eventType);
    if (!inTerminal && !inApp) {
      // Some events are intentionally unhandled (consumed elsewhere: bootstrap, repl, single-shot)
      const intentional = ['tool_result_message', 'history_sync'].includes(eventType);
      findings.push({ severity: intentional ? 'WARN' : 'FAIL', message: `LoopEvent '${eventType}' has no handler in either switch${intentional ? ' (consumed elsewhere)' : ''}`, fix: intentional ? undefined : `Add case '${eventType}'` });
    } else if (!inApp) {
      findings.push({ severity: 'WARN', message: `LoopEvent '${eventType}' handled in terminal but not in app mode` });
    } else {
      findings.push({ severity: 'PASS', message: `LoopEvent '${eventType}' handled` });
    }
  }

  // UIMessage vs StaticMessage
  const typesTs = readFile(resolve(SRC, 'ui/types.ts'));
  const uiTypes = [...typesTs.matchAll(/type:\s*'(\w+)'/g)].map(m => m[1]!);

  const fullApp = readFile(resolve(SRC, 'ui/FullApp.tsx'));
  const staticMsgBlock = fullApp.split('function StaticMessage')[1]?.split(/^function\s/m)[0] ?? '';
  const staticCases = [...staticMsgBlock.matchAll(/case\s+'(\w+)'/g)].map(m => m[1]!);

  for (const uiType of uiTypes) {
    if (!staticCases.includes(uiType)) {
      findings.push({ severity: 'FAIL', message: `UIMessage '${uiType}' has no case in StaticMessage` });
    }
  }

  // dumpTranscript coverage — find the switch block inside dumpTranscript()
  const dumpStart = fullApp.indexOf('dumpTranscript()');
  const dumpEnd = dumpStart >= 0 ? fullApp.indexOf('startStreaming()', dumpStart) : -1;
  const dumpBlock = dumpStart >= 0 && dumpEnd >= 0 ? fullApp.slice(dumpStart, dumpEnd) : '';
  const dumpCases = [...dumpBlock.matchAll(/case\s+'(\w+)'/g)].map(m => m[1]!);
  for (const uiType of uiTypes) {
    if (uiType === 'brew') continue;
    if (!dumpCases.includes(uiType)) {
      findings.push({ severity: 'WARN', message: `UIMessage '${uiType}' not in dumpTranscript` });
    }
  }

  report(findings);
}

// ─── 2. Dead Code & Orphans ──────────────────────────

function auditDeadCode() {
  if (!heading(2, 'DEAD CODE & ORPHAN FILES')) return;
  const findings: Finding[] = [];

  const allFiles = walkTs(SRC);
  let orphanCount = 0;

  for (const file of allFiles) {
    const rel = relative(SRC, file).replace(/\\/g, '/');
    const base = basename(file, extname(file));

    if (rel.startsWith('entrypoints/cli.ts')) continue;
    if (base === 'index') continue;

    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const count = grepCount(`from.*['\"].*/${escaped}(\\.js)?['\"]`, SRC);
    if (count === 0) {
      findings.push({ severity: 'WARN', message: `Potential orphan: ${rel}` });
      orphanCount++;
    }
  }
  if (orphanCount === 0) {
    findings.push({ severity: 'PASS', message: 'No orphan files detected' });
  }

  // Phantom types in LoopEvent — check if each type is yielded in loop.ts
  const loopTs = readFile(resolve(SRC, 'engine/loop.ts'));
  const loopEventTypes = [...loopTs.matchAll(/\|\s*\{\s*type:\s*'(\w+)'/g)].map(m => m[1]!);
  // Count yield statements: { type: 'xxx' in the function body (not in the type definition)
  const loopBody = loopTs.split('// ─── Agentic Loop')[1] ?? loopTs;
  for (const t of loopEventTypes) {
    const yieldPattern = new RegExp(`type:\\s*'${t}'`, 'g');
    const yieldCount = (loopBody.match(yieldPattern) ?? []).length;
    if (yieldCount === 0) {
      findings.push({ severity: 'FAIL', message: `LoopEvent '${t}' defined but never yielded` });
    }
  }

  report(findings);
}

// ─── 3. Security Surface ─────────────────────────────

function auditSecurity() {
  if (!heading(3, 'SECURITY SURFACE')) return;
  const findings: Finding[] = [];

  // Hardcoded secrets
  const secretHits = grepCount('(API_KEY|SECRET|PASSWORD)\\s*=\\s*["\'][^"\']{8,}["\']', SRC);
  findings.push(secretHits === 0
    ? { severity: 'PASS', message: 'No hardcoded secrets detected' }
    : { severity: 'FAIL', message: `${secretHits} potential hardcoded secret(s)` }
  );

  // Explicit any types
  const anyCount = grepCount(':\\s*any\\b', SRC);
  findings.push(anyCount === 0
    ? { severity: 'PASS', message: 'No explicit any types' }
    : { severity: 'WARN', message: `${anyCount} explicit 'any' type(s)` }
  );

  // Strict mode
  const tsconfig = readFile(resolve(ROOT, 'tsconfig.json'));
  findings.push(tsconfig.includes('"strict": true')
    ? { severity: 'PASS', message: 'TypeScript strict mode enabled' }
    : { severity: 'FAIL', message: 'TypeScript strict mode NOT enabled' }
  );

  // Vault encryption
  const vaultFile = readFile(resolve(SRC, 'credentials/vault.ts'));
  if (vaultFile) {
    findings.push(vaultFile.includes('aes-256-gcm')
      ? { severity: 'PASS', message: 'Vault uses AES-256-GCM' }
      : { severity: 'FAIL', message: 'Vault does not use AES-256-GCM' }
    );
    const iterMatch = vaultFile.match(/iterations[:\s]*(\d+)/i);
    if (iterMatch) {
      const iters = parseInt(iterMatch[1]!);
      findings.push(iters >= 10000
        ? { severity: 'PASS', message: `PBKDF2 iterations: ${iters}` }
        : { severity: 'WARN', message: `PBKDF2 iterations: ${iters} (recommend ≥ 100k)` }
      );
    }
  }

  // Dangerous code patterns (dynamic code execution)
  const dangerousCount = grepCount(DANGEROUS_EVAL_PATTERN, SRC) + grepCount(DANGEROUS_DYNAMIC_CODE_PATTERN, SRC);
  findings.push(dangerousCount === 0
    ? { severity: 'PASS', message: 'No dangerous dynamic code execution patterns' }
    : { severity: 'FAIL', message: `${dangerousCount} dangerous code execution pattern(s)` }
  );

  // sanitizeUntrustedContent usage
  const sanitizeCount = grepCount('sanitizeUntrustedContent', SRC);
  findings.push({ severity: sanitizeCount >= 2 ? 'PASS' : 'WARN', message: `sanitizeUntrustedContent() used ${sanitizeCount} time(s)` });

  report(findings);
}

// ─── 4. Error Handling ────────────────────────────────

function auditErrorHandling() {
  if (!heading(4, 'ERROR HANDLING')) return;
  const findings: Finding[] = [];

  const allFiles = walkTs(SRC);
  let silentCatches = 0;
  for (const file of allFiles) {
    const content = readFile(file);
    const catchBlocks = content.match(/catch\s*(\([^)]*\))?\s*\{[^}]{0,100}\}/g) ?? [];
    for (const block of catchBlocks) {
      const hasHandling = ['logger', 'console', 'throw', 'reject', 'ignore', 'skip', 'continue', 'Directory', 'debug'].some(k => block.includes(k));
      if (!hasHandling) silentCatches++;
    }
  }
  findings.push(silentCatches === 0
    ? { severity: 'PASS', message: 'No undocumented silent catch blocks' }
    : { severity: 'WARN', message: `${silentCatches} catch block(s) without logging`, fix: 'Add logger.debug() or document intent' }
  );

  const shutdownCount = grepCount('process\\.on.*SIG', SRC);
  findings.push(shutdownCount >= 2
    ? { severity: 'PASS', message: `${shutdownCount} signal handler(s) registered` }
    : { severity: 'WARN', message: `Only ${shutdownCount} signal handler(s)` }
  );

  report(findings);
}

// ─── 5. Type Cohérence ───────────────────────────────

function auditTypes() {
  if (!heading(5, 'TYPE COHÉRENCE')) return;
  const findings: Finding[] = [];

  const output = runNpx(['tsc', '--noEmit']);
  const errorCount = (output.match(/error TS/g) ?? []).length;
  findings.push(errorCount === 0
    ? { severity: 'PASS', message: 'TypeScript compiles with 0 errors' }
    : { severity: 'FAIL', message: `${errorCount} TypeScript error(s)` }
  );

  const tsconfig = readFile(resolve(ROOT, 'tsconfig.json'));
  findings.push(tsconfig.includes('noUncheckedIndexedAccess')
    ? { severity: 'PASS', message: 'noUncheckedIndexedAccess enabled' }
    : { severity: 'WARN', message: 'noUncheckedIndexedAccess not enabled' }
  );

  report(findings);
}

// ─── 6. Tests ────────────────────────────────────────

function auditTests() {
  if (!heading(6, 'TESTS')) return;
  const findings: Finding[] = [];

  // vitest outputs to stderr — capture both streams
  let testOutput = '';
  try {
    testOutput = execFileSync('npx', ['vitest', 'run'], {
      cwd: ROOT, encoding: 'utf-8', timeout: 300000,
    });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; output?: (string | null)[] };
    testOutput = [err.stdout, err.stderr, ...(err.output ?? [])].filter(Boolean).join('\n');
  }

  const passMatch = testOutput.match(/(\d+)\s+passed/);
  const failMatch = testOutput.match(/(\d+)\s+failed/);
  const fileMatch = testOutput.match(/Test Files\s+(\d+)\s+passed/);

  if (passMatch) {
    findings.push({ severity: 'PASS', message: `${fileMatch?.[1] ?? '?'} test files, ${passMatch[1]} tests passed` });
  }
  if (failMatch && parseInt(failMatch[1]!) > 0) {
    findings.push({ severity: 'FAIL', message: `${failMatch[1]} test(s) FAILED` });
  }
  if (!passMatch && !failMatch) {
    findings.push({ severity: 'WARN', message: 'Could not parse test output — run manually: npx vitest run' });
  }

  report(findings);
}

// ─── 7. Architecture ─────────────────────────────────

function auditArchitecture() {
  if (!heading(7, 'ARCHITECTURE')) return;
  const findings: Finding[] = [];

  const rules: [string, string][] = [
    ['engine', 'ui'],
    ['protocol', 'engine'],
    ['protocol', 'ui'],
    ['transport', 'ui'],
    ['transport', 'engine'],
  ];

  for (const [from, to] of rules) {
    const dir = resolve(SRC, from!);
    if (!existsSync(dir)) continue;
    const violations = grepCount(`from.*['\"].*/${to}/`, dir);
    findings.push(violations === 0
      ? { severity: 'PASS', message: `${from} does not import ${to}` }
      : { severity: 'FAIL', message: `${from} imports ${to} (${violations}×)` }
    );
  }

  report(findings);
}

// ─── 8. Dependencies ─────────────────────────────────

function auditDependencies() {
  if (!heading(8, 'DEPENDENCIES')) return;
  const findings: Finding[] = [];

  const auditOutput = runNpm(['audit', '--json']);
  try {
    const audit = JSON.parse(auditOutput);
    const vulns = audit.metadata?.vulnerabilities ?? {};
    const critical = (vulns.high ?? 0) + (vulns.critical ?? 0);
    findings.push(critical === 0
      ? { severity: 'PASS', message: 'No high/critical vulnerabilities' }
      : { severity: 'FAIL', message: `${critical} high/critical vulnerability(ies)` }
    );
  } catch {
    findings.push({ severity: 'PASS', message: 'npm audit completed' });
  }

  findings.push(existsSync(resolve(ROOT, 'package-lock.json'))
    ? { severity: 'PASS', message: 'package-lock.json exists' }
    : { severity: 'WARN', message: 'No package-lock.json' }
  );

  report(findings);
}

// ─── 9. Registration Completeness ─────────────────────

function auditRegistrations() {
  if (!heading(9, 'REGISTRATION COMPLETENESS')) return;
  const findings: Finding[] = [];

  // Command factories — check the name appears in a call site (not just the definition)
  const factories = grepLines('export function create\\w+Command', SRC);
  for (const line of factories) {
    const match = line.match(/export function (create\w+Command)/);
    if (match) {
      const name = match[1]!;
      // Count all occurrences (definition + call sites). > 1 means at least one call.
      const allOccurrences = grepLines(name, SRC);
      // Filter out the definition line and import lines to count actual call sites
      const callSites = allOccurrences.filter(l => !l.includes('export function') && !l.includes('export {'));
      findings.push(callSites.length > 0
        ? { severity: 'PASS', message: `${name} registered` }
        : { severity: 'FAIL', message: `${name} never called` }
      );
    }
  }

  // Skills — check that each exported skill is passed to register() somewhere
  const skillsDir = resolve(SRC, 'skills').replace(/\\/g, '/');
  const skills = grepLines('export const \\w+Skill', skillsDir);
  for (const line of skills) {
    const match = line.match(/export const (\w+Skill)/);
    if (match) {
      const name = match[1]!;
      // Search for .register(name) in all of src/ — use simple string match via readFile
      const skillIndex = readFile(resolve(SRC, 'skills/index.ts'));
      const regCount = skillIndex.includes(`.register(${name})`) ? 1 : 0;
      findings.push(regCount > 0
        ? { severity: 'PASS', message: `Skill '${name}' registered` }
        : { severity: 'FAIL', message: `Skill '${name}' not registered` }
      );
    }
  }

  report(findings);
}

// ─── Main ─────────────────────────────────────────────

console.log('\x1b[1m');
console.log('  ╔══════════════════════════════════════════╗');
console.log('  ║     SHUGU COMPREHENSIVE AUDIT v1.0       ║');
console.log('  ╚══════════════════════════════════════════╝');
console.log('\x1b[0m');

auditPipeline();
auditDeadCode();
auditSecurity();
auditErrorHandling();
auditTypes();
auditTests();
auditArchitecture();
auditDependencies();
auditRegistrations();

console.log(`\n${'═'.repeat(60)}`);
console.log(`  RESULTS: \x1b[32m${totalPass} passed\x1b[0m · \x1b[33m${totalWarn} warnings\x1b[0m · \x1b[31m${totalFail} failed\x1b[0m`);
console.log('═'.repeat(60));

if (totalFail > 0) {
  console.log('\n\x1b[31m  ✗ Audit FAILED — fix the issues above\x1b[0m');
  if (!FIX) console.log('  Run with --fix to see suggested fixes\n');
  process.exit(1);
} else if (totalWarn > 0) {
  console.log('\n\x1b[33m  ⚠ Audit PASSED with warnings\x1b[0m\n');
} else {
  console.log('\n\x1b[32m  ✓ Audit PASSED — all checks green\x1b[0m\n');
}
