import { ZodError } from 'zod';
import { generatePlan, parseGenerationInput, PlanGenerationError } from '../services/planService.js';

export const HEARTBEAT_INTERVAL_MS = 15_000;

/** Maps any thrown error to a safe, consistent HTTP status and JSON body. */
export const toErrorResponse = (error) => {
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: {
        success: false,
        error: 'Invalid event plan request.',
        code: 'INVALID_PLAN_REQUEST',
        details: error.issues.map(({ path, message }) => ({ path: path.join('.'), message })),
      },
    };
  }
  if (error instanceof PlanGenerationError) {
    return { status: error.statusCode, body: { success: false, error: error.message, code: error.code } };
  }
  console.error('Unexpected plan generation error.', error instanceof Error ? error.name : 'UnknownError');
  return {
    status: 500,
    body: {
      success: false,
      error: 'An unexpected error prevented plan generation. Check the backend logs and retry.',
      code: 'PLAN_GENERATION_FAILED',
    },
  };
};

const readBody = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

export const generatePlanHandler = async (req, res) => {
  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abortController.abort();
  });
  try {
    const result = await generatePlan(readBody(req), { signal: abortController.signal });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    if (abortController.signal.aborted) return undefined;
    const { status, body } = toErrorResponse(error);
    return res.status(status).json(body);
  }
};

const sendEvent = (res, payload) => {
  if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

export const generatePlanStreamHandler = async (req, res) => {
  const body = readBody(req);

  // Reject bad requests with a real HTTP status before any stream is opened.
  try {
    parseGenerationInput(body);
  } catch (error) {
    const { status, body: errorBody } = toErrorResponse(error);
    return res.status(status).json(errorBody);
  }

  const abortController = new AbortController();
  let heartbeat;
  const stopHeartbeat = () => clearInterval(heartbeat);
  res.on('close', () => {
    stopHeartbeat();
    if (!res.writableEnded) abortController.abort();
  });
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // Generation can stay silent for minutes while the model thinks. An SSE comment keeps idle-timeout
  // proxies and load balancers from closing the connection; clients ignore comment lines.
  heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': keep-alive\n\n');
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  try {
    const result = await generatePlan(body, {
      signal: abortController.signal,
      onProgress: (progress) => sendEvent(res, { type: 'progress', ...progress }),
    });
    sendEvent(res, { type: 'complete', result });
  } catch (error) {
    if (abortController.signal.aborted) return undefined;
    const { body: errorBody } = toErrorResponse(error);
    const { success: ignoredSuccess, ...payload } = errorBody;
    sendEvent(res, { type: 'error', ...payload });
  } finally {
    stopHeartbeat();
    if (!res.writableEnded) res.end();
  }
  return undefined;
};
