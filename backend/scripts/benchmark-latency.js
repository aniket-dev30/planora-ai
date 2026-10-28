import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDaysToDateKey, getTodayDateKey } from '../../shared/taskDates.mjs';

dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../.env'), quiet: true });

const parseRuns = (args) => {
  const index = args.indexOf('--runs');
  const positionalRuns = args.find((argument) => /^\d+$/.test(argument));
  const inlineRuns = args.find((argument) => argument.startsWith('--runs='));
  const value = index >= 0 ? args[index + 1] : inlineRuns?.slice('--runs='.length) ?? positionalRuns;
  if (value === undefined) return 5;
  const runs = Number(value);
  return Number.isInteger(runs) && runs >= 3 && runs <= 10 ? runs : null;
};

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run benchmark:latency -- 5 --confirm-live');
  console.log('You can also pass --runs=5 directly to the Node script.');
  console.log('Runs 3-10 paired standard/priority comparisons; --confirm-live is required.');
  process.exit(0);
}
if (!args.includes('--confirm-live')) {
  console.error('Live Gemini calls are disabled unless you explicitly pass --confirm-live.');
  process.exit(2);
}
const runCount = parseRuns(args);
if (runCount === null) {
  console.error('--runs must be an integer from 3 to 10.');
  process.exit(2);
}
if (!process.env.GEMINI_API_KEY) {
  console.error('Set GEMINI_API_KEY in backend/.env before running the live benchmark.');
  process.exit(2);
}

const { generatePlan, getGeminiModel, getThinkingLevel } = await import('../src/services/planService.js');
const today = getTodayDateKey();
const benchmarkInput = {
  eventName: 'Planora latency benchmark event',
  eventType: 'Birthday',
  eventDate: addDaysToDateKey(today, 60),
  today,
  eventStartTime: '17:00',
  eventDurationMinutes: 180,
  durationIsSuggested: false,
  city: 'Delhi',
  guestCount: 40,
  totalBudget: 120000,
  style: 'Warm, practical family celebration',
  venuePreference: 'Accessible indoor venue with an outdoor backup',
  dietaryPreferences: 'Vegetarian, no eggs, include allergy-aware options',
  culturalPreferences: 'North Indian family celebration',
  additionalRequirements: 'Include children’s activities and a rain backup. Keep the plan within budget.',
  priorities: ['Guest comfort', 'Budget discipline'],
  requestedAction: 'Create a balanced event plan.',
};

const parseLog = (value) => {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const runSample = async (serviceTier, run) => {
  const capturedLogs = [];
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = (line) => capturedLogs.push(line);
  console.error = (line) => capturedLogs.push(line);
  const startedAt = performance.now();
  let success = false;
  let error;

  try {
    const result = await generatePlan(benchmarkInput, {
      serviceTier,
      onProgress: () => {},
    });
    success = result.source === 'gemini' && result.data.mode === 'gemini';
    if (!success) error = { code: 'UNEXPECTED_NON_GEMINI_RESULT' };
  } catch (caught) {
    error = {
      code: typeof caught?.code === 'string' ? caught.code : 'GENERATION_FAILED',
      providerStatusCode: Number.isInteger(caught?.providerStatusCode) ? caught.providerStatusCode : null,
      safeErrorCategory: typeof caught?.safeErrorCategory === 'string' ? caught.safeErrorCategory : null,
      retryable: typeof caught?.retryable === 'boolean' ? caught.retryable : null,
    };
  } finally {
    console.info = originalInfo;
    console.error = originalError;
  }

  const logs = capturedLogs.map(parseLog).filter(Boolean);
  const timing = logs.find((line) => line.event === 'plan_generation_timing');
  const providerError = logs.find((line) => typeof line.providerStatusCode === 'number');
  const result = {
    run,
    serviceTier,
    outcome: success ? 'success_validated' : error?.code ?? 'failed',
    elapsedWallMs: Math.round(performance.now() - startedAt),
    timeToFirstProviderEventMs: timing?.timeToFirstProviderEventMs ?? null,
    timeToFirstTokenMs: timing?.timeToFirstTokenMs ?? null,
    generationAfterFirstTokenMs: timing?.generationAfterFirstTokenMs ?? null,
    totalRequestMs: timing?.totalMs ?? null,
    responseValidationMs: timing?.responseValidationMs ?? null,
    providerAttemptCount: timing?.providerAttemptCount ?? 0,
    providerAttempts: (timing?.providerAttempts ?? []).map(
      ({ attempt, statusCode, elapsedMs, outcome }) => ({ attempt, statusCode, elapsedMs, outcome }),
    ),
    usage: timing?.usage ?? null,
  };

  if (!success) {
    result.providerError = {
      code: error?.code ?? null,
      providerStatusCode: error?.providerStatusCode ?? providerError?.providerStatusCode ?? null,
      safeErrorCategory: error?.safeErrorCategory ?? providerError?.safeErrorCategory ?? null,
      retryable: error?.retryable ?? providerError?.retryable ?? null,
      requestPhase: providerError?.requestPhase ?? timing?.requestPhase ?? null,
      ...(typeof providerError?.providerRequestId === 'string'
        ? { providerRequestId: providerError.providerRequestId }
        : {}),
    };
  }
  return result;
};

const tiers = ['standard', 'priority'];
const samples = [];
for (let run = 1; run <= runCount; run += 1) {
  const order = run % 2 === 1 ? tiers : [...tiers].reverse();
  for (const serviceTier of order) {
    samples.push(await runSample(serviceTier, run));
  }
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

const metricNames = [
  'timeToFirstProviderEventMs',
  'timeToFirstTokenMs',
  'generationAfterFirstTokenMs',
  'totalRequestMs',
  'responseValidationMs',
];
const summary = Object.fromEntries(tiers.map((serviceTier) => {
  const successful = samples.filter((sample) => sample.serviceTier === serviceTier && sample.outcome === 'success_validated');
  const failures = samples.filter((sample) => sample.serviceTier === serviceTier && sample.outcome !== 'success_validated');
  const metrics = Object.fromEntries(metricNames.map((name) => {
    const values = successful.map((sample) => sample[name]).filter(Number.isFinite);
    return [name, values.length
      ? { medianMs: median(values), minMs: Math.min(...values), maxMs: Math.max(...values), measuredRuns: values.length }
      : null];
  }));
  return [serviceTier, { successfulRuns: successful.length, failedRuns: failures.length, metrics }];
}));

console.log(JSON.stringify({
  benchmark: 'planora_gemini_service_tier_latency',
  model: getGeminiModel(),
  thinkingLevel: getThinkingLevel(),
  runsPerTier: runCount,
  fixture: 'synthetic event; same prompt/schema/requirements for both tiers',
  samples,
  summary,
  note: 'Only validated successful runs are included in latency medians and ranges. Prompt and plan content are not logged.',
}, null, 2));
