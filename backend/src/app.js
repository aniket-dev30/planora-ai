import cors from 'cors';
import express from 'express';
import { apiNotFound, errorHandler } from './middleware/errors.js';
import { createAccessControl } from './middleware/accessControl.js';
import {
  createConcurrencyLimiter,
  createDailyGenerationLimiter,
  createRateLimiter,
  readLimitConfig,
} from './middleware/limits.js';
import { parseAllowedOrigins, securityHeaders } from './middleware/security.js';
import { createPlansRouter } from './routes/plans.js';
import { getGeminiConfigurationStatus, getGeminiModel } from './services/planService.js';

export const JSON_BODY_LIMIT = '256kb';

export const createApp = ({ env = process.env, verifyAccessToken } = {}) => {
  const app = express();
  app.disable('x-powered-by');
  if (!env.FRONTEND_URL?.trim() && !['development', 'test'].includes(env.NODE_ENV)) {
    throw new Error('FRONTEND_URL must be configured outside development and tests.');
  }
  const accessControl = createAccessControl({ env, verifyAccessToken });

  // Behind a reverse proxy/PaaS, set TRUST_PROXY (e.g. "1") so per-IP limits see the client IP.
  if (env.TRUST_PROXY) {
    const value = env.TRUST_PROXY;
    app.set('trust proxy', /^\d+$/.test(value) ? Number(value) : value === 'true' ? true : value);
  }

  const allowedOrigins = parseAllowedOrigins(env.FRONTEND_URL);
  app.use(securityHeaders);
  app.use(
    cors({
      origin: (origin, callback) => {
        // Requests with no Origin header (curl, server-to-server, same-origin) are not browser CORS requests.
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('CORS: origin not allowed'));
      },
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.get('/api/health', (_req, res) => {
    const configuration = getGeminiConfigurationStatus();
    res.json({
      success: true,
      message: 'Planora AI API is running!',
      ai: {
        configuration,
        provider: configuration === 'configured' ? 'gemini' : configuration === 'missing' ? 'demo' : 'unavailable',
        model: getGeminiModel(),
      },
    });
  });

  const { rateMax, concurrencyMax, dailyGenerationMax } = readLimitConfig(env);
  app.use(
    '/api',
    createPlansRouter({
      rateLimiter: createRateLimiter({ max: rateMax }),
      accessControl,
      concurrencyLimiter: createConcurrencyLimiter({ max: concurrencyMax }),
      dailyGenerationLimiter: createDailyGenerationLimiter({ max: dailyGenerationMax }),
    }),
  );
  app.use('/api', apiNotFound);
  app.use(errorHandler);
  return app;
};
