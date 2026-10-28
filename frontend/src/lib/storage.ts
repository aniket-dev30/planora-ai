export type EventType = 'Wedding' | 'Birthday' | 'Community event' | 'Other celebration';

export type TaskStatus = 'todo' | 'in progress' | 'done';
export type VendorStatus = 'researching' | 'contacted' | 'quoted' | 'booked' | 'not needed';
export type TaskPriority = 'Low' | 'Medium' | 'High';

export type ExpenseItem = {
  id: string;
  category: string;
  label: string;
  amount: number;
  kind: 'expense' | 'contingency' | 'reserve';
  notes: string;
};

export type TimelineEntry = {
  id: string;
  title: string;
  startTime: string;
  durationMinutes: number;
  notes: string;
};

export type TaskItem = {
  id: string;
  title: string;
  priority: TaskPriority;
  dueDate: string;
  status: TaskStatus;
  source: 'manual' | 'ai';
  description: string;
};

export type VendorItem = {
  id: string;
  category: string;
  name: string;
  status: VendorStatus;
  estimatedCost: number;
  notes: string;
};

export type EventPlan = {
  eventStartTime: string;
  eventDurationMinutes: number;
  durationIsSuggested: boolean;
  overview: string;
  theme: string;
  palette: string[];
  ideas: string[];
  budgetAllocation: Record<string, number>;
  itemizedCosts: ExpenseItem[];
  timeline: TimelineEntry[];
  tasks: TaskItem[];
  vendors: VendorItem[];
  menuSuggestions: string[];
  contingency: string[];
  costSavings: string[];
  assumptions: string[];
  mode: 'demo' | 'gemini';
  generatedAt: string;
  budgetWarnings: string[];
};

export type EventData = {
  id: string;
  eventName: string;
  eventType: EventType;
  eventDate: string;
  eventStartTime: string;
  eventDurationMinutes: number;
  durationIsSuggested: boolean;
  city: string;
  guestCount: number;
  totalBudget: number;
  style: string;
  venuePreference: string;
  dietaryPreferences: string;
  culturalPreferences: string;
  additionalRequirements: string;
  priorities: string[];
  createdAt: string;
  updatedAt: string;
  plan: EventPlan;
};

const STORAGE_KEY = 'planora-ai-events-v1';
const LEGACY_SAMPLE_MARKER = 'This is sample data for dashboard demonstration.';
const EVENT_TYPES: EventType[] = ['Wedding', 'Birthday', 'Community event', 'Other celebration'];
const TASK_STATUSES: TaskStatus[] = ['todo', 'in progress', 'done'];
const TASK_PRIORITIES: TaskPriority[] = ['Low', 'Medium', 'High'];
const VENDOR_STATUSES: VendorStatus[] = ['researching', 'contacted', 'quoted', 'booked', 'not needed'];

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const recordArray = (value: unknown): Record<string, unknown>[] => (
  Array.isArray(value) ? value.map(asRecord).filter((row): row is Record<string, unknown> => row !== null) : []
);

