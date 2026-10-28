export type TimelineActivity = {
  title: string;
  startTime: string;
  durationMinutes: number;
  notes: string;
};

export function timeToMinutes(value: string): number;
export function minutesToTime(value: number): string;
export function validateTimeline<T extends TimelineActivity>(
  entries: T[],
  startTime: string,
  durationMinutes: number,
): T[];
