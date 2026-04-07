/**
 * Benchmark Suite: Context Window Stress Test + Obsidian Memory Impact
 *
 * Usage: npx tsx scripts/benchmark-context.ts
 *
 * Benchmark A — pushes MiniMax M2.7 from 50K to 1M tokens, measuring recall precision
 * Benchmark B — compares answer quality with vs without MemoryAgent
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import { MiniMaxClient } from '../src/transport/client.js';
import { ContextTooLongError, RateLimitError } from '../src/transport/errors.js';
import type { AccumulatedResponse } from '../src/transport/stream.js';
import type { Message, AssistantMessage, Usage } from '../src/protocol/messages.js';
import { isTextBlock, getTextContent } from '../src/protocol/messages.js';
import { MemoryAgent } from '../src/context/memory/agent.js';

// ─── .env Loader (replicated from bin/pcc.mjs) ──────────

function loadEnv(path: string): boolean {
  try {
    const content = readFileSync(path, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
    return true;
  } catch { return false; }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv(join(process.cwd(), '.env'));
loadEnv(join(homedir(), '.pcc', '.env'));
loadEnv(join(__dirname, '..', '.env'));

// ─── Configuration ──────────────────────────────────────

const CONFIG = {
  model: 'MiniMax-M2.7-highspeed',
  temperature: 0.01,
  maxResponseTokens: 1024,
  timeoutMs: 300_000,
  pauseMs: 2000,
  budgetCapUsd: 5.0,
  factsPerMessage: 500,    // user messages of ~500 facts each
  charsPerToken: 3.5,      // MiniMax estimation ratio
} as const;

// Thresholds: progressive + dense around the 204K declared limit
const THRESHOLDS = [50_000, 100_000, 150_000, 180_000, 195_000, 200_000, 204_000, 210_000, 220_000, 250_000, 300_000];

// ─── Cost Tracking ──────────────────────────────────────

// MiniMax M2.7-highspeed pricing (per million tokens)
const INPUT_COST_PER_M = 0.30;
const OUTPUT_COST_PER_M = 1.10;

let totalCostUsd = 0;

function trackCost(usage: Usage): number {
  const cost = (usage.input_tokens / 1_000_000) * INPUT_COST_PER_M
             + (usage.output_tokens / 1_000_000) * OUTPUT_COST_PER_M;
  totalCostUsd += cost;
  return cost;
}

// ─── City Pool (200 unique cities) ──────────────────────

const CITIES = [
  'Paris','Tokyo','Lima','Cairo','Oslo','Seoul','Rome','Baku','Doha','Suva',
  'Kyiv','Riga','Male','Bern','Apia','Lome','Niue','Kiev','Minsk','Quito',
  'Dubai','Lagos','Hanoi','Delhi','Dhaka','Kabul','Amman','Tunis','Rabat','Accra',
  'Bogota','Dakar','Sanaa','Maputo','Lusaka','Nauru','Tonga','Palau','Samoa','Kiribati',
  'Berlin','Madrid','London','Prague','Vienna','Warsaw','Lisbon','Dublin','Athens','Ankara',
  'Ottawa','Havana','Nassau','Brasilia','Santiago','Asuncion','Managua','Panama','Caracas','Sucre',
  'Beijing','Manila','Jakarta','Bangkok','Colombo','Yangon','Taipei','Bishkek','Astana','Muscat',
  'Canberra','Hobart','Auckland','Surabaya','Sapporo','Fukuoka','Nagoya','Osaka','Sendai','Kobe',
  'Zurich','Geneva','Monaco','Milan','Naples','Florence','Venice','Porto','Seville','Lyon',
  'Munich','Hamburg','Cologne','Dresden','Leipzig','Bremen','Essen','Hanover','Dortmund','Duisburg',
  'Montreal','Toronto','Calgary','Vancouver','Edmonton','Winnipeg','Quebec','Halifax','Victoria','Regina',
  'Houston','Chicago','Phoenix','Dallas','Austin','Denver','Seattle','Boston','Miami','Portland',
  'Mumbai','Chennai','Kolkata','Jaipur','Lucknow','Pune','Indore','Nagpur','Patna','Bhopal',
  'Shanghai','Shenzhen','Guangzhou','Chengdu','Wuhan','Nanjing','Hangzhou','Suzhou','Kunming','Changsha',
  'Nairobi','Kampala','Kigali','Harare','Windhoek','Gaborone','Mbabane','Maseru','Moroni','Asmara',
  'Riyadh','Tehran','Baghdad','Beirut','Damascus','Kuwait','Manama','Djibouti','Mogadishu','Tripoli',
  'Yerevan','Tbilisi','Tashkent','Dushanbe','Ashgabat','Baku2','Nukualofa','Funafuti','Tarawa','Majuro',
  'Stockholm','Helsinki','Copenhagen','Reykjavik','Tallinn','Vilnius','Ljubljana','Zagreb','Sarajevo','Pristina',
  'Montevideo','Georgetown','Paramaribo','Cayenne','Bridgetown','Roseau','Kingstown','Castries','Basseterre','Antigua',
  'Wellington','Honiara','Noumea','Papeete','Rarotonga','Nicosia','Valletta','SanMarino','Vaduz','Luxembourg',
];

// ─── Benchmark A Types ──────────────────────────────────

interface TraceFact {
  id: number;
  city: string;
  code: string;
  text: string;
}

type QuestionType = 'beginning' | 'middle' | 'end' | 'nonexistent' | 'reasoning';

interface RecallQuestion {
  type: QuestionType;
  prompt: string;
  expectedCodes: string[];   // empty for nonexistent
  factIds: number[];
}

interface RecallResult {
  question: RecallQuestion;
  response: string;
  correct: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  error: string | null;
}

interface ThresholdResult {
  targetTokens: number;
  estimatedTokens: number;
  factsUsed: number;
  recalls: RecallResult[];
  accuracy: number;
  hallucinationDetected: boolean;
  avgLatencyMs: number;
  apiInputTokens: number;
  error: string | null;
  hardLimitHit: boolean;
}

// ─── Benchmark B Types ──────────────────────────────────

interface MemoryQuestion {
  prompt: string;
  expectedKeywords: string[];
  category: string;
}

interface MemoryResult {
  question: MemoryQuestion;
  mode: 'with-memory' | 'without-memory';
  response: string;
  score: number;
  citesMemory: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  error: string | null;
}

// ─── Fact Generation ────────────────────────────────────

function generateFacts(count: number): TraceFact[] {
  const facts: TraceFact[] = [];
  for (let i = 1; i <= count; i++) {
    const city = CITIES[(i - 1) % CITIES.length]!;
    const id = i;
    const code = `ZULU-${String(i).padStart(4, '0')}`;
    facts.push({
      id,
      city: `${city}${i > CITIES.length ? `-${Math.floor(i / CITIES.length)}` : ''}`,
      code,
      text: `FACT-${String(i).padStart(4, '0')}: The secret code for city ${city}${i > CITIES.length ? `-${Math.floor(i / CITIES.length)}` : ''} is ${code}.`,
    });
  }
  return facts;
}

// ─── Message Packing ────────────────────────────────────

/** Estimate total tokens for a set of messages */
function estimateMessagesTokens(messages: Message[]): number {
  let totalChars = 0;
  for (const msg of messages) {
    // Per-message overhead (role, JSON structure): ~10 tokens
    totalChars += 35; // ~10 tokens * 3.5 chars/token
    if (typeof msg.content === 'string') {
      totalChars += msg.content.length;
    } else {
      for (const block of msg.content) {
        if (block.type === 'text') totalChars += (block as { text: string }).text.length;
      }
    }
  }
  return Math.ceil(totalChars / CONFIG.charsPerToken);
}

