"use client";

import { useState } from "react";
import { useTransition } from "react";
import { getAIProfileBriefingAction } from "./actions";

interface MemberBriefingProps {
  workspaceId: string;
  memberId: string;
}

interface BriefingData {
  summary: string;
  priorities: string[];
  followUps: string[];
  insights: string[];
}

export function MemberBriefing({ workspaceId, memberId }: MemberBriefingProps) {
  const [data, setData] = useState<BriefingData | null>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState(false);

  const generate = () => {
    setError(false);
    startTransition(async () => {
      try {
        const result = await getAIProfileBriefingAction(workspaceId, memberId);
        setData(result);
      } catch (err) {
        console.error(err);
        setError(true);
      }
    });
  };

  return (
    <div className="rounded-xl border bg-gradient-to-br from-indigo-50/50 to-white p-6 shadow-sm overflow-hidden relative">
      <div className="flex items-center justify-between mb-4 relative z-10">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          ✧ AI Briefing
        </h3>
        <button
          onClick={generate}
          disabled={isPending}
          className="actions-inline px-3 py-1.5 text-sm border rounded-md"
        >
          {isPending ? "Generating..." : (data ? "Regenerate" : "Generate")}
        </button>
      </div>

      <div className="relative z-10">
        {!data && !isPending && !error && (
          <div className="text-muted text-sm py-4">
            Click generate to create a personalized AI summary of this member&apos;s current priorities, meetings, and insights.
          </div>
        )}

        {isPending && (
          <div className="py-8 flex flex-col items-center justify-center text-muted animate-pulse">
            <div className="text-2xl mx-auto mb-3 animate-bounce">✧</div>
            <p className="text-sm">Synthesizing recent activity...</p>
          </div>
        )}

        {error && !isPending && (
          <div className="text-danger text-sm py-4 flex items-center gap-2">
            △ Failed to generate briefing. Please try again.
          </div>
        )}

        {data && !isPending && (
          <div className="space-y-6 text-sm duration-500">
            <div className="leading-relaxed font-medium">
              {data.summary}
            </div>

            {data.priorities.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted mb-2">Top Priorities</h4>
                <ul className="space-y-2">
                  {data.priorities.map((item, idx) => (
                    <li key={idx} className="flex gap-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 mt-1.5 flex-shrink-0" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {data.followUps.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted mb-2">Meeting Follow-ups</h4>
                <ul className="space-y-2">
                  {data.followUps.map((item, idx) => (
                    <li key={idx} className="flex gap-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-amber-500 mt-1.5 flex-shrink-0" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {data.insights.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted mb-2">Key Insights</h4>
                <ul className="space-y-2">
                  {data.insights.map((item, idx) => (
                    <li key={idx} className="flex gap-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-teal-500 mt-1.5 flex-shrink-0" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
      
      {/* Decorative background element */}
      <div className="absolute -top-12 -right-12 w-48 h-48 bg-indigo-500/5 blur-3xl rounded-full block pointer-events-none" />
    </div>
  );
}
