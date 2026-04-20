import { prisma } from "@corgtex/shared";
import type { OAuthConnection } from "@prisma/client";

function parseMicrosoftDateTime(value: { dateTime?: string | null; timeZone?: string | null }) {
  const raw = value.dateTime?.trim();
  if (!raw) {
    return new Date(NaN);
  }

  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(raw)) {
    return new Date(raw);
  }

  if (value.timeZone === "UTC") {
    return new Date(`${raw}Z`);
  }

  return new Date(raw);
}

export async function refreshOAuthTokenIfNeeded(connectionId: string): Promise<OAuthConnection> {
  const connection = await prisma.oAuthConnection.findUnique({
    where: { id: connectionId },
  });

  if (!connection) throw new Error("Connection not found");

  // Refresh if less than 5 minutes remain
  if (connection.expiresAt && connection.expiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
    if (!connection.refreshToken) {
      throw new Error("Cannot refresh token without refresh_token");
    }

    if (connection.provider === "GOOGLE") {
      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID || "",
          client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
          refresh_token: connection.refreshToken,
          grant_type: "refresh_token",
        }),
      });

      if (!response.ok) throw new Error("Failed to refresh Google token");
      const data = await response.json();

      return prisma.oAuthConnection.update({
        where: { id: connection.id },
        data: {
          accessToken: data.access_token,
          expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
          ...(data.refresh_token && { refreshToken: data.refresh_token }),
        },
      });
    }

    if (connection.provider === "MICROSOFT") {
      const response = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: process.env.MICROSOFT_CLIENT_ID || "",
          client_secret: process.env.MICROSOFT_CLIENT_SECRET || "",
          refresh_token: connection.refreshToken,
          grant_type: "refresh_token",
        }),
      });

      if (!response.ok) throw new Error("Failed to refresh Microsoft token");
      const data = await response.json();

      return prisma.oAuthConnection.update({
        where: { id: connection.id },
        data: {
          accessToken: data.access_token,
          expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
          ...(data.refresh_token && { refreshToken: data.refresh_token }),
        },
      });
    }
  }

  return connection;
}

export interface CalendarEvent {
  id: string;
  title: string;
  description: string | null;
  startTime: Date;
  endTime: Date;
  attendees: string[];
  htmlLink: string | null;
}

export async function fetchCalendarEvents(connectionId: string, timeMin: Date, timeMax: Date): Promise<CalendarEvent[]> {
  const connection = await refreshOAuthTokenIfNeeded(connectionId);

  if (connection.provider === "GOOGLE") {
    const query = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
    });

    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${query}`, {
      headers: { Authorization: `Bearer ${connection.accessToken}` },
    });

    if (!res.ok) throw new Error(`Google Calendar API error: ${await res.text()}`);
    const data = await res.json();

    return (data.items || []).map((item: any) => ({
      id: item.id,
      title: item.summary || "Untitled Event",
      description: item.description || null,
      startTime: new Date(item.start.dateTime || item.start.date),
      endTime: new Date(item.end.dateTime || item.end.date),
      attendees: (item.attendees || []).map((a: any) => a.email),
      htmlLink: item.htmlLink || null,
    }));
  }

  if (connection.provider === "MICROSOFT") {
    const query = new URLSearchParams({
      $filter: `start/dateTime ge '${timeMin.toISOString()}' and end/dateTime le '${timeMax.toISOString()}'`,
      $orderBy: "start/dateTime",
    });

    const res = await fetch(`https://graph.microsoft.com/v1.0/me/events?${query}`, {
      headers: {
        Authorization: `Bearer ${connection.accessToken}`,
        Prefer: 'outlook.timezone="UTC"',
      },
    });

    if (!res.ok) throw new Error(`Microsoft Graph API error: ${await res.text()}`);
    const data = await res.json();

    return (data.value || []).map((item: any) => ({
      id: item.id,
      title: item.subject || "Untitled Event",
      description: item.bodyPreview || null,
      startTime: parseMicrosoftDateTime(item.start),
      endTime: parseMicrosoftDateTime(item.end),
      attendees: (item.attendees || []).map((a: any) => a.emailAddress?.address).filter(Boolean),
      htmlLink: item.webLink || null,
    }));
  }

  return [];
}
