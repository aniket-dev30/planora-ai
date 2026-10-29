import { GoogleGenAI } from '@google/genai';
import { z, ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { eventInputSchema, planOutputSchema, planResponseSchema } from '../schemas/plan.js';
import {
  calculateBudgetReduction,
  deriveBudgetAllocation,
  scaleBudgetItemsToTarget,
  summarizeBudget,
} from '../../../shared/budget.mjs';
import { focusedPlanFields } from '../../../shared/planFocus.mjs';
import { minutesToTime, timeToMinutes, validateTimeline } from '../../../shared/timeline.mjs';
import {
  addDaysToDateKey,
  diffDateKeys,
  validateGeneratedTaskDeadlines,
} from '../../../shared/taskDates.mjs';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

export const getGeminiModel = () => process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;

export const DEFAULT_THINKING_LEVEL = 'low';
const THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high']);

/** Thinking depth is tunable (GEMINI_THINKING_LEVEL) but only to values the SDK documents. */
export const getThinkingLevel = () => {
  const level = process.env.GEMINI_THINKING_LEVEL?.trim().toLowerCase();
  return level && THINKING_LEVELS.has(level) ? level : DEFAULT_THINKING_LEVEL;
};

export const DEFAULT_TIMEOUT_MS = 240_000;
const MAX_PROVIDER_ATTEMPTS = 3;
const PROVIDER_RETRY_BASE_DELAY_MS = 200;
const PROVIDER_RETRY_MAX_DELAY_MS = 600;
const PROVIDER_RETRY_WINDOW_MS = 30_000;
const INTERACTION_STATUSES = new Set([
  'in_progress',
  'requires_action',
  'completed',
  'failed',
  'cancelled',
  'incomplete',
  'budget_exceeded',
  'queued',
]);

export const getGeminiTimeoutMs = () => {
  const value = Number(process.env.GEMINI_TIMEOUT_MS);
  return Number.isInteger(value) && value >= 10_000 && value <= 600_000 ? value : DEFAULT_TIMEOUT_MS;
};

/**
 * The calendar date used for deadline planning. Prefers the caller's local date so users
 * in UTC+5:30 are not judged by the server's UTC date, but only trusts it within one day
 * of the server's UTC day so a bad client cannot move "today" arbitrarily.
 */
export const resolveToday = (clientToday, serverNow = new Date()) => {
  const serverToday = serverNow.toISOString().slice(0, 10);
  if (!clientToday) return serverToday;
  try {
    return Math.abs(diffDateKeys(serverToday, clientToday)) <= 1 ? clientToday : serverToday;
  } catch {
    return serverToday;
  }
};

export class PlanGenerationError extends Error {
  constructor(message, statusCode = 502, code = 'GEMINI_GENERATION_FAILED') {
    super(message);
    this.name = 'PlanGenerationError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const readGeminiApiKey = () => {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  if (
    apiKey.length < 10
    || apiKey.length > 256
    || /\s/.test(apiKey)
    || /^(your.*api.*key.*|changeme|placeholder|xxx+)$/i.test(apiKey)
  ) {
    throw new PlanGenerationError(
      'GEMINI_API_KEY is configured but malformed. Replace it with a valid Google AI Studio API key and restart the backend.',
      503,
      'GEMINI_CONFIGURATION_INVALID',
    );
  }
  return apiKey;
};

const validateGeminiModel = () => {
  const model = getGeminiModel();
  if (!/^gemini-[A-Za-z0-9._-]+$/.test(model)) {
    throw new PlanGenerationError(
      'GEMINI_MODEL must be a Gemini model identifier. Set it in backend/.env and restart the backend.',
      503,
      'GEMINI_CONFIGURATION_INVALID',
    );
  }
  return model;
};

export const getGeminiConfigurationStatus = () => {
  try {
    const apiKey = readGeminiApiKey();
    if (!apiKey) return 'missing';
    validateGeminiModel();
    return 'configured';
  } catch {
    if (error instanceof PlanGenerationError) return 'invalid';
    throw error;
  }
};

const providerStatuses = new Set([
  'ABORTED',
  'CANCELLED',
  'DATA_LOSS',
  'DEADLINE_EXCEEDED',
  'FAILED_PRECONDITION',
  'INTERNAL',
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'OUT_OF_RANGE',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'UNAUTHENTICATED',
  'UNAVAILABLE',
  'UNIMPLEMENTED',
  'UNKNOWN',
]);

const getProviderErrorBody = (error) => {
  if (error?.error && typeof error.error === 'object' && !Array.isArray(error.error)) {
    if (error.error.error && typeof error.error.error === 'object' && !Array.isArray(error.error.error)) {
      return error.error.error;
    }
    return error.error;
  }
  if (typeof error?.message !== 'string') return undefined;
  try {
    const parsed = JSON.parse(error.message);
    const body = parsed?.error ?? parsed;
    return body && typeof body === 'object' && !Array.isArray(body) ? body : undefined;
  } catch {
    return undefined;
  }
};

const sanitizeProviderStatus = (value) => (
  typeof value === 'string' && providerStatuses.has(value) ? value : null
);

const sanitizeProviderReason = (value) => (
  typeof value === 'string'
    && value.length <= 63
    && /^[A-Z][A-Z0-9_]+[A-Z0-9]$/.test(value)
    ? value
    : null
);

const getProviderRequestId = (headers) => {
  let value;
  if (typeof headers?.get === 'function') {
    value = headers.get('x-goog-request-id');
  } else if (headers && typeof headers === 'object') {
    const headerName = Object.keys(headers).find((name) => name.toLowerCase() === 'x-goog-request-id');
    if (headerName) value = headers[headerName];
  }
  return typeof value === 'string'
    && value.length <= 128
    && /^[A-Za-z0-9._:-]+$/.test(value)
    ? value
    : null;
};

export const classifyGeminiError = (error) => {
  const providerError = getProviderErrorBody(error);
  const errorInfo = Array.isArray(providerError?.details)
    ? providerError.details.find((detail) => detail?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo')
    : undefined;
  const providerErrorStatus = sanitizeProviderStatus(providerError?.status);
  const providerErrorReason = sanitizeProviderReason(providerError?.reason ?? errorInfo?.reason);
  const statusValue = error?.status
    ?? error?.statusCode
    ?? error?.response?.status
    ?? providerError?.code;
  const parsedStatus = Number(statusValue);
  const providerStatusCode = Number.isInteger(parsedStatus) && parsedStatus >= 100 && parsedStatus <= 599
    ? parsedStatus
    : null;
  const providerSignal = [
    error?.name,
    error?.code,
    error?.cause?.code,
    providerError?.status,
    providerError?.reason,
    providerError?.message,
    error?.message,
  ].filter((value) => typeof value === 'string').join(' ');

  let safeErrorCategory = 'provider_error';
  if (
    providerStatusCode === 401
    || providerStatusCode === 403
    || /invalid api key|api key not valid|unauthorized|unauthenticated|permission denied/i.test(providerSignal)
  ) {
    safeErrorCategory = 'authentication';
  } else if (
    providerStatusCode === 404
    || /not_found|model.*(not found|does not exist|unavailable)|(?:unsupported|not supported).*(?:model)/i.test(providerSignal)
  ) {
    safeErrorCategory = 'model_not_found';
  } else if (
    providerStatusCode === 429
    || /resource_exhausted|quota|rate.?limit/i.test(providerSignal)
  ) {
    safeErrorCategory = 'quota_rate_limit';
  } else if (
    error?.name === 'TimeoutError'
    || /timeout|timed out|etimedout|esockettimedout/i.test(providerSignal)
    || providerStatusCode === 408
    || providerStatusCode === 504
  ) {
    safeErrorCategory = 'timeout';
  } else if (
    error instanceof TypeError
    || /connectionerror|requestabortederror|network|fetch failed|econn|enotfound|eai_again|und_err/i.test(providerSignal)
  ) {
    safeErrorCategory = 'network';
  } else if (
    providerStatusCode === 400
    || providerStatusCode === 422
    || /invalid_argument|failed_precondition|unsupported|invalid .*?(request|configuration|schema)/i.test(providerSignal)
  ) {
    safeErrorCategory = 'unsupported_request_configuration';
  } else if (error instanceof SyntaxError || error instanceof ZodError || error instanceof RangeError) {
    safeErrorCategory = 'response_validation';
  }

  return {
    providerStatusCode,
    safeErrorCategory,
    retryable: ['quota_rate_limit', 'timeout', 'network'].includes(safeErrorCategory)
      || (safeErrorCategory === 'provider_error' && providerStatusCode !== null && providerStatusCode >= 500),
    providerErrorStatus,
    providerErrorReason,
    providerRequestId: getProviderRequestId(error?.headers),
  };
};

const mapGeminiError = (error, attemptCount = 1) => {
  if (error instanceof PlanGenerationError) return error;

  const { safeErrorCategory } = classifyGeminiError(error);

  if (safeErrorCategory === 'authentication') {
    return new PlanGenerationError(
      'Gemini rejected the configured API key. Check GEMINI_API_KEY in backend/.env, then restart the backend.',
      502,
      'GEMINI_AUTHENTICATION_FAILED',
    );
  }
  if (safeErrorCategory === 'quota_rate_limit') {
    return new PlanGenerationError(
      'Gemini quota or rate limit reached. Check the project quota and billing in Google AI Studio, wait briefly, then retry.',
      429,
      'GEMINI_QUOTA_EXCEEDED',
    );
  }
  if (safeErrorCategory === 'timeout') {
    return new PlanGenerationError(
      `Gemini did not finish within ${Math.round(getGeminiTimeoutMs() / 6000) / 10} minutes. Retry with a more focused request or check Google AI Studio service status.`,
      504,
      'GEMINI_TIMEOUT',
    );
  }
  if (safeErrorCategory === 'model_not_found') {
    return new PlanGenerationError(
      `The configured Gemini model (${getGeminiModel()}) is unavailable for content generation. Check model access and retry.`,
      502,
      'GEMINI_MODEL_UNAVAILABLE',
    );
  }
  if (safeErrorCategory === 'unsupported_request_configuration') {
    return new PlanGenerationError(
      'Gemini rejected the generation request configuration. Check that the configured model supports structured JSON output and that the request schema is compatible.',
      502,
      'GEMINI_REQUEST_CONFIGURATION_UNSUPPORTED',
    );
  }
  if (error instanceof SyntaxError || error instanceof ZodError || error instanceof RangeError) {
    if (error instanceof RangeError && /deadline|event date/i.test(error.message)) {
      return new PlanGenerationError(
        'Gemini returned task deadlines outside the current date and event date. Retry or update the event date; existing task deadlines were not changed.',
        502,
        'GEMINI_TASK_DEADLINES_INVALID',
      );
    }
    if (error instanceof RangeError && /overlap|fit between|event end time|event duration|invalid 24-hour time/i.test(error.message)) {
      return new PlanGenerationError(
        'Gemini returned a schedule with invalid times, an overlap, or an activity outside the event window. Retry or adjust the event schedule.',
        502,
        'GEMINI_TIMELINE_INVALID',
      );
    }
    return new PlanGenerationError(
      'Gemini returned a plan that did not meet the required event, budget, or response constraints. Retry or simplify the request.',
      502,
      'GEMINI_RESPONSE_INVALID',
    );
  }
  if (safeErrorCategory === 'network') {
    return new PlanGenerationError(
      'The backend could not reach Gemini. Check network access and Google AI Studio service status, then retry.',
      503,
      'GEMINI_NETWORK_ERROR',
    );
  }
  const { providerStatusCode } = classifyGeminiError(error);
  if (providerStatusCode !== null && providerStatusCode >= 500) {
    return new PlanGenerationError(
      `Gemini is temporarily unavailable (HTTP ${providerStatusCode}). The request failed after ${attemptCount} attempts. Retry shortly; if the issue persists, check Google AI Studio service status.`,
      503,
      'GEMINI_PROVIDER_ERROR',
    );
  }
  return new PlanGenerationError(
    'Gemini returned an unexpected generation error. Check the backend logs for sanitized diagnostic details and Google AI Studio service status before retrying.',
    502,
    'GEMINI_PROVIDER_ERROR',
  );
};

const clampCurrency = (value) => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
};

const formatTaskDeadline = (eventDate, daysBefore, today) => {
  if (eventDate < today) return eventDate;
  const suggestedDate = addDaysToDateKey(eventDate, -daysBefore);
  return suggestedDate < today ? today : suggestedDate;
};

const buildBudgetData = (input) => {
  const total = clampCurrency(input.totalBudget || 0);
  const ratio = {
    Wedding: { venue: 0.28, food: 0.25, decor: 0.18, photography: 0.12, logistics: 0.1, contingency: 0.07 },
    Birthday: { venue: 0.22, food: 0.28, decor: 0.2, cake: 0.05, photography: 0.08, activities: 0.05, contingency: 0.07, surprises: 0.05 },
    'Community event': { venue: 0.22, food: 0.2, permits: 0.12, logistics: 0.18, volunteer: 0.12, contingency: 0.16 },
    'Other celebration': { venue: 0.26, food: 0.24, decor: 0.18, entertainment: 0.16, logistics: 0.1, contingency: 0.06 },
  };

  const allocation = ratio[input.eventType] || ratio['Other celebration'];
  const categoryAmounts = Object.fromEntries(
    Object.entries(allocation).map(([name, share]) => [name, clampCurrency(total * share)])
  );

  const itemized = [
    { category: 'Venue', label: 'Venue and setup', kind: 'expense', amount: categoryAmounts.venue || 0, notes: `${input.venuePreference || 'Flexible venue'} setup and arrivals.` },
    { category: 'Food', label: 'Food and beverages', kind: 'expense', amount: categoryAmounts.food || 0, notes: `${input.dietaryPreferences || 'Inclusive menu'} for ${input.guestCount} guests.` },
    { category: 'Decor', label: 'Decor and styling', kind: 'expense', amount: categoryAmounts.decor || 0, notes: `${input.style || 'Signature style'} styling with a premium but practical finish.` },
    { category: 'Cake', label: 'Birthday cake', kind: 'expense', amount: categoryAmounts.cake || 0, notes: 'Illustrative cake allowance; confirm dietary requirements and ingredients.' },
    { category: 'Activities', label: 'Children’s games and activities', kind: 'expense', amount: categoryAmounts.activities || 0, notes: 'Age-appropriate games and basic materials.' },
    { category: 'Photography', label: 'Photography and memory capture', kind: 'expense', amount: categoryAmounts.photography || 0, notes: 'Illustrative planning estimate; confirm a real quote.' },
    { category: 'Logistics', label: 'Guest flow and logistics', kind: 'expense', amount: categoryAmounts.logistics || 0, notes: 'Guest management, signage, and travel coordination.' },
    { category: 'Contingency', label: 'Contingency allocation', kind: 'contingency', amount: categoryAmounts.contingency || 0, notes: 'Allocated backup for weather or timing; counted once in planned total.' },
  ].filter((item) => item.amount > 0);

  const remainder = clampCurrency(total - itemized.reduce((sum, entry) => sum + entry.amount, 0));
  if (remainder > 0) {
    itemized.push({ category: 'Reserve', label: 'Flexible reserve allocation', kind: 'reserve', amount: remainder, notes: 'Allocated flexible reserve; not unallocated budget and counted once in planned total.' });
  }

  return { total, categoryAmounts, itemized };
};

const buildTasks = (input, eventDate, today) => [
  { title: 'Finalize guest list and RSVPs', priority: 'High', dueDate: formatTaskDeadline(eventDate, 21, today), status: 'todo', source: 'ai', description: 'Confirm confirmed guests, plus a waitlist for last-minute flexibility.' },
  { title: 'Lock venue and contract details', priority: 'High', dueDate: formatTaskDeadline(eventDate, 18, today), status: 'todo', source: 'ai', description: `Secure a ${input.venuePreference || 'well-located'} venue and review pricing details.` },
  { title: 'Confirm catering and dietary plan', priority: 'High', dueDate: formatTaskDeadline(eventDate, 14, today), status: 'in progress', source: 'ai', description: `${input.dietaryPreferences || 'Offer flexible vegetarian, vegan, and allergy-aware options.'}` },
  { title: 'Prepare shopping list and decor checklist', priority: 'Medium', dueDate: formatTaskDeadline(eventDate, 10, today), status: 'todo', source: 'ai', description: 'List tablescape, signage, flowers, and personalized elements for the chosen style.' },
  { title: 'Week-of timeline rehearsal', priority: 'Medium', dueDate: formatTaskDeadline(eventDate, 3, today), status: 'todo', source: 'ai', description: 'Review vendor calls, setup timing, and event-day responsibilities.' },
];

const WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/**
 * Pure: returns the effective duration without mutating the input. A duration that is only
 * a suggestion can be overridden by an explicit "two hours" / "90 minutes" in the free text.
 */
export const resolveDuration = (input) => {
  if (input.durationIsSuggested) {
    const text = `${input.additionalRequirements} ${input.requestedAction}`.toLowerCase();
    const match = text.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s*[- ]?hours?\b|\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s*minutes?\b/);
    if (match) {
      const value = match[1] || match[2];
      const amount = Number(value) || WORD_NUMBERS[value];
      const minutes = match[0].includes('hour') ? amount * 60 : amount;
      if (Number.isInteger(minutes) && minutes > 0 && minutes <= 1440) {
        return { eventDurationMinutes: minutes, durationIsSuggested: false };
      }
    }
  }
  return { eventDurationMinutes: input.eventDurationMinutes, durationIsSuggested: input.durationIsSuggested };
};