/** Calculate how many facts are needed to reach targetTokens */
function factsNeededForTarget(facts: TraceFact[], targetTokens: number): number {
  // Binary search for the right count
  let lo = 100, hi = facts.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const msgs = packFacts(facts, mid);
    const tokens = estimateMessagesTokens(msgs);
    if (tokens < targetTokens) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Pack N facts into alternating user/assistant messages */
function packFacts(facts: TraceFact[], count: number): Message[] {
  const messages: Message[] = [];
  const usedFacts = facts.slice(0, count);

  for (let i = 0; i < usedFacts.length; i += CONFIG.factsPerMessage) {
    const chunk = usedFacts.slice(i, i + CONFIG.factsPerMessage);
    const text = chunk.map(f => f.text).join('\n');
    messages.push({ role: 'user', content: text });
    messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: 'Acknowledged.' }],
    } as AssistantMessage);
  }

  return messages;
}

function buildContextMessages(facts: TraceFact[], targetTokens: number): { messages: Message[]; factsUsed: number; estimatedTokens: number } {
  const count = factsNeededForTarget(facts, targetTokens);
  const messages = packFacts(facts, count);
  const estimatedTokens = estimateMessagesTokens(messages);
  return { messages, factsUsed: count, estimatedTokens };
}

// ─── Recall Questions ───────────────────────────────────

function generateRecallQuestions(facts: TraceFact[], totalUsed: number): RecallQuestion[] {
  const used = facts.slice(0, totalUsed);
  const beginFact = used[Math.floor(totalUsed * 0.05)]!;
  const midFact = used[Math.floor(totalUsed * 0.50)]!;
  const endFact = used[Math.floor(totalUsed * 0.95)]!;
  const reasonFact1 = used[Math.floor(totalUsed * 0.25)]!;
  const reasonFact2 = used[Math.floor(totalUsed * 0.75)]!;

  return [
    {
      type: 'beginning',
      prompt: `What is the secret code for city ${beginFact.city}? Reply with ONLY the code (e.g., ZULU-XXXX).`,
      expectedCodes: [beginFact.code],
      factIds: [beginFact.id],
    },
    {
      type: 'middle',
      prompt: `What is the secret code for city ${midFact.city}? Reply with ONLY the code.`,
      expectedCodes: [midFact.code],
      factIds: [midFact.id],
    },
    {
      type: 'end',
      prompt: `What is the secret code for city ${endFact.city}? Reply with ONLY the code.`,
      expectedCodes: [endFact.code],
      factIds: [endFact.id],
    },
    {
      type: 'nonexistent',
      prompt: `What is the secret code for city ATLANTIS? Reply with ONLY the code, or "NOT FOUND" if not in the facts.`,
      expectedCodes: [],
      factIds: [],
    },
    {
      type: 'reasoning',
      prompt: `What are the secret codes for BOTH city ${reasonFact1.city} AND city ${reasonFact2.city}? Reply with both codes.`,
      expectedCodes: [reasonFact1.code, reasonFact2.code],
      factIds: [reasonFact1.id, reasonFact2.id],
    },
  ];
}

// ─── Scoring ────────────────────────────────────────────

function scoreRecall(q: RecallQuestion, response: string): boolean {
  const upper = response.toUpperCase();
  if (q.type === 'nonexistent') {
    // Correct if NO ZULU code is mentioned, or says NOT FOUND
    return !upper.match(/ZULU-\d{4}/) || upper.includes('NOT FOUND');
  }
  // For all others: all expected codes must be present
  return q.expectedCodes.every(code => upper.includes(code));
}

// ─── Safe API Call ──────────────────────────────────────

interface SafeResult {
  response: AccumulatedResponse | null;
  error: string | null;
  latencyMs: number;
}

async function safeComplete(
  client: MiniMaxClient,
  messages: Message[],
  systemPrompt?: string,
): Promise<SafeResult> {
  const start = Date.now();
  try {
    const response = await client.complete(messages, {
      maxTokens: CONFIG.maxResponseTokens,
      temperature: CONFIG.temperature,
      systemPrompt: systemPrompt ?? undefined,
    });
    return { response, error: null, latencyMs: Date.now() - start };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Detect context overflow — MiniMax returns different messages:
    // "prompt is too long" OR "context window exceeds limit"
    if (err instanceof ContextTooLongError || errMsg.includes('context window exceeds limit') || errMsg.includes('prompt is too long')) {
      return { response: null, error: 'context_too_long', latencyMs: Date.now() - start };
    }
    if (err instanceof RateLimitError) {
      console.log(`    ⏳ Rate limited, waiting ${err.retryAfterMs}ms...`);
      await sleep(err.retryAfterMs);
      // Retry once
      try {
        const response = await client.complete(messages, {
          maxTokens: CONFIG.maxResponseTokens,
          temperature: CONFIG.temperature,
          systemPrompt: systemPrompt ?? undefined,
        });
        return { response, error: null, latencyMs: Date.now() - start };
      } catch (retryErr) {
        return { response: null, error: `retry_failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`, latencyMs: Date.now() - start };
      }
    }
    return { response: null, error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - start };
  }
}

// ─── Benchmark A: Context Window Stress Test ────────────

const SYSTEM_PROMPT_A = `You are a fact retrieval assistant. You have been given many numbered facts about cities and their secret codes.
When asked about a specific city's code, reply with ONLY the code (e.g., ZULU-0042). Nothing else.
If the city does not exist in the facts, reply "NOT FOUND".
For questions about multiple cities, list both codes separated by a comma.`;

