export type BudgetKind = 'expense' | 'contingency' | 'reserve';

export type BudgetLineItem = {
  amount: number;
  kind?: BudgetKind;
  [key: string]: unknown;
};

export type BudgetSummary = {
  expenses: number;
  contingency: number;
  reserve: number;
  allocated: number;
  unallocated: number;
};

export function validateBudgetAmount(amount: number): number;
export function calculateBudgetReduction(budget: number, percent: number): {
  originalBudget: number;
  targetBudget: number;
  savings: number;
  percent: number;
  actualPercent: number;
};
export function scaleBudgetItemsToTarget<T extends BudgetLineItem>(items: T[], targetBudget: number): T[];
export function summarizeBudget(items: BudgetLineItem[], budgetLimit: number): BudgetSummary;
export function deriveBudgetAllocation(items: Array<BudgetLineItem & { category: string }>): Record<string, number>;
export function isOverBudget(items: BudgetLineItem[], budgetLimit: number): boolean;
