export function validateBudgetAmount(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    throw new RangeError('Budget amounts must be finite, non-negative numbers.');
  }
  return amount;
}

const toPaise = (amount) => {
  validateBudgetAmount(amount);
  if (amount > Number.MAX_SAFE_INTEGER / 100) {
    throw new RangeError('Budget amounts exceed the supported currency range.');
  }
  const [mantissa, exponentText] = amount.toString().toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const digits = BigInt(`${whole}${fraction}`);
  const scale = fraction.length - Number(exponentText ?? 0);
  const paise = scale <= 2
    ? digits * (10n ** BigInt(2 - scale))
    : (digits + (10n ** BigInt(scale - 2)) / 2n) / (10n ** BigInt(scale - 2));
  if (paise > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Budget amounts exceed the supported currency range.');
  }
  return paise;
};

const fromPaise = (paise) => Number(paise) / 100;

export function calculateBudgetReduction(budget, percent) {
  const budgetPaise = toPaise(budget);
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new RangeError('Budget reduction percentage must be between 0 and 100.');
  }
  const percentageBasisPoints = Math.round(percent * 100 + 1e-9);
  const targetPaise = (
    budgetPaise * BigInt(10_000 - percentageBasisPoints) + 5_000n
  ) / 10_000n;
  return {
    originalBudget: fromPaise(budgetPaise),
    targetBudget: fromPaise(targetPaise),
    savings: fromPaise(budgetPaise - targetPaise),
    percent: percentageBasisPoints / 100,
    actualPercent: budgetPaise === 0n
      ? 0
      : Number((((budgetPaise - targetPaise) * 10_000n + budgetPaise / 2n) / budgetPaise)) / 100,
  };
}

/**
 * Scales line items proportionally and uses largest-remainder rounding so their sum
 * equals targetBudget to the nearest paisa. Existing item metadata and kinds are retained.
 */
export function scaleBudgetItemsToTarget(items, targetBudget) {
  const targetPaise = toPaise(targetBudget);
  if (!Array.isArray(items) || items.length === 0) {
    throw new RangeError('At least one budget line item is required to allocate a target budget.');
  }
  const amounts = items.map((item) => toPaise(item.amount));
  const sourceTotal = amounts.reduce((total, amount) => total + amount, 0n);
  if (sourceTotal === 0n) {
    if (targetPaise > 0n) {
      throw new RangeError('A positive target budget cannot be allocated from zero-valued line items.');
    }
    return items.map((item) => ({ ...item, amount: 0 }));
  }

  const shares = amounts.map((amount, index) => {
    const numerator = amount * targetPaise;
    return {
      index,
      paise: numerator / sourceTotal,
      remainder: numerator % sourceTotal,
    };
  });
  let remainder = targetPaise - shares.reduce((total, share) => total + share.paise, 0n);
  const remainderOrder = [...shares].sort((a, b) => (
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1
  ));
  for (let index = 0; remainder > 0n; index += 1, remainder -= 1n) {
    remainderOrder[index].paise += 1n;
  }

  const scaled = items.map((item, index) => ({ ...item, amount: fromPaise(shares[index].paise) }));
  const allocatedPaise = scaled.reduce((total, item) => total + toPaise(item.amount), 0n);
  if (allocatedPaise !== targetPaise) {
    throw new RangeError('Scaled budget line items do not match the target budget.');
  }
  return scaled;
}

export function summarizeBudget(items, budgetLimit) {
  const budgetPaise = toPaise(budgetLimit);
  const summary = items.reduce((totals, item) => {
    const amount = toPaise(item.amount);
    totals.allocated += amount;
    if (item.kind === 'contingency') totals.contingency += amount;
    else if (item.kind === 'reserve') totals.reserve += amount;
    else totals.expenses += amount;
    return totals;
  }, { expenses: 0n, contingency: 0n, reserve: 0n, allocated: 0n });

  return {
    expenses: fromPaise(summary.expenses),
    contingency: fromPaise(summary.contingency),
    reserve: fromPaise(summary.reserve),
    allocated: fromPaise(summary.allocated),
    unallocated: fromPaise(budgetPaise - summary.allocated),
  };
}

/**
 * Sums itemized costs per category. Used as the single source of truth for
 * `budgetAllocation` so the category totals can never disagree with the line items.
 */
export function deriveBudgetAllocation(items) {
  const allocation = {};
  for (const item of items) {
    const amount = toPaise(item.amount);
    const category = String(item.category).trim() || 'Uncategorized';
    allocation[category] = fromPaise((toPaise(allocation[category] ?? 0)) + amount);
  }
  return allocation;
}

export function isOverBudget(items, budgetLimit) {
  return summarizeBudget(items, budgetLimit).unallocated < 0;
}
