import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/app.js';
import { createConcurrencyLimiter, createRateLimiter } from '../src/middleware/limits.js';
import { parseAllowedOrigins } from '../src/middleware/security.js';

const futureDate = (days) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const validBody = () => ({
  eventName: 'Diya’s Naming Ceremony',
  eventType: 'Other celebration',
  eventDate: futureDate(45),
  eventStartTime: '11:00',
  eventDurationMinutes: 180,
  durationIsSuggested: false,
  city: 'Noida',
  guestCount: 40,
  totalBudget: 90000,
  style: 'Traditional',
  venuePreference: 'Home',
  dietaryPreferences: '',
  culturalPreferences: '',
  additionalRequirements: '',
  priorities: [],
});

const post = (base, path, body, headers = {}) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

let server;
let base;
const savedKey = process.env.GEMINI_API_KEY;

before(async () => {
  // No key: the app runs in its labelled Demo mode, so no external API can be called from these tests.
  delete process.env.GEMINI_API_KEY;
  const app = createApp({ env: { FRONTEND_URL: 'http://localhost:5173, https://planora.example', PLAN_RATE_LIMIT_PER_MINUTE: '4' } });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
});

test('health reports provider state and sends security headers without X-Powered-By', async () => {
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.ai.provider, 'demo');
  assert.equal(JSON.stringify(body).includes('AIza'), false);
});

test('invalid requests get a 400 with field-level details and no internals', async () => {
  const response = await post(base, '/api/plans/generate', { ...validBody(), eventDate: '2026-02-31', guestCount: -3 });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.code, 'INVALID_PLAN_REQUEST');
  assert.ok(body.details.some((detail) => detail.path === 'eventDate'));
  assert.equal(JSON.stringify(body).includes('node_modules'), false);
  assert.equal('stack' in body, false);
});

test('malformed JSON and oversized bodies return clean JSON errors', async () => {
  const malformed = await post(base, '/api/plans/generate', '{not json');
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).code, 'INVALID_JSON');

  const huge = await post(base, '/api/plans/generate', JSON.stringify({ filler: 'x'.repeat(300_000) }));
  assert.equal(huge.status, 413);
  assert.equal((await huge.json()).code, 'PAYLOAD_TOO_LARGE');
});

test('unknown API routes return JSON 404', async () => {
  const response = await fetch(`${base}/api/does-not-exist`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, 'NOT_FOUND');
});

test('CORS allows configured origins only', async () => {
  const allowed = await fetch(`${base}/api/health`, { headers: { Origin: 'https://planora.example' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://planora.example');

  const blocked = await fetch(`${base}/api/health`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).code, 'ORIGIN_NOT_ALLOWED');
});

test('the stream endpoint rejects invalid input with a real 400 instead of opening a stream', async () => {
  const response = await post(base, '/api/plans/generate/stream', { ...validBody(), eventDate: 'tomorrow' });
  assert.equal(response.status, 400);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal((await response.json()).code, 'INVALID_PLAN_REQUEST');
});

test('the stream endpoint streams progress then a complete, labelled Demo plan when no key is set', async () => {
  const response = await post(base, '/api/plans/generate/stream', validBody());
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const text = await response.text();
  assert.match(text, /"type":"progress"/);
  assert.match(text, /"type":"complete"/);
  assert.match(text, /"source":"demo"/);
});

test('the plan endpoints are rate limited per client with a Retry-After hint', async () => {
  // The two stream tests above already consumed part of this app's 4-request window.
  const statuses = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await post(base, '/api/plans/generate', validBody());
    statuses.push(response.status);
    if (response.status === 429) {
      assert.ok(Number(response.headers.get('retry-after')) >= 1);
      assert.equal((await response.json()).code, 'RATE_LIMITED');
      break;
    }
  }
  assert.ok(statuses.includes(200), `valid requests should succeed before the limit: ${statuses.join(',')}`);
  assert.ok(statuses.includes(429), `expected a 429 in ${statuses.join(',')}`);
  assert.equal(statuses.includes(400), false, `fixture must be valid: ${statuses.join(',')}`);
});

test('rate limiter windows reset over time', () => {
  let clock = 0;
  const limiter = createRateLimiter({ windowMs: 1000, max: 2, now: () => clock });
  const run = () => {
    const result = { status: 200 };
    const res = { set() { return res; }, status(code) { result.status = code; return res; }, json() { return res; } };
    let passed = false;
    limiter({ ip: '1.1.1.1' }, res, () => { passed = true; });
    return passed;
  };
  assert.deepEqual([run(), run(), run()], [true, true, false]);
  clock = 1500;
  assert.equal(run(), true);
});

test('the concurrency limiter caps in-flight generations and releases them on close', () => {
  const limiter = createConcurrencyLimiter({ max: 2 });
  const attempt = () => {
    const res = new EventEmitter();
    let status = 200;
    res.set = () => res;
    res.status = (code) => { status = code; return res; };
    res.json = () => res;
    let passed = false;
    limiter({ ip: '2.2.2.2' }, res, () => { passed = true; });
    return { res, passed, status: () => status };
  };
  const first = attempt();
  const second = attempt();
  const third = attempt();
  assert.deepEqual([first.passed, second.passed, third.passed], [true, true, false]);
  assert.equal(third.status(), 429);
  first.res.emit('close');
  first.res.emit('finish'); // releasing twice must not double-count
  assert.equal(limiter.activeCount(), 1);
  assert.equal(attempt().passed, true);
});

test('FRONTEND_URL accepts a comma-separated list and trims trailing slashes', () => {
  assert.deepEqual(parseAllowedOrigins('https://a.example/, http://localhost:5173'), ['https://a.example', 'http://localhost:5173']);
  assert.deepEqual(parseAllowedOrigins(''), ['http://localhost:5173']);
});
