import { validateBudgetAmount } from '../../../shared/budget.mjs';
import { isTaskAfterEvent, isValidDateKey } from '../../../shared/taskDates.mjs';
import { validateTimeline } from '../../../shared/timeline.mjs';
import type { EventData, EventType } from './storage';

export type EventSettingsDraft = {
  eventName: string;
  eventType: EventType;
  eventDate: string;
  city: string;
  guestCount: number;
  totalBudget: number;
  eventStartTime: string;
  eventDurationMinutes: number;
};

export type SettingsValidation =
  | { ok: true; values: EventSettingsDraft; warnings: string[] }
  | { ok: false; errors: string[] };

export const settingsDraftFromEvent = (event: EventData): EventSettingsDraft => ({
  eventName: event.eventName,
  eventType: event.eventType,
  eventDate: event.eventDate,
  city: event.city,
  guestCount: event.guestCount,
  totalBudget: event.totalBudget,
  eventStartTime: event.eventStartTime,
  eventDurationMinutes: event.eventDurationMinutes,
});

/** Validates a settings draft against the event's existing plan. Pure, so it is unit-testable. */
export const validateEventSettings = (draft: EventSettingsDraft, event: EventData): SettingsValidation => {
  const errors: string[] = [];
  const warnings: string[] = [];
  const values: EventSettingsDraft = {
    ...draft,
    eventName: draft.eventName.trim(),
    city: draft.city.trim(),
  };

  if (values.eventName.length < 2 || values.eventName.length > 120) errors.push('Event name must be 2–120 characters.');
  if (values.city.length < 2 || values.city.length > 100) errors.push('Location must be 2–100 characters.');
  if (!isValidDateKey(values.eventDate)) errors.push('Enter a valid event date.');
  if (!Number.isInteger(values.guestCount) || values.guestCount < 1 || values.guestCount > 20000) {
    errors.push('Guest count must be a whole number between 1 and 20,000.');
  }
  try {
    validateBudgetAmount(values.totalBudget);
  } catch {
    errors.push('Budget must be a finite, non-negative number.');
  }
  if (!Number.isInteger(values.eventDurationMinutes) || values.eventDurationMinutes < 30 || values.eventDurationMinutes > 1440) {
    errors.push('Duration must be between 30 and 1,440 minutes.');
  } else {
    try {
      validateTimeline(event.plan.timeline, values.eventStartTime, values.eventDurationMinutes);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'The current timeline does not fit this start time and duration.');
    }
  }
  if (errors.length) return { ok: false, errors };

  const lateTasks = event.plan.tasks.filter((task) => isTaskAfterEvent(task.dueDate, values.eventDate)).length;
  if (lateTasks > 0) {
    warnings.push(`${lateTasks} task${lateTasks === 1 ? ' is' : 's are'} due after the new event date. Review ${lateTasks === 1 ? 'it' : 'them'} in Vendors & Tasks.`);
  }
  return { ok: true, values, warnings };
};