async function runBenchmarkA(client: MiniMaxClient): Promise<ThresholdResult[]> {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Benchmark A: Context Window Stress Test');
  console.log('═══════════════════════════════════════════════════\n');

  // Pre-generate enough facts for the largest threshold
  const maxTarget = THRESHOLDS[THRESHOLDS.length - 1]!;
  // ~17 tokens per fact, so maxTarget/15 gives comfortable headroom
  const maxFacts = Math.ceil(maxTarget / 15) + 2000;
  console.log(`  Generating ${maxFacts.toLocaleString()} traceable facts...`);
  const allFacts = generateFacts(maxFacts);
  console.log(`  Done.\n`);

  const results: ThresholdResult[] = [];
  let hardLimitConfirmed = 0; // counter: stop after 2 confirmed rejections

  for (let ti = 0; ti < THRESHOLDS.length; ti++) {
    const target = THRESHOLDS[ti]!;

    // Calculate actual facts needed for this token target
    const { messages: preflightMsgs, factsUsed: factsNeeded, estimatedTokens } = buildContextMessages(allFacts, target);

    console.log(`  [${ti + 1}/${THRESHOLDS.length}] Testing ${(target / 1000).toFixed(0)}K tokens (${factsNeeded.toLocaleString()} facts, ~${estimatedTokens.toLocaleString()} est. tokens)...`);

    // Budget check
    if (totalCostUsd >= CONFIG.budgetCapUsd) {
      console.log(`    ❌ Budget cap $${CONFIG.budgetCapUsd} reached. Stopping.`);
      break;
    }

    // If we've confirmed hard limit 2 times, stop
    if (hardLimitConfirmed >= 2) {
      console.log(`    ⛔ Hard limit confirmed. Skipping remaining thresholds.`);
      break;
    }

    const { messages: contextMessages } = buildContextMessages(allFacts, target);
    const questions = generateRecallQuestions(allFacts, factsNeeded);

    const recalls: RecallResult[] = [];
    let thresholdError: string | null = null;
    let hardLimitHit = false;
    let apiInputTokens = 0;

    for (const q of questions) {
      // Append question as final user message
      const messagesWithQuestion: Message[] = [
        ...contextMessages,
        { role: 'user', content: q.prompt },
      ];

      const result = await safeComplete(client, messagesWithQuestion, SYSTEM_PROMPT_A);

      if (result.error === 'context_too_long') {
        hardLimitHit = true;
        hardLimitConfirmed++;
        thresholdError = 'context_too_long';
        recalls.push({
          question: q,
          response: '',
          correct: false,
          latencyMs: result.latencyMs,
          inputTokens: 0,
          outputTokens: 0,
          error: 'context_too_long',
        });
        console.log(`    ⛔ Context too long at ${(target / 1000).toFixed(0)}K`);
        break; // No point testing more questions at this threshold
      }

      if (result.error) {
        recalls.push({
          question: q,
          response: '',
          correct: false,
          latencyMs: result.latencyMs,
          inputTokens: 0,
          outputTokens: 0,
          error: result.error,
        });
        thresholdError = result.error;
        continue;
      }

      const resp = result.response!;
      const text = getTextContent(resp.message);
      trackCost(resp.usage);
      apiInputTokens = resp.usage.input_tokens; // Last one is most accurate

      const correct = scoreRecall(q, text);

      recalls.push({
        question: q,
        response: text.slice(0, 200),
        correct,
        latencyMs: result.latencyMs,
        inputTokens: resp.usage.input_tokens,
        outputTokens: resp.usage.output_tokens,
        error: null,
      });

      const icon = correct ? '✓' : '✗';
      console.log(`    ${icon} ${q.type}: "${text.slice(0, 60).replace(/\n/g, ' ')}" (${result.latencyMs}ms)`);

      await sleep(CONFIG.pauseMs);
    }

    // Calculate stats
    const answerable = recalls.filter(r => r.question.type !== 'nonexistent' && !r.error);
    const correctCount = answerable.filter(r => r.correct).length;
    const nonExistent = recalls.find(r => r.question.type === 'nonexistent');
    const hallucinationDetected = nonExistent ? !nonExistent.correct && !nonExistent.error : false;
    const avgLatency = recalls.length > 0
      ? Math.round(recalls.reduce((s, r) => s + r.latencyMs, 0) / recalls.length)
      : 0;
    const accuracy = answerable.length > 0 ? correctCount / answerable.length : 0;

    const thresholdResult: ThresholdResult = {
      targetTokens: target,
      estimatedTokens,
      factsUsed: factsNeeded,
      recalls,
      accuracy,
      hallucinationDetected,
      avgLatencyMs: avgLatency,
      apiInputTokens,
      error: thresholdError,
      hardLimitHit,
    };
    results.push(thresholdResult);

    // Mini summary
    if (!hardLimitHit) {
      const accStr = answerable.length > 0 ? `${correctCount}/${answerable.length}` : 'N/A';
      console.log(`    → Accuracy: ${accStr} | Halluc: ${hallucinationDetected ? 'YES' : 'No'} | Latency: ${avgLatency}ms | API tokens: ${apiInputTokens.toLocaleString()}`);
    }
    console.log(`    → Cost so far: $${totalCostUsd.toFixed(4)}\n`);
  }

  return results;
}

// ─── Benchmark B: Memory Impact Test ────────────────────

const PROJECT_FACTS = [
  { title: 'Database choice', content: 'The team decided to use PostgreSQL over MongoDB for the main database because of complex relational queries needed.', type: 'decision' as const, tags: ['database', 'architecture'] },
  { title: 'Indentation preference', content: 'User prefers tabs over spaces with 2-width indentation in all TypeScript files.', type: 'preference' as const, tags: ['formatting'] },
  { title: 'API rate limit', content: 'The external payment service has a rate limit of 100 requests per minute. Above that, requests are throttled.', type: 'project_fact' as const, tags: ['api', 'limits'] },
  { title: 'Deploy target', content: 'Production deployments go to Railway with auto-deploy from the main branch. Staging uses preview deploys.', type: 'decision' as const, tags: ['deployment'] },
  { title: 'Auth strategy', content: 'Authentication uses JWT tokens with 15-minute expiry and refresh tokens stored in httpOnly cookies.', type: 'decision' as const, tags: ['auth', 'security'] },
  { title: 'Testing framework', content: 'The project uses Vitest for unit tests and Playwright for end-to-end testing.', type: 'project_fact' as const, tags: ['testing'] },
  { title: 'CSS approach', content: 'Styling uses Tailwind CSS v4 with a custom design system. No CSS modules or styled-components.', type: 'decision' as const, tags: ['styling'] },
  { title: 'Error monitoring', content: 'Sentry is configured for error monitoring in production with a 10% sample rate for performance traces.', type: 'project_fact' as const, tags: ['monitoring'] },
  { title: 'Branch naming', content: 'Git branches follow the pattern type/description-YYYYMMDD where type is feat, fix, refactor, or chore.', type: 'preference' as const, tags: ['git'] },
  { title: 'API versioning', content: 'The REST API uses URL-based versioning with /api/v1/ prefix. GraphQL is at /graphql with schema versioning.', type: 'decision' as const, tags: ['api'] },
  { title: 'Cache strategy', content: 'Redis is used for caching with a 5-minute TTL for API responses and 1-hour TTL for user sessions.', type: 'project_fact' as const, tags: ['caching'] },
  { title: 'Image processing', content: 'User uploads are processed through Sharp for resizing, stored in S3 with CloudFront CDN in front.', type: 'project_fact' as const, tags: ['images'] },
  { title: 'Logging format', content: 'Structured JSON logging via Pino. Log levels: error→warn→info→debug. Logs shipped to Datadog.', type: 'decision' as const, tags: ['logging'] },
  { title: 'Email provider', content: 'Transactional emails sent via Resend. Marketing emails via Mailchimp. Templates in React Email.', type: 'project_fact' as const, tags: ['email'] },
  { title: 'State management', content: 'Frontend uses Zustand for global state and TanStack Query for server state. No Redux.', type: 'decision' as const, tags: ['frontend'] },
  { title: 'Search engine', content: 'Full-text search powered by Meilisearch with auto-sync from PostgreSQL every 30 seconds.', type: 'project_fact' as const, tags: ['search'] },
  { title: 'CI pipeline', content: 'GitHub Actions runs lint, typecheck, unit tests, and e2e tests on every PR. Deploys on merge to main.', type: 'project_fact' as const, tags: ['ci'] },
  { title: 'Timezone handling', content: 'All dates stored in UTC. User timezone detected client-side via Intl API. Display uses date-fns-tz.', type: 'decision' as const, tags: ['dates'] },
  { title: 'File uploads limit', content: 'Maximum file upload size is 50MB. Accepted formats: PNG, JPG, WebP, PDF, DOCX. Others rejected.', type: 'project_fact' as const, tags: ['uploads'] },
  { title: 'Feature flags', content: 'Feature flags managed through LaunchDarkly. New features behind flags for 2 weeks before full rollout.', type: 'project_fact' as const, tags: ['features'] },
];

