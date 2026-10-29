import express from 'express';
import { generatePlanHandler, generatePlanStreamHandler } from '../controllers/plansController.js';

export const createPlansRouter = ({
  rateLimiter,
  accessControl,
  concurrencyLimiter,
  dailyGenerationLimiter,
} = {}) => {
  const router = express.Router();
  const guards = [rateLimiter, accessControl, concurrencyLimiter, dailyGenerationLimiter].filter(Boolean);
  router.post('/plans/generate', ...guards, generatePlanHandler);
  router.post('/plans/generate/stream', ...guards, generatePlanStreamHandler);
  return router;
};
