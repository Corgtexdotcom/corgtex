export type NotificationPreferenceSection = "urgent" | "activity";

export type NotificationPreferenceRow = {
  type: string;
  label: string;
  section: NotificationPreferenceSection;
};

export type NotificationChannelOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export const urgentNotificationRows: NotificationPreferenceRow[] = [
  { type: "deliberation.mention", label: "Mentions", section: "urgent" },
  { type: "advice.requested", label: "Advice/input requests", section: "urgent" },
  { type: "advice.reminder_due", label: "Advice reminders", section: "urgent" },
  { type: "advice.reply_posted", label: "Advice/input replies", section: "urgent" },
  { type: "role-onboarding.assigned", label: "Role onboarding", section: "urgent" },
  { type: "budget.threshold_reached", label: "Budget threshold", section: "urgent" },
  { type: "action.assigned", label: "Direct action assignments", section: "urgent" },
  { type: "tension.assigned", label: "Direct tension assignments", section: "urgent" },
];

export const activityNotificationRows: NotificationPreferenceRow[] = [
  { type: "meeting.created", label: "New meetings", section: "activity" },
  { type: "action.created", label: "New actions", section: "activity" },
  { type: "tension.created", label: "New tensions", section: "activity" },
  { type: "proposal.opened", label: "Opened proposals", section: "activity" },
  { type: "proposal.submitted", label: "Submitted proposals", section: "activity" },
];

const inAppEmailOptions: NotificationChannelOption[] = [
  { value: "IN_APP", label: "In-app" },
  { value: "EMAIL", label: "Email" },
  { value: "IN_APP_EMAIL", label: "In-app + email" },
];

const slackOptions: NotificationChannelOption[] = [
  { value: "SLACK", label: "Slack" },
  { value: "IN_APP_SLACK", label: "In-app + Slack" },
  { value: "EMAIL_SLACK", label: "Email + Slack" },
  { value: "ALL", label: "In-app + email + Slack" },
];

export function displayNotificationChannel(channel: string | null | undefined) {
  return channel === "BOTH" ? "IN_APP_EMAIL" : channel;
}

export function displayActivityNotificationChannel(channel: string | null | undefined) {
  const displayed = displayNotificationChannel(channel);
  if (!displayed || displayed === "IN_APP" || displayed === "OFF") {
    return displayed;
  }
  return "IN_APP";
}

export function notificationChannelOptions(params: {
  includeUseDefault: boolean;
  slackConnected: boolean;
  activityOnly?: boolean;
}): NotificationChannelOption[] {
  const options: NotificationChannelOption[] = [];
  if (params.includeUseDefault) {
    options.push({ value: "USE_DEFAULT", label: "Use default" });
  }

  if (params.activityOnly) {
    options.push({ value: "IN_APP", label: "In-app" });
    options.push({ value: "OFF", label: "Off" });
    return options;
  }

  options.push(...inAppEmailOptions);
  if (params.slackConnected) {
    options.push(...slackOptions);
  } else {
    options.push({ value: "SLACK", label: "Slack - connect Slack first", disabled: true });
  }
  options.push({ value: "OFF", label: "Off" });
  return options;
}
