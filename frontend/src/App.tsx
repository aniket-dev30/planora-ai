import { Suspense, lazy, useCallback, useMemo, useRef, useState } from 'react';
import { AlertCircle, CalendarDays, Check, CirclePlus, CreditCard, NotebookPen, Plus, Trash2, Users } from 'lucide-react';
import { GenerationStatus } from './components/GenerationStatus';
import { Header } from './components/Header';
import type { HeaderNotification } from './components/Header';
import { Sidebar } from './components/Sidebar';
import type { NavKey } from './components/Sidebar';
import { DashboardPage } from './pages/DashboardPage';
import { SettingsPage } from './pages/SettingsPage';
import { formatCurrency, formatDateKey } from './lib/format';
import { mergeGeneratedPlan } from './lib/planMerge';
import { useGeneration } from './lib/useGeneration';
import type { EventSettingsDraft } from './lib/eventSettings';
import { loadEvents, saveEvents } from './lib/storage';
import type { EventData, EventPlan, EventType, ExpenseItem, TaskItem, TaskPriority, TaskStatus, TimelineEntry, VendorItem, VendorStatus } from './lib/storage';
import { deriveBudgetAllocation, summarizeBudget, validateBudgetAmount } from '../../shared/budget.mjs';
import { minutesToTime, timeToMinutes, validateTimeline } from '../../shared/timeline.mjs';
import { addDaysToDateKey, getTodayDateKey, isTaskAfterEvent, isTaskOverdue } from '../../shared/taskDates.mjs';
import type { ApiPlanResponse } from './types/api';

const PlannerPage = lazy(() => import('./pages/PlannerPage'));

const defaultEventDate = () => addDaysToDateKey(getTodayDateKey(), 45);

const CORE_FORM_DEFAULTS = {
  eventName: '',
  eventType: 'Wedding' as EventType,
  eventDate: defaultEventDate(),
  eventStartTime: '18:00',
  eventDurationMinutes: 240,
  durationIsSuggested: true,
  city: '',
  guestCount: 80,
  totalBudget: 500000,
  style: '',
  venuePreference: '',
  dietaryPreferences: 'Vegetarian-friendly and inclusive options',
  culturalPreferences: '',
  additionalRequirements: '',
  priorities: ['Premium decor', 'Food quality'],
};

