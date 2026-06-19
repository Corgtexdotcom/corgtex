"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ControlPlaneClientOption } from "@corgtex/domain";
import { MultiSelectFilter } from "@/lib/components/MultiSelectFilter";
import { cn } from "@/lib/utils";

type ClientContextSwitcherProps = {
  clients: ControlPlaneClientOption[];
  selectedClientId?: string | null;
  selectedClientIds?: readonly string[] | null;
  mode: "detail" | "filter";
  className?: string;
  label?: string;
};

function localePrefix(pathname: string) {
  const match = pathname.match(/^\/([a-z]{2})(?=\/|$)/);
  return match ? `/${match[1]}` : "";
}

export function ClientContextSwitcher({
  clients,
  selectedClientId,
  selectedClientIds,
  mode,
  className,
  label = "Client",
}: ClientContextSwitcherProps) {
  const router = useRouter();
  const pathname = usePathname() || "";
  const searchParams = useSearchParams();
  const selectedFilterClientIds = selectedClientIds ?? (selectedClientId ? [selectedClientId] : []);

  const handleChange = (clientId: string) => {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (mode === "detail") {
      if (!clientId) return;
      const tab = params.get("tab") || "overview";
      router.push(`${localePrefix(pathname)}/control-plane/deployments/${clientId}?tab=${encodeURIComponent(tab)}`);
      return;
    }

    if (clientId) {
      params.set("client", clientId);
    } else {
      params.delete("client");
    }
    params.delete("page");
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  };

  const handleFilterSelectionChange = (clientIds: string[]) => {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.delete("client");
    for (const clientId of clientIds) {
      params.append("client", clientId);
    }
    params.delete("page");
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  };

  if (mode === "filter") {
    return (
      <MultiSelectFilter
        name="client"
        label={label}
        options={clients.map((client) => ({ value: client.id, label: client.label }))}
        selectedValues={selectedFilterClientIds}
        allLabel="All clients"
        className={className}
        onSelectionChange={handleFilterSelectionChange}
      />
    );
  }

  return (
    <label className={cn("flex items-center gap-2", className)}>
      <span className="text-[10px] font-bold text-muted uppercase tracking-wider">
        {label}
      </span>
      <select
        value={selectedClientId ?? ""}
        onChange={(event) => handleChange(event.target.value)}
        className="bg-surface border border-line text-xs text-text rounded-lg px-2.5 py-2 focus:border-line focus:outline-none min-w-[180px]"
      >
        {clients.map((client) => (
          <option key={client.id} value={client.id}>
            {client.label}
          </option>
        ))}
      </select>
    </label>
  );
}