const buildTimeline = (input, durationMinutes) => {
  if (durationMinutes < 30) {
    throw new RangeError('The event duration is too short for the proposed activity schedule. Increase the duration or simplify the requested activities.');
  }
  const scheduleMinutes = durationMinutes >= 35 ? durationMinutes - 5 : durationMinutes;
  const durations = [0.13, 0.08, 0.2, 0.32, 0.15, 0.12]
    .map((weight) => Math.max(5, Math.floor(scheduleMinutes * weight)));
  let difference = scheduleMinutes - durations.reduce((sum, value) => sum + value, 0);
  for (let index = 0; difference !== 0; index = (index + 1) % durations.length) {
    const adjustment = difference > 0 ? 1 : -1;
    if (durations[index] + adjustment >= 5) {
      durations[index] += adjustment;
      difference -= adjustment;
    }
  }
  const birthday = input.eventType === 'Birthday';
  const titles = birthday
    ? ['Guest arrival and snacks', 'Welcome and birthday games', 'Birthday cake and children’s activities', 'Dinner service', 'Photography and family portraits', 'Farewell and rain-backup check']
    : ['Guest arrival and welcome', 'Opening remarks', 'Main event activity', 'Meal service', 'Photography and portraits', 'Farewell and contingency check'];
  const notes = birthday
    ? ['Welcome guests; light snacks and vegetarian refreshments.', 'Short welcome and age-appropriate children’s games.', 'Cake moment followed by supervised children’s activities.', 'Serve dinner with the stated dietary requirements.', 'Capture family and group photographs.', 'Confirm rain backup and orderly guest departure.']
    : ['Welcome guests and help them settle in.', 'Brief host welcome and event orientation.', 'Main event activity or programme.', 'Serve the planned meal.', 'Capture key moments and group photographs.', 'Confirm contingency arrangements and guest departure.'];
  let cursor = timeToMinutes(input.eventStartTime);
  const timeline = titles.map((title, index) => {
    const entry = { title, startTime: minutesToTime(cursor), durationMinutes: durations[index], notes: notes[index] };
    cursor += durations[index];
    return entry;
  });
  return validateTimeline(timeline, input.eventStartTime, durationMinutes);
};

