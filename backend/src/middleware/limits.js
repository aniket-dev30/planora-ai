import { parseGenerationInput, PlanGenerationError } from '../services/planService.js';
import { ZodError } from 'zod';

const toPositiveInt = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const rejectTooMany = (res, code, message, retryAfterSeconds) => {
  res.set('Retry-After', String(retryAfterSeconds));
  return res.status(429).json({ success: false, error: message, code });
};

/**
 * In-memory fixed-window request limiter keyed by client IP. Suitable for a single instance; use
 * a shared store (e.g. Redis) or the hosting platform's limiter if you scale horizontally.
 */
export const createRateLimiter = ({
  windowMs = 60_000,
  max = 10,
  now = () => Date.now(),
} = {}) => {
  const hits = new Map();
  let lastSweep = now();

  const middleware = (req, res, next) => {
    const current = now();
    if (current - lastSweep > windowMs) {
      for (const [key, entry] of hits) if (entry.resetAt <= current) hits.delete(key);
      lastSweep = current;
    }
    const key = req.ip || 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= current) {
      entry = { count: 0, resetAt: current + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      return rejectTooMany(
        res,
        'RATE_LIMITED',
        'Too many plan requests. Please wait a moment before trying again.',
        Math.max(1, Math.ceil((entry.resetAt - current) / 1000)),
      );
    }
    return next();
  };
  middleware.reset = () => hits.clear();
  return middleware;
};

/**
 * Caps simultaneous in-flight generations per client IP. Each generation can run for minutes and
 * costs provider quota, so this is the main guard against duplicate/abusive submissions.
 */
export const createConcurrencyLimiter = ({ max = 2 } = {}) => {
  const active = new Map();
  const middleware = (req, res, next) => {
    const key = req.ip || 'unknown';
    const count = active.get(key) ?? 0;
    if (count >= max) {
      return rejectTooMany(
        res,
        'GENERATION_IN_PROGRESS',
        'A plan is already being generated for this connection. Wait for it to finish or cancel it first.',
        10,
      );
    }
    active.set(key, count + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const remaining = (active.get(key) ?? 1) - 1;
      if (remaining <= 0) active.delete(key);
      else active.set(key, remaining);
    };
    res.on('close', release);
    res.on('finish', release);
    return next();
  };
  middleware.activeCount = () => [...active.values()].reduce((total, count) => total + count, 0);
  return middleware;
};

export const createDailyGenerationLimiter = ({ max = 50, now = () => Date.now() } = {}) => {
  let activeDate = new Date(now()).toISOString().slice(0, 10);
  let generationCount = 0;

  return (req, res, next) => {
    try {
      parseGenerationInput(req.body);
    } catch (error) {
      if (error instanceof ZodError || (error instanceof PlanGenerationError && error.statusCode < 500)) {
        return next();
      }
      return next(error);
    }

    const current = now();
    const currentDate = new Date(current).toISOString().slice(0, 10);
    if (currentDate !== activeDate) {
      activeDate = currentDate;
      generationCount = 0;
    }
    if (generationCount >= max) {
      const nextDay = Date.parse(`${activeDate}T00:00:00.000Z`) + 86_400_000;
      return rejectTooMany(
        res,
        'DAILY_GENERATION_LIMIT',
        'The daily Planora demo generation limit has been reached. Please try again tomorrow.',
        Math.max(1, Math.ceil((nextDay - current) / 1000)),
      );
    }
    generationCount += 1;
    return next();
  };
};

export const readLimitConfig = (env = process.env) => ({
  rateMax: toPositiveInt(env.PLAN_RATE_LIMIT_PER_MINUTE, 10),
  concurrencyMax: toPositiveInt(env.PLAN_MAX_CONCURRENT_PER_IP, 2),
  dailyGenerationMax: toPositiveInt(env.PLAN_MAX_GENERATIONS_PER_DAY, 50),
});
