import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowUpRight, RefreshCw, Sparkles } from 'lucide-react';
import type { EventData } from '../lib/storage';
import type { ApiPlanResponse, EventFormValues } from '../types/api';
import { GenerationStatus } from '../components/GenerationStatus';
import { formatCurrency, formatDateKey } from '../lib/format';
import { useGeneration } from '../lib/useGeneration';
import { summarizeBudget } from '../../../shared/budget.mjs';
import { focusedPlanFields } from '../../../shared/planFocus.mjs';
import { getTodayDateKey, isTaskAfterEvent, isTaskOverdue } from '../../../shared/taskDates.mjs';

const defaultPrompts = [
  'Reduce my budget by 15%.',
  'Suggest a vegetarian menu for 100 guests.',
  'Create a rain backup plan.',
  'Make the decor more elegant but affordable.',
  'Add a checklist for the week before the event.',
];

const SECTION_LABELS: Record<string, string> = {
  overview: 'Overview',
  theme: 'Theme',
  palette: 'Palette',
  ideas: 'Ideas',
  itemizedCosts: 'Budget items',
  budgetAllocation: 'Budget categories',
  costSavings: 'Cost-saving tips',
  budgetWarnings: 'Budget notes',
  timeline: 'Timeline',
  tasks: 'Tasks',
  vendors: 'Vendors',
  menuSuggestions: 'Menu ideas',
  contingency: 'Contingency plans',
};

type Suggestion = {
  data: ApiPlanResponse['data'];
  source: ApiPlanResponse['source'];
  updatedFields: string[] | null;
  eventId: string;
  basedOnVersion: string;
};

export type ApplyPlanHandler = (plan: ApiPlanResponse['data'], updatedFields: string[] | null) => void;

