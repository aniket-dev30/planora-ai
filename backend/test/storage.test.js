import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEvents, saveEvents } from '../../frontend/src/lib/storage.ts';

const createEvent = (id, eventName) => ({
  id,
  eventName,
  eventType: 'Birthday',
  eventDate: '2026-12-15',
  eventStartTime: '18:00',
  eventDurationMinutes: 120,
  durationIsSuggested: false,
  city: 'Ghaziabad',
  guestCount: 30,
  totalBudget: 20000,
  plan: {
    eventStartTime: '18:00',
    eventDurationMinutes: 120,
    durationIsSuggested: false,
    itemizedCosts: [{ id: `${id}-food`, category: 'Food', label: 'Dinner', amount: 5600, kind: 'expense' }],
    timeline: [{ id: `${id}-timeline`, title: 'Dinner', startTime: '19:00', durationMinutes: 30 }],
    tasks: [{ id: `${id}-task`, title: 'Confirm menu', status: 'todo' }],
  },
});

test('saved edits survive reloads without overwriting other events', () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };

  try {
    saveEvents([createEvent('event-1', 'Birthday one'), createEvent('event-2', 'Birthday two')]);
    const [first, second] = loadEvents();
    first.plan.itemizedCosts[0].amount = 5000;
    first.plan.timeline[0].startTime = '18:30';
    first.plan.tasks[0].status = 'done';
    saveEvents([first, second]);

    const [savedFirst, savedSecond] = loadEvents();
    assert.equal(savedFirst.plan.itemizedCosts[0].amount, 5000);
    assert.equal(savedFirst.plan.timeline[0].startTime, '18:30');
    assert.equal(savedFirst.plan.tasks[0].status, 'done');
    assert.equal(savedSecond.eventName, 'Birthday two');
    assert.equal(savedSecond.plan.itemizedCosts[0].amount, 5600);
  } finally {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete globalThis.localStorage;
  }
});

test('missing and malformed persisted data safely loads as an empty event list', () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };

  try {
    assert.deepEqual(loadEvents(), []);
    values.set('planora-ai-events-v1', '{not valid JSON');
    assert.deepEqual(loadEvents(), []);
  } finally {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete globalThis.localStorage;
  }
});
