import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  calculateBudgetReduction,
  deriveBudgetAllocation,
  scaleBudgetItemsToTarget,
  summarizeBudget,
} from '../../shared/budget.mjs';
import { timeToMinutes, validateTimeline } from '../../shared/timeline.mjs';
import {
  getTodayDateKey,
  isTaskAfterEvent,
  isTaskOverdue,
  validateGeneratedTaskDeadlines,
} from '../../shared/taskDates.mjs';
import { eventInputSchema } from '../src/schemas/plan.js';
import {
  buildDemoPlan,
  buildGeminiPrompt,
  classifyGeminiError,
  DEFAULT_GEMINI_MODEL,
  generatePlan,
  getRequestedBudgetReduction,
  getGeminiModel,
  PlanGenerationError,
} from '../src/services/planService.js';
import { generatePlanStreamHandler } from '../src/controllers/plansController.js';

const birthdayEventDate = new Date();
birthdayEventDate.setUTCDate(birthdayEventDate.getUTCDate() + 60);

const birthdayInput = eventInputSchema.parse({
  eventName: "Aarav's 1st Birthday",
  eventType: 'Birthday',
  eventDate: birthdayEventDate.toISOString().slice(0, 10),
  eventStartTime: '18:00',
  eventDurationMinutes: 240,
  durationIsSuggested: true,
  city: 'Ghaziabad, Uttar Pradesh',
  guestCount: 30,
  totalBudget: 20000,
  style: 'Bright birthday celebration',
  venuePreference: 'Indoor hall with rain backup',
  dietaryPreferences: 'Vegetarian, no eggs',
  culturalPreferences: '',
  additionalRequirements: 'Two hours. Birthday cake, decorations, snacks and dinner, children’s games, photography, and a rain backup plan.',
  priorities: ['Saving money'],
});

test('Gemini prompt relies on structured output and retains concise essential planning guidance', () => {
  const prompt = buildGeminiPrompt(birthdayInput);

  assert.match(prompt, /short, actionable phrases/);
  assert.match(prompt, /Avoid repeating information between fields/);
  assert.match(prompt, /Honor every event, cultural, dietary, and additional requirement/);
  assert.match(prompt, /itemized expense, contingency, and reserve amounts must not exceed it/);
  assert.match(prompt, /chronological, non-overlapping, positive-duration/);
  assert.match(prompt, /valid YYYY-MM-DD dates from today/);
  assert.match(prompt, /"priorities":\["Saving money"\]/);
  assert.match(prompt, /"dietaryPreferences":"Vegetarian, no eggs"/);
  assert.match(prompt, /"culturalPreferences":/);
  assert.match(prompt, /"additionalRequirements":/);
  assert.doesNotMatch(prompt, /Return JSON only, with no markdown/);
  assert.doesNotMatch(prompt, /Create a complete plan containing every field/);
  assert.doesNotMatch(prompt, /overview, theme, palette, ideas, budgetAllocation/);
});

const createGeminiResponseFixture = (plan) => {
  const response = structuredClone(plan);
  delete response.mode;
  delete response.generatedAt;
  delete response.eventStartTime;
  delete response.eventDurationMinutes;
  delete response.durationIsSuggested;
  return response;
};

test('a requested two-hour birthday schedule stays within 18:00–20:00', () => {
  const result = buildDemoPlan(birthdayInput).data;
  assert.equal(result.eventDurationMinutes, 120);
  assert.equal(result.durationIsSuggested, false);
  assert.equal(result.itemizedCosts.reduce((total, item) => total + item.amount, 0), 20000);
  assert.ok(result.itemizedCosts.some((item) => item.category === 'Cake'));
  assert.ok(result.itemizedCosts.some((item) => item.category === 'Photography'));
  assert.equal(result.timeline[0].startTime, '18:00');
  assert.deepEqual(result.timeline, validateTimeline(result.timeline, '18:00', 120));
  for (const activity of result.timeline) {
    const end = timeToMinutes(activity.startTime) + activity.durationMinutes;
    assert.ok(end <= 20 * 60, `${activity.title} ends after 20:00`);
  }
  assert.ok(result.ideas.some((idea) => /cake/i.test(idea)));
  assert.ok(result.ideas.some((idea) => /children/i.test(idea)));
  assert.ok(result.ideas.some((idea) => /rain backup/i.test(idea)));
  assert.ok(result.menuSuggestions.some((suggestion) => /no-egg/i.test(suggestion)));
});

test('timeline validation rejects zero/negative duration, overflow, and overlap, and sorts chronologically', () => {
  const activity = (title, startTime, durationMinutes) => ({ title, startTime, durationMinutes, notes: '' });
  assert.throws(() => validateTimeline([activity('Invalid', '18:00', 0)], '18:00', 120), /positive duration/);
  assert.throws(() => validateTimeline([activity('Invalid', '18:00', -10)], '18:00', 120), /positive duration/);
  assert.throws(() => validateTimeline([activity('Late', '19:59', 2)], '18:00', 120), /fit between/);
  assert.throws(() => validateTimeline([activity('A', '18:00', 30), activity('B', '18:20', 10)], '18:00', 120), /overlaps/);

  const sorted = validateTimeline([
    activity('Dinner', '19:00', 30),
    activity('Welcome', '18:00', 30),
  ], '18:00', 120);
  assert.deepEqual(sorted.map((item) => item.title), ['Welcome', 'Dinner']);
});

test('budget totals change with item edits and count contingency/reserves once', () => {
  const items = [
    { kind: 'expense', amount: 4800 },
    { kind: 'expense', amount: 5600 },
    { kind: 'expense', amount: 4000 },
    { kind: 'contingency', amount: 1400 },
    { kind: 'reserve', amount: 4200 },
  ];
  const initial = summarizeBudget(items, 20000);
  assert.equal(initial.expenses, 14400);
  assert.equal(initial.contingency, 1400);
  assert.equal(initial.reserve, 4200);
  assert.equal(initial.allocated, 20000);
  assert.equal(initial.unallocated, 0);

  items[1].amount = 5000;
  const edited = summarizeBudget(items, 20000);
  assert.equal(edited.allocated, 19400);
  assert.equal(edited.unallocated, 600);

  const withNewItem = summarizeBudget([...items, { kind: 'expense', amount: 100 }], 20000);
  assert.equal(withNewItem.allocated, 19500);
  const afterDelete = summarizeBudget(items.filter((_, index) => index !== 1), 20000);
  assert.equal(afterDelete.allocated, 14400);
});

