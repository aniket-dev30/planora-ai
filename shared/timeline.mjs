const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function timeToMinutes(value) {
  const match = TIME_PATTERN.exec(value);
  if (!match) throw new RangeError(`Invalid 24-hour time: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function minutesToTime(value) {
  const normalized = ((value % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

export function validateTimeline(entries, startTime, durationMinutes) {
  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
    throw new RangeError('Event duration must be a positive number of minutes.');
  }

  const start = timeToMinutes(startTime);
  const end = start + durationMinutes;
  if (end > 1440) throw new RangeError('The event end time cannot extend past midnight.');

  const sorted = entries.map((entry) => {
    const activityStart = timeToMinutes(entry.startTime);
    if (!Number.isInteger(entry.durationMinutes) || entry.durationMinutes <= 0) {
      throw new RangeError(`Activity "${entry.title}" must have a positive duration.`);
    }
    if (activityStart < start || activityStart + entry.durationMinutes > end) {
      throw new RangeError(`Activity "${entry.title}" must fit between ${startTime} and ${minutesToTime(end)}.`);
    }
    return { ...entry, _start: activityStart, _end: activityStart + entry.durationMinutes };
  }).sort((left, right) => left._start - right._start);

  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]._start < sorted[index - 1]._end) {
      throw new RangeError(`Activity "${sorted[index].title}" overlaps "${sorted[index - 1].title}".`);
    }
  }

  return sorted.map(({ _start, _end, ...entry }) => entry);
}
