import React from "react";
import { getGoalTree, getMyGoalSlice, listRecognitions, requireWorkspaceMembership } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { GoalProgress } from "./GoalProgress";
import { RecognitionCard } from "./RecognitionCard";
import type { GoalCadence } from "@prisma/client";

export const dynamic = "force-dynamic";

export default async function GoalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ view?: string; cadence?: string }>;
}) {
  const { workspaceId } = await params;
  const { view = "tree", cadence = "QUARTERLY" } = await searchParams;
  const actor = await requirePageActor();

  let tree: any[] = [];
  let mySlice: any[] = [];
  let recognitions: any[] = [];

  if (view === "tree") {
    // Tree view filtered by cadence
    tree = await getGoalTree(actor, workspaceId, { cadence: cadence as GoalCadence });
  } else {
    // My Slice view
    if (actor.kind === "user") {
      const membership = await requireWorkspaceMembership({ actor, workspaceId });
      if (membership) {
        mySlice = await getMyGoalSlice(actor, membership.id, workspaceId);
        recognitions = await listRecognitions(actor, { workspaceId, recipientMemberId: membership.id });
      }
    }
  }

  const cadences: { id: string; label: string }[] = [
    { id: "TEN_YEAR", label: "10Y" },
    { id: "FIVE_YEAR", label: "5Y" },
    { id: "ANNUAL", label: "Annual" },
    { id: "QUARTERLY", label: "Quarterly" },
    { id: "MONTHLY", label: "Monthly" },
    { id: "WEEKLY", label: "Weekly" },
  ];

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-gray-200 dark:border-gray-800 pb-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Strategic Goals</h1>
          <p className="text-gray-500 mt-1">Align organization, circle, and personal objectives.</p>
        </div>
        
        <div className="flex mt-2 sm:mt-0 glass-panel rounded-lg overflow-hidden border border-gray-200 dark:border-gray-800 p-1">
          <a
            href={`/workspaces/${workspaceId}/goals?view=tree&cadence=${cadence}`}
            className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
              view === "tree" ? "bg-black text-white dark:bg-white dark:text-black shadow-sm" : "text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200"
            }`}
          >
            Tree View
          </a>
          <a
            href={`/workspaces/${workspaceId}/goals?view=slice&cadence=${cadence}`}
            className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
              view === "slice" ? "bg-black text-white dark:bg-white dark:text-black shadow-sm" : "text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200"
            }`}
          >
            My Slice
          </a>
        </div>
      </div>

      {view === "tree" && (
        <div className="space-y-6">
          <div className="flex overflow-x-auto pb-2 gap-2">
            {cadences.map(c => (
              <a
                key={c.id}
                href={`/workspaces/${workspaceId}/goals?view=tree&cadence=${c.id}`}
                className={`px-3 py-1 text-sm font-medium rounded-full whitespace-nowrap transition-colors border ${
                  cadence === c.id 
                    ? "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800/50" 
                    : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-400 dark:border-gray-800 dark:hover:bg-gray-800"
                }`}
              >
                {c.label}
              </a>
            ))}
          </div>

          <div className="space-y-4">
            {tree.length === 0 ? (
              <div className="p-12 text-center text-gray-500 bg-white dark:bg-gray-900 rounded-xl border border-dashed border-gray-300 dark:border-gray-700">
                No {cadence.toLowerCase().replace("_", " ")} goals found.
              </div>
            ) : (
              tree.map(goal => (
                <GoalNode key={goal.id} goal={goal} level={0} />
              ))
            )}
          </div>
        </div>
      )}

      {view === "slice" && (
        <div className="space-y-8">
          <div>
            <h3 className="text-xl font-semibold mb-4 text-gray-900 dark:text-white">My Active Goals</h3>
            <div className="space-y-4">
              {mySlice.length === 0 ? (
                <div className="p-8 text-center text-gray-500 bg-white dark:bg-gray-900 rounded-xl border border-dashed border-gray-300 dark:border-gray-700">
                  You don&apos;t own any goals right now.
                </div>
              ) : (
                mySlice.map(goal => (
                  <div key={goal.id} className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5 shadow-sm">
                    <div className="flex justify-between items-start mb-2">
                      <h4 className="font-semibold text-lg">{goal.title}</h4>
                      <span className="text-xs px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-gray-600 dark:text-gray-400">
                        {goal.cadence.replace("_", " ")}
                      </span>
                    </div>
                    {goal.parentGoal && (
                      <div className="text-sm text-gray-500 dark:text-gray-400 mb-3 flex items-center">
                        <span className="mr-1">↗ contributes to:</span>
                        <span className="font-medium text-gray-700 dark:text-gray-300">
                          {goal.parentGoal.circle?.name ? `[${goal.parentGoal.circle.name}] ` : ""} 
                          {goal.parentGoal.title}
                        </span>
                      </div>
                    )}
                    <GoalProgress percent={goal.progressPercent} />
                  </div>
                ))
              )}
            </div>
          </div>

          <div>
            <h3 className="text-xl font-semibold mb-4 text-gray-900 dark:text-white">Recent Recognitions</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {recognitions.length === 0 ? (
                <div className="col-span-full p-8 text-center text-gray-500 bg-white dark:bg-gray-900 rounded-xl border border-dashed border-gray-300 dark:border-gray-700">
                  No recognitions yet. Keep doing great work!
                </div>
              ) : (
                recognitions.map(rec => (
                  <RecognitionCard key={rec.id} recognition={rec} />
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function GoalNode({ goal, level }: { goal: any; level: number }) {
  return (
    <div className={`border border-gray-200 dark:border-gray-800 rounded-lg bg-white dark:bg-gray-900 shadow-sm overflow-hidden mb-3`} style={{ marginLeft: `${level * 1.5}rem` }}>
      <div className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0 pr-4">
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-[10px] font-bold tracking-wider px-1.5 py-0.5 rounded uppercase ${
                goal.level === "COMPANY" ? "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300" :
                goal.level === "CIRCLE" ? "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300" :
                "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300"
              }`}>
                {goal.level}
              </span>
              <h3 className="text-base font-semibold text-gray-900 dark:text-white truncate">
                {goal.circle?.name ? `[${goal.circle.name}] ` : ""}{goal.title}
              </h3>
            </div>
            {goal.ownerMember && (
              <div className="text-sm text-gray-500 flex items-center gap-1.5 mb-2 mt-1">
                {goal.ownerMember.user?.avatarUrl ? (
                  <img src={goal.ownerMember.user.avatarUrl} alt="" className="w-4 h-4 rounded-full" />
                ) : (
                  <div className="w-4 h-4 rounded-full bg-gray-200 dark:bg-gray-700" />
                )}
                <span>{goal.ownerMember.user?.displayName || "Unknown"}</span>
              </div>
            )}
          </div>
          <div className="text-right flex-shrink-0 flex flex-col items-end">
            <span className="text-xs font-semibold px-2 py-1 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded">
              {goal.status}
            </span>
            {goal.targetDate && (
              <span className="text-xs mt-1 text-gray-500">
                Target: {new Date(goal.targetDate).toLocaleDateString()}
              </span>
            )}
          </div>
        </div>
        
        <div className="mt-3 flex items-center justify-between text-xs text-gray-500 mb-1">
          <span>Overall Progress</span>
          <span className="font-medium text-gray-700 dark:text-gray-300">{goal.progressPercent}%</span>
        </div>
        <GoalProgress percent={goal.progressPercent} />

        {/* Key Results */}
        {goal.keyResults && goal.keyResults.length > 0 && (
          <div className="mt-4 pt-3 border-t border-gray-100 dark:border-gray-800 space-y-2">
            {goal.keyResults.map((kr: any) => (
              <div key={kr.id} className="text-sm flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                <span className="text-gray-700 dark:text-gray-300 flex-1">{kr.title}</span>
                <span className="text-gray-500 text-xs font-mono ml-0 sm:ml-4 flex-shrink-0">
                  {kr.currentValue || 0} / {kr.targetValue || 0} {kr.unit || ""} ({kr.progressPercent}%)
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Children */}
      {goal.childGoals && goal.childGoals.length > 0 && (
        <div className="bg-gray-50 dark:bg-gray-800/30 p-3 pt-4 border-t border-gray-200 dark:border-gray-800">
          {goal.childGoals.map((child: any) => (
            <GoalNode key={child.id} goal={child} level={level + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
