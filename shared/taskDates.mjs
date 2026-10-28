const pad = (value) => String(value).padStart(2, '0');

/**
 * Formats a Date as a calendar date key (YYYY-MM-DD) using the *local* time zone.
 * Using toISOString() here would return the UTC date, which is the wrong calendar
 * day for users east/west of UTC (e.g. IST between 00:00 and 05:30).
 */
export function toDateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function getTodayDateKey(now = new Date()) {
  return toDateKey(now);
}

export function isValidDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Adds whole days to a date key without any time-zone conversion. */
export function addDaysToDateKey(value, days) {
  if (!isValidDateKey(value)) throw new RangeError('A valid YYYY-MM-DD date is required.');
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function diffDateKeys(from, to) {
  if (!isValidDateKey(from) || !isValidDateKey(to)) throw new RangeError('Valid YYYY-MM-DD dates are required.');
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000);
}

export function isTaskOverdue(dueDate, status, today = getTodayDateKey()) {
  return status !== 'done' && isValidDateKey(dueDate) && dueDate < today;
}

export function isTaskAfterEvent(dueDate, eventDate) {
  return isValidDateKey(dueDate) && isValidDateKey(eventDate) && dueDate > eventDate;
}

export function validateGeneratedTaskDeadlines(tasks, eventDate, today = getTodayDateKey()) {
  if (!isValidDateKey(eventDate)) {
    throw new RangeError('The event date must be a valid calendar date before task deadlines can be planned.');
  }
  if (!isValidDateKey(today)) {
    throw new RangeError('The current date must be a valid calendar date before task deadlines can be planned.');
  }
  if (eventDate < today) {
    throw new RangeError('The event date is in the past. Update the event date before generating new task deadlines.');
  }

  for (const task of tasks) {
    if (!isValidDateKey(task.dueDate)) {
      throw new RangeError(`Task "${task.title}" must have a valid YYYY-MM-DD deadline.`);
    }
    if (task.dueDate < today) {
      throw new RangeError(`Task "${task.title}" has a deadline before today.`);
    }
    if (task.dueDate > eventDate) {
      throw new RangeError(`Task "${task.title}" has a deadline after the event date.`);
    }
  }

  return tasks;
}
