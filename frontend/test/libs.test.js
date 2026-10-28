import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCurrency, formatDateKey, formatElapsed } from '../src/lib/format.ts';
import { settingsDraftFromEvent, validateEventSettings } from '../src/lib/eventSettings.ts';
import { mergeGeneratedPlan } from '../src/lib/planMerge.ts';
import { deriveBudgetAllocation, summarizeBudget } from '../../shared/budget.mjs';
import { focusedPlanFields } from '../../shared/planFocus.mjs';
import { addDaysToDateKey, diffDateKeys, isValidDateKey, toDateKey } from '../../shared/taskDates.mjs';

const makeEvent = (overrides = {}) => ({
  id: 'e1', eventName: 'Asha’s Wedding', eventType: 'Wedding', eventDate: '2027-02-14',
  eventStartTime: '18:00', eventDurationMinutes: 240, durationIsSuggested: false,
  city: 'Delhi', guestCount: 150, totalBudget: 500000,
  style: 'Elegant', venuePreference: 'Hall', dietaryPreferences: '', culturalPreferences: '',
  additionalRequirements: '', priorities: [], createdAt: '', updatedAt: '',
  plan: {
    timeline: [{ id: 't1', title: 'Welcome', startTime: '18:00', durationMinutes: 60, notes: '' }],
    tasks: [
      { id: 'k1', title: 'Book venue', priority: 'High', dueDate: '2027-01-01', status: 'done', source: 'ai', description: '' },
      { id: 'k2', title: 'Send invites', priority: 'Medium', dueDate: '2027-03-01', status: 'todo', source: 'manual', description: '' },
    ],
    itemizedCosts: [], vendors: [],
  },
  ...overrides,
});

test('formatDateKey shows the calendar day regardless of time zone and rejects invalid input', () => {
  assert.match(formatDateKey('2026-03-05'), /5 Mar 2026/);
  assert.match(formatDateKey('2028-02-29'), /29 Feb 2028/);
  assert.equal(formatDateKey('2026-02-31'), 'Date not set');
  assert.equal(formatDateKey(''), 'Date not set');
});

test('formatCurrency uses Indian grouping and tolerates non-finite values', () => {
  assert.match(formatCurrency(1234567), /12,34,567/);
  assert.match(formatCurrency(Number.NaN), /0/);
});

test('formatElapsed renders m:ss', () => {
  assert.equal(formatElapsed(0), '0:00');
  assert.equal(formatElapsed(65.9), '1:05');
  assert.equal(formatElapsed(217), '3:37');
  assert.equal(formatElapsed(-5), '0:00');
});