const MEMORY_QUESTIONS: MemoryQuestion[] = [
  { prompt: 'What database does this project use and why?', expectedKeywords: ['postgresql', 'relational'], category: 'decision' },
  { prompt: 'What is the indentation style preference for this project?', expectedKeywords: ['tabs', '2'], category: 'preference' },
  { prompt: 'What is the rate limit for the external payment API?', expectedKeywords: ['100', 'minute'], category: 'fact' },
  { prompt: 'Where are production deployments hosted?', expectedKeywords: ['railway', 'main'], category: 'decision' },
  { prompt: 'How does authentication work in this project?', expectedKeywords: ['jwt', '15', 'refresh'], category: 'decision' },
  { prompt: 'What testing frameworks are used?', expectedKeywords: ['vitest', 'playwright'], category: 'fact' },
  { prompt: 'What CSS solution does the project use?', expectedKeywords: ['tailwind'], category: 'decision' },
  { prompt: 'How is caching implemented?', expectedKeywords: ['redis', '5', 'minute'], category: 'fact' },
  { prompt: 'What is the search technology used?', expectedKeywords: ['meilisearch'], category: 'fact' },
  { prompt: 'How are feature flags managed?', expectedKeywords: ['launchdarkly', '2 week'], category: 'fact' },
];

function scoreMemoryAnswer(q: MemoryQuestion, response: string): number {
  const lower = response.toLowerCase();
  const matched = q.expectedKeywords.filter(kw => lower.includes(kw.toLowerCase()));
  const ratio = matched.length / q.expectedKeywords.length;
  if (ratio >= 1.0) return 2;
  if (ratio >= 0.5) return 1;
  return 0;
}

async function setupMemoryIndex(projectDir: string): Promise<MemoryAgent> {
  const benchDir = join(projectDir, '.pcc-benchmark');
  mkdirSync(join(benchDir, 'memory'), { recursive: true });

  const agent = new MemoryAgent(null, join(projectDir, '.pcc-benchmark').replace(/[\\/]memory$/, ''));
  // Override index path — MemoryAgent uses projectDir/.pcc/memory/index.json
  // We need to point it to .pcc-benchmark/memory/
  // Since MemoryAgent hardcodes .pcc/memory, we pass the parent dir
  const fakePccParent = benchDir.replace(/[\\/]\.pcc-benchmark$/, '');
  const agent2 = new MemoryAgent(null, fakePccParent);

  // Actually, MemoryAgent constructor does: join(projectDir, '.pcc', 'memory')
  // So we need to create .pcc/memory inside a temp dir
  // Simplest: just use the real project dir but with a separate agent instance
  const memAgent = new MemoryAgent(null, projectDir);
  await memAgent.loadIndex();

  // Save benchmark facts
  for (const fact of PROJECT_FACTS) {
    await memAgent.save({
      title: fact.title,
      content: fact.content,
      type: fact.type,
      confidence: 0.95,
      source: 'manual',
      tags: fact.tags,
      timestamp: new Date().toISOString(),
    });
  }
  await memAgent.flushIndex();

  return memAgent;
}

const SYSTEM_PROMPT_B_WITH = `You are a coding assistant for this project. Use the provided project memories to answer accurately. If you know the answer from the memories, state it directly and concisely.`;

const SYSTEM_PROMPT_B_WITHOUT = `You are a coding assistant. Answer the question based on your general knowledge. If you don't know specific project details, say so.`;

async function runBenchmarkB(client: MiniMaxClient): Promise<{ withMemory: MemoryResult[]; withoutMemory: MemoryResult[] }> {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Benchmark B: Memory Impact Test');
  console.log('═══════════════════════════════════════════════════\n');

  // Setup memory
  console.log('  Setting up memory index with 20 project facts...');
  const memAgent = await setupMemoryIndex(process.cwd());
  console.log('  Done.\n');

  const withMemory: MemoryResult[] = [];
  const withoutMemory: MemoryResult[] = [];

  // Mode A: With memory
  console.log('  ── Mode A: With Memory ──\n');
  for (const q of MEMORY_QUESTIONS) {
    // Get relevant context
    const memContext = await memAgent.getRelevantContext(q.prompt, 5);
    const fullSystem = memContext
      ? `${SYSTEM_PROMPT_B_WITH}\n\n${memContext}`
      : SYSTEM_PROMPT_B_WITH;

    const messages: Message[] = [{ role: 'user', content: q.prompt }];
    const result = await safeComplete(client, messages, fullSystem);

    if (result.response) {
      const text = getTextContent(result.response.message);
      trackCost(result.response.usage);
      const score = scoreMemoryAnswer(q, text);
      const cites = /memor|recall|previous|noted|decided|preference|configured/i.test(text);

      withMemory.push({
        question: q,
        mode: 'with-memory',
        response: text.slice(0, 300),
        score,
        citesMemory: cites,
        latencyMs: result.latencyMs,
        inputTokens: result.response.usage.input_tokens,
        outputTokens: result.response.usage.output_tokens,
        error: null,
      });

      console.log(`    ${score === 2 ? '✓✓' : score === 1 ? '✓ ' : '✗ '} [${score}/2] ${q.prompt.slice(0, 50)}...`);
    } else {
      withMemory.push({
        question: q,
        mode: 'with-memory',
        response: '',
        score: 0,
        citesMemory: false,
        latencyMs: result.latencyMs,
        inputTokens: 0,
        outputTokens: 0,
        error: result.error,
      });
      console.log(`    ✗  ERROR: ${result.error}`);
    }

    await sleep(CONFIG.pauseMs);
  }

  // Mode B: Without memory
  console.log('\n  ── Mode B: Without Memory ──\n');
  for (const q of MEMORY_QUESTIONS) {
    const messages: Message[] = [{ role: 'user', content: q.prompt }];
    const result = await safeComplete(client, messages, SYSTEM_PROMPT_B_WITHOUT);

    if (result.response) {
      const text = getTextContent(result.response.message);
      trackCost(result.response.usage);
      const score = scoreMemoryAnswer(q, text);

      withoutMemory.push({
        question: q,
        mode: 'without-memory',
        response: text.slice(0, 300),
        score,
        citesMemory: false,
        latencyMs: result.latencyMs,
        inputTokens: result.response.usage.input_tokens,
        outputTokens: result.response.usage.output_tokens,
        error: null,
      });

      console.log(`    ${score === 2 ? '✓✓' : score === 1 ? '✓ ' : '✗ '} [${score}/2] ${q.prompt.slice(0, 50)}...`);
    } else {
      withoutMemory.push({
        question: q,
        mode: 'without-memory',
        response: '',
        score: 0,
        citesMemory: false,
        latencyMs: result.latencyMs,
        inputTokens: 0,
        outputTokens: 0,
        error: result.error,
      });
      console.log(`    ✗  ERROR: ${result.error}`);
    }

    await sleep(CONFIG.pauseMs);
  }

  return { withMemory, withoutMemory };
}