const buildVendorSuggestions = (input, categoryAmounts) => {
  const vendors = [
    { category: 'Venue', name: 'Venue coordinator', status: 'researching', estimatedCost: categoryAmounts.venue || 0, notes: `Illustrative allocation only; confirm ${input.venuePreference || 'venue'} pricing and terms directly.` },
    { category: 'Catering', name: 'Catering partner', status: 'researching', estimatedCost: categoryAmounts.food || 0, notes: `Planning estimate only; confirm ${input.dietaryPreferences || 'inclusive menu'} and pricing directly.` },
    { category: 'Photography', name: 'Photographer', status: 'researching', estimatedCost: categoryAmounts.photography || 0, notes: 'Illustrative planning estimate; request and verify an actual quote.' },
    { category: 'Decor', name: 'Styling team', status: 'researching', estimatedCost: categoryAmounts.decor || 0, notes: `Illustrative allocation only; confirm ${input.style || 'styling'} pricing directly.` },
  ];

  return vendors;
};

const buildMenuSuggestions = (input) => [
  `Signature welcome drinks and light canapé station with ${input.dietaryPreferences || 'vegetarian-friendly choices'}.`,
  `Snacks and dinner for ${input.guestCount} guests, respecting ${input.dietaryPreferences || 'the stated dietary preferences'}.`,
  ...(input.eventType === 'Birthday' ? ['Birthday cake; confirm ingredients match the no-egg requirement if specified.'] : []),
  'Dessert table and coffee or tea bar for a polished finish.',
];

