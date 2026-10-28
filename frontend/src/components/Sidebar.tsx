import { CalendarRange, CheckSquare, CircleDollarSign, Compass, LayoutDashboard, ListTodo, Settings, Sparkles } from 'lucide-react';

export type NavKey = 'overview' | 'events' | 'planner' | 'budget' | 'timeline' | 'vendors' | 'settings';

const items: Array<{ key: NavKey; label: string; icon: typeof LayoutDashboard }> = [
  { key: 'overview', label: 'Overview', icon: LayoutDashboard },
  { key: 'events', label: 'My Events', icon: CalendarRange },
  { key: 'planner', label: 'AI Planner', icon: Sparkles },
  { key: 'budget', label: 'Budget', icon: CircleDollarSign },
  { key: 'timeline', label: 'Timeline', icon: ListTodo },
  { key: 'vendors', label: 'Vendors & Tasks', icon: CheckSquare },
  { key: 'settings', label: 'Settings', icon: Settings },
];

export function Sidebar({ active, onNavigate }: { active: NavKey; onNavigate: (key: NavKey) => void }) {
  return (
    <aside className="sidebar">
      <div className="brand-block">
        <div className="brand-icon"><Compass size={18} aria-hidden="true" /></div>
        <div>
          <div className="brand-name">Planora AI</div>
          <div className="brand-subtitle">From Idea to Perfect Event</div>
        </div>
      </div>

      <nav className="nav-list" aria-label="Sidebar navigation">
        {items.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            className={`nav-item ${active === key ? 'active' : ''}`}
            aria-current={active === key ? 'page' : undefined}
            onClick={() => onNavigate(key)}
          >
            <Icon size={18} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