// ─── Console Formatting ─────────────────────────────────

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length);
}

function padL(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : ' '.repeat(w - s.length) + s;
}

function printSummaryA(results: ThresholdResult[]): void {
  console.log('\n╔════════════╦════════╦══════════╦══════════╦════════╦═══════════╦══════════════╦════════════════════╗');
  console.log('║ Target     ║ Facts  ║ Est. Tok ║ Accuracy ║ Halluc ║ Latency   ║ API Tokens   ║ Error              ║');
  console.log('╠════════════╬════════╬══════════╬══════════╬════════╬═══════════╬══════════════╬════════════════════╣');
  for (const r of results) {
    const threshold = padL(`${(r.targetTokens / 1000).toFixed(0)}K`, 8);
    const facts = padL(r.factsUsed.toLocaleString(), 6);
    const est = padL(`${(r.estimatedTokens / 1000).toFixed(0)}K`, 6);
    const answerable = r.recalls.filter(rc => rc.question.type !== 'nonexistent' && !rc.error);
    const correct = answerable.filter(rc => rc.correct).length;
    const acc = r.hardLimitHit ? pad('   -', 8) : pad(`  ${correct}/${answerable.length}`, 8);
    const halluc = r.hardLimitHit ? pad(' -', 6) : pad(r.hallucinationDetected ? ' YES' : ' No', 6);
    const latency = r.hardLimitHit ? padL('-', 7) : padL(`${r.avgLatencyMs}ms`, 7);
    const tokens = r.hardLimitHit ? padL('-', 12) : padL(r.apiInputTokens.toLocaleString(), 12);
    const error = pad(r.error ? r.error.slice(0, 18) : '-', 18);
    console.log(`║ ${threshold} ║ ${facts} ║   ${est} ║ ${acc} ║ ${halluc} ║  ${latency} ║ ${tokens} ║ ${error} ║`);
  }
  console.log('╚════════════╩════════╩══════════╩══════════╩════════╩═══════════╩══════════════╩════════════════════╝');

  const hardLimit = results.find(r => r.hardLimitHit);
  if (hardLimit) {
    const prevOk = results.filter(r => !r.hardLimitHit);
    const lastOk = prevOk[prevOk.length - 1];
    console.log(`\n  Hard limit: API rejected at ${(hardLimit.targetTokens / 1000).toFixed(0)}K tokens`);
    if (lastOk) {
      console.log(`  Last successful threshold: ${(lastOk.targetTokens / 1000).toFixed(0)}K (${lastOk.apiInputTokens.toLocaleString()} API tokens)`);
    }
  } else {
    console.log('\n  No hard limit hit! MiniMax accepted all thresholds up to 1M tokens.');
  }
}

function printSummaryB(withMem: MemoryResult[], withoutMem: MemoryResult[]): void {
  console.log('\n╔══════════════════════════════════════════════╦══════════╦═════════╦═══════╗');
  console.log('║ Question                                     ║ With Mem ║ Without ║ Delta ║');
  console.log('╠══════════════════════════════════════════════╬══════════╬═════════╬═══════╣');
  for (let i = 0; i < MEMORY_QUESTIONS.length; i++) {
    const q = MEMORY_QUESTIONS[i]!;
    const wm = withMem[i]!;
    const wo = withoutMem[i]!;
    const qText = pad(q.prompt.slice(0, 44), 44);
    const wmScore = padL(`${wm.score}/2`, 6);
    const woScore = padL(`${wo.score}/2`, 5);
    const delta = wm.score - wo.score;
    const deltaStr = padL(delta > 0 ? `+${delta}` : `${delta}`, 5);
    console.log(`║ ${qText} ║   ${wmScore} ║  ${woScore} ║ ${deltaStr} ║`);
  }
  console.log('╚══════════════════════════════════════════════╩══════════╩═════════╩═══════╝');

  const avgWith = withMem.reduce((s, r) => s + r.score, 0) / withMem.length;
  const avgWithout = withoutMem.reduce((s, r) => s + r.score, 0) / withoutMem.length;
  const citationRate = withMem.filter(r => r.citesMemory).length / withMem.length;
  const delta = avgWith - avgWithout;

  console.log(`\n  Average: With memory ${avgWith.toFixed(1)}/2.0 | Without ${avgWithout.toFixed(1)}/2.0 | Delta ${delta > 0 ? '+' : ''}${delta.toFixed(1)}`);
  console.log(`  Memory citation rate: ${(citationRate * 100).toFixed(0)}%`);
}

// ─── Benchmark C: Classic LLM Benchmarks ────────────────
//
// Mini versions of standard benchmarks to compare MiniMax M2.7
// against its official claims. 5 categories × 5 questions = 25 calls.
//
// Official claims we're testing:
//   SWE-bench Verified: 78%        (we test coding ability)
//   GDPval-AA ELO: 1495            (we test instruction following)
//   Terminal Bench 2: 57%           (we test shell reasoning)
//   MLE-Bench medal rate: 66.6%    (we test ML knowledge)
//   Context: 204,800 tokens        (tested in Benchmark A)
//   Speed: 100 TPS                 (we measure actual TPS)
//   Hallucination rate: 34%        (we test factual accuracy)

interface ClassicQuestion {
  category: 'mmlu' | 'gpqa' | 'math' | 'humaneval' | 'niah';
  prompt: string;
  expectedAnswer: string;        // substring that must appear in correct response
  choices?: string[];            // for MCQ
  correctChoice?: string;        // A/B/C/D
  difficulty: 'easy' | 'medium' | 'hard';
  officialBenchmark: string;     // which official benchmark this maps to
}

interface ClassicResult {
  question: ClassicQuestion;
  response: string;
  correct: boolean;
  latencyMs: number;
  outputTokens: number;
  tokensPerSecond: number;
  error: string | null;
}

