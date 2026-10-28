import { Suspense, lazy } from 'react';
import { ArrowRight, CalendarDays, CheckCircle2, CircleDollarSign, Sparkles, TrendingUp, WalletCards } from 'lucide-react';
import type { EventData } from '../lib/storage';
import { formatCurrency, formatDateKey } from '../lib/format';
import { getTodayDateKey, isTaskOverdue } from '../../../shared/taskDates.mjs';

const DashboardBudgetChart = lazy(() => import('../components/DashboardBudgetChart'));

const statusColor = (status: string) => {
  if (status === 'done') return '#2a7d50';
  if (status === 'in progress') return '#b36b2d';
  return '#5a4b90';
};

export function DashboardPage({ events, onCreateEvent, onOpenEvent }: { events: EventData[]; onCreateEvent: () => void; onOpenEvent: (id: string) => void }) {
  const totalBudget = events.reduce((sum, event) => sum + (event.totalBudget || 0), 0);
  const completedTasks = events.reduce((sum, event) => sum + event.plan.tasks.filter((task) => task.status === 'done').length, 0);
  const totalTasks = events.reduce((sum, event) => sum + event.plan.tasks.length, 0);
  const progress = totalTasks ? Math.round((completedTasks / totalTasks) * 100) : 0;

  const chartData = events.slice(0, 5).map((event) => ({
    id: event.id,
    name: event.eventName.length > 16 ? `${event.eventName.slice(0, 15)}…` : event.eventName,
    fullName: event.eventName,
    budget: event.totalBudget,
    planned: event.plan.itemizedCosts.reduce((sum, item) => sum + item.amount, 0),
  }));

  const todayDate = getTodayDateKey();
  const allUpcoming = [...events].filter((event) => event.eventDate >= todayDate).sort((a, b) => a.eventDate.localeCompare(b.eventDate));
  const upcoming = allUpcoming.slice(0, 3);
  // Pending work only, soonest deadline first (overdue tasks naturally sort to the top).
  const tasks = events
    .flatMap((event) => event.plan.tasks.map((task) => ({ ...task, eventName: event.eventName, eventId: event.id })))
    .filter((task) => task.status !== 'done')
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, 5);
  const chartSummary = chartData.length
    ? `Budget compared with planned costs. ${chartData.map((item) => `${item.fullName}: budget ${formatCurrency(item.budget)}, planned ${formatCurrency(item.planned)}`).join('; ')}.`
    : '';

  return (
    <div className="dashboard-page">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Welcome back</p>
          <h1>Plan your next perfect celebration.</h1>
          <p className="muted">Keep budgets, vendors, tasks, and event ideas aligned from the first sketch to the final send-off.</p>
          <button type="button" className="primary-btn large" onClick={onCreateEvent}>
            <Sparkles size={16} />
            Plan an event
          </button>
        </div>
        <div className="hero-side-card">
          <div className="mini-stat">
            <CalendarDays size={18} />
            <div>
              <p>Upcoming</p>
              <strong>{allUpcoming.length}</strong>
            </div>
          </div>
          <div className="mini-stat">
            <WalletCards size={18} />
            <div>
              <p>Budget</p>
              <strong>{formatCurrency(totalBudget)}</strong>
            </div>
          </div>
          <div className="mini-stat">
            <CheckCircle2 size={18} />
            <div>
              <p>Progress</p>
              <strong>{progress}%</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="stats-grid">
        <div className="panel-card stat-card">
          <div className="stat-head"><span>Events</span><CalendarDays size={16} /></div>
          <strong>{events.length}</strong>
          <p>{events.length ? 'Saved plans ready to review' : 'No saved events yet'}</p>
        </div>
        <div className="panel-card stat-card">
          <div className="stat-head"><span>Total budget</span><CircleDollarSign size={16} /></div>
          <strong>{formatCurrency(totalBudget)}</strong>
          <p>Across all saved events</p>
        </div>
        <div className="panel-card stat-card">
          <div className="stat-head"><span>Planning progress</span><TrendingUp size={16} /></div>
          <strong>{progress}%</strong>
          <p>{completedTasks} tasks completed</p>
        </div>
      </section>

      <section className="bottom-grid">
        <div className="panel-card wide-panel">
          <div className="section-header">
            <h3>Upcoming events</h3>
            {upcoming.length > 0 ? <button type="button" className="ghost-text" onClick={() => onOpenEvent(upcoming[0].id)}>View details</button> : null}
          </div>
          {upcoming.length ? (
            <div className="event-list">
              {upcoming.map((event) => (
                <button key={event.id} type="button" className="event-row" onClick={() => onOpenEvent(event.id)}>
                  <div>
                    <strong>{event.eventName}</strong>
                    <span>{event.eventType} • {event.city}</span>
                  </div>
                  <div className="event-meta">
                    <span>{formatDateKey(event.eventDate)}</span>
                    <ArrowRight size={18} />
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-card">
              <p>No events yet.</p>
              <button type="button" className="primary-btn small" onClick={onCreateEvent}>Create your first event</button>
            </div>
          )}
        </div>

        <div className="panel-card wide-panel budget-panel">
          <div className="section-header">
            <h3>Budget utilization</h3>
            {events.length > 5 ? <span className="muted">Showing the first 5 events</span> : null}
          </div>
          <div className="chart-wrap" role={chartData.length ? 'img' : undefined} aria-label={chartSummary || undefined}>
            {chartData.length ? (
              <Suspense fallback={<div className="chart-loading" role="status">Loading budget chart…</div>}>
                <DashboardBudgetChart data={chartData} />
              </Suspense>
            ) : <div className="chart-loading">No budget data yet. Create an event to see planned spending.</div>}
          </div>
        </div>
      </section>

      <section className="panel-card task-panel">
        <div className="section-header">
          <h3>Tasks to do next</h3>
        </div>
        {tasks.length ? (
          <div className="task-list">
            {tasks.map((task) => (
              <div key={`${task.eventId}-${task.id}`} className="task-item">
                <span className="status-pill" style={{ background: `${statusColor(task.status)}20`, color: statusColor(task.status) }}>{task.status}</span>
                <div>
                  <strong>{task.title}</strong>
                  <p>{task.eventName}</p>
                  {isTaskOverdue(task.dueDate, task.status, todayDate) ? <span className="badge">Overdue</span> : null}
                </div>
                <small>{formatDateKey(task.dueDate)}</small>
              </div>
            ))}
          </div>
        ) : <div className="empty-card"><p>{totalTasks ? 'Everything is done. Nice work!' : 'No planning tasks yet.'}</p></div>}
      </section>
    </div>
  );
}
