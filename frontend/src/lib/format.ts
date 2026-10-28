import { isValidDateKey } from '../../../shared/taskDates.mjs';

const currencyFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

export const formatCurrency = (amount: number): string => currencyFormatter.format(Number.isFinite(amount) ? amount : 0);

const dateFormatter = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * Formats a YYYY-MM-DD calendar date. The date is built from its parts in the local time zone;
 * `new Date('2026-03-05')` would parse as UTC midnight and show the previous day west of UTC.
 */
export const formatDateKey = (dateKey: string): string => {
  if (!isValidDateKey(dateKey)) return 'Date not set';
  const [year, month, day] = dateKey.split('-').map(Number);
  return dateFormatter.format(new Date(year, month - 1, day));
};

export const formatElapsed = (totalSeconds: number): string => {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
