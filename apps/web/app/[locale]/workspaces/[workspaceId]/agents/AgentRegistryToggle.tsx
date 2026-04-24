"use client";

import { useTransition } from "react";
import { toggleAgentAction } from "./actions";

export function AgentRegistryToggle({ 
  workspaceId, 
  agentKey, 
  enabled 
}: { 
  workspaceId: string; 
  agentKey: string; 
  enabled: boolean; 
}) {
  const [isPending, startTransition] = useTransition();

  const handleToggle = () => {
    startTransition(() => {
      toggleAgentAction(workspaceId, agentKey, !enabled);
    });
  };

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={handleToggle}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${
        enabled ? "bg-black dark:bg-white" : "bg-zinc-200 dark:bg-zinc-800"
      }`}
    >
      <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white dark:bg-zinc-950 shadow ring-0 transition duration-200 ease-in-out ${
        enabled ? "translate-x-5" : "translate-x-0"
      }`} />
    </button>
  );
}