test('budget math rejects negative and non-finite amounts', () => {
  assert.throws(() => summarizeBudget([{ amount: -1 }], 20000), /finite, non-negative/);
  assert.throws(() => summarizeBudget([{ amount: Number.NaN }], 20000), /finite, non-negative/);
  assert.throws(() => summarizeBudget([{ amount: Number.POSITIVE_INFINITY }], 20000), /finite, non-negative/);
});

test('budget reductions use the requested percentage and round currency to paise', () => {
  for (const [percent, expected] of [[10, 450000], [15, 425000], [20, 400000], [25, 375000]]) {
    const reduction = calculateBudgetReduction(500000, percent);
    assert.equal(reduction.targetBudget, expected);
    assert.equal(reduction.savings, 500000 - expected);
  }
  assert.equal(calculateBudgetReduction(1.005, 0).targetBudget, 1.01);
  assert.equal(calculateBudgetReduction(1.004, 0).targetBudget, 1);
  assert.equal(summarizeBudget(scaleBudgetItemsToTarget([{ amount: 1.005 }], 0), 0).allocated, 0);
  assert.deepEqual(calculateBudgetReduction(0, 15), {
    originalBudget: 0, targetBudget: 0, savings: 0, percent: 15, actualPercent: 0,
  });
  assert.throws(() => calculateBudgetReduction(100, 101), /between 0 and 100/);
});

test('duplicate categories are aggregated and contingency/reserve line items are counted once', () => {
  const items = [
    { category: 'Venue', amount: 200, kind: 'expense' },
    { category: 'Venue', amount: 100, kind: 'expense' },
    { category: 'Contingency', amount: 50, kind: 'contingency' },
    { category: 'Reserve', amount: 25, kind: 'reserve' },
  ];
  assert.deepEqual(deriveBudgetAllocation(items), { Venue: 300, Contingency: 50, Reserve: 25 });
  assert.deepEqual(summarizeBudget(items, 500), {
    expenses: 300, contingency: 50, reserve: 25, allocated: 375, unallocated: 125,
  });
  assert.equal(summarizeBudget(scaleBudgetItemsToTarget(items, 425), 500).allocated, 425);
});

test('requested percentage reductions are parsed before generation and invalid values are rejected', () => {
  assert.equal(getRequestedBudgetReduction({
    requestedAction: 'Reduce my budget by 15%.', totalBudget: 500000,
  }).targetBudget, 425000);
  assert.equal(getRequestedBudgetReduction({
    requestedAction: 'Reduce decor costs.', totalBudget: 500000,
  }), null);
  assert.throws(() => getRequestedBudgetReduction({
    requestedAction: 'Reduce my budget to 15%.', totalBudget: 500000,
  }), (error) => error instanceof PlanGenerationError && error.code === 'BUDGET_REDUCTION_AMBIGUOUS');
  assert.throws(() => getRequestedBudgetReduction({
    requestedAction: 'Reduce my budget by 150%.', totalBudget: 500000,
  }), (error) => error instanceof PlanGenerationError && error.statusCode === 400);
});

