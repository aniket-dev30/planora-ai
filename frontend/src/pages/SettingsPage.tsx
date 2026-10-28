import { useState } from 'react';
import type { FormEvent } from 'react';
import { AlertCircle, Check, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { settingsDraftFromEvent, validateEventSettings } from '../lib/eventSettings';
import type { EventSettingsDraft } from '../lib/eventSettings';
import type { EventData, EventType } from '../lib/storage';

type Props = {
  event: EventData;
  onSave: (values: EventSettingsDraft, warnings: string[]) => void;
  onDelete: (id: string) => void;
};

const EVENT_TYPES: EventType[] = ['Wedding', 'Birthday', 'Community event', 'Other celebration'];

/**
 * Edits are held in a draft and validated together on Save, so half-typed values (an empty name, a
 * partly typed budget) are never persisted. The parent remounts this form (via `key`) when the event
 * changes or is saved, which resets the draft from the saved event.
 */
export function SettingsPage({ event, onSave, onDelete }: Props) {
  const [draft, setDraft] = useState<EventSettingsDraft>(() => settingsDraftFromEvent(event));
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const set = <K extends keyof EventSettingsDraft>(field: K, value: EventSettingsDraft[K]) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };
  const numeric = (value: string) => (value === '' ? Number.NaN : Number(value));

  const isDirty = JSON.stringify(draft) !== JSON.stringify(settingsDraftFromEvent(event));

  const handleSubmit = (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    const result = validateEventSettings(draft, event);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors([]);
    onSave(result.values, result.warnings);
  };

  return (
    <section className="panel-card workspace-card settings-panel" aria-labelledby="settings-heading">
      <div className="section-header compact">
        <h3 id="settings-heading">Event settings</h3>
      </div>
      <form onSubmit={handleSubmit} noValidate>
        <div className="form-grid">
          <label><span>Event name</span><input maxLength={120} value={draft.eventName} onChange={(e) => set('eventName', e.target.value)} /></label>
          <label><span>Event type</span>
            <select value={draft.eventType} onChange={(e) => set('eventType', e.target.value as EventType)}>
              {EVENT_TYPES.map((type) => <option key={type}>{type}</option>)}
            </select>
          </label>
          <label><span>Event date</span><input type="date" value={draft.eventDate} onChange={(e) => set('eventDate', e.target.value)} /></label>
          <label><span>Location</span><input maxLength={100} value={draft.city} onChange={(e) => set('city', e.target.value)} /></label>
          <label><span>Guest count</span><input type="number" min={1} max={20000} step={1} value={Number.isNaN(draft.guestCount) ? '' : draft.guestCount} onChange={(e) => set('guestCount', numeric(e.target.value))} /></label>
          <label><span>Budget (INR)</span><input type="number" min={0} step={1} value={Number.isNaN(draft.totalBudget) ? '' : draft.totalBudget} onChange={(e) => set('totalBudget', numeric(e.target.value))} /></label>
          <label><span>Start time</span><input type="time" value={draft.eventStartTime} onChange={(e) => set('eventStartTime', e.target.value)} /></label>
          <label><span>Duration in minutes {event.durationIsSuggested ? '(suggested)' : ''}</span><input type="number" min={30} max={1440} step={1} value={Number.isNaN(draft.eventDurationMinutes) ? '' : draft.eventDurationMinutes} onChange={(e) => set('eventDurationMinutes', numeric(e.target.value))} /></label>
        </div>

        {errors.length ? (
          <div className="error-box" role="alert">
            <AlertCircle size={16} aria-hidden="true" />
            <ul>{errors.map((message) => <li key={message}>{message}</li>)}</ul>
          </div>
        ) : null}

        <div className="form-actions">
          <button type="submit" className="primary-btn" disabled={!isDirty}><Check size={15} aria-hidden="true" /> Save changes</button>
          <button type="button" className="ghost-btn" disabled={!isDirty} onClick={() => { setDraft(settingsDraftFromEvent(event)); setErrors([]); }}>Discard changes</button>
        </div>
      </form>

      <div className="danger-zone">
        <div>
          <h4>Delete this event</h4>
          <p className="muted">Removes this event and its budget, timeline, vendors and tasks from this browser. This cannot be undone.</p>
        </div>
        <button type="button" className="ghost-btn danger" onClick={() => setConfirmingDelete(true)}><Trash2 size={15} aria-hidden="true" /> Delete event</button>
      </div>

      {confirmingDelete ? (
        <ConfirmDialog
          title={`Delete “${event.eventName}”?`}
          description={`This permanently removes the event with ${event.plan.tasks.length} task${event.plan.tasks.length === 1 ? '' : 's'}, ${event.plan.itemizedCosts.length} budget item${event.plan.itemizedCosts.length === 1 ? '' : 's'} and ${event.plan.vendors.length} vendor${event.plan.vendors.length === 1 ? '' : 's'}. It cannot be undone.`}
          confirmLabel="Delete event"
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => { setConfirmingDelete(false); onDelete(event.id); }}
        />
      ) : null}
    </section>
  );
}

export default SettingsPage;