export const buildDemoPlan = (rawInput) => {
  const today = resolveToday(rawInput.today);
  const { eventDurationMinutes: durationMinutes, durationIsSuggested } = resolveDuration(rawInput);
  const input = { ...rawInput, eventDurationMinutes: durationMinutes, durationIsSuggested };
  const eventDate = input.eventDate;
  const { total, categoryAmounts, itemized } = buildBudgetData(input);
  const themeTitle = input.style || 'Warm modern elegance';
  const palette = ['#38294a', '#f2d9c5', '#8a6ab3', '#f6efe9'];
  const requirements = `${input.additionalRequirements} ${input.dietaryPreferences}`.toLowerCase();
  const birthdayIdeas = input.eventType === 'Birthday'
    ? ['Provide a birthday cake and coordinate the cake moment with the host.', 'Plan age-appropriate children’s games with adult supervision.', 'Arrange decorations, snacks, dinner, and a photographer within the stated budget.']
    : [];
  const rainPlan = /rain|outdoor|garden/.test(`${requirements} ${input.venuePreference.toLowerCase()}`)
    ? ['Rain backup: reserve an indoor covered area or a confirmed alternate room before booking.']
    : [];
  const menu = buildMenuSuggestions(input);
  const noEgg = /no[- ]?egg|egg[- ]?free|without eggs/i.test(`${input.dietaryPreferences} ${input.additionalRequirements}`);
  if (noEgg) menu.push('No-egg menu requirement: confirm ingredients and cross-contact handling directly with the caterer.');

  const plan = {
    eventStartTime: input.eventStartTime,
    eventDurationMinutes: durationMinutes,
    durationIsSuggested: input.durationIsSuggested,
    overview: `${input.eventName} is planned as a ${input.eventType.toLowerCase()} experience in ${input.city}, designed to balance ${input.style.toLowerCase()} aesthetics with practical guest comfort and budget discipline.`,
    theme: `${themeTitle} with a refined, welcoming mood`,
    palette,
    ideas: [
      `Use layered lighting and ${input.style.toLowerCase()} florals to create a warm, premium arrival experience.`,
      `Create a dedicated photo corner and a guest sign-in station that feels personal and easy to manage.`,
      `Build in a comfort check with seating, temperature control, and clear wayfinding for the guest count.`,
      ...birthdayIdeas,
      ...rainPlan,
    ],
    budgetAllocation: categoryAmounts,
    itemizedCosts: itemized,
    timeline: buildTimeline(input, durationMinutes),
    tasks: buildTasks(input, eventDate, today),
    vendors: buildVendorSuggestions(input, categoryAmounts),
    menuSuggestions: menu,
    contingency: [
      'Keep a weather backup if the venue is outdoors and have a simple indoor fallback.',
      'Confirm a 10% buffer in the budget for vendor escalations or inventory changes.',
      'Prepare a quick guest communications plan for changes in timing or venue access.'
    ],
    costSavings: [
      'Bundle decor and floral choices to reduce repeated freight and setup costs.',
      'Choose a venue with in-house furniture or lighting to trim rentals.',
      'Limit premium add-ons to one signature feature instead of multiple high-cost decorations.'
    ],
    assumptions: [
      `Estimated guest count of ${input.guestCount} is used for planning and food quantities.`,
      `The event is scheduled from ${input.eventStartTime} for ${durationMinutes} minutes${input.durationIsSuggested ? ' (suggested duration)' : ''}.`,
      `Vendor estimates are illustrative and should be validated with actual quotations.`
    ],
    mode: 'demo',
    generatedAt: new Date().toISOString(),
    budgetWarnings: total <= 0 ? ['Budget is zero, so the plan is intentionally conservative and should not be treated as a final procurement guide.'] : [],
  };

  return { success: true, data: planOutputSchema.parse(plan), message: 'Demo Mode: deterministic planning suggestions; vendor prices are estimates, not verified quotes.', source: 'demo' };
};

const getFocusedFields = (input) => (input.existingPlan ? focusedPlanFields(input.requestedAction) : []);

