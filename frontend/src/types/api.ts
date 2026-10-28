export type EventFormValues = {
  eventName: string;
  eventType: 'Wedding' | 'Birthday' | 'Community event' | 'Other celebration';
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
  requestedAction?: string;
  existingPlan?: ApiPlanResponse['data'];
};

export type ApiPlanResponse = {
  success: boolean;
  source: 'gemini' | 'demo';
  /** Plan sections a focused request changed; null/absent means the whole plan was regenerated. */
  updatedFields?: string[] | null;
  message: string;
  data: {
    eventStartTime: string;
    eventDurationMinutes: number;
    durationIsSuggested: boolean;
    overview: string;
    theme: string;
    palette: string[];
    ideas: string[];
    budgetAllocation: Record<string, number>;
    itemizedCosts: Array<{
      category: string;
      label: string;
      amount: number;
      kind: 'expense' | 'contingency' | 'reserve';
      notes: string;
    }>;
    timeline: Array<{
      title: string;
      startTime: string;
      durationMinutes: number;
      notes: string;
    }>;
    tasks: Array<{
      title: string;
      priority: 'Low' | 'Medium' | 'High';
      dueDate: string;
      status: 'todo' | 'in progress' | 'done';
      source: 'manual' | 'ai';
      description: string;
    }>;
    vendors: Array<{
      category: string;
      name: string;
      status: 'researching' | 'contacted' | 'quoted' | 'booked' | 'not needed';
      estimatedCost: number;
      notes: string;
    }>;
    menuSuggestions: string[];
    contingency: string[];
    costSavings: string[];
    assumptions: string[];
    mode: 'demo' | 'gemini';
    generatedAt: string;
    budgetWarnings: string[];
  };
};