test('a 15% budget reduction deterministically reconciles a mismatched Gemini total', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousFetch = globalThis.fetch;
  const totalBudget = 500000;
  const existingPlan = buildDemoPlan({ ...birthdayInput, totalBudget }).data;
  const savedPlan = structuredClone(existingPlan);
  const input = {
    ...birthdayInput,
    totalBudget,
    requestedAction: 'Reduce my budget by 15%.',
    existingPlan,
  };
  const generatedPlan = createGeminiResponseFixture(existingPlan);
  generatedPlan.itemizedCosts = [
    { category: 'Venue', label: 'Hall', amount: 200000, kind: 'expense', notes: '' },
    { category: 'Venue', label: 'Setup', amount: 100000, kind: 'expense', notes: '' },
    { category: 'Food', label: 'Dinner', amount: 25000, kind: 'expense', notes: '' },
    { category: 'Contingency', label: 'Weather reserve', amount: 25000, kind: 'contingency', notes: '' },
  ];
  generatedPlan.costSavings = ['Reduce spending by 30% by changing suppliers.', 'Ask vendors for bundled pricing.'];
  generatedPlan.budgetWarnings = ['The plan saves 30%.'];
  process.env.GEMINI_API_KEY = `AIza${'b'.repeat(35)}`;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: 'budget-reduction-interaction',
    status: 'completed',
    output_text: JSON.stringify(generatedPlan),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  try {
    const result = await generatePlan(input);
    const summary = summarizeBudget(result.data.itemizedCosts, totalBudget);
    assert.equal(summary.allocated, 425000);
    assert.equal(summary.unallocated, 75000);
    assert.equal(summary.contingency, 30357.14);
    assert.deepEqual(result.data.budgetAllocation, deriveBudgetAllocation(result.data.itemizedCosts));
    assert.equal(Object.values(result.data.budgetAllocation).reduce((sum, amount) => sum + amount, 0), 425000);
    assert.equal(result.data.itemizedCosts.filter((item) => item.kind === 'contingency').length, 1);
    assert.match(result.data.costSavings.at(-1), /requested reduction 15%, actual reduction 15%/);
    assert.doesNotMatch(result.data.costSavings.join(' '), /30%/);
    assert.ok(result.data.budgetWarnings.some((warning) => /₹75,000 of the event budget is unallocated/.test(warning)));
    assert.equal(result.data.mode, 'gemini');
    assert.deepEqual(existingPlan, savedPlan, 'generating a proposal must not mutate the saved plan');
    assert.deepEqual(result.updatedFields, ['itemizedCosts', 'costSavings', 'budgetWarnings', 'budgetAllocation']);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('Demo Mode budget reductions use the same deterministic target and preserve other sections', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const totalBudget = 500000;
  const existingPlan = buildDemoPlan({ ...birthdayInput, totalBudget }).data;
  const input = {
    ...birthdayInput,
    totalBudget,
    requestedAction: 'Reduce my budget by 15%.',
    existingPlan,
  };
  try {
    const result = await generatePlan(input);
    assert.equal(result.source, 'demo');
    assert.equal(summarizeBudget(result.data.itemizedCosts, totalBudget).allocated, 425000);
    assert.equal(result.data.overview, existingPlan.overview);
    assert.deepEqual(result.updatedFields, ['itemizedCosts', 'costSavings', 'budgetWarnings', 'budgetAllocation']);
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('malformed or negative Gemini budget values are rejected instead of presented as valid', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousFetch = globalThis.fetch;
  const totalBudget = 500000;
  const existingPlan = buildDemoPlan({ ...birthdayInput, totalBudget }).data;
  const input = {
    ...birthdayInput,
    totalBudget,
    requestedAction: 'Reduce my budget by 15%.',
    existingPlan,
  };
  const invalidPlans = [
    { ...createGeminiResponseFixture(existingPlan), itemizedCosts: undefined },
    {
      ...createGeminiResponseFixture(existingPlan),
      itemizedCosts: [{ category: 'Venue', label: 'Hall', amount: -1, kind: 'expense', notes: '' }],
    },
  ];
  let responseIndex = 0;
  process.env.GEMINI_API_KEY = `AIza${'d'.repeat(35)}`;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: 'invalid-budget-interaction',
    status: 'completed',
    output_text: JSON.stringify(invalidPlans[responseIndex++]),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  try {
    for (const _invalidPlan of invalidPlans) {
      await assert.rejects(generatePlan(input), (error) => (
        error instanceof PlanGenerationError && error.code === 'GEMINI_RESPONSE_INVALID'
      ));
    }
    assert.equal(responseIndex, invalidPlans.length);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('underallocated plan budgets report the remaining amount explicitly', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousFetch = globalThis.fetch;
  const apiKey = `AIza${'c'.repeat(35)}`;
  const demoPlan = buildDemoPlan(birthdayInput).data;
  demoPlan.itemizedCosts[0].amount -= 1500;
  process.env.GEMINI_API_KEY = apiKey;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: 'budget-interaction',
    status: 'completed',
    output_text: JSON.stringify(demoPlan),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  try {
    const result = await generatePlan(birthdayInput);
    const summary = summarizeBudget(result.data.itemizedCosts, birthdayInput.totalBudget);
    assert.equal(summary.allocated, 18500);
    assert.equal(summary.unallocated, 1500);
    assert.ok(result.data.budgetWarnings.some((warning) => warning.includes('₹1,500') && /unallocated/i.test(warning)));

    demoPlan.itemizedCosts[0].amount += 2000;
    await assert.rejects(generatePlan(birthdayInput), (error) => {
      assert.ok(error instanceof PlanGenerationError);
      assert.equal(error.code, 'GEMINI_RESPONSE_INVALID');
      return true;
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('generated task deadlines must be valid and between today and the event date', () => {
  const tasks = [{ title: 'Book venue', dueDate: '2026-11-01' }];
  assert.equal(validateGeneratedTaskDeadlines(tasks, '2026-12-15', '2026-10-24'), tasks);
  assert.throws(
    () => validateGeneratedTaskDeadlines([{ title: 'Past task', dueDate: '2026-10-23' }], '2026-12-15', '2026-10-24'),
    /deadline before today/,
  );
  assert.throws(
    () => validateGeneratedTaskDeadlines([{ title: 'Late task', dueDate: '2026-12-16' }], '2026-12-15', '2026-10-24'),
    /after the event date/,
  );
  assert.throws(
    () => validateGeneratedTaskDeadlines([{ title: 'Invalid date', dueDate: '2026-02-30' }], '2026-12-15', '2026-10-24'),
    /valid YYYY-MM-DD/,
  );
  assert.throws(
    () => validateGeneratedTaskDeadlines([], '2026-10-23', '2026-10-24'),
    /event date is in the past/,
  );
});

test('existing past task deadlines are flagged without rewriting them', () => {
  const task = { title: 'Past task', dueDate: '2026-10-23', status: 'todo' };
  assert.equal(isTaskOverdue(task.dueDate, task.status, '2026-10-24'), true);
  assert.equal(isTaskOverdue(task.dueDate, 'done', '2026-10-24'), false);
  assert.equal(isTaskAfterEvent('2026-12-16', '2026-12-15'), true);
  assert.equal(task.dueDate, '2026-10-23');
});

test('an absent Gemini key returns an explicitly labelled Demo plan', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const result = await generatePlan(birthdayInput);
    assert.equal(result.source, 'demo');
    assert.equal(result.data.mode, 'demo');
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('a valid Gemini response is schema-validated and marked live', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousModel = process.env.GEMINI_MODEL;
  const previousFetch = globalThis.fetch;
  const apiKey = `AIza${'a'.repeat(35)}`;
  process.env.GEMINI_MODEL = 'gemini-3.8-flash';
  const geminiInput = { ...birthdayInput, eventDurationMinutes: 240, durationIsSuggested: true };
  const demoPlan = buildDemoPlan({ ...geminiInput }).data;
  const geminiPlan = createGeminiResponseFixture(demoPlan);
  process.env.GEMINI_API_KEY = apiKey;
  globalThis.fetch = async (url) => {
    const requestUrl = url instanceof Request ? url.url : String(url);
    assert.match(requestUrl, /\/interactions(?:\?|$)/);
    const request = url instanceof Request ? await url.json() : JSON.parse(url.body);
    assert.equal(request.model, getGeminiModel());
    assert.equal(request.response_format.type, 'text');
    assert.equal(request.response_format.mime_type, 'application/json');
    assert.ok(request.response_format.schema.required.includes('itemizedCosts'));
    assert.ok(request.response_format.schema.required.includes('tasks'));
    assert.equal(request.response_format.schema.required.includes('generatedAt'), false);
    assert.deepEqual(request.generation_config, { max_output_tokens: 8192, thinking_level: 'low' });
    assert.equal('service_tier' in request, false, 'production requests should retain the standard default');
    assert.equal(request.store, false);
    assert.match(request.input, /Aarav's 1st Birthday/);
    assert.match(request.input, /no eggs/);
    assert.match(request.input, /"guestCount"\s*:\s*30/);
    return new Response(JSON.stringify({
      id: 'test-interaction',
      status: 'completed',
      model: getGeminiModel(),
      output_text: JSON.stringify(geminiPlan),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const result = await generatePlan(geminiInput);
    assert.equal(result.source, 'gemini');
    assert.equal(result.data.mode, 'gemini');
    assert.equal(result.data.eventStartTime, geminiInput.eventStartTime);
    assert.equal(result.data.eventDurationMinutes, 120);
    assert.ok(Number.isFinite(Date.parse(result.data.generatedAt)));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = previousModel;
  }
});

test('the opt-in Gemini service tier is sent without changing other generation settings', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousFetch = globalThis.fetch;
  const input = { ...birthdayInput, eventDurationMinutes: 240, durationIsSuggested: true };
  const output = createGeminiResponseFixture(buildDemoPlan(input).data);
  let capturedRequest;
  process.env.GEMINI_API_KEY = `AIza${'p'.repeat(35)}`;
  globalThis.fetch = async (url, options) => {
    const request = url instanceof Request ? await url.json() : JSON.parse(options.body);
    capturedRequest = request;
    return new Response(`data: ${JSON.stringify({
      event_type: 'step.delta',
      index: 0,
      delta: { type: 'text', text: JSON.stringify(output) },
    })}\n\ndata: ${JSON.stringify({
      event_type: 'interaction.completed',
      interaction: { id: 'priority-interaction', status: 'completed' },
    })}\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };

  try {
    const result = await generatePlan(input, { serviceTier: 'priority', onProgress: () => {} });
    assert.equal(result.source, 'gemini');
    assert.equal(capturedRequest.service_tier, 'priority');
    assert.equal(capturedRequest.model, getGeminiModel());
    assert.equal(capturedRequest.response_format.mime_type, 'application/json');
    assert.deepEqual(capturedRequest.generation_config, { max_output_tokens: 8192, thinking_level: 'low' });
    assert.equal(capturedRequest.stream, true);
    assert.match(capturedRequest.input, /Aarav's 1st Birthday/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('unsupported Gemini service tiers are rejected before contacting the provider', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousFetch = globalThis.fetch;
  let providerCalls = 0;
  process.env.GEMINI_API_KEY = `AIza${'t'.repeat(35)}`;
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error('Provider must not be called for an unsupported service tier.');
  };

  try {
    await assert.rejects(
      generatePlan(birthdayInput, { serviceTier: 'flex' }),
      (error) => error instanceof PlanGenerationError && error.code === 'GEMINI_SERVICE_TIER_INVALID',
    );
    assert.equal(providerCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('focused Gemini requests update only relevant sections and preserve existing task deadlines', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = `AIza${'f'.repeat(35)}`;
  const existingPlan = buildDemoPlan(birthdayInput).data;
  const originalTasks = structuredClone(existingPlan.tasks);
  const yesterday = new Date(`${getTodayDateKey()}T00:00:00.000Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  existingPlan.tasks[0].dueDate = yesterday.toISOString().slice(0, 10);
  const focusedInput = {
    ...birthdayInput,
    requestedAction: 'Make the decor more affordable.',
    existingPlan,
  };
  globalThis.fetch = async (url) => {
    const request = await (url instanceof Request ? url.json() : JSON.parse(url.body));
    assert.match(request.input, /This is a focused edit/);
    assert.match(request.input, /itemizedCosts/);
    assert.doesNotMatch(request.input, /Current plan sections to revise:.*"tasks"/);
    assert.match(request.input, /"guestCount":30/);
    assert.ok(request.response_format.schema.required.includes('itemizedCosts'));
    assert.equal(request.response_format.schema.required.includes('tasks'), false);
    const partial = {
      theme: existingPlan.theme,
      palette: existingPlan.palette,
      ideas: existingPlan.ideas,
      budgetAllocation: existingPlan.budgetAllocation,
      itemizedCosts: existingPlan.itemizedCosts,
      costSavings: existingPlan.costSavings,
      budgetWarnings: existingPlan.budgetWarnings,
    };
    return new Response(JSON.stringify({
      id: 'focused-interaction',
      status: 'completed',
      output_text: JSON.stringify(partial),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const result = await generatePlan(focusedInput);
    assert.equal(result.data.tasks[0].dueDate, yesterday.toISOString().slice(0, 10));
    assert.deepEqual(result.data.tasks.slice(1), originalTasks.slice(1));
    assert.equal(result.data.mode, 'gemini');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('Gemini streaming buffers output until completion and validates the full plan', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousFetch = globalThis.fetch;
  const previousInfo = console.info;
  process.env.GEMINI_API_KEY = `AIza${'g'.repeat(35)}`;
  const plan = buildDemoPlan(birthdayInput).data;
  const geminiPlan = createGeminiResponseFixture(plan);
  const output = JSON.stringify(geminiPlan);
  const midpoint = Math.floor(output.length / 2);
  const deltaOutput = output;
  const events = [
    { event_type: 'interaction.created', interaction: { id: 'streaming-interaction' } },
    { event_type: 'step.delta', index: 0, delta: { type: 'text', text: deltaOutput.slice(0, midpoint) } },
    { event_type: 'step.delta', index: 0, delta: { type: 'text', text: deltaOutput.slice(midpoint) } },
    {
      event_type: 'interaction.completed',
      interaction: { id: 'streaming-interaction', status: 'completed', output_text: '' },
    },
  ];
  globalThis.fetch = async () => new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
  let timingLog = '';
  console.info = (line) => { timingLog = line; };

  try {
    const progress = [];
    const result = await generatePlan(birthdayInput, { onProgress: (update) => progress.push(update) });
    assert.equal(result.source, 'gemini');
    assert.equal(result.data.mode, 'gemini');
    assert.equal(result.data.overview, geminiPlan.overview);
    assert.ok(Number.isFinite(Date.parse(result.data.generatedAt)));
    assert.ok(progress.some(({ stage }) => stage === 'drafting'));
    assert.ok(progress.some(({ stage }) => stage === 'validating'));
    assert.ok(progress.every((update) => !('text' in update) && !('delta' in update)));
    assert.ok(progress.every((update) => !JSON.stringify(update).includes(geminiPlan.overview)));
    const timings = JSON.parse(timingLog);
    assert.ok(Number.isFinite(timings.timeToFirstProviderEventMs));
    assert.ok(Number.isFinite(timings.timeToFirstTokenMs));
    assert.ok(timings.timeToFirstProviderEventMs <= timings.timeToFirstTokenMs);
    assert.equal(timingLog.includes(birthdayInput.eventName), false);
    assert.equal(timingLog.includes(geminiPlan.overview), false);
  } finally {
    console.info = previousInfo;
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('Gemini text deltas are fully assembled when no final output text is provided', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = `AIza${'k'.repeat(35)}`;
  const plan = buildDemoPlan(birthdayInput).data;
  const geminiPlan = createGeminiResponseFixture(plan);
  const output = JSON.stringify(geminiPlan);
  const splitPoints = [Math.floor(output.length / 3), Math.floor((output.length * 2) / 3)];
  const deltas = [
    output.slice(0, splitPoints[0]),
    output.slice(splitPoints[0], splitPoints[1]),
    output.slice(splitPoints[1]),
  ];
  globalThis.fetch = async () => new Response(
    `${deltas.map((text) => `data: ${JSON.stringify({ event_type: 'step.delta', index: 0, delta: { type: 'text', text } })}\n\n`).join('')}data: ${JSON.stringify({
      event_type: 'interaction.completed',
      interaction: { id: 'delta-interaction', status: 'completed' },
    })}\n\n`,
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );

  try {
    const result = await generatePlan(birthdayInput, { onProgress: () => {} });
    assert.equal(result.source, 'gemini');
    assert.equal(result.data.theme, geminiPlan.theme);
    assert.ok(Number.isFinite(Date.parse(result.data.generatedAt)));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('Gemini schema diagnostics log only validation category and rejected paths', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousFetch = globalThis.fetch;
  const previousInfo = console.info;
  const apiKey = `AIza${'l'.repeat(35)}`;
  const plan = buildDemoPlan(birthdayInput).data;
  const geminiPlan = createGeminiResponseFixture(plan);
  delete geminiPlan.itemizedCosts[0].label;
  let timingLog = '';
  process.env.GEMINI_API_KEY = apiKey;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: 'invalid-schema-interaction',
    status: 'completed',
    output_text: JSON.stringify(geminiPlan),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  console.info = (line) => { timingLog = line; };

  try {
    await assert.rejects(
      generatePlan(birthdayInput),
      (error) => error instanceof PlanGenerationError && error.code === 'GEMINI_RESPONSE_INVALID',
    );
    const diagnostic = JSON.parse(timingLog);
    assert.equal(diagnostic.responseValidationCategory, 'schema');
    assert.ok(diagnostic.responseValidationFields.includes('itemizedCosts.0.label'));
    assert.equal(timingLog.includes(apiKey), false);
    assert.equal(timingLog.includes(birthdayInput.eventName), false);
  } finally {
    console.info = previousInfo;
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('Gemini streaming rejects malformed JSON before emitting a completed plan', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = `AIza${'i'.repeat(35)}`;
  globalThis.fetch = async () => new Response([
    { event_type: 'step.delta', index: 0, delta: { type: 'text', text: '{not json}' } },
    { event_type: 'interaction.completed', interaction: { id: 'malformed-interaction', status: 'completed' } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });

  try {
    await assert.rejects(
      generatePlan(birthdayInput, { onProgress: () => {} }),
      (error) => error instanceof PlanGenerationError && error.code === 'GEMINI_RESPONSE_INVALID',
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('Gemini empty streaming output returns a specific safe error without parsing', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousFetch = globalThis.fetch;
  const previousInfo = console.info;
  let timingLog = '';
  process.env.GEMINI_API_KEY = `AIza${'e'.repeat(35)}`;
  globalThis.fetch = async () => new Response(
    `data: ${JSON.stringify({
      event_type: 'interaction.completed',
      interaction: { id: 'empty-interaction', status: 'completed' },
    })}\n\n`,
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
  console.info = (line) => { timingLog = line; };

  try {
    await assert.rejects(
      generatePlan(birthdayInput, { onProgress: () => {} }),
      (error) => error instanceof PlanGenerationError
        && error.code === 'GEMINI_RESPONSE_EMPTY'
        && /without returning plan text/.test(error.message),
    );
    const timing = JSON.parse(timingLog);
    assert.equal(timing.outputChars, 0);
    assert.equal(timing.responseValidationCategory, 'empty_output');
    assert.equal(timing.providerInteractionStatus, 'completed');
    assert.equal(timing.safeErrorCategory, 'response_validation');
    assert.equal(timing.retryable, false);
  } finally {
    console.info = previousInfo;
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('Gemini empty non-streaming output returns the same controlled response error', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = `AIza${'m'.repeat(35)}`;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: 'empty-non-streaming-interaction',
    status: 'completed',
    output_text: '',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  try {
    await assert.rejects(
      generatePlan(birthdayInput),
      (error) => error instanceof PlanGenerationError && error.code === 'GEMINI_RESPONSE_EMPTY',
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('Gemini incomplete streaming output is rejected before parsing or validation', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousFetch = globalThis.fetch;
  const previousInfo = console.info;
  let timingLog = '';
  process.env.GEMINI_API_KEY = `AIza${'n'.repeat(35)}`;
  globalThis.fetch = async () => new Response(
    `data: ${JSON.stringify({
      event_type: 'interaction.completed',
      interaction: { id: 'incomplete-interaction', status: 'incomplete', continuation_token: 'opaque' },
    })}\n\n`,
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
  console.info = (line) => { timingLog = line; };

  try {
    await assert.rejects(
      generatePlan(birthdayInput, { onProgress: () => {} }),
      (error) => error instanceof PlanGenerationError && error.code === 'GEMINI_RESPONSE_INCOMPLETE',
    );
    const timing = JSON.parse(timingLog);
    assert.equal(timing.providerInteractionStatus, 'incomplete');
    assert.equal(timing.providerFinalOutcome, 'incomplete');
    assert.equal(timing.responseValidationCategory, 'incomplete_response');
    assert.equal(timing.outputChars, 0);
  } finally {
    console.info = previousInfo;
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('closing a client stream aborts the in-flight Gemini request', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = `AIza${'j'.repeat(35)}`;
  let observedSignal;
  globalThis.fetch = async (url, options) => {
    const request = url instanceof Request ? url : new Request(url, options);
    observedSignal = request.signal;
    return new Promise((resolve, reject) => {
      const rejectAborted = () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      if (observedSignal.aborted) {
        rejectAborted();
      } else {
        observedSignal.addEventListener('abort', rejectAborted, { once: true });
      }
    });
  };

  const response = new EventEmitter();
  response.writableEnded = false;
  response.destroyed = false;
  const chunks = [];
  response.status = () => response;
  response.set = () => response;
  response.flushHeaders = () => {};
  response.write = (chunk) => { chunks.push(chunk); return true; };
  response.end = () => { response.writableEnded = true; };

  try {
    const pending = generatePlanStreamHandler({ body: birthdayInput }, response);
    for (let attempt = 0; attempt < 50 && !observedSignal; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.ok(observedSignal, 'Gemini request should start before the client disconnects');
    response.emit('close');
    await pending;
    // Whether the upstream signal aborts is best-effort (the SDK/undici link signals through weak
    // references, so it can legitimately fail after garbage collection). The guarantee we own is
    // that the handler stops waiting, ends the stream, and never emits a plan.
    assert.equal(response.writableEnded, true);
    assert.equal(chunks.some((chunk) => chunk.includes('"type":"complete"')), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('Gemini streaming API failures return an error and never a demo plan', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = `AIza${'h'.repeat(35)}`;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' },
  }), { status: 429, headers: { 'Content-Type': 'application/json' } });

  try {
    await assert.rejects(
      generatePlan(birthdayInput, { onProgress: () => {} }),
      (error) => error instanceof PlanGenerationError && error.code === 'GEMINI_QUOTA_EXCEEDED',
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('Gemini provider errors are classified from safe SDK status and category metadata', () => {
  const apiError = (status, providerStatus, message = 'Provider request failed') => Object.assign(
    new Error(JSON.stringify({ error: { code: status, status: providerStatus, message } })),
    { status },
  );
  const cases = [
    [apiError(401, 'UNAUTHENTICATED'), 'authentication', false, 401, 'UNAUTHENTICATED'],
    [apiError(404, 'NOT_FOUND', 'Model not found'), 'model_not_found', false, 404, 'NOT_FOUND'],
    [apiError(429, 'RESOURCE_EXHAUSTED'), 'quota_rate_limit', true, 429, 'RESOURCE_EXHAUSTED'],
    [apiError(400, 'INVALID_ARGUMENT'), 'unsupported_request_configuration', false, 400, 'INVALID_ARGUMENT'],
    [Object.assign(new Error('Request timed out'), { name: 'RequestTimeoutError' }), 'timeout', true, null, null],
    [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }), 'network', true, null, null],
  ];

  for (const [error, safeErrorCategory, retryable, providerStatusCode, providerErrorStatus] of cases) {
    assert.deepEqual(classifyGeminiError(error), {
      providerStatusCode,
      safeErrorCategory,
      retryable,
      providerErrorStatus,
      providerErrorReason: null,
      providerRequestId: null,
    });
  }
});

test('a transient Gemini 503 retries once and returns the successful response', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousFetch = globalThis.fetch;
  const previousInfo = console.info;
  const logs = [];
  let providerCalls = 0;
  const successResponse = new Response(
    `data: ${JSON.stringify({
      event_type: 'step.delta',
      index: 0,
      delta: { type: 'text', text: JSON.stringify(createGeminiResponseFixture(buildDemoPlan(birthdayInput).data)) },
    })}\n\ndata: ${JSON.stringify({
      event_type: 'interaction.completed',
      interaction: { id: 'retry-success-interaction', status: 'completed' },
    })}\n\n`,
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
  process.env.GEMINI_API_KEY = `AIza${'r'.repeat(35)}`;
  globalThis.fetch = async () => {
    providerCalls += 1;
    if (providerCalls === 1) {
      return new Response(JSON.stringify({
        error: { code: 503, message: 'Temporary provider failure', status: 'UNAVAILABLE' },
      }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
    return successResponse;
  };
  console.info = (line) => logs.push(line);

  try {
    const result = await generatePlan(birthdayInput, { onProgress: () => {} });
    assert.equal(result.source, 'gemini');
    assert.equal(providerCalls, 2, 'the retry must be sequential and bounded');
    const timing = JSON.parse(logs.find((line) => line.includes('"event":"plan_generation_timing"')));
    assert.equal(timing.providerAttemptCount, 2);
    assert.deepEqual(timing.providerAttempts.map(({ attempt, statusCode, outcome }) => (
      { attempt, statusCode, outcome }
    )), [
      { attempt: 1, statusCode: 503, outcome: 'retrying' },
      { attempt: 2, statusCode: null, outcome: 'success' },
    ]);
    assert.equal(timing.providerFinalOutcome, 'success');
    assert.equal(timing.outcome, 'success');
    assert.ok(timing.totalMs >= timing.geminiApiMs);
    assert.ok(timing.providerAttempts.every(({ elapsedMs }) => elapsedMs >= 0));
  } finally {
    console.info = previousInfo;
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('a slow second Gemini 503 stays within the bounded retry window for a final attempt', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousFetch = globalThis.fetch;
  const previousInfo = console.info;
  const logs = [];
  let providerCalls = 0;
  const successResponse = new Response(
    `data: ${JSON.stringify({
      event_type: 'step.delta',
      index: 0,
      delta: { type: 'text', text: JSON.stringify(createGeminiResponseFixture(buildDemoPlan(birthdayInput).data)) },
    })}\n\ndata: ${JSON.stringify({
      event_type: 'interaction.completed',
      interaction: { id: 'slow-retry-success-interaction', status: 'completed' },
    })}\n\n`,
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
  process.env.GEMINI_API_KEY = `AIza${'u'.repeat(35)}`;
  globalThis.fetch = async () => {
    providerCalls += 1;
    if (providerCalls === 2) await new Promise((resolve) => setTimeout(resolve, 8_500));
    if (providerCalls < 3) {
      return new Response(JSON.stringify({
        error: { code: 503, message: 'Temporary provider failure', status: 'UNAVAILABLE' },
      }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
    return successResponse;
  };
  console.info = (line) => logs.push(line);

  try {
    const result = await generatePlan(birthdayInput, { onProgress: () => {} });
    assert.equal(result.source, 'gemini');
    assert.equal(providerCalls, 3, 'a slow transient failure should not prematurely consume the retry window');
    const timing = JSON.parse(logs.find((line) => line.includes('"event":"plan_generation_timing"')));
    assert.equal(timing.providerAttemptCount, 3);
    assert.deepEqual(timing.providerAttempts.map(({ attempt, statusCode, outcome }) => (
      { attempt, statusCode, outcome }
    )), [
      { attempt: 1, statusCode: 503, outcome: 'retrying' },
      { attempt: 2, statusCode: 503, outcome: 'retrying' },
      { attempt: 3, statusCode: null, outcome: 'success' },
    ]);
  } finally {
    console.info = previousInfo;
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('provider Retry-After is respected without exceeding the application retry policy', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousFetch = globalThis.fetch;
  const plan = createGeminiResponseFixture(buildDemoPlan(birthdayInput).data);
  const successResponse = new Response(
    `data: ${JSON.stringify({
      event_type: 'step.delta',
      index: 0,
      delta: { type: 'text', text: JSON.stringify(plan) },
    })}\n\ndata: ${JSON.stringify({
      event_type: 'interaction.completed',
      interaction: { id: 'retry-after-success', status: 'completed' },
    })}\n\n`,
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
  let providerCalls = 0;
  let retryElapsedMs = 0;
  let firstCallAt;
  process.env.GEMINI_API_KEY = `AIza${'a'.repeat(35)}`;
  globalThis.fetch = async () => {
    providerCalls += 1;
    if (providerCalls === 1) {
      firstCallAt = performance.now();
      return new Response(JSON.stringify({
        error: { code: 503, message: 'Temporary provider failure', status: 'UNAVAILABLE' },
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'Retry-After-Ms': '250' },
      });
    }
    retryElapsedMs = performance.now() - firstCallAt;
    return successResponse;
  };

  try {
    const result = await generatePlan(birthdayInput, { onProgress: () => {} });
    assert.equal(result.source, 'gemini');
    assert.equal(providerCalls, 2);
    assert.ok(retryElapsedMs >= 240, `retry began after only ${retryElapsedMs} ms`);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('cancellation during provider retry backoff prevents another request', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousFetch = globalThis.fetch;
  const previousInfo = console.info;
  const previousRandom = Math.random;
  const logs = [];
  const controller = new AbortController();
  let providerCalls = 0;
  let resolveFirstCall;
  const firstCall = new Promise((resolve) => { resolveFirstCall = resolve; });
  process.env.GEMINI_API_KEY = `AIza${'c'.repeat(35)}`;
  Math.random = () => 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    resolveFirstCall();
    return new Response(JSON.stringify({
      error: { code: 503, message: 'Temporary provider failure', status: 'UNAVAILABLE' },
    }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  };
  console.info = (line) => logs.push(line);

  try {
    const pending = generatePlan(birthdayInput, { signal: controller.signal });
    await firstCall;
    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    await assert.rejects(pending);
    assert.equal(providerCalls, 1, 'cancellation must prevent the next provider attempt');
    const timing = JSON.parse(logs.find((line) => line.includes('"event":"plan_generation_timing"')));
    assert.equal(timing.providerAttemptCount, 1);
    assert.equal(timing.providerFinalOutcome, 'cancelled');
    assert.equal(timing.outcome, 'CLIENT_DISCONNECTED');
  } finally {
    Math.random = previousRandom;
    console.info = previousInfo;
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('Gemini 503 diagnostics retain only validated provider reason and allowlisted request ID', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousFetch = globalThis.fetch;
  const previousError = console.error;
  const previousInfo = console.info;
  const apiKey = `AIza${'q'.repeat(35)}`;
  const sensitiveMarker = 'private-provider-message-and-metadata';
  const logs = [];
  let providerCalls = 0;
  process.env.GEMINI_API_KEY = apiKey;
  globalThis.fetch = async () => {
    providerCalls += 1;
    return new Response(JSON.stringify({
      error: {
        code: 503,
        message: `Temporary failure ${sensitiveMarker}`,
        status: 'UNAVAILABLE',
        details: [{
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'BACKEND_UNAVAILABLE',
          domain: 'generativelanguage.googleapis.com',
          metadata: { private: sensitiveMarker },
        }],
      },
    }), {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-request-id': 'req-1234.safe-id',
        authorization: sensitiveMarker,
        'x-unrelated-header': sensitiveMarker,
      },
    });
  };
  console.error = (line) => logs.push(line);
  console.info = (line) => logs.push(line);

  try {
    await assert.rejects(
      generatePlan(birthdayInput, { onProgress: () => {} }),
      (error) => {
        assert.ok(error instanceof PlanGenerationError);
        assert.equal(error.code, 'GEMINI_PROVIDER_ERROR');
        assert.equal(error.providerStatusCode, 503);
        assert.equal(error.providerErrorStatus, 'UNAVAILABLE');
        assert.equal(error.providerErrorReason, 'BACKEND_UNAVAILABLE');
        assert.equal(error.providerRequestId, 'req-1234.safe-id');
        assert.match(error.message, /temporarily unavailable \(HTTP 503\)/);
        assert.match(error.message, /after 3 attempts/);
        return true;
      },
    );

    const diagnostic = JSON.parse(logs.find((line) => line.includes('"providerStatusCode"')));
    assert.equal(providerCalls, 3, 'transient failures must stop at the strict attempt limit');
    assert.equal(diagnostic.providerStatusCode, 503);
    assert.equal(diagnostic.safeErrorCategory, 'provider_error');
    assert.equal(diagnostic.retryable, true);
    assert.equal(diagnostic.providerErrorStatus, 'UNAVAILABLE');
    assert.equal(diagnostic.providerErrorReason, 'BACKEND_UNAVAILABLE');
    assert.equal(diagnostic.providerRequestId, 'req-1234.safe-id');
    assert.equal(diagnostic.requestPhase, 'provider_request');
    assert.equal(diagnostic.providerAttemptCount, 3);
    assert.equal(diagnostic.providerFinalOutcome, 'failed');
    assert.deepEqual(diagnostic.providerAttempts.map(({ attempt, statusCode, outcome }) => (
      { attempt, statusCode, outcome }
    )), [
      { attempt: 1, statusCode: 503, outcome: 'retrying' },
      { attempt: 2, statusCode: 503, outcome: 'retrying' },
      { attempt: 3, statusCode: 503, outcome: 'failed' },
    ]);
    const timing = JSON.parse(logs.find((line) => line.includes('"event":"plan_generation_timing"')));
    assert.equal(timing.outcome, 'GEMINI_PROVIDER_ERROR');
    assert.equal(timing.providerAttemptCount, 3);
    assert.ok(timing.totalMs >= timing.geminiApiMs);
    assert.ok(timing.providerAttempts.every(({ elapsedMs }) => elapsedMs >= 0));
    assert.equal(logs.join('\n').includes(apiKey), false);
    assert.equal(logs.join('\n').includes(sensitiveMarker), false);
    assert.equal(logs.join('\n').includes('authorization'), false);
    assert.equal(logs.join('\n').includes('x-unrelated-header'), false);
    assert.equal(logs.join('\n').includes(birthdayInput.eventName), false);
  } finally {
    console.error = previousError;
    console.info = previousInfo;
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('Gemini diagnostics omit missing and malformed provider fields', () => {
  const missing = Object.assign(new Error('Provider failure'), { status: 503 });
  assert.deepEqual(classifyGeminiError(missing), {
    providerStatusCode: 503,
    safeErrorCategory: 'provider_error',
    retryable: true,
    providerErrorStatus: null,
    providerErrorReason: null,
    providerRequestId: null,
  });

  const malformed = Object.assign(new Error('Provider failure'), {
    status: 503,
    error: {
      status: 'Unavailable; disclose internal details',
      details: [{
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'backend unavailable with private details',
      }],
    },
    headers: new Headers({
      'x-goog-request-id': 'bad request id contains spaces',
      authorization: 'must-not-be-read',
    }),
  });
  assert.deepEqual(classifyGeminiError(malformed), {
    providerStatusCode: 503,
    safeErrorCategory: 'provider_error',
    retryable: true,
    providerErrorStatus: null,
    providerErrorReason: null,
    providerRequestId: null,
  });
});

test('unsupported Gemini request errors log only sanitized metadata and remain actionable', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousFetch = globalThis.fetch;
  const previousError = console.error;
  const previousInfo = console.info;
  const apiKey = `AIza${'s'.repeat(35)}`;
  const promptMarker = 'event prompt must not be logged';
  const diagnosticLogs = [];
  let providerCalls = 0;
  process.env.GEMINI_API_KEY = apiKey;
  globalThis.fetch = async () => {
    providerCalls += 1;
    return new Response(JSON.stringify({
      error: {
        code: 400,
        message: `Unsupported response configuration: ${promptMarker}`,
        status: 'INVALID_ARGUMENT',
      },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  };
  console.error = (line) => diagnosticLogs.push(line);
  console.info = (line) => diagnosticLogs.push(line);

  try {
    await assert.rejects(
      generatePlan(birthdayInput, { onProgress: () => {} }),
      (error) => {
        assert.ok(error instanceof PlanGenerationError);
        assert.equal(error.code, 'GEMINI_REQUEST_CONFIGURATION_UNSUPPORTED');
        assert.equal(error.providerStatusCode, 400);
        assert.equal(error.safeErrorCategory, 'unsupported_request_configuration');
        assert.equal(error.retryable, false);
        assert.match(error.message, /structured JSON output/);
        assert.equal(error.message.includes(apiKey), false);
        return true;
      },
    );
    assert.equal(providerCalls, 1, 'permanent request errors must not be retried');
    const failure = JSON.parse(diagnosticLogs.find((line) => line.includes('"providerStatusCode"')));
    assert.deepEqual(failure, {
      providerStatusCode: 400,
      safeErrorCategory: 'unsupported_request_configuration',
      retryable: false,
      providerErrorStatus: 'INVALID_ARGUMENT',
      providerErrorReason: null,
      providerRequestId: null,
      requestPhase: 'provider_request',
      providerAttemptCount: 1,
      providerAttempts: [{
        attempt: 1,
        statusCode: 400,
        elapsedMs: failure.providerAttempts[0].elapsedMs,
        outcome: 'failed',
      }],
      providerFinalOutcome: 'failed',
    });
    assert.equal(diagnosticLogs.join('\n').includes(apiKey), false);
    assert.equal(diagnosticLogs.join('\n').includes(promptMarker), false);
    assert.equal(diagnosticLogs.join('\n').includes(birthdayInput.eventName), false);
  } finally {
    console.error = previousError;
    console.info = previousInfo;
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('Gemini timeline overlaps fail instead of producing a plan', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = `AIza${'d'.repeat(35)}`;
  const invalidPlan = buildDemoPlan(birthdayInput).data;
  invalidPlan.timeline[1].startTime = invalidPlan.timeline[0].startTime;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: 'invalid-timeline-interaction',
    status: 'completed',
    output_text: JSON.stringify(invalidPlan),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  try {
    await assert.rejects(generatePlan(birthdayInput), (error) => {
      assert.ok(error instanceof PlanGenerationError);
      assert.equal(error.code, 'GEMINI_TIMELINE_INVALID');
      return true;
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('Gemini plans with past task deadlines fail instead of silently changing the dates', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = `AIza${'e'.repeat(35)}`;
  const invalidPlan = buildDemoPlan(birthdayInput).data;
  const yesterday = new Date(`${getTodayDateKey()}T00:00:00.000Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  invalidPlan.tasks[0].dueDate = yesterday.toISOString().slice(0, 10);
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: 'past-deadline-interaction',
    status: 'completed',
    output_text: JSON.stringify(invalidPlan),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  try {
    await assert.rejects(generatePlan(birthdayInput), (error) => {
      assert.ok(error instanceof PlanGenerationError);
      assert.equal(error.code, 'GEMINI_TASK_DEADLINES_INVALID');
      assert.match(error.message, /outside the current date and event date/);
      return true;
    });
    assert.equal(invalidPlan.tasks[0].dueDate, yesterday.toISOString().slice(0, 10));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('Gemini authentication failures return a safe error instead of Demo Mode', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousFetch = globalThis.fetch;
  const apiKey = `AIza${'b'.repeat(35)}`;
  process.env.GEMINI_API_KEY = apiKey;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' },
  }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  try {
    await assert.rejects(generatePlan(birthdayInput), (error) => {
      assert.ok(error instanceof PlanGenerationError);
      assert.equal(error.code, 'GEMINI_AUTHENTICATION_FAILED');
      assert.match(error.message, /Check GEMINI_API_KEY/);
      assert.equal(error.message.includes(apiKey), false);
      return true;
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('a malformed configured key produces a safe configuration error', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const malformedKey = 'your_gemini_api_key_here';
  process.env.GEMINI_API_KEY = malformedKey;

  try {
    await assert.rejects(generatePlan(birthdayInput), (error) => {
      assert.ok(error instanceof PlanGenerationError);
      assert.equal(error.code, 'GEMINI_CONFIGURATION_INVALID');
      assert.equal(error.message.includes(malformedKey), false);
      return true;
    });
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('the Gemini model is read from the environment and defaults to Gemini 3.8 Flash', () => {
  const previousModel = process.env.GEMINI_MODEL;
  delete process.env.GEMINI_MODEL;
  assert.equal(getGeminiModel(), DEFAULT_GEMINI_MODEL);
  process.env.GEMINI_MODEL = 'gemini-custom-model';
  assert.equal(getGeminiModel(), 'gemini-custom-model');
  if (previousModel === undefined) delete process.env.GEMINI_MODEL;
  else process.env.GEMINI_MODEL = previousModel;
});
