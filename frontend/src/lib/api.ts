import type { ApiPlanResponse, EventFormValues } from '../types/api';
import { getTodayDateKey } from '../../../shared/taskDates.mjs';

// A safety net only: the backend always answers by its own deadline (4 minutes by default, 10 at most),
// and users can cancel at any time. This must stay longer than the backend's largest allowed timeout.
const CLIENT_TIMEOUT_MS = 11 * 60_000;

const API_BASE_URL = ((import.meta.env?.VITE_API_BASE_URL || '')).replace(/\/$/, '');

type StreamMessage =
  | { type: 'progress'; message: string }
  | { type: 'complete'; result: ApiPlanResponse }
  | { type: 'error'; error?: string; details?: Array<{ message?: string }> };

const validatePlanResponse = (payload: Partial<ApiPlanResponse>): ApiPlanResponse => {
  if (
    payload.success !== true
    || !payload.data
    || (payload.source !== 'gemini' && payload.source !== 'demo')
    || payload.data.mode !== payload.source
  ) {
    throw new Error('The backend returned an unconfirmed plan source. No plan was marked as Gemini-generated.');
  }
  return payload as ApiPlanResponse;
};

export async function generatePlan(
  request: EventFormValues,
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
): Promise<ApiPlanResponse> {
  let response: Response;
  const timeoutSignal = AbortSignal.timeout(CLIENT_TIMEOUT_MS);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  try {
    response = await fetch(`${API_BASE_URL}/api/plans/generate/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `today` is the user's local calendar date, so deadlines are not judged against the server's UTC date.
      body: JSON.stringify({ ...request, today: getTodayDateKey() }),
      signal: requestSignal,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw new DOMException('Plan generation was cancelled.', 'AbortError');
    }
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error('Plan generation took too long and was stopped. Retry with a more focused request.', { cause: error });
    }
    throw new Error('Cannot reach Planora or generation timed out. Check the backend and API URL, then retry.', { cause: error });
  }

  if (!response.ok) {
    let errorMessage = 'Unable to generate an event plan.';
    try {
      const payload = await response.json() as { error?: string; details?: Array<{ message?: string }> };
      errorMessage = payload.error || payload.details?.[0]?.message || errorMessage;
    } catch {
      // Keep the generic actionable message if the server error body is not JSON.
    }
    throw new Error(errorMessage);
  }

  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
    throw new Error('The backend returned an unreadable generation stream. Confirm the backend is current and retry.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', cancelReader, { once: true });
  let buffer = '';
  let result: ApiPlanResponse | undefined;

  const processEvent = (eventText: string) => {
    const data = eventText
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    let message: StreamMessage;
    try {
      message = JSON.parse(data) as StreamMessage;
    } catch {
      throw new Error('The backend returned an unreadable generation update. Retry the request.');
    }
    if (message.type === 'progress') {
      onProgress?.(message.message);
    } else if (message.type === 'error') {
      const detail = Array.isArray(message.details) ? message.details[0]?.message : undefined;
      throw new Error(message.error || detail || 'Unable to generate an event plan.');
    } else if (message.type === 'complete') {
      result = validatePlanResponse(message.result);
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        processEvent(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
      if (done) break;
    }
    if (buffer.trim()) processEvent(buffer);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (signal?.aborted) {
      throw new DOMException('Plan generation was cancelled.', 'AbortError');
    }
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error('Plan generation took too long and was stopped. Retry with a more focused request.', { cause: error });
    }
    if (error instanceof Error) throw error;
    throw new Error('The generation stream ended unexpectedly. Retry the request.', { cause: error });
  } finally {
    signal?.removeEventListener('abort', cancelReader);
  }

  if (signal?.aborted) {
    throw new DOMException('Plan generation was cancelled.', 'AbortError');
  }
  if (!result) throw new Error('Gemini did not return a complete validated plan. Retry the request.');
  return result;
}
