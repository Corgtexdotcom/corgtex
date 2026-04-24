"use client";

import { updateModelUsageBudgetAction } from"../actions";

export function AgentBudgetManager({ 
 workspaceId, 
 budget 
}: { 
 workspaceId: string, 
 budget: { monthlyCostCapUsd: number, alertThresholdPct: number, periodStartDay: number } | null 
}) {
 return (
 <div className="bg-surface-strong border border-line rounded-xl overflow-hidden shadow-sm mb-6">
 <div className="p-6">
 <h3 className="text-lg font-medium tracking-tight text-text mb-2">Model Usage Budget</h3>
 <p className="text-sm text-muted leading-relaxed mb-6">
 Set a hard cap on AI agent spending per billing cycle. Once the cap is reached, agents will pause execution.
 </p>

 <form action={updateModelUsageBudgetAction} className="space-y-4">
 <input type="hidden" name="workspaceId" value={workspaceId} />

 <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
 <div>
 <label className="block text-sm font-medium text-text mb-1">
 Monthly Cap (USD)
 </label>
 <input 
 type="number" 
 name="monthlyCostCapUsd" 
 min="-1" 
 step="0.01" 
 defaultValue={budget ? budget.monthlyCostCapUsd : -1} 
 className="w-full text-sm border border-line rounded-md bg-surface-strong text-text py-1.5 px-3"
 />
 <p className="text-xs text-muted mt-1">Set to -1 for unlimited usage.</p>
 </div>

 <div>
 <label className="block text-sm font-medium text-text mb-1">
 Alert Threshold (%)
 </label>
 <input 
 type="number" 
 name="alertThresholdPct" 
 min="1" 
 max="100" 
 defaultValue={budget ? budget.alertThresholdPct : 80} 
 className="w-full text-sm border border-line rounded-md bg-surface-strong text-text py-1.5 px-3"
 />
 <p className="text-xs text-muted mt-1">Send a notification when usage hits this percentage.</p>
 </div>

 <div>
 <label className="block text-sm font-medium text-text mb-1">
 Billing Cycle Start Day
 </label>
 <input 
 type="number" 
 name="periodStartDay" 
 min="1" 
 max="31" 
 defaultValue={budget ? budget.periodStartDay : 1} 
 className="w-full text-sm border border-line rounded-md bg-surface-strong text-text py-1.5 px-3"
 />
 <p className="text-xs text-muted mt-1">Day of the month the budget resets.</p>
 </div>
 </div>

 <div className="pt-2">
 <button type="submit" className="button secondary small">
 Save Budget Settings
 </button>
 </div>
 </form>
 </div>
 </div>
);
}
