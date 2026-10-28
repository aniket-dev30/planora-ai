import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

type BudgetChartDatum = {
  id: string;
  name: string;
  fullName: string;
  budget: number;
  planned: number;
};

import { formatCurrency } from '../lib/format';

export function DashboardBudgetChart({ data }: { data: BudgetChartDatum[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data}>
        <CartesianGrid vertical={false} strokeDasharray="4 4" />
        <XAxis dataKey="id" tickFormatter={(id) => data.find((item) => item.id === id)?.name ?? ''} />
        <YAxis tickFormatter={(value) => `₹${Math.round(value / 1000)}k`} />
        <Tooltip
          labelFormatter={(id) => data.find((item) => item.id === id)?.fullName ?? ''}
          formatter={(value, name) => [formatCurrency(Number(value)), String(name)]}
        />
        <Legend />
        <Bar dataKey="budget" name="Budget" radius={[8, 8, 0, 0]} fill="#c7b9e8" />
        <Bar dataKey="planned" name="Planned costs" radius={[8, 8, 0, 0]} fill="#5a4b90" />
      </BarChart>
    </ResponsiveContainer>
  );
}

export default DashboardBudgetChart;
