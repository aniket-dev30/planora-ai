import { useCallback, useEffect, useRef, useState } from 'react';
import { generatePlan } from './api';
import type { ApiPlanResponse, EventFormValues } from '../types/api';

export type GenerationOutcome =
  | { status: 'done'; result: ApiPlanResponse }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

/**
 * Owns one cancellable plan generation: a single in-flight request, an AbortController that is always
 * released, and progress text that only ever reflects what the backend reported.
 */
export function useGeneration() {
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState('');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const inFlight = useRef(false);
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
      const result = await generatePlan(request, (message) => {
        if (mounted.current) setProgress(message);
      }, controller.signal);
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
  }, []);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  return { isLoading, progress, startedAt, run, cancel };
}
