import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveBudgetAllocation } from '../../shared/budget.mjs';
import { getTodayDateKey, toDateKey } from '../../shared/taskDates.mjs';
import { eventInputSchema } from '../src/schemas/plan.js';
import {
  buildDemoPlan,
  generatePlan,
  getGeminiResponseSchema,
  getGeminiTimeoutMs,
  getThinkingLevel,
  OUTPUT_LIST_LIMITS,
  PlanGenerationError,
  resolveDuration,
  resolveToday,
} from '../src/services/planService.js';

const futureDate = (days) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const baseInput = (overrides = {}) => eventInputSchema.parse({
  eventName: 'Meera & Kabir Wedding',
  eventType: 'Wedding',
  eventDate: futureDate(90),
  eventStartTime: '18:00',
  eventDurationMinutes: 240,
  durationIsSuggested: true,
  city: 'Delhi',
  guestCount: 120,
  totalBudget: 800000,
  style: 'Elegant',
  venuePreference: 'Banquet hall',
  dietaryPreferences: 'Vegetarian',
  culturalPreferences: 'North Indian',
  additionalRequirements: '',
  priorities: [],
  ...overrides,
});

const withGemini = async (fetchStub, run) => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = `AIza${'k'.repeat(35)}`;
  globalThis.fetch = fetchStub;
  try {
    return await run();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
};