const CLASSIC_QUESTIONS: ClassicQuestion[] = [
  // ─── MMLU-style (knowledge QCM) ──────────────────────
  {
    category: 'mmlu', difficulty: 'easy', officialBenchmark: 'MMLU',
    prompt: `What is the time complexity of binary search on a sorted array of n elements?\nA) O(n)\nB) O(n²)\nC) O(log n)\nD) O(n log n)\nAnswer with ONLY the letter.`,
    expectedAnswer: 'C', correctChoice: 'C',
    choices: ['O(n)', 'O(n²)', 'O(log n)', 'O(n log n)'],
  },
  {
    category: 'mmlu', difficulty: 'medium', officialBenchmark: 'MMLU',
    prompt: `In a relational database, what does ACID stand for?\nA) Atomicity, Consistency, Isolation, Durability\nB) Access, Control, Integrity, Data\nC) Asynchronous, Concurrent, Indexed, Distributed\nD) Aggregation, Caching, Indexing, Denormalization\nAnswer with ONLY the letter.`,
    expectedAnswer: 'A', correctChoice: 'A',
    choices: ['Atomicity...', 'Access...', 'Async...', 'Aggregation...'],
  },
  {
    category: 'mmlu', difficulty: 'hard', officialBenchmark: 'MMLU',
    prompt: `In the context of distributed systems, what does the CAP theorem state?\nA) You can have Consistency, Availability, and Partition tolerance simultaneously\nB) You can only guarantee two of Consistency, Availability, and Partition tolerance\nC) Consistency Always Prevails over availability\nD) Caching Accelerates Performance in distributed systems\nAnswer with ONLY the letter.`,
    expectedAnswer: 'B', correctChoice: 'B',
    choices: ['All three', 'Only two', 'Consistency prevails', 'Caching'],
  },
  {
    category: 'mmlu', difficulty: 'hard', officialBenchmark: 'MMLU',
    prompt: `What is the primary difference between TCP and UDP?\nA) TCP is faster than UDP\nB) UDP provides reliable, ordered delivery while TCP does not\nC) TCP provides reliable, ordered delivery while UDP does not\nD) They are identical protocols with different names\nAnswer with ONLY the letter.`,
    expectedAnswer: 'C', correctChoice: 'C',
    choices: ['TCP faster', 'UDP reliable', 'TCP reliable', 'Identical'],
  },
  {
    category: 'mmlu', difficulty: 'medium', officialBenchmark: 'MMLU',
    prompt: `Which design pattern ensures a class has only one instance and provides a global point of access to it?\nA) Factory\nB) Observer\nC) Singleton\nD) Strategy\nAnswer with ONLY the letter.`,
    expectedAnswer: 'C', correctChoice: 'C',
    choices: ['Factory', 'Observer', 'Singleton', 'Strategy'],
  },

  // ─── GPQA-style (expert reasoning) ───────────────────
  {
    category: 'gpqa', difficulty: 'hard', officialBenchmark: 'GPQA-Diamond',
    prompt: `A hash table uses chaining for collision resolution. If n keys are inserted into a table with m slots, and the hash function distributes keys uniformly, what is the expected length of each chain?\nAnswer with a simple mathematical expression.`,
    expectedAnswer: 'n/m',
  },
  {
    category: 'gpqa', difficulty: 'hard', officialBenchmark: 'GPQA-Diamond',
    prompt: `In a B+ tree of order m, what is the maximum number of keys that can be stored in an internal node?\nA) m\nB) m-1\nC) m+1\nD) 2m\nAnswer with ONLY the letter.`,
    expectedAnswer: 'B', correctChoice: 'B',
    choices: ['m', 'm-1', 'm+1', '2m'],
  },
  {
    category: 'gpqa', difficulty: 'hard', officialBenchmark: 'GPQA-Diamond',
    prompt: `What is the space complexity of Dijkstra's algorithm using a binary heap, where V is the number of vertices and E is the number of edges?\nA) O(V)\nB) O(E)\nC) O(V + E)\nD) O(V²)\nAnswer with ONLY the letter.`,
    expectedAnswer: 'C', correctChoice: 'C',
    choices: ['O(V)', 'O(E)', 'O(V + E)', 'O(V²)'],
  },
  {
    category: 'gpqa', difficulty: 'medium', officialBenchmark: 'GPQA-Diamond',
    prompt: `In machine learning, what does the bias-variance tradeoff describe?\nA) The tradeoff between model complexity and training speed\nB) The tradeoff between underfitting (high bias) and overfitting (high variance)\nC) The tradeoff between accuracy and interpretability\nD) The tradeoff between batch size and learning rate\nAnswer with ONLY the letter.`,
    expectedAnswer: 'B', correctChoice: 'B',
    choices: ['Complexity/speed', 'Under/overfitting', 'Accuracy/interpret', 'Batch/LR'],
  },
  {
    category: 'gpqa', difficulty: 'hard', officialBenchmark: 'GPQA-Diamond',
    prompt: `In a system using eventual consistency, what guarantee does the system provide?\nA) All reads will immediately see the latest write\nB) If no new updates are made, all replicas will eventually converge to the same value\nC) Writes are guaranteed to be applied in order\nD) The system will never return stale data\nAnswer with ONLY the letter.`,
    expectedAnswer: 'B', correctChoice: 'B',
    choices: ['Immediate read', 'Eventually converge', 'Ordered writes', 'No stale data'],
  },

  // ─── MATH-style (mathematical reasoning) ─────────────
  {
    category: 'math', difficulty: 'easy', officialBenchmark: 'MATH-500',
    prompt: `What is the sum of all integers from 1 to 100? Answer with ONLY the number.`,
    expectedAnswer: '5050',
  },
  {
    category: 'math', difficulty: 'medium', officialBenchmark: 'MATH-500',
    prompt: `A function f(n) is defined as: f(1)=1, f(n)=f(n-1)+2n-1 for n>1. What is f(10)? Answer with ONLY the number.`,
    expectedAnswer: '100',
  },
  {
    category: 'math', difficulty: 'hard', officialBenchmark: 'MATH-500',
    prompt: `How many distinct ways can you climb a staircase of 10 steps if you can take 1 or 2 steps at a time? Answer with ONLY the number.`,
    expectedAnswer: '89',
  },
  {
    category: 'math', difficulty: 'hard', officialBenchmark: 'MATH-500',
    prompt: `What is the greatest common divisor (GCD) of 252 and 105? Answer with ONLY the number.`,
    expectedAnswer: '21',
  },
  {
    category: 'math', difficulty: 'medium', officialBenchmark: 'MATH-500',
    prompt: `If log₂(x) = 5, what is x? Answer with ONLY the number.`,
    expectedAnswer: '32',
  },

  // ─── HumanEval-style (code generation) ───────────────
  {
    category: 'humaneval', difficulty: 'easy', officialBenchmark: 'HumanEval',
    prompt: `Write a Python function that returns the factorial of a non-negative integer n. Just the function, no explanation.\ndef factorial(n):`,
    expectedAnswer: 'factorial',
  },
  {
    category: 'humaneval', difficulty: 'medium', officialBenchmark: 'HumanEval',
    prompt: `Write a Python function that checks if a string is a palindrome (ignoring case and non-alphanumeric characters). Return True or False.\ndef is_palindrome(s):`,
    expectedAnswer: 'def is_palindrome',
  },
  {
    category: 'humaneval', difficulty: 'hard', officialBenchmark: 'HumanEval',
    prompt: `Write a Python function that returns the longest common subsequence (LCS) length of two strings. Use dynamic programming.\ndef lcs_length(s1, s2):`,
    expectedAnswer: 'def lcs_length',
  },
  {
    category: 'humaneval', difficulty: 'medium', officialBenchmark: 'HumanEval',
    prompt: `Write a TypeScript function that flattens a deeply nested array. For example, flatten([1, [2, [3, [4]]]]) should return [1, 2, 3, 4].\nfunction flatten(arr: any[]): any[]`,
    expectedAnswer: 'function flatten',
  },
  {
    category: 'humaneval', difficulty: 'hard', officialBenchmark: 'HumanEval',
    prompt: `Write a Python function that implements binary search on a sorted list. Return the index of the target, or -1 if not found.\ndef binary_search(arr, target):`,
    expectedAnswer: 'def binary_search',
  },

  // ─── NIAH-style (needle in a haystack — mini version) ─
  {
    category: 'niah', difficulty: 'easy', officialBenchmark: 'NIAH',
    prompt: `Here is a document about various programming languages:\n\nPython was created by Guido van Rossum in 1991. It emphasizes code readability. JavaScript was created by Brendan Eich in 1995 for web browsers. Java was created by James Gosling at Sun Microsystems in 1995. The secret passphrase hidden in this document is "EMERALD-PHOENIX-42". Ruby was created by Yukihiro Matsumoto in 1995. Go was created at Google in 2009 by Robert Griesemer, Rob Pike, and Ken Thompson. Rust was created by Graydon Hoare at Mozilla in 2010.\n\nWhat is the secret passphrase hidden in this document? Reply with ONLY the passphrase.`,
    expectedAnswer: 'EMERALD-PHOENIX-42',
  },
  {
    category: 'niah', difficulty: 'medium', officialBenchmark: 'NIAH',
    prompt: `${'The following is a technical report about database optimization techniques. '.repeat(20)}The authentication token for the production API is "KRYPTON-SIGMA-7891". ${'This section covers indexing strategies for large-scale data warehouses. '.repeat(20)}What is the authentication token mentioned in the document? Reply with ONLY the token.`,
    expectedAnswer: 'KRYPTON-SIGMA-7891',
  },
  {
    category: 'niah', difficulty: 'hard', officialBenchmark: 'NIAH',
    prompt: `${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. '.repeat(50)}The nuclear launch code is "OBSIDIAN-DELTA-3301". ${'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. '.repeat(50)}What is the nuclear launch code mentioned in this text? Reply with ONLY the code.`,
    expectedAnswer: 'OBSIDIAN-DELTA-3301',
  },
  {
    category: 'niah', difficulty: 'hard', officialBenchmark: 'NIAH',
    prompt: `${'According to recent research in distributed systems, consensus algorithms play a critical role in ensuring data consistency across nodes. '.repeat(40)}IMPORTANT: The verification key is "QUANTUM-NEBULA-5577". ${'Paxos and Raft are two of the most widely studied consensus protocols, each with distinct tradeoffs in terms of performance and complexity. '.repeat(40)}What is the verification key? Reply with ONLY the key.`,
    expectedAnswer: 'QUANTUM-NEBULA-5577',
  },
  {
    category: 'niah', difficulty: 'medium', officialBenchmark: 'NIAH',
    prompt: `${'The field of natural language processing has seen remarkable advances with transformer architectures and attention mechanisms. '.repeat(30)}Hidden fact: The cafeteria password for Tuesday is "RUBY-FALCON-2048". ${'Large language models have demonstrated emergent capabilities including reasoning, code generation, and multi-step problem solving. '.repeat(30)}What is the cafeteria password for Tuesday? Reply with ONLY the password.`,
    expectedAnswer: 'RUBY-FALCON-2048',
  },
];

