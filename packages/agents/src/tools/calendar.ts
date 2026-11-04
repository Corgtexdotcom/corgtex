import { prisma, type AppActor } from "@corgtex/shared";
import { getCalendarAvailability, refreshOAuthTokenIfNeeded } from "@corgtex/domain";
import type { OAuthProvider } from "@prisma/client";
import type { ModelTool } from "@corgtex/models";

export const checkCalendarAvailabilityTool: ModelTool = {
  type: "function",
  function: {
    name: "check_calendar_availability",
    description: "Check free/busy availability for a list of emails between two dates.",
    parameters: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: ["GOOGLE", "MICROSOFT"],
          description: "Explicit connected calendar provider to use in this workspace.",
        },
        emails: {
          type: "array",
          items: { type: "string" },
          description: "List of email addresses to check availability for.",
        },
        timeMin: {
          type: "string",
          description: "ISO 8601 start date-time string (e.g. 2026-04-10T09:00:00Z)",
        },
        timeMax: {
          type: "string",
          description: "ISO 8601 end date-time string (e.g. 2026-04-10T17:00:00Z)",
        },
      },
      required: ["provider", "emails", "timeMin", "timeMax"],
    },
  },
};

export const scheduleMeetingTool: ModelTool = {
  type: "function",
  function: {
    name: "schedule_meeting",
    description: "Schedule a calendar event via the user's primary connected calendar provider.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Meeting title/subject" },
        description: { type: "string", description: "Meeting body/description" },
        startTime: { type: "string", description: "ISO 8601 start date-time string" },
        endTime: { type: "string", description: "ISO 8601 end date-time string" },
        attendeeEmails: {
          type: "array",
          items: { type: "string" },
          description: "List of attendee email addresses to invite",
        },
      },
      required: ["title", "startTime", "endTime", "attendeeEmails"],
    },
  },
};

export async function checkCalendarAvailability(actor: AppActor, workspaceId: string, provider: OAuthProvider, emails: string[], timeMin: string, timeMax: string) {
  return getCalendarAvailability(actor, { workspaceId, provider, emails, timeMin, timeMax });
}

export async function scheduleMeeting(userId: string, workspaceId: string, title: string, description: string | undefined, startTime: string, endTime: string, attendeeEmails: string[]) {
  const connection = await prisma.oAuthConnection.findFirst({
    where: { userId },
  });

  if (!connection) {
    return { error: "You must connect your Google or Microsoft calendar in Settings before scheduling meetings." };
  }

  const validConnection = await refreshOAuthTokenIfNeeded(connection.id);

  try {
    if (validConnection.provider === "GOOGLE") {
      const resp = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${validConnection.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          summary: title,
          description: description || "",
          start: { dateTime: startTime },
          end: { dateTime: endTime },
          attendees: attendeeEmails.map(email => ({ email })),
        }),
      });

      if (!resp.ok) return { error: `Google API Error: ${await resp.text()}` };
      const data = await resp.json();
      return { success: true, htmlLink: data.htmlLink, id: data.id };
    }

    if (validConnection.provider === "MICROSOFT") {
      const resp = await fetch("https://graph.microsoft.com/v1.0/me/events", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${validConnection.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          subject: title,
          body: description ? { contentType: "HTML", content: description } : undefined,
          start: { dateTime: startTime, timeZone: "UTC" },
          end: { dateTime: endTime, timeZone: "UTC" },
          attendees: attendeeEmails.map(email => ({ type: "required", emailAddress: { address: email } })),
        }),
      });

      if (!resp.ok) return { error: `Microsoft API Error: ${await resp.text()}` };
      const data = await resp.json();
      return { success: true, webLink: data.webLink, id: data.id };
    }
  } catch (err: any) {
    return { error: `Scheduling failed: ${err.message}` };
  }
}