export const getRequestedBudgetReduction = (input) => {
  const action = String(input.requestedAction ?? '');
  const reducingBudget = /\b(?:reduce|lower|cut|decrease|trim)\b[\s\S]{0,80}\b(?:budget|spend|spending|costs?)\b/i.test(action)
    || /\b(?:budget|spend|spending|costs?)\b[\s\S]{0,80}\b(?:reduce|lower|cut|decrease|trim)\b/i.test(action);
  if (!reducingBudget) return null;
  const percentage = action.match(/\bby\s+(\d+(?:\.\d+)?)\s*(?:%|percent\b)/i);
  if (!percentage) {
    if (/\bto\s+\d+(?:\.\d+)?\s*(?:%|percent\b)/i.test(action)) {
      throw new PlanGenerationError(
        'Specify whether you want to reduce the budget by a percentage or set it to a percentage of the original.',
        400,
        'BUDGET_REDUCTION_AMBIGUOUS',
      );
    }
    return null;
  }
  const percent = Number(percentage[1]);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new PlanGenerationError(
      'Budget reduction percentage must be between 0 and 100.',
      400,
      'BUDGET_REDUCTION_INVALID',
    );
  }
  try {
    return calculateBudgetReduction(input.totalBudget, percent);
  } catch {
    throw new PlanGenerationError(
      'The event budget cannot be used to calculate the requested reduction. Check the budget amount and try again.',
      400,
      'BUDGET_REDUCTION_INVALID',
    );
  }
};

const willGenerateTasks = (input) => {
  const fields = getFocusedFields(input);
  return fields.length === 0 || fields.includes('tasks');
};

// Fields the provider writes. Everything else (timing, source, timestamps, and the
// category totals in budgetAllocation) is set or derived by the server.
const generatedPlanSchema = planOutputSchema.omit({
  eventStartTime: true,
  eventDurationMinutes: true,
  durationIsSuggested: true,
  budgetAllocation: true,
  mode: true,
  generatedAt: true,
});

// Upper bounds on list length keep the response (and therefore generation time) bounded.
export const OUTPUT_LIST_LIMITS = {
  ideas: 6,
  itemizedCosts: 14,
  timeline: 10,
  tasks: 14,
  vendors: 8,
  menuSuggestions: 8,
  contingency: 5,
  costSavings: 5,
  assumptions: 5,
  budgetWarnings: 3,
};

const normalizeGeminiSchema = (schema) => {
  if (Array.isArray(schema)) {
    return schema.map(normalizeGeminiSchema);
  }

  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => (
        key !== 'additionalProperties'
        && key !== 'default'
        && key !== 'exclusiveMinimum'
      ))
      .filter(([key, value]) => !(
        key === 'maximum'
        && value === Number.MAX_SAFE_INTEGER
      ))
      .map(([key, value]) => [
        key,
        normalizeGeminiSchema(value),
      ]),
  );
};

export const getGeminiResponseSchema = (input) => {
  const { $schema: ignoredSchema, ...schema } = normalizeGeminiSchema(
    z.toJSONSchema(generatedPlanSchema, { target: 'draft-07' }),
  );
  for (const [field, maxItems] of Object.entries(OUTPUT_LIST_LIMITS)) {
    if (schema.properties[field]?.type === 'array') schema.properties[field].maxItems = maxItems;
  }
  const fields = getFocusedFields(input);
  if (!fields.length) return schema;
  return {
    ...schema,
    properties: Object.fromEntries(fields.map((field) => [field, schema.properties[field]])),
    required: fields,
  };
};

export const buildGeminiPrompt = (input) => {
  const today = resolveToday(input.today);
  const eventContext = {
    eventName: input.eventName,
    eventType: input.eventType,
    eventDate: input.eventDate,
    eventStartTime: input.eventStartTime,
    eventDurationMinutes: input.eventDurationMinutes,
    durationIsSuggested: input.durationIsSuggested,
    city: input.city,
    guestCount: input.guestCount,
    totalBudget: input.totalBudget,
    style: input.style,
    venuePreference: input.venuePreference,
    dietaryPreferences: input.dietaryPreferences,
    culturalPreferences: input.culturalPreferences,
    additionalRequirements: input.additionalRequirements,
    priorities: input.priorities,
    requestedAction: input.requestedAction || 'Create a balanced event plan.',
  };
  const fields = getFocusedFields({ ...input, requestedAction: eventContext.requestedAction });
  const focused = fields.length > 0;
  const budgetReduction = getRequestedBudgetReduction(input);
  const existingSections = focused
    ? Object.fromEntries(fields.map((field) => [field, input.existingPlan[field]]))
    : undefined;
  const scheduleEnd = minutesToTime(timeToMinutes(input.eventStartTime) + input.eventDurationMinutes);

  return `You are Planora AI. Plan a warm Indian celebration using realistic INR estimates; never invent real vendor contacts. Honor every event, cultural, dietary, and additional requirement.
${focused
    ? `This is a focused edit. Change only these plan fields: ${fields.join(', ')}. Return a JSON object containing only those fields; the server will preserve every other saved field.`
    : ''
  }
${budgetReduction
    ? `This request is a ${budgetReduction.percent}% reduction from the original event budget of INR ${budgetReduction.originalBudget.toFixed(2)}. The deterministic target for all itemized expenses, contingency, and reserve combined is INR ${budgetReduction.targetBudget.toFixed(2)}; do not change unrelated event details.`
    : ''
  }
Keep the budget within the event budget; itemized expense, contingency, and reserve amounts must not exceed it. Keep timeline activities chronological, non-overlapping, positive-duration, and within ${input.eventStartTime}-${scheduleEnd}. New task due dates must be valid YYYY-MM-DD dates from today (${today}) through event date (${input.eventDate}).
Use short, actionable phrases for narrative fields and list entries (notes and descriptions under 20 words). Avoid repeating information between fields while retaining event-specific details. Be selective: prefer the most useful items over exhaustive lists.

Event context: ${JSON.stringify(eventContext)}
${focused ? `Current plan sections to revise: ${JSON.stringify(existingSections)}` : ''}`;
};

const summarizeUsage = (usage) => {
  if (!usage || typeof usage !== 'object') return undefined;
  const pick = (value) => (Number.isFinite(value) ? value : undefined);
  return {
    inputTokens: pick(usage.total_input_tokens),
    outputTokens: pick(usage.total_output_tokens),
    thoughtTokens: pick(usage.total_thought_tokens),
    totalTokens: pick(usage.total_tokens),
  };
};

const formatInr = (amount) => new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
}).format(amount);

