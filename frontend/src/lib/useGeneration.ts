import { useCallback, useEffect, useRef, useState } from 'react';
import { generatePlan } from './api';
import type { ApiPlanResponse, EventFormValues } from '../types/api';
import { useDemoAccessToken } from '../auth/accessToken';

export type GenerationOutcome =
  | { status: 'done'; result: ApiPlanResponse }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

const getTokenForRequest = async (getToken: () => Promise<string>, signal: AbortSignal) => {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException('Plan generation was cancelled.', 'AbortError'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([getToken(), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
};

/**
 * Owns one cancellable plan generation: a single in-flight request, an AbortController that is always
 * released, and progress text that only ever reflects what the backend reported.
 */
export function useGeneration() {
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState('');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const inFlight = useRef(false);
  const getAccessToken = useDemoAccessToken();
  const controllerRef = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, []);

  const run = useCallback(async (request: EventFormValues): Promise<GenerationOutcome | undefined> => {
    // The ref (not state) is the gate: two rapid submits in the same tick must not both pass.
    if (inFlight.current) return undefined;
    inFlight.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    setIsLoading(true);
    setStartedAt(Date.now());
    setProgress('Sending your request…');
    try {
      const accessToken = getAccessToken ? await getTokenForRequest(getAccessToken, controller.signal) : undefined;
      const result = await generatePlan(request, (message) => {
        if (mounted.current) setProgress(message);
      }, controller.signal, accessToken);
      return { status: 'done', result };
    } catch (error) {
      if (controller.signal.aborted) return { status: 'cancelled' };
      return { status: 'error', message: error instanceof Error ? error.message : 'Unable to generate the plan.' };
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      inFlight.current = false;
      if (mounted.current) {
        setIsLoading(false);
        setProgress('');
        setStartedAt(null);
      }
    }
  }, [getAccessToken]);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  return { isLoading, progress, startedAt, run, cancel };
}
