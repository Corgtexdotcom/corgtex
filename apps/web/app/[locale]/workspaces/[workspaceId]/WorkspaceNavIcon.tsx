"use client";

import {
  Brain,
  CalendarDays,
  CheckSquare,
  CircleDot,
  ClipboardList,
  Command,
  FileText,
  Gauge,
  Hexagon,
  Home,
  Landmark,
  LogOut,
  Menu,
  MessageSquare,
  PackageCheck,
  RefreshCw,
  Settings,
  Shield,
  Target,
  TriangleAlert,
  UserCog,
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
  proposals: FileText,
  circles: CircleDot,
  cycles: RefreshCw,
  finance: Landmark,
  agents: Hexagon,
  governance: Gauge,
  audit: ClipboardList,
  settings: Settings,
};

type UtilityIconName =
  | "ai"
  | "command"
  | "logout"
  | "menu"
  | "platformAdmin"
  | "userSettings";

const UTILITY_ICONS: Record<UtilityIconName, LucideIcon> = {
  ai: MessageSquare,
  command: Command,
  logout: LogOut,
  menu: Menu,
  platformAdmin: Shield,
  userSettings: UserCog,
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
  name: UtilityIconName;
  className?: string;
}) {
  const Icon = UTILITY_ICONS[name];
  return <Icon aria-hidden="true" className={className} strokeWidth={1.9} />;
}
