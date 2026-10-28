import express from 'express';
import { generatePlanHandler, generatePlanStreamHandler } from '../controllers/plansController.js';

export const createPlansRouter = ({ rateLimiter, concurrencyLimiter } = {}) => {
  const router = express.Router();
  const guards = [rateLimiter, concurrencyLimiter].filter(Boolean);
  router.post('/plans/generate', ...guards, generatePlanHandler);
  router.post('/plans/generate/stream', ...guards, generatePlanStreamHandler);
  return router;
};

export default createPlansRouter();
