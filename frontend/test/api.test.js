import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePlan } from '../src/lib/api.ts';
import { runIfIdle } from '../src/lib/submissionGate.ts';
import { getTodayDateKey } from '../../shared/taskDates.mjs';

const request = {
  eventName: 'The Sharma Wedding',
  eventType: 'Wedding',
  eventDate: '2026-12-15',
  eventStartTime: '18:00',
  eventDurationMinutes: 300,
  durationIsSuggested: false,
  city: 'Delhi, India',
  guestCount: 200,
  totalBudget: 500000,
  style: 'Elegant traditional celebration',
  venuePreference: 'Indoor wedding venue',
  dietaryPreferences: 'Vegetarian-friendly',
  culturalPreferences: 'Sharma family wedding traditions',
  additionalRequirements: 'Comfortable guest flow',
  priorities: ['Guest experience'],
  requestedAction: 'Suggest a balanced event plan.',
};

const createPlanResponse = (source) => ({
  success: true,
  source,
  message: 'Plan generated.',
  data: { mode: source },
});

const eventStreamResponse = (...messages) => new Response(
  messages.map((message) => `data: ${JSON.stringify(message)}\n\n`).join(''),
  { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
);

test('generatePlan sends the event context and returns explicit Gemini source', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/plans/generate/stream');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { ...request, today: getTodayDateKey() });
    return eventStreamResponse(
      { type: 'progress', stage: 'generating', message: 'Gemini is preparing your recommendations.' },
      { type: 'complete', result: createPlanResponse('gemini') },
    );
  };

  try {
    const progress = [];
    const result = await generatePlan(request, (message) => progress.push(message));
    assert.equal(result.source, 'gemini');
    assert.equal(result.data.mode, 'gemini');
    assert.deepEqual(progress, ['Gemini is preparing your recommendations.']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generatePlan remains pending through a quiet stream and returns when the complete plan arrives', async () => {
  const originalFetch = globalThis.fetch;
  let streamController;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      streamController = controller;
      controller.enqueue(new TextEncoder().encode(
        `data: ${JSON.stringify({ type: 'progress', message: 'Gemini is preparing your recommendations.' })}\n\n`,
      ));
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

  try {
    const progress = [];
    const resultPromise = generatePlan(request, (message) => progress.push(message));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(progress, ['Gemini is preparing your recommendations.']);
    streamController.enqueue(new TextEncoder().encode(
      `data: ${JSON.stringify({ type: 'complete', result: createPlanResponse('gemini') })}\n\n`,
    ));
    streamController.close();
    const result = await resultPromise;
    assert.equal(result.source, 'gemini');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generatePlan uses the completed response rather than an untrusted partial draft event', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => eventStreamResponse(
    { type: 'draft', text: '{"overview":"Unvalidated partial text' },
    { type: 'progress', message: 'Gemini is preparing your recommendations.' },
    { type: 'complete', result: createPlanResponse('gemini') },
  );

  try {
    const progress = [];
    const result = await generatePlan(request, (message) => progress.push(message));
    assert.equal(result.data.mode, 'gemini');
    assert.deepEqual(progress, ['Gemini is preparing your recommendations.']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generatePlan cancels a quiet stream only when the caller explicitly aborts', async () => {
  const originalFetch = globalThis.fetch;
  let readerCancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    cancel() {
      readerCancelled = true;
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  const controller = new AbortController();

  try {
    const resultPromise = generatePlan(request, undefined, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await assert.rejects(resultPromise, (error) => error.name === 'AbortError');
    assert.equal(readerCancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generatePlan forwards explicit cancellation while waiting for the server response', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = async (_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });

  try {
    const resultPromise = generatePlan(request, undefined, controller.signal);
    controller.abort();
    await assert.rejects(resultPromise, (error) => error.name === 'AbortError');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generatePlan preserves Demo Mode only when the backend explicitly returns demo', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => eventStreamResponse({
    type: 'complete',
    result: createPlanResponse('demo'),
  });

  try {
    const result = await generatePlan(request);
    assert.equal(result.source, 'demo');
    assert.equal(result.data.mode, 'demo');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generatePlan rejects a successful response with an unconfirmed source', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => eventStreamResponse({
    type: 'complete',
    result: { ...createPlanResponse('demo'), source: 'gemini' },
  });

  try {
    await assert.rejects(generatePlan(request), /unconfirmed plan source/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generatePlan surfaces streamed backend errors without treating them as success', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => eventStreamResponse({
    type: 'error',
    code: 'GEMINI_QUOTA_EXCEEDED',
    error: 'Gemini quota or rate limit reached. Retry later.',
  });

  try {
    await assert.rejects(generatePlan(request), /quota or rate limit reached/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generatePlan surfaces actionable Gemini configuration errors without Demo Mode fallback', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => eventStreamResponse({
    type: 'error',
    code: 'GEMINI_REQUEST_CONFIGURATION_UNSUPPORTED',
    error: 'Gemini rejected the generation request configuration. Check that the configured model supports structured JSON output and that the request schema is compatible.',
  });

  try {
    await assert.rejects(
      generatePlan(request),
      /Check that the configured model supports structured JSON output/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generatePlan reports a stalled stream as an actionable timeout', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.error(new DOMException('Request timed out.', 'TimeoutError'));
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

  try {
    await assert.rejects(generatePlan(request), /took too long/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generatePlan rejects malformed stream events and cancels the response reader', async () => {
  const originalFetch = globalThis.fetch;
  let readerCancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {broken json}\n\n'));
    },
    cancel() {
      readerCancelled = true;
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

  try {
    await assert.rejects(generatePlan(request), /unreadable generation update/);
    assert.equal(readerCancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generatePlan does not accept a partial draft without a complete validated plan', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => eventStreamResponse(
    { type: 'draft', text: '{"overview":"Incomplete' },
    { type: 'progress', stage: 'drafting', message: 'Still drafting.' },
  );

  try {
    await assert.rejects(generatePlan(request), /complete validated plan/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('repeated generation submissions issue exactly one API request', async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return eventStreamResponse({
      type: 'complete',
      result: createPlanResponse('gemini'),
    });
  };
  const lock = { current: false };
  const submit = () => runIfIdle(lock, () => generatePlan(request));

  try {
    const first = submit();
    const second = submit();
    assert.equal(await second, undefined);
    const result = await first;
    assert.equal(result.source, 'gemini');
    assert.equal(requestCount, 1);
    assert.equal(lock.current, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generatePlan ignores SSE keep-alive comments and still returns the plan', async () => {
  const originalFetch = globalThis.fetch;
  const progress = [];
  globalThis.fetch = async () => new Response(
    `: keep-alive\n\n${[
      { type: 'progress', stage: 'generating', message: 'Request sent to Gemini.' },
    ].map((m) => `data: ${JSON.stringify(m)}\n\n`).join('')}: keep-alive\n\ndata: ${JSON.stringify({ type: 'complete', result: createPlanResponse('gemini') })}\n\n`,
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
  try {
    const result = await generatePlan(request, (message) => progress.push(message));
    assert.equal(result.source, 'gemini');
    assert.deepEqual(progress, ['Request sent to Gemini.']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generatePlan surfaces the backend’s validation message for a 400 response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ success: false, error: 'Invalid event plan request.', code: 'INVALID_PLAN_REQUEST' }),
    { status: 400, headers: { 'Content-Type': 'application/json' } },
  );
  try {
    await assert.rejects(generatePlan(request), /Invalid event plan request/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generatePlan rejects with an AbortError when the caller cancels mid-stream', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => new Response(new ReadableStream({
    start(controller) {
      options.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  try {
    const controller = new AbortController();
    const pending = generatePlan(request, undefined, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, (error) => error.name === 'AbortError');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