test('date-key arithmetic is calendar-exact across month, year and leap boundaries', () => {
  assert.equal(addDaysToDateKey('2026-12-31', 1), '2027-01-01');
  assert.equal(addDaysToDateKey('2028-02-28', 1), '2028-02-29');
  assert.equal(addDaysToDateKey('2026-03-01', -1), '2026-02-28');
  assert.equal(diffDateKeys('2026-03-04', '2026-03-05'), 1);
  assert.equal(diffDateKeys('2026-03-05', '2026-03-04'), -1);
  assert.equal(isValidDateKey('2026-13-01'), false);
  assert.equal(toDateKey(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
});

test('budget allocation is derived from line items and matches the summary total', () => {
  const items = [
    { category: 'Venue', amount: 100000, kind: 'expense' },
    { category: 'Venue', amount: 20000, kind: 'expense' },
    { category: 'Catering', amount: 150000, kind: 'expense' },
    { category: 'Buffer', amount: 30000, kind: 'contingency' },
  ];
  const allocation = deriveBudgetAllocation(items);
  assert.deepEqual(allocation, { Venue: 120000, Catering: 150000, Buffer: 30000 });
  assert.equal(Object.values(allocation).reduce((a, b) => a + b, 0), summarizeBudget(items, 500000).allocated);
  assert.equal(summarizeBudget(items, 250000).unallocated, -50000);
});

test('settings validation accepts a correct draft and trims text', () => {
  const event = makeEvent();
  const draft = { ...settingsDraftFromEvent(event), eventName: '  New Name  ' };
  const result = validateEventSettings(draft, event);
  assert.equal(result.ok, true);
  assert.equal(result.values.eventName, 'New Name');
});

test('settings validation reports every problem at once', () => {
  const event = makeEvent();
  const draft = {
    ...settingsDraftFromEvent(event),
    eventName: ' ', eventDate: '2027-02-30', guestCount: 0, totalBudget: -5, city: 'X',
  };
  const result = validateEventSettings(draft, event);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 5, result.errors.join(' | '));
});

test('settings validation rejects NaN from a cleared number field', () => {
  const event = makeEvent();
  const result = validateEventSettings({ ...settingsDraftFromEvent(event), guestCount: Number.NaN, totalBudget: Number.NaN }, event);
  assert.equal(result.ok, false);
});

test('settings validation blocks a duration that no longer fits the timeline', () => {
  const event = makeEvent();
  event.plan.timeline = [{ id: 't', title: 'Dinner', startTime: '19:00', durationMinutes: 90, notes: '' }];
  const result = validateEventSettings({ ...settingsDraftFromEvent(event), eventDurationMinutes: 60 }, event);
  assert.equal(result.ok, false);
});

test('moving the event date earlier warns about tasks left after it, without blocking the save', () => {
  const event = makeEvent();
  const result = validateEventSettings({ ...settingsDraftFromEvent(event), eventDate: '2027-02-01' }, event);
  assert.equal(result.ok, true);
  assert.match(result.warnings[0], /1 task is due after the new event date/);
});

const generated = () => ({
  mode: 'gemini', generatedAt: '2026-01-01T00:00:00.000Z',
  eventStartTime: '18:00', eventDurationMinutes: 240, durationIsSuggested: false,
  overview: 'New overview', theme: 'New theme', palette: [], ideas: [], budgetAllocation: { Venue: 10 },
  itemizedCosts: [{ category: 'Venue', label: 'Hall', amount: 10, kind: 'expense', notes: '' }],
  timeline: [], tasks: [{ title: 'New task', priority: 'Low', dueDate: '2027-01-10', status: 'todo', source: 'ai', description: '' }],
  vendors: [], menuSuggestions: ['Paneer'], contingency: [], costSavings: [], assumptions: [], budgetWarnings: [],
});

test('a focused update replaces only the requested sections and keeps task progress', () => {
  const event = makeEvent();
  const merged = mergeGeneratedPlan(event.plan, generated(), ['menuSuggestions']);
  assert.deepEqual(merged.menuSuggestions, ['Paneer']);
  assert.deepEqual(merged.tasks, event.plan.tasks, 'tasks (including the completed one) must be untouched');
  assert.equal(merged.tasks[0].status, 'done');
  assert.equal(merged.overview, event.plan.overview);
});

test('a focused list update assigns fresh ids to the replaced items only', () => {
  const event = makeEvent();
  const merged = mergeGeneratedPlan(event.plan, generated(), ['tasks']);
  assert.equal(merged.tasks.length, 1);
  assert.ok(merged.tasks[0].id && merged.tasks[0].id !== 'k1');
  assert.deepEqual(merged.timeline, event.plan.timeline);
});

test('applying a validated budget proposal preserves the event budget and unrelated event data', () => {
  const event = makeEvent();
  const proposal = generated();
  proposal.itemizedCosts = [
    { category: 'Venue', label: 'Hall', amount: 425000, kind: 'expense', notes: '' },
  ];
  proposal.budgetAllocation = { Venue: 425000 };
  proposal.costSavings = ['Budget target: ₹4,25,000; requested reduction 15%, actual reduction 15% from the original ₹5,00,000 (₹75,000 saved).'];
  proposal.budgetWarnings = ['Budget target: ₹4,25,000; requested reduction 15%, actual reduction 15% from the original ₹5,00,000 (₹75,000 saved).'];

  const applied = {
    ...event,
    plan: mergeGeneratedPlan(event.plan, proposal, [
      'itemizedCosts', 'costSavings', 'budgetWarnings', 'budgetAllocation',
    ]),
  };

  assert.equal(applied.totalBudget, 500000);
  assert.equal(applied.guestCount, event.guestCount);
  assert.equal(applied.eventDate, event.eventDate);
  assert.deepEqual(applied.plan.tasks, event.plan.tasks);
  assert.deepEqual(applied.plan.timeline, event.plan.timeline);
  assert.equal(summarizeBudget(applied.plan.itemizedCosts, applied.totalBudget).allocated, 425000);
});

test('a full regeneration (no updatedFields) replaces everything and gives every item an id', () => {
  const event = makeEvent();
  const merged = mergeGeneratedPlan(event.plan, generated(), null);
  assert.equal(merged.overview, 'New overview');
  assert.ok(merged.tasks.every((task) => typeof task.id === 'string' && task.id));
  assert.ok(merged.itemizedCosts.every((item) => typeof item.id === 'string' && item.id));
});

test('the UI and the server agree on which prompts are focused', () => {
  assert.deepEqual(focusedPlanFields('Suggest a vegetarian menu for 100 guests.'), ['menuSuggestions']);
  assert.ok(focusedPlanFields('Reduce my budget by 15%.').includes('itemizedCosts'));
  assert.deepEqual(focusedPlanFields('Make it more fun for the kids'), []);
  assert.deepEqual(focusedPlanFields(undefined), []);
});