const geminiResponseFor = (input, mutate) => {
  const plan = structuredClone(buildDemoPlan(input).data);
  for (const key of ['mode', 'generatedAt', 'eventStartTime', 'eventDurationMinutes', 'durationIsSuggested']) delete plan[key];
  mutate?.(plan);
  return new Response(JSON.stringify({
    id: 'i', status: 'completed', model: 'gemini-3.8-flash', output_text: JSON.stringify(plan),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

// A provider call that never settles and ignores abort signals: the worst case for cancellation.
const neverSettles = () => new Promise(() => {});

test('cancelling stops waiting immediately even if the upstream abort never propagates', async () => {
  await withGemini(neverSettles, async () => {
    const controller = new AbortController();
    const pending = generatePlan(baseInput(), { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const startedAt = performance.now();
    await assert.rejects(pending);
    assert.ok(performance.now() - startedAt < 2000, 'cancellation must not wait for the provider');
  });
});

test('an expired deadline returns a timeout error even if the provider never responds', async () => {
  let providerCalls = 0;
  await withGemini((...args) => {
    providerCalls += 1;
    return neverSettles(...args);
  }, async () => {
    await assert.rejects(
      generatePlan(baseInput(), { timeoutMs: 40 }),
      (error) => error instanceof PlanGenerationError && error.code === 'GEMINI_TIMEOUT' && error.statusCode === 504,
    );
  });
  assert.equal(providerCalls, 1, 'a timed-out provider request must not be retried');
});

test('timeouts and cancellation never fall back to a fabricated Demo plan', async () => {
  await withGemini(neverSettles, async () => {
    const result = await generatePlan(baseInput(), { timeoutMs: 30 }).catch((error) => error);
    assert.ok(result instanceof PlanGenerationError);
    assert.equal(result.data, undefined);
  });
});

test('a past event date is rejected before any provider call is made', async () => {
  let providerCalls = 0;
  await withGemini(async () => { providerCalls += 1; return new Response('{}'); }, async () => {
    await assert.rejects(
      generatePlan(baseInput({ eventDate: '2020-01-01' })),
      (error) => error instanceof PlanGenerationError && error.code === 'EVENT_DATE_IN_PAST' && error.statusCode === 400,
    );
  });
  assert.equal(providerCalls, 0);
});

test('budgetAllocation is derived from itemized costs, never trusted from the model', async () => {
  const input = baseInput();
  await withGemini(async () => geminiResponseFor(input, (plan) => {
    plan.budgetAllocation = { Bogus: 1 };
  }), async () => {
    const { data } = await generatePlan(input);
    assert.deepEqual(data.budgetAllocation, deriveBudgetAllocation(data.itemizedCosts));
    assert.equal(data.budgetAllocation.Bogus, undefined);
  });
});

test('a full generation reports no partial update; a focused one lists the sections it changed', async () => {
  const input = baseInput();
  await withGemini(async () => geminiResponseFor(input), async () => {
    const full = await generatePlan(input);
    assert.equal(full.updatedFields, null);
  });

  const existingPlan = buildDemoPlan(input).data;
  const focusedInput = baseInput({ existingPlan, requestedAction: 'Update the menu for vegetarian guests' });
  await withGemini(async () => new Response(JSON.stringify({
    id: 'i', status: 'completed', model: 'gemini-3.8-flash',
    output_text: JSON.stringify({ menuSuggestions: ['Paneer tikka', 'Dal makhani'] }),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }), async () => {
    const focused = await generatePlan(focusedInput);
    assert.deepEqual(focused.updatedFields, ['menuSuggestions']);
    assert.deepEqual(focused.data.menuSuggestions, ['Paneer tikka', 'Dal makhani']);
    assert.deepEqual(focused.data.tasks, existingPlan.tasks);
  });
});

test('the provider response schema is bounded and excludes server-derived fields', () => {
  const schema = getGeminiResponseSchema(baseInput());
  assert.equal(schema.properties.budgetAllocation, undefined);
  assert.equal(schema.required.includes('budgetAllocation'), false);
  for (const [field, limit] of Object.entries(OUTPUT_LIST_LIMITS)) {
    assert.equal(schema.properties[field].maxItems, limit, `${field} should be capped`);
  }

  const assertNoUnsupportedKeyword = (value) => {
    if (Array.isArray(value)) {
      value.forEach(assertNoUnsupportedKeyword);
      return;
    }
    if (!value || typeof value !== 'object') return;
    assert.equal('additionalProperties' in value, false);
    Object.values(value).forEach(assertNoUnsupportedKeyword);
  };
  assertNoUnsupportedKeyword(schema);

  const existingPlan = buildDemoPlan(baseInput()).data;
  const focusedInput = baseInput({
    requestedAction: 'Create a rain backup plan.',
    existingPlan,
  });
  const focusedSchema = getGeminiResponseSchema(focusedInput);
  assert.deepEqual(focusedSchema.required, ['contingency', 'ideas']);
  assertNoUnsupportedKeyword(focusedSchema);
});

test('resolveDuration is pure and honours an explicit duration in free text', () => {
  const input = baseInput({ additionalRequirements: 'Keep it to two hours please.' });
  const snapshot = structuredClone(input);
  assert.deepEqual(resolveDuration(input), { eventDurationMinutes: 120, durationIsSuggested: false });
  assert.deepEqual(input, snapshot, 'input must not be mutated');
  const explicit = baseInput({ durationIsSuggested: false, additionalRequirements: 'two hours' });
  assert.equal(resolveDuration(explicit).eventDurationMinutes, 240);
});

test('today follows the caller’s calendar day within one day of the server, never further', () => {
  // 20:00 UTC on 4 Mar is 01:30 IST on 5 Mar: the user's "today" is already the 5th.
  const serverNow = new Date('2026-03-04T20:00:00.000Z');
  assert.equal(resolveToday('2026-03-05', serverNow), '2026-03-05');
  assert.equal(resolveToday('2026-03-04', serverNow), '2026-03-04');
  assert.equal(resolveToday('2026-03-09', serverNow), '2026-03-04');
  assert.equal(resolveToday('not-a-date', serverNow), '2026-03-04');
  assert.equal(resolveToday(undefined, serverNow), '2026-03-04');
});

test('date keys use the local calendar day, not the UTC day', () => {
  const localLateNight = new Date(2026, 2, 4, 23, 30);
  assert.equal(toDateKey(localLateNight), '2026-03-04');
  assert.equal(getTodayDateKey(localLateNight), '2026-03-04');
});

test('tuning environment variables fall back to safe defaults when invalid', () => {
  const saved = { level: process.env.GEMINI_THINKING_LEVEL, timeout: process.env.GEMINI_TIMEOUT_MS };
  try {
    delete process.env.GEMINI_THINKING_LEVEL;
    assert.equal(getThinkingLevel(), 'low');
    process.env.GEMINI_THINKING_LEVEL = 'MINIMAL';
    assert.equal(getThinkingLevel(), 'minimal');
    process.env.GEMINI_THINKING_LEVEL = 'ludicrous';
    assert.equal(getThinkingLevel(), 'low');
    process.env.GEMINI_TIMEOUT_MS = '5';
    assert.equal(getGeminiTimeoutMs(), 240_000);
    process.env.GEMINI_TIMEOUT_MS = '90000';
    assert.equal(getGeminiTimeoutMs(), 90_000);
  } finally {
    for (const [key, value] of [['GEMINI_THINKING_LEVEL', saved.level], ['GEMINI_TIMEOUT_MS', saved.timeout]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('the event input schema rejects impossible calendar dates', () => {
  assert.throws(() => baseInput({ eventDate: '2026-02-31' }), /valid calendar date/);
  assert.throws(() => baseInput({ eventDate: '31/12/2026' }), /valid calendar date/);
  assert.doesNotThrow(() => baseInput({ eventDate: '2028-02-29' }));
});

test('Demo Mode honours focused requests and keeps every other saved section', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const existingPlan = buildDemoPlan(baseInput()).data;
    existingPlan.tasks = existingPlan.tasks.map((task) => ({ ...task, status: 'done' }));
    const focused = await generatePlan(baseInput({ existingPlan, requestedAction: 'Suggest a vegetarian menu' }));
    assert.equal(focused.source, 'demo');
    assert.deepEqual(focused.updatedFields, ['menuSuggestions']);
    assert.ok(focused.data.tasks.every((task) => task.status === 'done'), 'completed tasks must survive');

    const full = await generatePlan(baseInput({ existingPlan, requestedAction: 'Make it more fun for the kids' }));
    assert.equal(full.updatedFields, null);
  } finally {
    if (previousKey !== undefined) process.env.GEMINI_API_KEY = previousKey;
  }
});