export function PlannerPage({ event, onApplyPlan }: { event: EventData | null; onApplyPlan: ApplyPlanHandler }) {
  const [prompt, setPrompt] = useState(defaultPrompts[0]);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [error, setError] = useState('');
  const { isLoading, progress, startedAt, run, cancel } = useGeneration();

  const requestBody = useMemo<EventFormValues | null>(() => {
    if (!event) return null;
    return {
      eventName: event.eventName,
      eventType: event.eventType,
      eventDate: event.eventDate,
      eventStartTime: event.eventStartTime,
      eventDurationMinutes: event.eventDurationMinutes,
      durationIsSuggested: event.durationIsSuggested,
      city: event.city,
      guestCount: event.guestCount,
      totalBudget: event.totalBudget,
      style: event.style,
      venuePreference: event.venuePreference,
      dietaryPreferences: event.dietaryPreferences,
      culturalPreferences: event.culturalPreferences,
      additionalRequirements: event.additionalRequirements,
      priorities: event.priorities,
      requestedAction: prompt.trim(),
      existingPlan: event.plan,
    };
  }, [event, prompt]);

  const handleGenerate = async () => {
    if (!requestBody || !event) return;
    setError('');
    setSuggestion(null);
    const requestedFor = { id: event.id, version: event.updatedAt };
    const outcome = await run(requestBody);
    if (!outcome) return; // A generation is already running; ignore the duplicate request.
    if (outcome.status === 'done') {
      setSuggestion({
        data: outcome.result.data,
        source: outcome.result.source,
        updatedFields: outcome.result.updatedFields ?? null,
        eventId: requestedFor.id,
        basedOnVersion: requestedFor.version,
      });
    } else if (outcome.status === 'cancelled') {
      setError('Generation cancelled. Nothing was changed. You can try again whenever you are ready.');
    } else {
      setError(outcome.message);
    }
  };

  if (!event) {
    return (
      <div className="panel-card empty-state-block">
        <AlertTriangle size={20} aria-hidden="true" />
        <h3>AI planner ready</h3>
        <p>Select an event to generate tailored event suggestions.</p>
      </div>
    );
  }

  const current = suggestion && suggestion.eventId === event.id ? suggestion : null;
  const isStale = current !== null && current.basedOnVersion !== event.updatedAt;
  const today = getTodayDateKey();
  const suggestionBudget = current ? summarizeBudget(current.data.itemizedCosts, event.totalBudget) : null;
  const changedLabels = current?.updatedFields?.map((field) => SECTION_LABELS[field] ?? field) ?? null;
  const sourceLabel = (source: ApiPlanResponse['source']) => (source === 'demo' ? 'Demo Mode' : 'Gemini');

  const apply = () => {
    if (!current) return;
    onApplyPlan(current.data, current.updatedFields);
    setSuggestion(null);
  };

  return (
    <div className="planner-page">
      <div className="panel-card planner-card">
        <div className="section-header compact">
          <h3>AI assistant</h3>
          <span className="badge">
            {isLoading
              ? 'Generating…'
              : current
                ? sourceLabel(current.source)
                : `Saved plan: ${sourceLabel(event.plan.mode)}`}
          </span>
        </div>
        <label className="field-label" htmlFor="planner-prompt">What would you like to change?</label>
        <textarea
          id="planner-prompt"
          value={prompt}
          maxLength={500}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          disabled={isLoading}
        />
        <div className="chip-row" role="group" aria-label="Example prompts">
          {defaultPrompts.map((item) => (
            <button key={item} type="button" className="chip" onClick={() => setPrompt(item)} disabled={isLoading}>{item}</button>
          ))}
        </div>
        <p className="muted">
          {changedHint(prompt)}
        </p>
        <div className="generation-controls">
          <button type="button" className="primary-btn" onClick={handleGenerate} disabled={isLoading || !prompt.trim()}>
            {isLoading ? <RefreshCw className="spin" size={16} aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}
            {isLoading ? 'Generating…' : 'Generate suggestions'}
          </button>
        </div>
        {isLoading ? <GenerationStatus message={progress} startedAt={startedAt} onCancel={cancel} /> : null}
      </div>

      <div className="panel-card suggestion-card">
        <div className="section-header compact">
          <h3>Proposed updates</h3>
          <span className="badge">{current ? sourceLabel(current.source) : isLoading ? 'Generating…' : 'Not generated'}</span>
        </div>
        {error ? (
          <div className="error-box" role="alert">
            <span>{error}</span>
            {!isLoading ? <button type="button" className="ghost-btn small" onClick={handleGenerate}>Try again</button> : null}
          </div>
        ) : null}
        {current ? (
          <div className="proposal-content">
            {isStale ? (
              <div className="error-box" role="alert">
                This event was edited after the suggestion was requested. Applying it may replace those newer edits. Regenerate for a fresh suggestion.
              </div>
            ) : null}
            <p className="muted">
              {changedLabels
                ? `Applying will update only: ${changedLabels.join(', ')}. Everything else stays as saved.`
                : 'This is a full plan. Applying will replace the whole saved plan, including task progress.'}
            </p>
            <p><strong>Overview:</strong> {current.data.overview}</p>
            <p><strong>Theme:</strong> {current.data.theme}</p>
            <h4>Budget outline</h4>
            {suggestionBudget ? (
              <p className="muted">
                Event budget: {formatCurrency(event.totalBudget)}
                {' · '}Itemized total: {formatCurrency(suggestionBudget.allocated)}
                {' · '}Unallocated: {formatCurrency(suggestionBudget.unallocated)}
              </p>
            ) : null}
            <ul>{current.data.itemizedCosts.map((item, index) => <li key={`${item.category}-${index}`}>{item.category} — {item.label}: {formatCurrency(item.amount)}</li>)}</ul>
            <h4>Schedule and checklist</h4>
            <ul>{current.data.timeline.map((item, index) => <li key={`${item.startTime}-${index}`}>{item.startTime} · {item.title} ({item.durationMinutes} min)</li>)}</ul>
            <ul>{current.data.tasks.map((task, index) => <li key={`${task.title}-${index}`}>{task.title} · {task.priority} · due {formatDateKey(task.dueDate)}{isTaskOverdue(task.dueDate, task.status, today) ? ' · OVERDUE' : ''}{isTaskAfterEvent(task.dueDate, event.eventDate) ? ' · AFTER EVENT DATE' : ''}</li>)}</ul>
            <h4>Vendor checklist <small>Estimated planning figures only; not verified quotes.</small></h4>
            <ul>{current.data.vendors.map((vendor, index) => <li key={`${vendor.category}-${index}`}>{vendor.category}: {vendor.name} — {vendor.status}</li>)}</ul>
            <h4>Menu ideas</h4>
            <ul>{current.data.menuSuggestions.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
            <h4>Cost-saving suggestions</h4>
            <ul>{current.data.costSavings.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
            {current.data.budgetWarnings.length ? <div className="error-box">{current.data.budgetWarnings.join(' ')}</div> : null}
            {current.data.mode === 'demo' ? <p className="muted">Demo Mode: deterministic suggestions for planning, not confirmed vendor pricing.</p> : null}
            <button type="button" className="primary-btn" onClick={apply}>{isStale ? 'Apply anyway' : 'Apply to this event'}</button>
          </div>
        ) : !error ? (
          <div className="empty-card inline-empty">
            {isLoading ? (
              <p>The plan is shown here once it has been fully received and checked (schema, budget, schedule and task dates).</p>
            ) : (
              <>
                <ArrowUpRight size={18} aria-hidden="true" />
                <p>Pick or write a request, then generate. Suggestions appear here for you to review before anything is saved.</p>
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Tells the user, before they spend a request, whether this prompt will touch the whole plan. */
const changedHint = (prompt: string): string => (
  focusedPlanFields(prompt).length > 0
    ? 'This looks like a focused request, so only the related sections are regenerated. Your other saved edits are kept.'
    : 'This request does not match a specific section, so the whole plan is regenerated and replaces the saved one when applied.'
);

export default PlannerPage;