const reconcileBudgetReduction = (plan, input) => {
  const reduction = getRequestedBudgetReduction(input);
  if (!reduction) return plan;

  plan.itemizedCosts = scaleBudgetItemsToTarget(plan.itemizedCosts, reduction.targetBudget);
  const summary = summarizeBudget(plan.itemizedCosts, input.totalBudget);
  if (summary.allocated !== reduction.targetBudget || summary.unallocated !== reduction.savings) {
    throw new RangeError('The reduced budget allocation does not exactly match the calculated target.');
  }
  const categoryTotal = summarizeBudget(
    Object.values(deriveBudgetAllocation(plan.itemizedCosts)).map((amount) => ({ amount })),
    reduction.targetBudget,
  ).allocated;
  if (categoryTotal !== summary.allocated) {
    throw new RangeError('Budget category totals do not match the itemized allocation.');
  }

  const statement = `Budget target: ${formatInr(reduction.targetBudget)}; requested reduction ${reduction.percent}%, actual reduction ${reduction.actualPercent}% from the original ${formatInr(reduction.originalBudget)} (${formatInr(reduction.savings)} saved).`;
  plan.costSavings = [
    ...plan.costSavings
      .filter((suggestion) => !/(?:\d+(?:\.\d+)?\s*(?:%|percent\b)|(?:₹|INR\s*)\s*\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s*(?:INR|rupees?)\b)/i.test(suggestion))
      .slice(0, OUTPUT_LIST_LIMITS.costSavings - 1),
    statement,
  ];
  plan.budgetWarnings = [statement];
  plan.budgetAllocation = deriveBudgetAllocation(plan.itemizedCosts);
  return plan;
};

/**
 * Rejects as soon as `signal` aborts, even if the underlying promise never settles. Upstream abort
 * propagation through the SDK/undici is best-effort (it relies on weak references), so waiting
 * code must not depend on it to stop.
 */
export const raceAbort = (promise, signal) => {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const rejectWithReason = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) return rejectWithReason();
    signal.addEventListener('abort', rejectWithReason, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', rejectWithReason); resolve(value); },
      (error) => { signal.removeEventListener('abort', rejectWithReason); reject(error); },
    );
    return undefined;
  });
};

const delayWithAbort = (delayMs, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) {
    reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    return;
  }
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', abort);
    resolve();
  }, delayMs);
  const abort = () => {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  };
  signal.addEventListener('abort', abort, { once: true });
});

const getRetryAfterMs = (headers, now = Date.now()) => {
  const getHeader = (name) => {
    if (typeof headers?.get === 'function') return headers.get(name);
    if (!headers || typeof headers !== 'object') return null;
    const headerName = Object.keys(headers).find((key) => key.toLowerCase() === name);
    return headerName ? headers[headerName] : null;
  };
  const retryAfterMilliseconds = getHeader('retry-after-ms');
  const milliseconds = retryAfterMilliseconds === null ? Number.NaN : Number(retryAfterMilliseconds);
  if (Number.isFinite(milliseconds) && milliseconds >= 0) return Math.ceil(milliseconds);
  const retryAfter = getHeader('retry-after');
  if (typeof retryAfter !== 'string' || !retryAfter.trim()) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const retryAt = Date.parse(retryAfter);
  return Number.isFinite(retryAt) && retryAt > now ? retryAt - now : null;
};

const isRetryableProviderError = (error) => {
  const classification = classifyGeminiError(error);
  return classification.retryable
    && (
      (classification.providerStatusCode !== null && classification.providerStatusCode >= 500)
      || classification.providerStatusCode === 408
      || classification.providerStatusCode === 429
      || ['network', 'timeout'].includes(classification.safeErrorCategory)
    );
};

const createProviderRequest = async (create, timings, signal) => {
  let retryStartedAt;
  const attempts = [];
  timings.providerAttempts = attempts;
  timings.providerFinalOutcome = 'failed';

  for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt += 1) {
    if (signal.aborted) {
      timings.providerFinalOutcome = 'cancelled';
      throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    }

    const attemptStartedAt = performance.now();
    try {
      const result = await raceAbort(create(), signal);
      const responseStatus = result?.sdkHttpResponse?.responseInternal?.status;
      attempts.push({
        attempt,
        statusCode: Number.isInteger(responseStatus) ? responseStatus : null,
        elapsedMs: Math.round(performance.now() - attemptStartedAt),
        outcome: 'success',
      });
      timings.providerFinalOutcome = 'success';
      return result;
    } catch (error) {
      const classification = classifyGeminiError(error);
      const elapsedMs = Math.round(performance.now() - attemptStartedAt);
      retryStartedAt ??= performance.now();
      const canRetry = !signal.aborted
        && attempt < MAX_PROVIDER_ATTEMPTS
        && isRetryableProviderError(error);
      const delayCeiling = Math.min(
        PROVIDER_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)),
        PROVIDER_RETRY_MAX_DELAY_MS,
      );
      const jitteredDelayMs = Math.round(delayCeiling * (0.5 + Math.random() * 0.5));
      const retryAfterMs = getRetryAfterMs(error?.headers);
      const delayMs = retryAfterMs === null ? jitteredDelayMs : Math.max(jitteredDelayMs, retryAfterMs);
      const retryWindowRemainingMs = PROVIDER_RETRY_WINDOW_MS - (performance.now() - retryStartedAt);
      const retry = canRetry && delayMs < retryWindowRemainingMs;
      attempts.push({
        attempt,
        statusCode: classification.providerStatusCode,
        elapsedMs,
        ...(retry ? { retryDelayMs: delayMs } : {}),
        outcome: signal.aborted ? 'cancelled' : retry ? 'retrying' : 'failed',
      });

      if (!retry) {
        timings.providerFinalOutcome = signal.aborted ? 'cancelled' : 'failed';
        throw error;
      }

      try {
        await delayWithAbort(delayMs, signal);
      } catch (delayError) {
        attempts[attempts.length - 1].outcome = 'cancelled';
        timings.providerFinalOutcome = 'cancelled';
        throw delayError;
      }
    }
  }

  throw new Error('Provider request attempts ended unexpectedly.');
};