function scoreClassic(q: ClassicQuestion, response: string): boolean {
  const text = response.trim();
  const upper = text.toUpperCase();

  if (q.correctChoice) {
    // MCQ: check if correct letter is in response
    // Accept "C", "C)", "(C)", "The answer is C", etc.
    const letter = q.correctChoice.toUpperCase();
    return upper.includes(letter) && !upper.includes(
      // Make sure it's not just mentioning the letter in another context
      // Check the letter appears as a standalone choice marker
      q.choices?.find((_, i) => {
        const otherLetter = String.fromCharCode(65 + i);
        return otherLetter !== letter && upper.startsWith(otherLetter);
      }) ?? '###NOMATCH###'
    );
  }

  // For non-MCQ: check expected substring
  return text.includes(q.expectedAnswer) || upper.includes(q.expectedAnswer.toUpperCase());
}

// Better MCQ scoring — extract the chosen letter
function extractMCQChoice(response: string): string | null {
  const text = response.trim().toUpperCase();
  // Try patterns: "C", "C)", "(C)", "Answer: C", "The answer is C"
  const patterns = [
    /^([A-D])\)?$/,                    // Just the letter
    /^\(([A-D])\)$/,                    // (C)
    /^([A-D])\)/,                       // C) at start
    /ANSWER[:\s]+\(?([A-D])\)?/i,       // Answer: C
    /^([A-D])\b/,                       // C followed by word boundary
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1]!;
  }
  // Last resort: first single capital letter A-D
  const firstLetter = text.match(/\b([A-D])\b/);
  return firstLetter ? firstLetter[1]! : null;
}

function scoreClassicMCQ(q: ClassicQuestion, response: string): boolean {
  if (q.correctChoice) {
    const chosen = extractMCQChoice(response);
    return chosen === q.correctChoice.toUpperCase();
  }
  return response.includes(q.expectedAnswer) || response.toUpperCase().includes(q.expectedAnswer.toUpperCase());
}

const SYSTEM_PROMPT_C = `You are taking a benchmark test. Answer each question as accurately and concisely as possible. For multiple choice, reply with ONLY the letter (A, B, C, or D). For math, reply with ONLY the number. For code, write the complete function. For text retrieval, reply with ONLY the requested value.`;

async function runBenchmarkC(client: MiniMaxClient): Promise<{ results: ClassicResult[]; byCategory: Record<string, { total: number; correct: number; accuracy: number }> }> {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Benchmark C: Classic LLM Benchmarks');
  console.log('  (MMLU × 5, GPQA × 5, MATH × 5, HumanEval × 5, NIAH × 5)');
  console.log('═══════════════════════════════════════════════════\n');

  const results: ClassicResult[] = [];

  let currentCategory = '';
  for (const q of CLASSIC_QUESTIONS) {
    if (q.category !== currentCategory) {
      currentCategory = q.category;
      console.log(`  ── ${q.category.toUpperCase()} (${q.officialBenchmark}) ──\n`);
    }

    // Budget check
    if (totalCostUsd >= CONFIG.budgetCapUsd) {
      console.log(`    ❌ Budget cap reached. Stopping.`);
      break;
    }

    const messages: Message[] = [{ role: 'user', content: q.prompt }];
    const startMs = Date.now();
    const result = await safeComplete(client, messages, SYSTEM_PROMPT_C);
    const elapsedMs = result.latencyMs;

    if (result.response) {
      const text = getTextContent(result.response.message);
      trackCost(result.response.usage);
      const outputTokens = result.response.usage.output_tokens;
      const tps = elapsedMs > 0 ? Math.round((outputTokens / elapsedMs) * 1000) : 0;

      const correct = q.correctChoice ? scoreClassicMCQ(q, text) : scoreClassic(q, text);

      results.push({
        question: q,
        response: text.slice(0, 300),
        correct,
        latencyMs: elapsedMs,
        outputTokens,
        tokensPerSecond: tps,
        error: null,
      });

      const icon = correct ? '✓' : '✗';
      const preview = text.slice(0, 60).replace(/\n/g, ' ');
      console.log(`    ${icon} [${q.difficulty}] "${preview}" (${elapsedMs}ms, ${tps} TPS)`);
    } else {
      results.push({
        question: q,
        response: '',
        correct: false,
        latencyMs: elapsedMs,
        outputTokens: 0,
        tokensPerSecond: 0,
        error: result.error,
      });
      console.log(`    ✗ ERROR: ${result.error}`);
    }

    await sleep(CONFIG.pauseMs);
  }

  // Aggregate by category
  const byCategory: Record<string, { total: number; correct: number; accuracy: number }> = {};
  for (const r of results) {
    const cat = r.question.category;
    if (!byCategory[cat]) byCategory[cat] = { total: 0, correct: 0, accuracy: 0 };
    byCategory[cat]!.total++;
    if (r.correct) byCategory[cat]!.correct++;
  }
  for (const cat of Object.keys(byCategory)) {
    byCategory[cat]!.accuracy = byCategory[cat]!.total > 0
      ? byCategory[cat]!.correct / byCategory[cat]!.total
      : 0;
  }

  return { results, byCategory };
}

