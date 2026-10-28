/**
 * Maps a free-text planner request to the plan sections it should change. Shared by the backend
 * (which restricts the model's output) and the UI (which tells the user what will be replaced), so
 * the two can never disagree. An empty result means "regenerate the whole plan".
 *
 * `budgetAllocation` is intentionally absent: it is derived from `itemizedCosts` on the server.
 */
export function focusedPlanFields(requestedAction) {
  const action = String(requestedAction ?? '').toLowerCase();
  const fields = new Set();
  const include = (pattern, names) => {
    if (pattern.test(action)) names.forEach((name) => fields.add(name));
  };
  include(/budget|cost|afford|price|cheap|saving|expense/, ['itemizedCosts', 'costSavings', 'budgetWarnings']);
  include(/decor|theme|style|color|palette|floral/, ['theme', 'palette', 'ideas']);
  include(/menu|food|diet|vegetarian|cater/, ['menuSuggestions']);
  include(/timeline|schedule|timing|start time/, ['timeline']);
  include(/task|checklist|deadline|to-do/, ['tasks']);
  include(/vendor|supplier|booking/, ['vendors']);
  include(/rain|weather|backup|contingency/, ['contingency', 'ideas']);
  include(/overview|summary/, ['overview']);
  return [...fields];
}