const callGemini = async (input, timings, {
  onProgress,
  signal,
  apiKey,
  timeoutMs: timeoutOverride,
  serviceTier,
} = {}) => {
  timings.requestPhase = 'request_configuration';
  const model = validateGeminiModel();
  const thinkingLevel = getThinkingLevel();
  const timeoutMs = timeoutOverride ?? getGeminiTimeoutMs();
  if (serviceTier !== undefined && !['standard', 'priority'].includes(serviceTier)) {
    throw new PlanGenerationError('The requested Gemini service tier is not supported.', 400, 'GEMINI_SERVICE_TIER_INVALID');
  }
  const genAI = new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 1 } } });
  const promptStartedAt = performance.now();
  const prompt = buildGeminiPrompt(input);
  timings.promptConstructionMs = Math.round(performance.now() - promptStartedAt);
  timings.promptChars = prompt.length;
  timings.thinkingLevel = thinkingLevel;
  onProgress?.({ stage: 'generating', message: 'Request sent to Gemini. Waiting for the model to start responding.' });

  // One controller owns cancellation. AbortSignal.any() is deliberately avoided: Node and the SDK
  // link composite signals through weak references, so under garbage collection an upstream abort
  // can silently fail to propagate. The timer and listener below keep this controller alive for
  // exactly as long as the request, and are always released in `finally`.
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(signal.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    controller.abort(Object.assign(new Error('Gemini request timed out.'), { name: 'TimeoutError' }));
  }, timeoutMs);

  let outputText = '';
  let usage;
  let firstTokenAt;
  let interactionStatus;
  let streamCompleted = false;
  const apiStartedAt = performance.now();
  try {
    const requestOptions = {
      signal: controller.signal,
      timeout_ms: timeoutMs,
      retries: { strategy: 'none' },
    };
    const request = {
      model,
      input: prompt,
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema: getGeminiResponseSchema(input),
      },
      generation_config: { max_output_tokens: 8192, thinking_level: thinkingLevel },
      ...(serviceTier ? { service_tier: serviceTier } : {}),
      store: false,
    };
    if (onProgress) {
      timings.requestPhase = 'provider_request';
      const stream = await createProviderRequest(
        () => genAI.interactions.create({ ...request, stream: true }, requestOptions),
        timings,
        controller.signal,
      );
      timings.requestPhase = 'provider_stream';
      const iterator = stream[Symbol.asyncIterator]();
      try {
        for (;;) {
          const { value: event, done } = await raceAbort(iterator.next(), controller.signal);
          if (done) break;
          timings.timeToFirstProviderEventMs ??= Math.round(performance.now() - apiStartedAt);
          if (
            event.event_type === 'step.delta'
            && event.delta.type === 'text'
          ) {
            if (firstTokenAt === undefined) {
              firstTokenAt = performance.now();
              timings.timeToFirstTokenMs = Math.round(firstTokenAt - apiStartedAt);
              onProgress?.({ stage: 'drafting', message: 'Gemini has started writing the plan.' });
            }
            outputText += event.delta.text;
          } else if (event.event_type === 'interaction.completed') {
            streamCompleted = true;
            interactionStatus = event.interaction.status;
            usage = event.interaction.usage;
          } else if (event.event_type === 'error') {
            timings.providerFinalOutcome = 'failed';
            timings.providerStreamError = true;
            const lastAttempt = timings.providerAttempts?.at(-1);
            if (lastAttempt) lastAttempt.outcome = 'failed';
            throw new PlanGenerationError(
              'Gemini reported an error while generating the plan. Retry shortly; if the issue persists, check Google AI Studio service status.',
              502,
              'GEMINI_PROVIDER_ERROR',
            );
          }
        }
      } finally {
        // Best effort: release the provider stream; never let cleanup mask the real outcome.
        Promise.resolve(iterator.return?.()).catch(() => {});
      }
      if (firstTokenAt !== undefined) timings.generationAfterFirstTokenMs = Math.round(performance.now() - firstTokenAt);
    } else {
      timings.requestPhase = 'provider_request';
      const result = await createProviderRequest(
        () => genAI.interactions.create({ ...request }, { ...requestOptions }),
        timings,
        controller.signal,
      );
      outputText = result.output_text || '';
      usage = result.usage;
      interactionStatus = result.status;
    }
  } catch (error) {
    // Distinguish our own deadline from a caller cancellation and from provider failures.
    if (timedOut && !signal?.aborted) {
      timings.providerFinalOutcome = 'timeout';
      if (timings.providerAttempts?.length) {
        timings.providerAttempts[timings.providerAttempts.length - 1].outcome = 'timeout';
      }
      throw Object.assign(new Error('Gemini request timed out.'), { name: 'TimeoutError', cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeoutTimer);
    signal?.removeEventListener('abort', abortFromCaller);
    timings.geminiApiMs = Math.round(performance.now() - apiStartedAt);
    timings.outputChars = outputText.length;
    const usageSummary = summarizeUsage(usage);
    if (usageSummary) timings.usage = usageSummary;
  }
  timings.requestPhase = 'response_parsing';
  if (interactionStatus !== undefined) {
    timings.providerInteractionStatus = INTERACTION_STATUSES.has(interactionStatus)
      ? interactionStatus
      : 'unknown';
  }
  if ((onProgress && !streamCompleted) || interactionStatus !== 'completed') {
    timings.providerInteractionStatus ??= 'missing';
    timings.providerFinalOutcome = 'incomplete';
    const lastAttempt = timings.providerAttempts?.at(-1);
    if (lastAttempt) lastAttempt.outcome = 'incomplete';
    timings.responseValidationCategory = 'incomplete_response';
    throw new PlanGenerationError(
      'Gemini did not complete the plan response. Retry the request; if the issue persists, try a more focused request.',
      502,
      'GEMINI_RESPONSE_INCOMPLETE',
    );
  }
  if (!outputText.trim()) {
    timings.responseValidationCategory = 'empty_output';
    throw new PlanGenerationError(
      'Gemini completed the request without returning plan text. Retry once; if the issue persists, check Google AI Studio service status.',
      502,
      'GEMINI_RESPONSE_EMPTY',
    );
  }
  onProgress?.({ stage: 'validating', message: 'Checking the complete plan before it can be applied.' });
  const parseStartedAt = performance.now();
  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } finally {
    timings.responseParsingMs = Math.round(performance.now() - parseStartedAt);
  }
  const fields = getFocusedFields(input);
  const missingFields = fields.filter((field) => !Object.hasOwn(parsed, field));
  if (missingFields.length) {
    timings.responseValidationCategory = 'missing_focused_fields';
    timings.responseValidationFields = missingFields;
    throw new PlanGenerationError(
      'Gemini omitted one or more requested plan sections. Retry the request; no partial changes were applied.',
      502,
      'GEMINI_RESPONSE_INVALID',
    );
  }
  const merged = fields.length ? { ...input.existingPlan, ...parsed } : parsed;
  const validationStartedAt = performance.now();
  timings.requestPhase = 'response_validation';
  try {
    const validated = planOutputSchema.parse({
      ...merged,
      // Never trust (or require) a model-written allocation; it is derived below.
      budgetAllocation: {},
      mode: 'gemini',
      generatedAt: new Date().toISOString(),
      eventStartTime: input.eventStartTime,
      eventDurationMinutes: input.eventDurationMinutes,
      durationIsSuggested: input.durationIsSuggested,
    });
    validated.timeline = validateTimeline(validated.timeline, input.eventStartTime, input.eventDurationMinutes);
    if (willGenerateTasks(input)) validateGeneratedTaskDeadlines(validated.tasks, input.eventDate, resolveToday(input.today));
    reconcileBudgetReduction(validated, input);
    const budgetSummary = summarizeBudget(validated.itemizedCosts, input.totalBudget);
    if (budgetSummary.unallocated < 0) {
      throw new RangeError('Generated plan allocations exceed the event budget.');
    }
    validated.budgetAllocation = deriveBudgetAllocation(validated.itemizedCosts);
    if (budgetSummary.unallocated > 0) {
      const formattedRemainder = new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        maximumFractionDigits: 0,
      }).format(budgetSummary.unallocated);
      validated.budgetWarnings = [
        ...validated.budgetWarnings,
        `${formattedRemainder} of the event budget is unallocated after itemized costs.`,
      ];
    }
    const updatedFields = fields.length
      ? [...new Set([...fields, ...(fields.includes('itemizedCosts') ? ['budgetAllocation'] : [])])]
      : null;
    return planResponseSchema.parse({
      success: true,
      data: validated,
      message: 'Gemini plan generated successfully.',
      source: 'gemini',
      updatedFields,
    });
  } finally {
    timings.responseValidationMs = Math.round(performance.now() - validationStartedAt);
  }
};

