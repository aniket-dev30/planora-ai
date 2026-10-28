export function toDateKey(date: Date): string;
export function getTodayDateKey(now?: Date): string;
export function isValidDateKey(value: unknown): value is string;
export function addDaysToDateKey(value: string, days: number): string;
export function diffDateKeys(from: string, to: string): number;
export function isTaskOverdue(dueDate: string, status: string, today?: string): boolean;
export function isTaskAfterEvent(dueDate: string, eventDate: string): boolean;
export function validateGeneratedTaskDeadlines<T extends { title: string; dueDate: string }>(
  tasks: T[],
  eventDate: string,
  today?: string,
): T[];
