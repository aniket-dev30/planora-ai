import type { ApiPlanResponse } from '../types/api';
import type { EventPlan } from './storage';

type GeneratedPlan = ApiPlanResponse['data'];

const withIds = <T extends object>(items: T[]): Array<T & { id: string }> => (
  items.map((item) => ({ ...item, id: crypto.randomUUID() }))
);

const LIST_FIELDS = ['itemizedCosts', 'timeline', 'tasks', 'vendors'] as const;

/**
 * Builds the editable plan to save from a generated one.
 *
 * For a focused suggestion (`updatedFields` set) only those sections are replaced, so tasks the user
 * has already ticked off, and every other section, are kept exactly as saved. A full regeneration
 * (`updatedFields` null) replaces the whole plan, as before.
 */
export const mergeGeneratedPlan = (
  current: EventPlan,
  generated: GeneratedPlan,
  updatedFields: string[] | null | undefined,
): EventPlan => {
  const replaceAll = !updatedFields || updatedFields.length === 0;
  const replaces = (field: string) => replaceAll || updatedFields.includes(field);

  const next: EventPlan = replaceAll ? { ...generated } as unknown as EventPlan : { ...current };
  if (!replaceAll) {
    const record = next as unknown as Record<string, unknown>;
    for (const field of updatedFields) {
      if (field in generated) record[field] = (generated as unknown as Record<string, unknown>)[field];
    }
    next.mode = generated.mode;
    next.generatedAt = generated.generatedAt;
  }

  for (const field of LIST_FIELDS) {
    if (!replaces(field)) continue;
    const items = generated[field] as unknown as Array<Record<string, unknown>>;
    (next as unknown as Record<string, unknown>)[field] = withIds(items);
  }
  return next;
};
