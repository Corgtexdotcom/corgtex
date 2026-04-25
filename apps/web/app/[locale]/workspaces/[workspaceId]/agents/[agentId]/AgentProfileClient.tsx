"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { updateBehaviorAction, assignCircleAction, removeCircleAction } from "./actions";

export function AgentProfileClient({
  agent,
  workspaceId,
  recentRuns,
  thirtyDaySpendUsd,
  allCircles,
  allRoles,
}: {
  agent: any;
  workspaceId: string;
  recentRuns: any[];
  thirtyDaySpendUsd: number;
  allCircles: any[];
  allRoles: any[];
}) {
  const t = useTranslations("agents");
  const [behaviorMd, setBehaviorMd] = useState(agent.behaviorMd || "");
  const [isPending, startTransition] = useTransition();
  const [selectedCircleId, setSelectedCircleId] = useState("");

  const handleSaveBehavior = () => {
    startTransition(async () => {
      try {
        await updateBehaviorAction(agent.id, workspaceId, behaviorMd);
        alert(t("alertBehaviorSaved"));
      } catch (e: any) {
        alert(e.message || t("alertBehaviorFailed"));
      }
    });
  };

  const handleAssignCircle = (circleId: string) => {
    startTransition(async () => {
      try {
        await assignCircleAction(agent.id, workspaceId, circleId);
        alert(t("alertAssigned"));
      } catch (e: any) {
        alert(e.message || t("alertAssignFailed"));
      }
    });
  };

  const handleRemoveFromCircle = (circleId: string) => {
    startTransition(async () => {
      try {
        await removeCircleAction(agent.id, workspaceId, circleId);
        alert(t("alertRemoved"));
      } catch (e: any) {
        alert(e.message || t("alertRemoveFailed"));
      }
    });
  };

  const unassignedCircles = allCircles.filter(
    (c) => !agent.circleAssignments.find((a: any) => a.circle.id === c.id)
  );

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
      <div className="md:col-span-2 space-y-6">
        <section className="bg-white rounded-xl shadow-sm border border-stone-200 overflow-hidden">
          <div className="bg-stone-50 border-b border-stone-200 px-6 py-4 flex items-center justify-between">
            <h2 className="text-lg font-serif text-stone-900 flex items-center gap-2">
              <span className="text-stone-500">⎈</span>
              {t("behaviorConfig")}
            </h2>
            <button
              className="secondary small"
              onClick={handleSaveBehavior}
              disabled={isPending}
            >
              <span>↓</span> {t("btnSave")}
            </button>
          </div>
          <div className="p-6">
            <p className="text-sm text-stone-500 mb-4 bg-stone-50 p-3 rounded-lg border border-stone-100">
              {t("behaviorDesc")}
            </p>
            <textarea
              className="font-mono text-sm w-full p-3 border border-stone-200 rounded min-h-[300px] resize-y"
              value={behaviorMd}
              onChange={(e: any) => setBehaviorMd(e.target.value)}
              placeholder={t("behaviorPlaceholder")}
            />
          </div>
        </section>

        <section className="bg-white rounded-xl shadow-sm border border-stone-200 overflow-hidden">
          <div className="bg-stone-50 border-b border-stone-200 px-6 py-4">
            <h2 className="text-lg font-serif text-stone-900 flex items-center gap-2">
              <span className="text-stone-500">●</span>
              {t("circleAssignments")}
            </h2>
          </div>
          <div className="p-0">
            {agent.circleAssignments.length > 0 ? (
              <ul className="divide-y divide-stone-100">
                {agent.circleAssignments.map((assignment: any) => (
                  <li key={assignment.id} className="p-4 flex items-center justify-between">
                    <div>
                      <h4 className="font-medium text-stone-900">{assignment.circle.name}</h4>
                      {assignment.role && (
                        <p className="text-sm text-stone-500">{assignment.role.name}</p>
                      )}
                    </div>
                    <button
                      className="danger small"
                      onClick={() => handleRemoveFromCircle(assignment.circle.id)}
                      disabled={isPending}
                    >
                      <span>✕</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="p-6 text-center text-stone-500 text-sm">
                {t("notAssigned")}
              </div>
            )}
            
            {unassignedCircles.length > 0 && (
              <div className="p-4 bg-stone-50 border-t border-stone-100">
                <h4 className="text-xs font-semibold text-stone-500 uppercase tracking-wider mb-3">{t("assignToCircle")}</h4>
                <div className="flex gap-2">
                  <select 
                    value={selectedCircleId} 
                    onChange={(e) => setSelectedCircleId(e.target.value)}
                    className="border border-stone-200 rounded px-2 py-1 text-sm flex-1"
                  >
                    <option value="">{t("selectCircle")}</option>
                    {unassignedCircles.map((circle) => (
                      <option key={circle.id} value={circle.id}>{circle.name}</option>
                    ))}
                  </select>
                  <button
                    className="secondary small"
                    onClick={() => {
                      if (selectedCircleId) {
                        handleAssignCircle(selectedCircleId);
                        setSelectedCircleId("");
                      }
                    }}
                    disabled={isPending || !selectedCircleId}
                  >
                    {t("btnAssign")}
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>

      <div className="space-y-6">
        <section className="bg-white rounded-xl shadow-sm border border-stone-200 overflow-hidden">
          <div className="p-6 text-center">
            <div className="mx-auto h-12 w-12 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center mb-4">
              <span className="text-xl">¤</span>
            </div>
            <h3 className="text-sm font-medium text-stone-500">{t("spend30d")}</h3>
            <p className="text-3xl font-serif text-stone-900 mt-2">
              ${thirtyDaySpendUsd.toFixed(2)}
            </p>
          </div>
        </section>

        <section className="bg-white rounded-xl shadow-sm border border-stone-200 overflow-hidden">
          <div className="bg-stone-50 border-b border-stone-200 px-6 py-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500 flex items-center gap-2">
              <span>⚙</span>
              {t("recentActivity")}
            </h2>
          </div>
          <div className="p-0">
            {recentRuns.length > 0 ? (
              <ul className="divide-y divide-stone-100">
                {recentRuns.map((run: any) => (
                  <li key={run.id} className="p-4 text-sm">
                    <p className="text-stone-900 font-medium truncate" title={run.goal}>{run.goal || t("noGoal")}</p>
                    <div className="mt-1 flex items-center justify-between text-stone-500 text-xs">
                      <span className={`px-1.5 py-0.5 rounded-md ${run.status === "COMPLETED" ? "bg-emerald-50 text-emerald-700" : run.status === "FAILED" ? "bg-red-50 text-red-700" : "bg-blue-50 text-blue-700"}`}>
                        {run.status}
                      </span>
                      <span>{new Date(run.createdAt).toLocaleDateString()}</span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="p-6 text-center text-stone-500 text-sm">
                {t("noRecentActivity")}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
