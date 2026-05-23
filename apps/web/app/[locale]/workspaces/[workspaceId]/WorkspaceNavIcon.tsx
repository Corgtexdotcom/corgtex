"use client";

import {
  Brain,
  CalendarDays,
  CheckSquare,
  CircleDot,
  ClipboardList,
  FileText,
  Gauge,
  Hexagon,
  Home,
  Landmark,
  MessageSquare,
  Network,
  PackageCheck,
  RefreshCw,
  Settings,
  Shield,
  Target,
  TriangleAlert,
  UserPlus,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { WorkspaceNavIconName } from "@/lib/nav-config";

const ICONS: Record<WorkspaceNavIconName, LucideIcon> = {
  home: Home,
  goals: Target,
  brain: Brain,
  tools: Wrench,
  built: PackageCheck,
  members: Users,
  tensions: TriangleAlert,
  actions: CheckSquare,
  meetings: CalendarDays,
  relationships: UserPlus,
  contextMaps: Network,
  proposals: FileText,
  circles: CircleDot,
  cycles: RefreshCw,
  finance: Landmark,
  agents: Hexagon,
  governance: Gauge,
  audit: ClipboardList,
  settings: Settings,
};

export type WorkspaceUtilityIconName =
  | "ai"
  | "platformAdmin";

const UTILITY_ICONS: Record<WorkspaceUtilityIconName, LucideIcon> = {
  ai: MessageSquare,
  platformAdmin: Shield,
};

export function WorkspaceNavIcon({
  name,
  className = "ws-nav-icon",
}: {
  name: WorkspaceNavIconName;
  className?: string;
}) {
  const Icon = ICONS[name];
  return <Icon aria-hidden="true" className={className} strokeWidth={1.9} />;
}

export function WorkspaceUtilityIcon({
  name,
  className = "ws-nav-icon",
}: {
  name: WorkspaceUtilityIconName;
  className?: string;
}) {
  const Icon = UTILITY_ICONS[name];
  return <Icon aria-hidden="true" className={className} strokeWidth={1.9} />;
}