function App() {
  const [initialEvents] = useState(() => loadEvents());
  const [events, setEvents] = useState<EventData[]>(initialEvents);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(initialEvents[0]?.id ?? null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [activeNav, setActiveNav] = useState<NavKey>('overview');
  const [searchTerm, setSearchTerm] = useState('');
  const [form, setForm] = useState(CORE_FORM_DEFAULTS);
  const [validationError, setValidationError] = useState('');
  const [workspaceError, setWorkspaceError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [persistenceError, setPersistenceError] = useState('');
  const { isLoading: isLoadingPlan, progress: createProgress, startedAt: createStartedAt, run: runGeneration, cancel: cancelGeneration } = useGeneration();

  // The ref always holds the latest list. Updaters read from it (not from a render's captured `events`),
  // so a change finishing after a long await can never overwrite edits made while it was pending.
  const eventsRef = useRef<EventData[]>(initialEvents);
  const commitEvents = useCallback((update: EventData[] | ((previous: EventData[]) => EventData[])) => {
    const next = typeof update === 'function' ? update(eventsRef.current) : update;
    eventsRef.current = next;
    setEvents(next);
    try {
      saveEvents(next);
      setPersistenceError('');
    } catch (error) {
      setPersistenceError(error instanceof Error ? error.message : 'Unable to save event changes.');
    }
  }, []);

  const selectedEvent = useMemo(() => events.find((event) => event.id === selectedEventId) ?? null, [events, selectedEventId]);
  const budgetSummary = selectedEvent ? summarizeBudget(selectedEvent.plan.itemizedCosts, selectedEvent.totalBudget) : summarizeBudget([], 0);
  const eventBudgetTotal = budgetSummary.allocated;
  const remainingBudget = budgetSummary.unallocated;
  const todayDateKey = getTodayDateKey();
  const filteredEvents = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    if (!query) return events;
    return events.filter((event) => [
      event.eventName,
      event.eventType,
      event.city,
      event.plan.overview,
      ...event.plan.tasks.flatMap((task) => [task.title, task.description]),
      ...event.plan.vendors.flatMap((vendor) => [vendor.name, vendor.category, vendor.notes]),
      ...event.plan.itemizedCosts.flatMap((item) => [item.category, item.label, item.notes]),
      ...event.plan.timeline.flatMap((item) => [item.title, item.notes]),
    ].some((value) => value.toLowerCase().includes(query)));
  }, [events, searchTerm]);
  const notifications = useMemo<HeaderNotification[]>(() => {
    const deadlineDate = addDaysToDateKey(getTodayDateKey(), 7);
    return events.flatMap((event) => event.plan.tasks
      .filter((task) => task.status !== 'done' && task.dueDate <= deadlineDate)
      .map((task) => ({ id: `${event.id}-${task.id}`, label: task.title, eventName: event.eventName, eventId: event.id })))
      .slice(0, 5);
  }, [events]);

  const createEvent = () => {
    setForm({ ...CORE_FORM_DEFAULTS, priorities: [...CORE_FORM_DEFAULTS.priorities] });
    setValidationError('');
    setSuccessMessage('');
    setIsCreateOpen(true);
  };

  const closeCreate = () => {
    setIsCreateOpen(false);
    setValidationError('');
  };

  const handleFormField = (field: keyof typeof CORE_FORM_DEFAULTS, value: string | number | string[]) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const handleCreateEvent = async () => {
    const fields = {
      eventName: form.eventName.trim(),
      eventType: form.eventType,
      eventDate: form.eventDate,
      eventStartTime: form.eventStartTime,
      eventDurationMinutes: Number(form.eventDurationMinutes),
      durationIsSuggested: form.durationIsSuggested,
      city: form.city.trim(),
      guestCount: Number(form.guestCount),
      totalBudget: Number(form.totalBudget),
      style: form.style.trim(),
      venuePreference: form.venuePreference.trim(),
      dietaryPreferences: form.dietaryPreferences.trim(),
      culturalPreferences: form.culturalPreferences.trim(),
      additionalRequirements: form.additionalRequirements.trim(),
      priorities: form.priorities,
    };

    if (!fields.eventName || !fields.city || !fields.style || !fields.venuePreference) {
      setValidationError('Please complete all required fields before saving the event.');
      return;
    }
    const dateParts = fields.eventDate.split('-').map(Number);
    const parsedEventDate = dateParts.length === 3 ? new Date(dateParts[0], dateParts[1] - 1, dateParts[2]) : new Date(Number.NaN);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.eventDate) || Number.isNaN(parsedEventDate.getTime()) || parsedEventDate.getFullYear() !== dateParts[0] || parsedEventDate.getMonth() !== dateParts[1] - 1 || parsedEventDate.getDate() !== dateParts[2]) {
      setValidationError('Please provide a valid event date.');
      return;
    }
    if (!Number.isInteger(fields.guestCount) || fields.guestCount < 1 || fields.guestCount > 20000) {
      setValidationError('Guest count must be between 1 and 20,000.');
      return;
    }
    if (fields.totalBudget < 0 || !Number.isFinite(fields.totalBudget)) {
      setValidationError('Budget must be a non-negative value.');
      return;
    }
    if (!Number.isInteger(fields.eventDurationMinutes) || fields.eventDurationMinutes < 30 || fields.eventDurationMinutes > 1440) {
      setValidationError('Event duration must be between 30 and 1,440 minutes.');
      return;
    }

    if (fields.eventDate < getTodayDateKey()) {
      setValidationError('The event date is in the past. Choose today or a later date so task deadlines can be planned.');
      return;
    }

    setValidationError('');
    const outcome = await runGeneration({ ...fields, requestedAction: 'Create a well-balanced first event plan.' });
    if (!outcome) return; // A generation is already running; ignore the duplicate submit.
    if (outcome.status === 'cancelled') {
      setValidationError('Generation cancelled. Your details are still here and nothing was created.');
      return;
    }
    if (outcome.status === 'error') {
      setValidationError(outcome.message);
      return;
    }

    const plan = outcome.result.data;
    const timestamp = new Date().toISOString();
    const newEvent: EventData = {
      id: crypto.randomUUID(),
      ...fields,
      eventStartTime: plan.eventStartTime,
      eventDurationMinutes: plan.eventDurationMinutes,
      durationIsSuggested: plan.durationIsSuggested,
      createdAt: timestamp,
      updatedAt: timestamp,
      plan: mergeGeneratedPlan({} as EventPlan, plan, null),
    };

    // Functional update: generation can take minutes, and the list may have changed since the click.
    commitEvents((previous) => [newEvent, ...previous]);
    setSelectedEventId(newEvent.id);
    setIsCreateOpen(false);
    setActiveNav('overview');
    setSearchTerm('');
    setSuccessMessage(`${newEvent.eventName} was created with a ${plan.mode === 'demo' ? 'Demo Mode' : 'Gemini'} plan.`);
  };

  const updateEvent = (patch: Partial<EventData>) => {
    if (!selectedEventId) return;
    commitEvents((previous) => previous.map((event) => {
      if (event.id !== selectedEventId) return event;
      const plan = patch.plan ?? event.plan;
      return {
        ...event,
        ...patch,
        // Category totals are derived from the line items, so they can never go stale after an edit.
        plan: patch.plan ? { ...plan, budgetAllocation: deriveBudgetAllocation(plan.itemizedCosts) } : plan,
        updatedAt: new Date().toISOString(),
      };
    }));
  };

  const deleteEvent = (id: string) => {
    const remaining = eventsRef.current.filter((event) => event.id !== id);
    commitEvents(remaining);
    setSelectedEventId(remaining[0]?.id ?? null);
    setActiveNav('overview');
    setSuccessMessage('Event deleted.');
  };

  const applyGeneratedPlan = (plan: ApiPlanResponse['data'], updatedFields: string[] | null) => {
    if (!selectedEvent) return;
    updateEvent({ plan: mergeGeneratedPlan(selectedEvent.plan, plan, updatedFields) });
    setSuccessMessage(`The ${plan.mode === 'demo' ? 'Demo Mode' : 'Gemini'} ${updatedFields?.length ? 'update' : 'plan'} was applied and saved. You can edit its sections from the sidebar.`);
  };

  const saveSettings = (values: EventSettingsDraft, warnings: string[]) => {
    if (!selectedEvent) return;
    const durationChanged = values.eventDurationMinutes !== selectedEvent.eventDurationMinutes;
    const durationIsSuggested = durationChanged ? false : selectedEvent.durationIsSuggested;
    updateEvent({
      ...values,
      durationIsSuggested,
      plan: {
        ...selectedEvent.plan,
        eventStartTime: values.eventStartTime,
        eventDurationMinutes: values.eventDurationMinutes,
        durationIsSuggested,
      },
    });
    setWorkspaceError('');
    setSuccessMessage(['Event settings saved.', ...warnings].join(' '));
  };

  const updateBudgetItem = (itemId: string, patch: Partial<ExpenseItem>) => {
    if (!selectedEvent) return;
    try {
      if (patch.amount !== undefined) validateBudgetAmount(patch.amount);
      const itemizedCosts = selectedEvent.plan.itemizedCosts.map((item) => item.id === itemId ? { ...item, ...patch } : item);
      summarizeBudget(itemizedCosts, selectedEvent.totalBudget);
      updateEvent({ plan: { ...selectedEvent.plan, itemizedCosts } });
      setWorkspaceError('');
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : 'Invalid budget amount.');
    }
  };

  const addBudgetItem = () => {
    if (!selectedEvent) return;
    const newItem: ExpenseItem = { id: crypto.randomUUID(), category: 'New', label: 'New expense', amount: 0, kind: 'expense', notes: '' };
    updateEvent({ plan: { ...selectedEvent.plan, itemizedCosts: [...selectedEvent.plan.itemizedCosts, newItem] } });
  };

  const removeBudgetItem = (itemId: string) => {
    if (!selectedEvent) return;
    updateEvent({ plan: { ...selectedEvent.plan, itemizedCosts: selectedEvent.plan.itemizedCosts.filter((item) => item.id !== itemId) } });
  };

  const updateTimelineItem = (itemId: string, patch: Partial<TimelineEntry>) => {
    if (!selectedEvent) return;
    try {
      const timeline = selectedEvent.plan.timeline.map((item) => item.id === itemId ? { ...item, ...patch } : item);
      const validatedTimeline = validateTimeline(timeline, selectedEvent.eventStartTime, selectedEvent.eventDurationMinutes);
      updateEvent({ plan: { ...selectedEvent.plan, timeline: validatedTimeline } });
      setWorkspaceError('');
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : 'Timeline edit violates the event schedule.');
    }
  };

  const addTimelineItem = () => {
    if (!selectedEvent) return;
    const eventStart = timeToMinutes(selectedEvent.eventStartTime);
    for (let slot = eventStart; slot + 5 <= eventStart + selectedEvent.eventDurationMinutes; slot += 5) {
      const next: TimelineEntry = { id: crypto.randomUUID(), title: 'New activity', startTime: minutesToTime(slot), durationMinutes: 5, notes: '' };
      try {
        const timeline = validateTimeline([...selectedEvent.plan.timeline, next], selectedEvent.eventStartTime, selectedEvent.eventDurationMinutes);
        updateEvent({ plan: { ...selectedEvent.plan, timeline } });
        setWorkspaceError('');
        return;
      } catch {
        continue;
      }
    }
    setWorkspaceError('There is no free five-minute slot in this event window. Adjust the schedule or event duration before adding an activity.');
  };

  const removeTimelineItem = (itemId: string) => {
    if (!selectedEvent) return;
    updateEvent({ plan: { ...selectedEvent.plan, timeline: selectedEvent.plan.timeline.filter((item) => item.id !== itemId) } });
  };

  const updateVendor = (itemId: string, patch: Partial<VendorItem>) => {
    if (!selectedEvent) return;
    const vendors = selectedEvent.plan.vendors.map((item) => item.id === itemId ? { ...item, ...patch } : item);
    updateEvent({ plan: { ...selectedEvent.plan, vendors } });
  };

  const addVendor = () => {
    if (!selectedEvent) return;
    const next: VendorItem = { id: crypto.randomUUID(), category: 'General', name: 'New vendor', status: 'researching', estimatedCost: 0, notes: '' };
    updateEvent({ plan: { ...selectedEvent.plan, vendors: [...selectedEvent.plan.vendors, next] } });
  };

  const removeVendor = (itemId: string) => {
    if (!selectedEvent) return;
    updateEvent({ plan: { ...selectedEvent.plan, vendors: selectedEvent.plan.vendors.filter((item) => item.id !== itemId) } });
  };

  const updateTask = (itemId: string, patch: Partial<TaskItem>) => {
    if (!selectedEvent) return;
    const tasks = selectedEvent.plan.tasks.map((item) => item.id === itemId ? { ...item, ...patch } : item);
    updateEvent({ plan: { ...selectedEvent.plan, tasks } });
  };

  const addTask = () => {
    if (!selectedEvent) return;
    const next: TaskItem = { id: crypto.randomUUID(), title: 'New task', priority: 'Medium', dueDate: selectedEvent.eventDate, status: 'todo', source: 'manual', description: '' };
    updateEvent({ plan: { ...selectedEvent.plan, tasks: [...selectedEvent.plan.tasks, next] } });
  };

  const removeTask = (itemId: string) => {
    if (!selectedEvent) return;
    updateEvent({ plan: { ...selectedEvent.plan, tasks: selectedEvent.plan.tasks.filter((item) => item.id !== itemId) } });
  };

  const openEvent = (id: string) => {
    setSelectedEventId(id);
    setActiveNav('overview');
    setIsCreateOpen(false);
    setSearchTerm('');
  };

  const openSearch = (value: string) => {
    setSearchTerm(value);
    if (value.trim()) setActiveNav('events');
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <Sidebar active={activeNav} onNavigate={setActiveNav} />
      <main className="main-area" id="main-content" tabIndex={-1}>
        <Header
          onCreateEvent={createEvent}
          searchTerm={searchTerm}
          onSearchChange={openSearch}
          notifications={notifications}
          onOpenNotification={(eventId) => {
            setSelectedEventId(eventId);
            setActiveNav('vendors');
          }}
        />
        {successMessage ? <div className="notice-box" role="status">{successMessage}<button type="button" className="ghost-text" onClick={() => setSuccessMessage('')}>Dismiss</button></div> : null}
        {persistenceError ? <div className="error-box" role="alert">Unable to persist event data: {persistenceError}</div> : null}

        {isCreateOpen ? (
          <section className="panel-card form-panel">
            <div className="section-header compact">
              <h3>New event</h3>
              <button type="button" className="ghost-text" onClick={closeCreate} disabled={isLoadingPlan}>Close</button>
            </div>
            <form onSubmit={(event) => { event.preventDefault(); void handleCreateEvent(); }}>
              <fieldset className="form-fieldset" disabled={isLoadingPlan}>
              <div className="form-grid">
                <label><span>Event name</span><input required minLength={2} maxLength={120} value={form.eventName} onChange={(e) => handleFormField('eventName', e.target.value)} /></label>
                <label><span>Event type</span><select value={form.eventType} onChange={(e) => handleFormField('eventType', e.target.value as EventType)}><option>Wedding</option><option>Birthday</option><option>Community event</option><option>Other celebration</option></select></label>
                <label><span>Event date</span><input required type="date" value={form.eventDate} onChange={(e) => handleFormField('eventDate', e.target.value)} /></label>
                <label><span>Event start time</span><input required type="time" value={form.eventStartTime} onChange={(e) => handleFormField('eventStartTime', e.target.value)} /></label>
                <label><span>Duration in minutes {form.durationIsSuggested ? '(suggested)' : ''}</span><input required type="number" min={30} max={1440} step={1} value={form.eventDurationMinutes} onChange={(e) => setForm((current) => ({ ...current, eventDurationMinutes: Number(e.target.value), durationIsSuggested: false }))} /></label>
                <label><span>City</span><input required minLength={2} maxLength={100} value={form.city} onChange={(e) => handleFormField('city', e.target.value)} /></label>
                <label><span>Guest count</span><input required type="number" min={1} max={20000} step={1} value={form.guestCount} onChange={(e) => handleFormField('guestCount', Number(e.target.value))} /></label>
                <label><span>Total budget (INR)</span><input required type="number" min={0} step={1} value={form.totalBudget} onChange={(e) => handleFormField('totalBudget', Number(e.target.value))} /></label>
                <label><span>Preferred style</span><input required minLength={2} maxLength={120} value={form.style} onChange={(e) => handleFormField('style', e.target.value)} /></label>
                <label><span>Venue preference</span><input required minLength={2} maxLength={120} value={form.venuePreference} onChange={(e) => handleFormField('venuePreference', e.target.value)} /></label>
                <label className="full-span"><span>Dietary preferences</span><input value={form.dietaryPreferences} onChange={(e) => handleFormField('dietaryPreferences', e.target.value)} /></label>
                <label className="full-span"><span>Cultural preferences</span><input value={form.culturalPreferences} onChange={(e) => handleFormField('culturalPreferences', e.target.value)} /></label>
                <label className="full-span"><span>Additional requirements</span><textarea rows={3} value={form.additionalRequirements} onChange={(e) => handleFormField('additionalRequirements', e.target.value)} /></label>
              </div>

              <div className="chip-row small-gap" role="group" aria-label="Planning priorities">
                {['Premium decor', 'Food quality', 'Sustainability', 'Saving money'].map((priority) => (
                  <button key={priority} type="button" aria-pressed={form.priorities.includes(priority)} className={`chip ${form.priorities.includes(priority) ? 'selected' : ''}`} onClick={() => {
                    const next = form.priorities.includes(priority)
                      ? form.priorities.filter((item) => item !== priority)
                      : [...form.priorities, priority];
                    handleFormField('priorities', next);
                  }}>
                    {priority}
                  </button>
                ))}
              </div>

              </fieldset>

              {validationError ? <div className="error-box" role="alert"><AlertCircle size={16} aria-hidden="true" /> {validationError}</div> : null}
              {isLoadingPlan ? <GenerationStatus message={createProgress} startedAt={createStartedAt} onCancel={cancelGeneration} /> : null}
              <div className="form-actions">
                <button type="button" className="ghost-btn" onClick={closeCreate} disabled={isLoadingPlan}>Cancel</button>
                <button type="submit" className="primary-btn" disabled={isLoadingPlan}>{isLoadingPlan ? 'Generating…' : 'Create event'}</button>
              </div>
            </form>
          </section>
        ) : null}

        {!isCreateOpen && activeNav === 'overview' ? (
          <>
            <DashboardPage events={events} onCreateEvent={createEvent} onOpenEvent={openEvent} />
            {selectedEvent ? (
              <section className="workspace-panel panel-card">
                <div className="section-header compact">
                  <h3>{selectedEvent.eventName}</h3>
                  <div className="small-badges"><span className="badge">{selectedEvent.eventType}</span><span className="badge">{selectedEvent.city}</span><span className="badge">{selectedEvent.plan.mode === 'demo' ? 'Demo plan' : 'Gemini plan'}</span></div>
                </div>
                <div className="workspace-grid">
                  <div className="mini-stat-panel"><CalendarDays size={18} /><div><small>Event date</small><strong>{formatDateKey(selectedEvent.eventDate)}</strong></div></div>
                  <div className="mini-stat-panel"><CalendarDays size={18} /><div><small>Schedule window {selectedEvent.durationIsSuggested ? '(suggested)' : ''}</small><strong>{selectedEvent.eventStartTime}–{minutesToTime(Number(selectedEvent.eventStartTime.slice(0, 2)) * 60 + Number(selectedEvent.eventStartTime.slice(3)) + selectedEvent.eventDurationMinutes)}</strong></div></div>
                  <div className="mini-stat-panel"><Users size={18} /><div><small>Guests</small><strong>{selectedEvent.guestCount}</strong></div></div>
                  <div className="mini-stat-panel"><CreditCard size={18} /><div><small>Total budget</small><strong>{formatCurrency(selectedEvent.totalBudget)}</strong></div></div>
                  <div className="mini-stat-panel"><Check size={18} /><div><small>Budget left</small><strong>{formatCurrency(remainingBudget)}</strong></div></div>
                </div>
                <div className="workspace-quickview">
                  <div>
                    <h4>Overview</h4>
                    <textarea aria-label="Plan overview" rows={4} value={selectedEvent.plan.overview} onChange={(event) => updateEvent({ plan: { ...selectedEvent.plan, overview: event.target.value } })} />
                  </div>
                  <div>
                    <h4>Theme</h4>
                    <input aria-label="Event theme" value={selectedEvent.plan.theme} onChange={(event) => updateEvent({ plan: { ...selectedEvent.plan, theme: event.target.value } })} />
                  </div>
                </div>
                {selectedEvent.plan.mode === 'demo' ? <p className="muted">Demo Mode planning estimates are illustrative. Vendor prices and availability are not verified.</p> : null}
              </section>
            ) : null}
          </>
        ) : null}

        {!isCreateOpen && activeNav === 'events' ? (
          <section className="panel-card workspace-card">
            <div className="section-header compact">
              <div><h3>My Events</h3><p className="muted">{filteredEvents.length} of {events.length} saved events</p></div>
              <button type="button" className="primary-btn small" onClick={createEvent}><Plus size={14} /> Plan an event</button>
            </div>
            {filteredEvents.length ? (
              <div className="event-list">
                {filteredEvents.map((event) => (
                  <button key={event.id} type="button" className="event-row" onClick={() => openEvent(event.id)}>
                    <div><strong>{event.eventName}</strong><span>{event.eventType} · {event.city} · {event.guestCount} guests</span></div>
                    <div className="event-meta"><span>{formatDateKey(event.eventDate)}</span><span className="badge">{event.plan.mode === 'demo' ? 'Demo' : 'Gemini'}</span></div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty-card"><p>{searchTerm ? `No events or planning notes match “${searchTerm}”.` : 'No saved events yet. Create an event to start planning.'}</p></div>
            )}
          </section>
        ) : null}

        <div hidden={isCreateOpen || activeNav !== 'planner'}>
          <Suspense fallback={<section className="panel-card empty-state-block" role="status">Loading AI planner…</section>}>
            <PlannerPage event={selectedEvent} onApplyPlan={applyGeneratedPlan} />
          </Suspense>
        </div>

        {!isCreateOpen && activeNav === 'budget' && selectedEvent ? (
          <section className="panel-card workspace-card">
            <div className="section-header compact">
              <div><h3>Budget</h3>{selectedEvent.plan.mode === 'demo' ? <p className="muted">Planning estimates only; confirm all supplier prices.</p> : null}</div>
              <button type="button" className="primary-btn small" onClick={addBudgetItem}><CirclePlus size={14} /> Add item</button>
            </div>
            <div className="budget-list">
              {selectedEvent.plan.itemizedCosts.map((item) => (
                <div key={item.id} className="editable-row">
                  <input aria-label="Budget category" value={item.category} onChange={(e) => updateBudgetItem(item.id, { category: e.target.value })} />
                  <input aria-label="Budget item" value={item.label} onChange={(e) => updateBudgetItem(item.id, { label: e.target.value })} />
                  <select aria-label="Budget item type" value={item.kind} onChange={(e) => updateBudgetItem(item.id, { kind: e.target.value as ExpenseItem['kind'] })}>
                    <option value="expense">Planned expense</option>
                    <option value="contingency">Contingency allocation</option>
                    <option value="reserve">Flexible reserve</option>
                  </select>
                  <input aria-label="Budget amount in INR" type="number" min={0} step={1} value={item.amount} onChange={(e) => updateBudgetItem(item.id, { amount: Number(e.target.value) })} />
                  <input aria-label="Budget notes" value={item.notes} onChange={(e) => updateBudgetItem(item.id, { notes: e.target.value })} />
                  <button type="button" className="icon-btn danger" aria-label={`Delete budget item ${item.label}`} onClick={() => removeBudgetItem(item.id)}><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
            {workspaceError ? <div className="error-box" role="alert">{workspaceError}</div> : null}
            {remainingBudget < 0 ? (
              <div className="error-box" role="alert">
                Planned amounts are {formatCurrency(-remainingBudget)} over your {formatCurrency(selectedEvent.totalBudget)} budget. Reduce an item or raise the budget in Settings.
              </div>
            ) : null}
            <div className="budget-summary-grid">
              <div><small>Planned spending</small><strong>{formatCurrency(budgetSummary.expenses)}</strong></div>
              <div><small>Contingency allocated</small><strong>{formatCurrency(budgetSummary.contingency)}</strong></div>
              <div><small>Flexible reserve allocated</small><strong>{formatCurrency(budgetSummary.reserve)}</strong></div>
              <div><small>Total planned / allocated</small><strong>{formatCurrency(eventBudgetTotal)}</strong></div>
              <div><small>Unallocated budget remaining</small><strong>{formatCurrency(remainingBudget)}</strong></div>
            </div>
            <p className="muted">Allocated contingency and flexible reserves are included exactly once in total planned. Unallocated budget is the limit minus all listed allocations. Actual paid expenses are not tracked separately yet.</p>
          </section>
        ) : null}

        {!isCreateOpen && activeNav === 'timeline' && selectedEvent ? (
          <section className="panel-card workspace-card">
            <div className="section-header compact">
              <h3>Timeline</h3>
              <button type="button" className="primary-btn small" onClick={addTimelineItem}><CirclePlus size={14} /> Add slot</button>
            </div>
            <div className="timeline-list">
              <p className="muted">Schedule window: {selectedEvent.eventStartTime}–{minutesToTime(Number(selectedEvent.eventStartTime.slice(0, 2)) * 60 + Number(selectedEvent.eventStartTime.slice(3)) + selectedEvent.eventDurationMinutes)}. Activities must be positive, chronological, non-overlapping, and fit this window.</p>
              {workspaceError ? <div className="error-box" role="alert">{workspaceError}</div> : null}
              {selectedEvent.plan.timeline.map((item) => (
                <div key={item.id} className="editable-row timeline-row">
                  <input aria-label="Timeline activity" value={item.title} onChange={(e) => updateTimelineItem(item.id, { title: e.target.value })} />
                  <input aria-label="Start time" type="time" value={item.startTime} onChange={(e) => updateTimelineItem(item.id, { startTime: e.target.value })} />
                  <input aria-label="Duration in minutes" type="number" min={1} value={item.durationMinutes} onChange={(e) => updateTimelineItem(item.id, { durationMinutes: Math.max(1, Number(e.target.value) || 1) })} />
                  <textarea aria-label="Timeline notes" value={item.notes} onChange={(e) => updateTimelineItem(item.id, { notes: e.target.value })} />
                  <button type="button" className="icon-btn danger" aria-label={`Delete timeline activity ${item.title}`} onClick={() => removeTimelineItem(item.id)}><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {!isCreateOpen && activeNav === 'vendors' && selectedEvent ? (
          <section className="panel-card workspace-card">
            <div className="section-header compact">
              <h3>Vendors & Tasks</h3>
              <div className="button-stack">
                <button type="button" className="primary-btn small" onClick={addVendor}><CirclePlus size={14} /> Vendor</button>
                <button type="button" className="primary-btn small" onClick={addTask}><CirclePlus size={14} /> Task</button>
              </div>
            </div>
            <div className="subsection-stack">
              <div>
                <h4>Vendors</h4>
                {selectedEvent.plan.vendors.map((vendor) => (
                  <div key={vendor.id} className="editable-row vendor-row">
                    <input aria-label="Vendor category" value={vendor.category} onChange={(e) => updateVendor(vendor.id, { category: e.target.value })} />
                    <input aria-label="Vendor name" value={vendor.name} onChange={(e) => updateVendor(vendor.id, { name: e.target.value })} />
                    <select aria-label="Vendor status" value={vendor.status} onChange={(e) => updateVendor(vendor.id, { status: e.target.value as VendorStatus })}>
                      <option value="researching">Researching</option>
                      <option value="contacted">Contacted</option>
                      <option value="quoted">Quoted</option>
                      <option value="booked">Booked</option>
                      <option value="not needed">Not needed</option>
                    </select>
                    <input aria-label="Vendor estimated cost in INR" type="number" min={0} value={vendor.estimatedCost} onChange={(e) => updateVendor(vendor.id, { estimatedCost: Math.max(0, Number(e.target.value) || 0) })} />
                    <textarea aria-label="Vendor notes (prices unverified)" value={vendor.notes} onChange={(e) => updateVendor(vendor.id, { notes: e.target.value })} />
                    <button type="button" className="icon-btn danger" aria-label={`Delete vendor ${vendor.name}`} onClick={() => removeVendor(vendor.id)}><Trash2 size={14} /></button>
                  </div>
                ))}
                <p className="muted">Any vendor costs shown are estimates only and are not verified quotes.</p>
              </div>
              <div>
                <h4>Tasks</h4>
                {selectedEvent.plan.tasks.map((task) => (
                  <div key={task.id} className="editable-row task-row">
                    <input aria-label="Task title" value={task.title} onChange={(e) => updateTask(task.id, { title: e.target.value })} />
                    <select aria-label="Task priority" value={task.priority} onChange={(e) => updateTask(task.id, { priority: e.target.value as TaskPriority })}>
                      <option value="Low">Low</option>
                      <option value="Medium">Medium</option>
                      <option value="High">High</option>
                    </select>
                    <input aria-label="Task due date" type="date" value={task.dueDate} onChange={(e) => updateTask(task.id, { dueDate: e.target.value })} />
                    {isTaskOverdue(task.dueDate, task.status, todayDateKey) ? <span className="badge">Overdue</span> : null}
                    {isTaskAfterEvent(task.dueDate, selectedEvent.eventDate) ? <span className="badge">After event date</span> : null}
                    <select aria-label="Task status" value={task.status} onChange={(e) => updateTask(task.id, { status: e.target.value as TaskStatus })}>
                      <option value="todo">To do</option>
                      <option value="in progress">In progress</option>
                      <option value="done">Done</option>
                    </select>
                    <textarea aria-label="Task description" value={task.description} onChange={(e) => updateTask(task.id, { description: e.target.value })} />
                    <button type="button" className="icon-btn danger" aria-label={`Delete task ${task.title}`} onClick={() => removeTask(task.id)}><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
            </div>
          </section>
        ) : null}

        {!isCreateOpen && activeNav === 'settings' && selectedEvent ? (
          <SettingsPage key={`${selectedEvent.id}-${selectedEvent.updatedAt}`} event={selectedEvent} onSave={saveSettings} onDelete={deleteEvent} />
        ) : null}

        {!selectedEvent && !isCreateOpen && activeNav !== 'overview' && activeNav !== 'events' && activeNav !== 'planner' && (
          <section className="panel-card empty-state-block">
            <NotebookPen size={24} />
            <h3>No event selected</h3>
            <p>Create an event to start managing its budget, timeline, vendors, and tasks.</p>
            <button type="button" className="primary-btn" onClick={createEvent}><Plus size={16} /> Create an event</button>
          </section>
        )}
      </main>
    </div>
  );
}

export default App;