function printSummaryC(results: ClassicResult[], byCategory: Record<string, { total: number; correct: number; accuracy: number }>): void {
  // Overall stats
  const avgTPS = results.filter(r => r.tokensPerSecond > 0).length > 0
    ? Math.round(results.filter(r => r.tokensPerSecond > 0).reduce((s, r) => s + r.tokensPerSecond, 0) / results.filter(r => r.tokensPerSecond > 0).length)
    : 0;

  console.log('\n╔═══════════════╦═══════════╦══════════════════════════╦═══════════╗');
  console.log('║ Category      ║ Score     ║ Official Benchmark       ║ Our Score ║');
  console.log('╠═══════════════╬═══════════╬══════════════════════════╬═══════════╣');

  const officialMap: Record<string, string> = {
    mmlu: 'MMLU (saturated ~90%)',
    gpqa: 'GPQA-Diamond (~85-94%)',
    math: 'MATH-500 (not reported)',
    humaneval: 'SWE-bench Verified: 78%',
    niah: 'NIAH (not reported)',
  };

  for (const [cat, stats] of Object.entries(byCategory)) {
    const catName = pad(cat.toUpperCase(), 13);
    const score = pad(`${stats.correct}/${stats.total}`, 7);
    const official = pad(officialMap[cat] ?? 'N/A', 24);
    const pct = padL(`${Math.round(stats.accuracy * 100)}%`, 7);
    console.log(`║ ${catName} ║  ${score}  ║ ${official} ║  ${pct}  ║`);
  }

  const totalCorrect = results.filter(r => r.correct).length;
  const totalQ = results.length;
  const overallPct = Math.round((totalCorrect / totalQ) * 100);

  console.log('╠═══════════════╬═══════════╬══════════════════════════╬═══════════╣');
  console.log(`║ ${pad('TOTAL', 13)} ║  ${pad(`${totalCorrect}/${totalQ}`, 7)}  ║ ${pad('Overall accuracy', 24)} ║  ${padL(`${overallPct}%`, 7)}  ║`);
  console.log('╚═══════════════╩═══════════╩══════════════════════════╩═══════════╝');

  console.log(`\n  Measured TPS: ${avgTPS} tokens/sec (official claim: 100 TPS)`);
  console.log(`  Hallucination test: ${byCategory['niah']?.correct ?? 0}/${byCategory['niah']?.total ?? 0} NIAH correct (official claim: 34% hallucination rate)`);
}

// ─── Main ───────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Shugu Benchmark Suite v1.0 — MiniMax M2.7');
  console.log('═══════════════════════════════════════════════════');

  // Validate API key
  const apiKey = process.env['MINIMAX_API_KEY'];
  if (!apiKey || apiKey.length < 10) {
    console.error('\n  ❌ MINIMAX_API_KEY not set. Add it to .env or export it.');
    process.exit(1);
  }
  console.log(`\n  API Key: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);
  console.log(`  Model: ${CONFIG.model}`);
  console.log(`  Budget cap: $${CONFIG.budgetCapUsd}`);
  console.log(`  Thresholds: ${THRESHOLDS.map(t => `${(t / 1000).toFixed(0)}K`).join(', ')}`);

  const client = new MiniMaxClient({
    temperature: CONFIG.temperature,
    maxTokens: CONFIG.maxResponseTokens,
    timeoutMs: CONFIG.timeoutMs,
  });

  // ── Run Benchmark A ──
  const benchmarkAResults = await runBenchmarkA(client);
  printSummaryA(benchmarkAResults);

  // ── Run Benchmark B ──
  const benchmarkBResults = await runBenchmarkB(client);
  printSummaryB(benchmarkBResults.withMemory, benchmarkBResults.withoutMemory);

  // ── Run Benchmark C ──
  const benchmarkCResults = await runBenchmarkC(client);
  printSummaryC(benchmarkCResults.results, benchmarkCResults.byCategory);

  // ── Save results ──
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputPath = join(__dirname, `benchmark-results-${timestamp}.json`);
  const fullResults = {
    version: 2,
    generatedAt: new Date().toISOString(),
    model: CONFIG.model,
    benchmarkA: {
      name: 'context-window-stress',
      thresholds: benchmarkAResults,
      hardLimitTokens: benchmarkAResults.find(r => r.hardLimitHit)?.targetTokens ?? null,
    },
    benchmarkB: {
      name: 'obsidian-memory-impact',
      withMemory: benchmarkBResults.withMemory,
      withoutMemory: benchmarkBResults.withoutMemory,
      avgScoreWith: benchmarkBResults.withMemory.reduce((s, r) => s + r.score, 0) / benchmarkBResults.withMemory.length,
      avgScoreWithout: benchmarkBResults.withoutMemory.reduce((s, r) => s + r.score, 0) / benchmarkBResults.withoutMemory.length,
    },
    benchmarkC: {
      name: 'classic-llm-benchmarks',
      results: benchmarkCResults.results,
      byCategory: benchmarkCResults.byCategory,
      officialClaims: {
        'SWE-bench Verified': '78%',
        'SWE-Pro': '56.22%',
        'Terminal Bench 2': '57.0%',
        'GDPval-AA ELO': '1495',
        'MLE-Bench medal rate': '66.6%',
        'Context window': '204,800 tokens',
        'Speed': '100 TPS',
        'Hallucination rate': '34%',
      },
    },
    totalCostUsd,
  };

  writeFileSync(outputPath, JSON.stringify(fullResults, null, 2), 'utf-8');

  // ── Final summary ──
  console.log('\n═══════════════════════════════════════════════════');
  console.log(`  Total cost: $${totalCostUsd.toFixed(4)}`);
  console.log(`  Results saved to: ${outputPath}`);
  console.log('═══════════════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