/**
 * Demo Mode honours focused requests the same way Gemini does: only the requested sections change and
 * every other saved section is kept, so the UI's "only these sections will change" note is true in both modes.
 */
const applyDemoFocus = (input, demo) => {
  const fields = getFocusedFields(input);
  const merged = fields.length ? { ...input.existingPlan } : { ...demo.data };
  for (const field of fields) merged[field] = demo.data[field];
  merged.mode = 'demo';
  merged.generatedAt = demo.data.generatedAt;
  reconcileBudgetReduction(merged, input);
  merged.budgetAllocation = deriveBudgetAllocation(merged.itemizedCosts);
  const updatedFields = fields.length
    ? [...new Set([...fields, ...(fields.includes('itemizedCosts') ? ['budgetAllocation'] : [])])]
    : null;
  return { ...demo, data: merged, updatedFields };
};

export const parseGenerationInput = (rawInput) => {
  let input = eventInputSchema.parse(rawInput);
  if (input.existingPlan) input = { ...input, existingPlan: planOutputSchema.parse(input.existingPlan) };
  input = { ...input, ...resolveDuration(input), today: resolveToday(input.today) };
  getRequestedBudgetReduction(input);
  try {
    validateTimeline([], input.eventStartTime, input.eventDurationMinutes);
  } catch {
    throw new PlanGenerationError(
      'The event schedule must fit between its start time and midnight. Adjust the start time or duration before generating a plan.',
      400,
      'EVENT_TIMELINE_INVALID',
    );
  }
  return input;
};

export const generatePlan = async (rawInput, options = {}) => {
  const requestId = randomUUID();
  const startedAt = performance.now();
  const timings = {};
  let outcome = 'success';
  let source = 'gemini';
  let failureDiagnostic;
  try {
    const validationStartedAt = performance.now();
    let input;
    try {
      input = parseGenerationInput(rawInput);
    } finally {
      timings.requestValidationMs = Math.round(performance.now() - validationStartedAt);
    }
    options.onProgress?.({ stage: 'validated', message: 'Event details checked.' });

    const apiKey = readGeminiApiKey();
    if (!apiKey) {
      source = 'demo';
      options.onProgress?.({ stage: 'demo', message: 'Gemini is not configured; using Demo Mode.' });
      return planResponseSchema.parse(applyDemoFocus(input, buildDemoPlan(input)));
    }

    // Fail fast: a plan whose task deadlines cannot be valid would only be rejected after a long,
    // billable generation.
    if (willGenerateTasks(input) && input.eventDate < input.today) {
      throw new PlanGenerationError(
        'The event date is in the past, so task deadlines cannot be planned. Update the event date and try again.',
        400,
        'EVENT_DATE_IN_PAST',
      );
    }

    try {
      return await callGemini(input, timings, { ...options, apiKey });
    } catch (error) {
      if (options.signal?.aborted) {
        outcome = 'CLIENT_DISCONNECTED';
        throw error;
      }
      if (error instanceof ZodError) {
        timings.responseValidationFields = [...new Set(error.issues.map((issue) => issue.path.join('.')))];
        timings.responseValidationCategory = 'schema';
      } else if (error instanceof RangeError) {
        timings.responseValidationCategory = /deadline|event date/i.test(error.message)
          ? 'task_deadlines'
          : /overlap|fit between|event end time|event duration|invalid 24-hour time/i.test(error.message)
            ? 'timeline'
            : 'budget_or_constraints';
      } else if (error instanceof SyntaxError) {
        timings.responseValidationCategory = 'invalid_json';
      }
      const classification = error instanceof PlanGenerationError
        ? {
          ...classifyGeminiError(error),
          providerStatusCode: null,
          safeErrorCategory: error.code.startsWith('GEMINI_RESPONSE_')
            ? 'response_validation'
            : error.code === 'GEMINI_PROVIDER_ERROR'
              ? 'provider_error'
              : 'request_configuration',
          retryable: false,
        }
        : classifyGeminiError(error);
      failureDiagnostic = {
        ...classification,
        requestPhase: timings.requestPhase || 'provider_request',
        providerAttemptCount: timings.providerAttempts?.length ?? 0,
        providerAttempts: timings.providerAttempts ?? [],
        providerFinalOutcome: timings.providerFinalOutcome ?? 'failed',
      };
      const safeError = mapGeminiError(error, timings.providerAttempts?.length ?? 1);
      Object.assign(safeError, classification);
      outcome = safeError.code;
      console.error(JSON.stringify(failureDiagnostic));
      throw safeError;
    }
  } catch (error) {
    outcome = options.signal?.aborted
      ? 'CLIENT_DISCONNECTED'
      : error instanceof PlanGenerationError
        ? error.code
        : 'REQUEST_INVALID';
    throw error;
  } finally {
    console.info(JSON.stringify({
      event: 'plan_generation_timing',
      requestId,
      source,
      outcome,
      ...timings,
      ...(failureDiagnostic || {}),
      providerAttemptCount: timings.providerAttempts?.length ?? 0,
      totalMs: Math.round(performance.now() - startedAt),
    }));
  }
};
