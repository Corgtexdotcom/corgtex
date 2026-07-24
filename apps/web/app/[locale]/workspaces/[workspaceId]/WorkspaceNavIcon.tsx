"use client";

import {
  BadgeCheck,
  Bell,
  Brain,
  CalendarDays,
  CheckSquare,
  CircleDot,
  Clipboard,
  ClipboardList,
  ExternalLink,
  FileText,
  Gauge,
  Hexagon,
  Home,
  Landmark,
  Languages,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  Network,
  PackageCheck,
  ScrollText,
  Send,
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
  agreements: ScrollText,
  proposals: FileText,
  circles: CircleDot,
  roles: BadgeCheck,
  finance: Landmark,
  agents: Hexagon,
  governance: Gauge,
  audit: ClipboardList,
  notifications: Bell,
  settings: Settings,
};

export type WorkspaceUtilityIconName =
  | "ai"
  | "capture"
  | "copy"
  | "external"
  | "language"
  | "logout"
  | "more"
  | "send"
  | "work"
  | "platformAdmin";

const UTILITY_ICONS: Record<WorkspaceUtilityIconName, LucideIcon> = {
  ai: MessageSquare,
  capture: FileText,
  copy: Clipboard,
  external: ExternalLink,
  language: Languages,
  logout: LogOut,
  more: MoreHorizontal,
  send: Send,
  work: ClipboardList,
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
