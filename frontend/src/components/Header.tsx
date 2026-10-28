import { Bell, Plus, Search } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

export type HeaderNotification = {
  id: string;
  label: string;
  eventName: string;
  eventId: string;
};

export function Header({
  onCreateEvent,
  searchTerm,
  onSearchChange,
  notifications,
  onOpenNotification,
}: {
  onCreateEvent: () => void;
  searchTerm: string;
  onSearchChange: (value: string) => void;
  notifications: HeaderNotification[];
  onOpenNotification: (eventId: string) => void;
}) {
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const popoverId = useId();
  const bellRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);

  // While the reminders are open: Escape closes them (and returns focus to the bell), as does a
  // press outside. Listeners exist only while open and are always removed.
  useEffect(() => {
    if (!isNotificationsOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsNotificationsOpen(false);
        bellRef.current?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popoverRef.current?.contains(target) && !bellRef.current?.contains(target)) setIsNotificationsOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [isNotificationsOpen]);

  return (
    <header className="topbar">
      <div className="search-wrap">
        <Search size={16} aria-hidden="true" />
        <input
          type="search"
          placeholder="Search events or notes"
          aria-label="Search events or notes"
          value={searchTerm}
          onFocus={() => setIsNotificationsOpen(false)}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </div>
      <div className="header-actions">
        <button
          ref={bellRef}
          type="button"
          className="ghost-btn"
          aria-controls={isNotificationsOpen ? popoverId : undefined}
          aria-label={`Notifications, ${notifications.length} planning reminders`}
          aria-expanded={isNotificationsOpen}
          onClick={() => setIsNotificationsOpen((open) => !open)}
        >
          <Bell size={18} aria-hidden="true" />
          {notifications.length ? <span className="notification-count">{notifications.length}</span> : null}
        </button>
        <button type="button" className="primary-btn" onClick={() => { setIsNotificationsOpen(false); onCreateEvent(); }}>
          <Plus size={16} aria-hidden="true" />
          Plan an event
        </button>
      </div>
      {isNotificationsOpen ? (
        <section ref={popoverRef} id={popoverId} className="notification-popover" aria-label="Planning reminders">
          <div className="section-header compact"><h3>Planning reminders</h3></div>
          {notifications.length ? notifications.map((notification) => (
            <button
              key={notification.id}
              type="button"
              className="notification-item"
              onClick={() => {
                onOpenNotification(notification.eventId);
                setIsNotificationsOpen(false);
              }}
            >
              <strong>{notification.label}</strong>
              <span>{notification.eventName}</span>
            </button>
          )) : <p className="muted">No tasks due soon. Your planning checklist is clear.</p>}
        </section>
      ) : null}
    </header>
  );
}
