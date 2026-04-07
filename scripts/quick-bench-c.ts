/**
 * Quick standalone run of Benchmark C classic tests.
 * Usage: npx tsx scripts/quick-bench-c.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import { MiniMaxClient } from '../src/transport/client.js';
import type { Message } from '../src/protocol/messages.js';
import { getTextContent } from '../src/protocol/messages.js';

// .env loader
function loadEnv(path: string): boolean {
  try {
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim(), v = t.slice(eq + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
    return true;
  } catch { return false; }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv(join(process.cwd(), '.env'));
loadEnv(join(__dirname, '..', '.env'));

const client = new MiniMaxClient({ temperature: 0.01, maxTokens: 1024, timeoutMs: 300_000 });
const SYS = 'You are taking a benchmark test. Answer each question as accurately and concisely as possible. For multiple choice, reply with ONLY the letter (A, B, C, or D). For math, reply with ONLY the number. For code, write the complete function. For text retrieval, reply with ONLY the requested value.';

interface Test {
  cat: string;
  name: string;
  prompt: string;
  expected: string;
  isMCQ?: boolean;
}

// NIAH filler
const FILLER_A = 'According to recent research in distributed systems, consensus algorithms play a critical role in ensuring data consistency across multiple nodes in a cluster. ';
const FILLER_B = 'Large language models have demonstrated emergent capabilities including multi-step reasoning, code generation, and complex problem solving across diverse domains. ';

const TESTS: Test[] = [
  // MMLU (5)
  { cat: 'MMLU', name: 'Binary search complexity', prompt: 'What is the time complexity of binary search on a sorted array?\nA) O(n)\nB) O(n²)\nC) O(log n)\nD) O(n log n)\nAnswer with ONLY the letter.', expected: 'C', isMCQ: true },
  { cat: 'MMLU', name: 'ACID definition', prompt: 'In a relational database, what does ACID stand for?\nA) Atomicity, Consistency, Isolation, Durability\nB) Access, Control, Integrity, Data\nC) Asynchronous, Concurrent, Indexed, Distributed\nD) Aggregation, Caching, Indexing, Denormalization\nAnswer with ONLY the letter.', expected: 'A', isMCQ: true },
  { cat: 'MMLU', name: 'CAP theorem', prompt: 'What does the CAP theorem state about distributed systems?\nA) You can have Consistency, Availability, and Partition tolerance simultaneously\nB) You can only guarantee two of Consistency, Availability, and Partition tolerance\nC) Consistency Always Prevails over availability\nD) Caching Accelerates Performance\nAnswer with ONLY the letter.', expected: 'B', isMCQ: true },
  { cat: 'MMLU', name: 'TCP vs UDP', prompt: 'What is the primary difference between TCP and UDP?\nA) TCP is faster than UDP\nB) UDP provides reliable ordered delivery while TCP does not\nC) TCP provides reliable ordered delivery while UDP does not\nD) They are identical\nAnswer with ONLY the letter.', expected: 'C', isMCQ: true },
  { cat: 'MMLU', name: 'Singleton pattern', prompt: 'Which design pattern ensures a class has only one instance?\nA) Factory\nB) Observer\nC) Singleton\nD) Strategy\nAnswer with ONLY the letter.', expected: 'C', isMCQ: true },

  // GPQA (5)
  { cat: 'GPQA', name: 'Hash table chain length', prompt: 'A hash table uses chaining. If n keys are inserted into m slots with uniform hashing, what is the expected chain length? Answer with a simple expression.', expected: 'n/m' },
  { cat: 'GPQA', name: 'B+ tree max keys', prompt: 'In a B+ tree of order m, what is the maximum number of keys in an internal node?\nA) m\nB) m-1\nC) m+1\nD) 2m\nAnswer with ONLY the letter.', expected: 'B', isMCQ: true },
  { cat: 'GPQA', name: 'Dijkstra space', prompt: "Dijkstra's algorithm with binary heap: space complexity where V=vertices, E=edges?\nA) O(V)\nB) O(E)\nC) O(V + E)\nD) O(V²)\nAnswer with ONLY the letter.", expected: 'C', isMCQ: true },
  { cat: 'GPQA', name: 'Bias-variance', prompt: 'The bias-variance tradeoff describes:\nA) Model complexity vs training speed\nB) Underfitting (high bias) vs overfitting (high variance)\nC) Accuracy vs interpretability\nD) Batch size vs learning rate\nAnswer with ONLY the letter.', expected: 'B', isMCQ: true },
  { cat: 'GPQA', name: 'Eventual consistency', prompt: 'Eventual consistency guarantees:\nA) All reads immediately see latest write\nB) If no new updates, all replicas eventually converge\nC) Writes applied in order\nD) No stale data ever\nAnswer with ONLY the letter.', expected: 'B', isMCQ: true },

  // MATH (5)
  { cat: 'MATH', name: 'Sum 1-100', prompt: 'What is the sum of all integers from 1 to 100? Answer with ONLY the number.', expected: '5050' },
  { cat: 'MATH', name: 'Recursive f(10)', prompt: 'f(1)=1, f(n)=f(n-1)+2n-1 for n>1. What is f(10)? Answer with ONLY the number.', expected: '100' },
  { cat: 'MATH', name: 'Staircase 10 steps', prompt: 'How many distinct ways to climb 10 steps taking 1 or 2 at a time? Answer with ONLY the number.', expected: '89' },
  { cat: 'MATH', name: 'GCD(252,105)', prompt: 'What is the GCD of 252 and 105? Answer with ONLY the number.', expected: '21' },
  { cat: 'MATH', name: 'log₂(x)=5', prompt: 'If log₂(x) = 5, what is x? Answer with ONLY the number.', expected: '32' },

  // HumanEval (5)
  { cat: 'CODE', name: 'Factorial', prompt: 'Write a Python function that returns the factorial of n.\ndef factorial(n):', expected: 'def factorial' },
  { cat: 'CODE', name: 'Is palindrome', prompt: 'Write a Python function that checks if a string is a palindrome (ignoring case and non-alphanumeric).\ndef is_palindrome(s):', expected: 'def is_palindrome' },
  { cat: 'CODE', name: 'LCS length', prompt: 'Write a Python function that returns the longest common subsequence length of two strings using DP.\ndef lcs_length(s1, s2):', expected: 'def lcs_length' },
  { cat: 'CODE', name: 'Flatten array TS', prompt: 'Write a TypeScript function that flattens a deeply nested array.\nfunction flatten(arr: any[]): any[]', expected: 'function flatten' },
  { cat: 'CODE', name: 'Binary search', prompt: 'Write a Python function for binary search. Return index or -1.\ndef binary_search(arr, target):', expected: 'def binary_search' },

  // NIAH (5)
  { cat: 'NIAH', name: 'Short (50 words)', prompt: 'Python was created by Guido. JavaScript by Brendan Eich. The secret passphrase hidden here is "EMERALD-PHOENIX-42". Ruby by Matz. Go by Google.\n\nWhat is the secret passphrase? Reply with ONLY it.', expected: 'EMERALD-PHOENIX-42' },
  { cat: 'NIAH', name: 'Medium (2K words)', prompt: FILLER_A.repeat(30) + 'The authentication token is "KRYPTON-SIGMA-7891". ' + FILLER_B.repeat(30) + '\n\nWhat is the authentication token? Reply with ONLY the token.', expected: 'KRYPTON-SIGMA-7891' },
  { cat: 'NIAH', name: 'Long (5K words)', prompt: FILLER_A.repeat(60) + 'IMPORTANT: The verification key is "QUANTUM-NEBULA-5577". ' + FILLER_B.repeat(60) + '\n\nWhat is the verification key? Reply with ONLY the key.', expected: 'QUANTUM-NEBULA-5577' },
  { cat: 'NIAH', name: 'Deep (10K words)', prompt: FILLER_A.repeat(120) + 'Hidden fact: The cafeteria password for Tuesday is "RUBY-FALCON-2048". ' + FILLER_B.repeat(120) + '\n\nWhat is the cafeteria password for Tuesday? Reply with ONLY it.', expected: 'RUBY-FALCON-2048' },
  { cat: 'NIAH', name: 'Extreme (20K words)', prompt: FILLER_A.repeat(250) + 'The nuclear launch code is "OBSIDIAN-DELTA-3301". ' + FILLER_B.repeat(250) + '\n\nWhat is the nuclear launch code? Reply with ONLY the code.', expected: 'OBSIDIAN-DELTA-3301' },
];

// ─── Run ─────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Benchmark C: Classic LLM Tests — MiniMax M2.7');
  console.log('═══════════════════════════════════════════════════\n');

  const results: { cat: string; name: string; correct: boolean; response: string; latencyMs: number; tps: number; inputTokens: number; outputTokens: number }[] = [];
  let totalCost = 0;
  let currentCat = '';

  for (const t of TESTS) {
    if (t.cat !== currentCat) {
      currentCat = t.cat;
      console.log(`\n  ── ${t.cat} ──\n`);
    }

    const start = Date.now();
    try {
      const msgs: Message[] = [{ role: 'user', content: t.prompt }];
      const r = await client.complete(msgs, { maxTokens: 1024, temperature: 0.01, systemPrompt: SYS });
      const text = getTextContent(r.message).trim();
      const ms = Date.now() - start;
      const tps = ms > 0 ? Math.round((r.usage.output_tokens / ms) * 1000) : 0;

      let correct: boolean;
      if (t.isMCQ) {
        // Extract letter
        const upper = text.toUpperCase();
        const letterMatch = upper.match(/\b([A-D])\b/);
        correct = letterMatch ? letterMatch[1] === t.expected.toUpperCase() : false;
      } else {
        correct = text.toUpperCase().includes(t.expected.toUpperCase());
      }

      totalCost += (r.usage.input_tokens / 1e6) * 0.30 + (r.usage.output_tokens / 1e6) * 1.10;

      results.push({ cat: t.cat, name: t.name, correct, response: text.slice(0, 120), latencyMs: ms, tps, inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens });

      const icon = correct ? '✓' : '✗';
      const preview = text.slice(0, 60).replace(/\n/g, ' ');
      console.log(`    ${icon} ${t.name}: "${preview}" (${ms}ms, ${tps} TPS, ${r.usage.input_tokens}+${r.usage.output_tokens} tok)`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ cat: t.cat, name: t.name, correct: false, response: 'ERROR: ' + msg.slice(0, 80), latencyMs: Date.now() - start, tps: 0, inputTokens: 0, outputTokens: 0 });
      console.log(`    ✗ ${t.name}: ERROR ${msg.slice(0, 80)}`);
    }

    await sleep(2000);
  }

  // ── Summary ──
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  RESULTS SUMMARY');
  console.log('═══════════════════════════════════════════════════\n');

  const cats = ['MMLU', 'GPQA', 'MATH', 'CODE', 'NIAH'];
  const officialClaims: Record<string, string> = {
    MMLU: 'Saturated (~90%+ for frontier)',
    GPQA: 'GPQA-Diamond not reported',
    MATH: 'MATH-500 not reported',
    CODE: 'SWE-bench Verified: 78%',
    NIAH: 'NIAH not reported, 34% halluc rate',
  };

  console.log('  Category    │ Score │  Pct  │ Official Claim');
  console.log('  ────────────┼───────┼───────┼──────────────────────────────');
  for (const cat of cats) {
    const catResults = results.filter(r => r.cat === cat);
    const correct = catResults.filter(r => r.correct).length;
    const total = catResults.length;
    const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
    console.log(`  ${cat.padEnd(12)}│ ${correct}/${total}   │ ${String(pct).padStart(3)}%  │ ${officialClaims[cat] ?? 'N/A'}`);
  }

  const totalCorrect = results.filter(r => r.correct).length;
  const totalTests = results.length;
  const overallPct = Math.round((totalCorrect / totalTests) * 100);
  console.log('  ────────────┼───────┼───────┼──────────────────────────────');
  console.log(`  TOTAL       │ ${totalCorrect}/${totalTests}  │ ${String(overallPct).padStart(3)}%  │`);

  // TPS stats
  const tpsValues = results.filter(r => r.tps > 0).map(r => r.tps);
  const avgTPS = tpsValues.length > 0 ? Math.round(tpsValues.reduce((a, b) => a + b, 0) / tpsValues.length) : 0;
  const maxTPS = tpsValues.length > 0 ? Math.max(...tpsValues) : 0;
  console.log(`\n  Speed: avg ${avgTPS} TPS, max ${maxTPS} TPS (official claim: 100 TPS)`);
  console.log(`  Cost: $${totalCost.toFixed(4)}`);

  // NIAH depth analysis
  console.log('\n  NIAH by depth:');
  const niahResults = results.filter(r => r.cat === 'NIAH');
  for (const r of niahResults) {
    const icon = r.correct ? '✓' : '✗';
    const tokInfo = r.inputTokens > 0 ? `${r.inputTokens} input tokens` : '';
    console.log(`    ${icon} ${r.name} (${r.latencyMs}ms, ${tokInfo})`);
  }

  // Save
  const outPath = join(__dirname, `benchmark-c-results-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify({ results, totalCost, avgTPS, maxTPS, overallPct }, null, 2));
  console.log(`\n  Results saved to: ${outPath}`);
  console.log('═══════════════════════════════════════════════════\n');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
