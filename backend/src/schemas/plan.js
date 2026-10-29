import { z } from 'zod';
import { isValidDateKey } from '../../../shared/taskDates.mjs';

const dateKeySchema = z.string().refine(isValidDateKey, 'Must be a valid calendar date in YYYY-MM-DD format.');

export const eventInputSchema = z.object({
  eventName: z.string().trim().min(2, 'Event name is required.').max(120),
  eventType: z.enum(['Wedding', 'Birthday', 'Community event', 'Other celebration']),
  eventDate: dateKeySchema,
  // The caller's local calendar date. Lets the server judge "today" in the user's time zone.
  today: dateKeySchema.optional(),
  eventStartTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('18:00'),
  eventDurationMinutes: z.number().int().positive().max(1440).default(240),
  durationIsSuggested: z.boolean().default(true),
  city: z.string().trim().min(2, 'City is required.').max(100),
  guestCount: z.number().int().min(1, 'Guest count must be at least 1.').max(20000),
  totalBudget: z.number().nonnegative('Budget must be zero or greater.'),
  style: z.string().trim().min(2, 'Event style is required.').max(120),
  venuePreference: z.string().trim().min(2, 'Venue preference is required.').max(120),
  dietaryPreferences: z.string().trim().max(300).default('Vegetarian-friendly and inclusive options'),
  culturalPreferences: z.string().trim().max(300).default(''),
  additionalRequirements: z.string().trim().max(500).default(''),
  priorities: z.array(z.string().trim().max(60)).max(8).default([]),
  requestedAction: z.string().trim().max(500).default(''),
  existingPlan: z.unknown().optional(),
}).strict().transform((input) => ({
  ...input,
  guestCount: Number(input.guestCount),
  totalBudget: Number(input.totalBudget),
  priorities: input.priorities ?? [],
}));

export const expenseItemSchema = z.object({
  category: z.string().min(1),
  label: z.string().min(1),
  amount: z.number().nonnegative(),
  kind: z.enum(['expense', 'contingency', 'reserve']).default('expense'),
  notes: z.string().default(''),
});

export const timelineEntrySchema = z.object({
  title: z.string().min(1),
  startTime: z.string().min(1),
  durationMinutes: z.number().int().positive().default(60),
  notes: z.string().default(''),
});

export const taskItemSchema = z.object({
  title: z.string().min(1),
  priority: z.enum(['Low', 'Medium', 'High']),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(['todo', 'in progress', 'done']),
  source: z.enum(['manual', 'ai']).default('ai'),
  description: z.string().default(''),
});

export const vendorItemSchema = z.object({
  category: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(['researching', 'contacted', 'quoted', 'booked', 'not needed']),
  estimatedCost: z.number().nonnegative().default(0),
  notes: z.string().default(''),
});

export const planOutputSchema = z.object({
  eventStartTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  eventDurationMinutes: z.number().int().positive().max(1440),
  durationIsSuggested: z.boolean(),
  overview: z.string().min(1),
  theme: z.string().min(1),
  palette: z.array(z.string()).min(2).max(6),
  ideas: z.array(z.string()).min(1),
  budgetAllocation: z.record(z.number().nonnegative()),
  itemizedCosts: z.array(expenseItemSchema).min(1),
  timeline: z.array(timelineEntrySchema).min(1),
  tasks: z.array(taskItemSchema).min(1),
  vendors: z.array(vendorItemSchema).min(1),
  menuSuggestions: z.array(z.string()).min(1),
  contingency: z.array(z.string()).min(1),
  costSavings: z.array(z.string()).min(1),
  assumptions: z.array(z.string()).min(1),
  mode: z.enum(['demo', 'gemini']),
  generatedAt: z.string(),
  budgetWarnings: z.array(z.string()).default([]),
});

export const planResponseSchema = z.object({
  success: z.boolean(),
  data: planOutputSchema,
  message: z.string().default('Plan generated successfully.'),
  source: z.enum(['gemini', 'demo']).default('demo'),
  // Sections the provider was asked to change; null means the whole plan was generated.
  updatedFields: z.array(z.string()).nullable().default(null),
});