const safeNumber = (value: unknown, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

export const normalizeEventData = (value: unknown): EventData[] => {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => {
      const item = asRecord(entry);
      if (!item) return null;
      const plan = asRecord(item.plan) || {};
      const allocation = asRecord(plan.budgetAllocation);

      const normalized: EventData = {
        id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
        eventName: typeof item.eventName === 'string' ? item.eventName : 'Untitled event',
        eventType: EVENT_TYPES.includes(item.eventType as EventType) ? item.eventType as EventType : 'Wedding',
        eventDate: typeof item.eventDate === 'string' ? item.eventDate : new Date().toISOString().slice(0, 10),
        eventStartTime: typeof item.eventStartTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(item.eventStartTime) ? item.eventStartTime : '18:00',
        eventDurationMinutes: Math.min(1440, Math.max(30, Math.round(safeNumber(item.eventDurationMinutes, 240)))),
        durationIsSuggested: typeof item.durationIsSuggested === 'boolean' ? item.durationIsSuggested : true,
        city: typeof item.city === 'string' ? item.city : 'Local city',
        guestCount: Math.max(1, Math.round(safeNumber(item.guestCount, 1))),
        totalBudget: Math.max(0, safeNumber(item.totalBudget, 0)),
        style: typeof item.style === 'string' ? item.style : 'Warm modern elegance',
        venuePreference: typeof item.venuePreference === 'string' ? item.venuePreference : 'Flexible indoor venue',
        dietaryPreferences: typeof item.dietaryPreferences === 'string' ? item.dietaryPreferences : 'Vegetarian-friendly',
        culturalPreferences: typeof item.culturalPreferences === 'string' ? item.culturalPreferences : '',
        additionalRequirements: typeof item.additionalRequirements === 'string' ? item.additionalRequirements : '',
        priorities: Array.isArray(item.priorities) ? item.priorities.filter((p): p is string => typeof p === 'string') : [],
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
        updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
        plan: {
          eventStartTime: typeof plan.eventStartTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(plan.eventStartTime) ? plan.eventStartTime : (typeof item.eventStartTime === 'string' ? item.eventStartTime : '18:00'),
          eventDurationMinutes: Math.min(1440, Math.max(30, Math.round(safeNumber(plan.eventDurationMinutes, safeNumber(item.eventDurationMinutes, 240))))),
          durationIsSuggested: typeof plan.durationIsSuggested === 'boolean' ? plan.durationIsSuggested : (typeof item.durationIsSuggested === 'boolean' ? item.durationIsSuggested : true),
          overview: typeof plan.overview === 'string' ? plan.overview : 'Event overview to be refined.',
          theme: typeof plan.theme === 'string' ? plan.theme : 'Warm modern elegance',
          palette: Array.isArray(plan.palette) ? plan.palette.filter((p): p is string => typeof p === 'string') : ['#38294a', '#f2d9c5', '#8a6ab3'],
          ideas: Array.isArray(plan.ideas) ? plan.ideas.filter((p): p is string => typeof p === 'string') : ['Create a warm guest experience.'],
          budgetAllocation: allocation ? Object.fromEntries(Object.entries(allocation).map(([key, value]) => [key, safeNumber(value, 0)])) : {},
          itemizedCosts: recordArray(plan.itemizedCosts).map((row) => ({
            id: typeof row.id === 'string' ? row.id : crypto.randomUUID(),
            category: typeof row.category === 'string' ? row.category : 'Uncategorized',
            label: typeof row.label === 'string' ? row.label : 'Expense',
            amount: safeNumber(row.amount, 0),
            kind: row.kind === 'contingency' || row.kind === 'reserve'
              ? row.kind
              : row.kind === 'expense'
                ? 'expense'
                : /contingency/i.test(String(row.category)) ? 'contingency' : /reserve/i.test(String(row.category)) ? 'reserve' : 'expense',
            notes: typeof row.notes === 'string' ? row.notes : '',
          })),
          timeline: recordArray(plan.timeline).map((row) => ({
            id: typeof row.id === 'string' ? row.id : crypto.randomUUID(),
            title: typeof row.title === 'string' ? row.title : 'New activity',
            startTime: typeof row.startTime === 'string' ? row.startTime : '18:00',
            durationMinutes: Math.max(1, Math.round(safeNumber(row.durationMinutes, 60))),
            notes: typeof row.notes === 'string' ? row.notes : '',
          })),
          tasks: recordArray(plan.tasks).map((row) => ({
            id: typeof row.id === 'string' ? row.id : crypto.randomUUID(),
            title: typeof row.title === 'string' ? row.title : 'Task',
            priority: TASK_PRIORITIES.includes(row.priority as TaskPriority) ? row.priority as TaskPriority : 'Medium',
            dueDate: typeof row.dueDate === 'string' ? row.dueDate : new Date().toISOString().slice(0, 10),
            status: TASK_STATUSES.includes(row.status as TaskStatus) ? row.status as TaskStatus : 'todo',
            source: row.source === 'ai' ? 'ai' : 'manual',
            description: typeof row.description === 'string' ? row.description : '',
          })),
          vendors: recordArray(plan.vendors).map((row) => ({
            id: typeof row.id === 'string' ? row.id : crypto.randomUUID(),
            category: typeof row.category === 'string' ? row.category : 'General',
            name: typeof row.name === 'string' ? row.name : 'Vendor',
            status: VENDOR_STATUSES.includes(row.status as VendorStatus) ? row.status as VendorStatus : 'researching',
            estimatedCost: safeNumber(row.estimatedCost, 0),
            notes: typeof row.notes === 'string' ? row.notes : '',
          })),
          menuSuggestions: Array.isArray(plan.menuSuggestions) ? plan.menuSuggestions.filter((p): p is string => typeof p === 'string') : ['Signature menu options.'],
          contingency: Array.isArray(plan.contingency) ? plan.contingency.filter((p): p is string => typeof p === 'string') : ['Backup arrangements.'],
          costSavings: Array.isArray(plan.costSavings) ? plan.costSavings.filter((p): p is string => typeof p === 'string') : ['Trim non-essential extras.'],
          assumptions: Array.isArray(plan.assumptions) ? plan.assumptions.filter((p): p is string => typeof p === 'string') : ['Assumptions noted.'],
          mode: plan.mode === 'gemini' ? 'gemini' : 'demo',
          generatedAt: typeof plan.generatedAt === 'string' ? plan.generatedAt : new Date().toISOString(),
          budgetWarnings: Array.isArray(plan.budgetWarnings) ? plan.budgetWarnings.filter((p): p is string => typeof p === 'string') : [],
        },
      };
      return normalized;
    })
    .filter((event): event is EventData => event !== null && !(event.eventName === 'Aarav & Meera Wedding' && event.plan.assumptions.includes(LEGACY_SAMPLE_MARKER)));
};

export const loadEvents = (): EventData[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return normalizeEventData(JSON.parse(raw));
  } catch {
    return [];
  }
};

export const saveEvents = (events: EventData[]) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
};
