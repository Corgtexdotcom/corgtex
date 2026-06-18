import { describe, expect, it } from "vitest";
import {
  openRelationshipReminders,
  sortRelationshipReminders,
  splitRelationshipReminders,
} from "./relationship-reminders";

describe("relationship reminders", () => {
  const activities = [
    {
      id: "later",
      title: "Later",
      type: "TASK",
      dueAt: "2026-06-20T09:00:00.000Z",
      completedAt: null,
      createdAt: "2026-06-10T09:00:00.000Z",
    },
    {
      id: "note",
      title: "Note",
      type: "NOTE",
      dueAt: "2026-06-18T09:00:00.000Z",
      completedAt: null,
      createdAt: "2026-06-10T09:00:00.000Z",
    },
    {
      id: "done",
      title: "Done",
      type: "TASK",
      dueAt: "2026-06-17T09:00:00.000Z",
      completedAt: "2026-06-17T12:00:00.000Z",
      createdAt: "2026-06-10T09:00:00.000Z",
    },
    {
      id: "soon",
      title: "Soon",
      type: "TASK",
      dueAt: "2026-06-18T09:00:00.000Z",
      completedAt: null,
      createdAt: "2026-06-11T09:00:00.000Z",
    },
  ];

  it("filters open task reminders", () => {
    expect(openRelationshipReminders(activities).map((activity) => activity.id)).toEqual(["soon", "later"]);
  });

  it("sorts by due date before creation date", () => {
    expect(sortRelationshipReminders([activities[0], activities[3]]).map((activity) => activity.id)).toEqual(["soon", "later"]);
  });

  it("splits overdue and upcoming reminders", () => {
    const result = splitRelationshipReminders(activities, new Date("2026-06-19T00:00:00.000Z"));
    expect(result.overdue.map((activity) => activity.id)).toEqual(["soon"]);
    expect(result.upcoming.map((activity) => activity.id)).toEqual(["later"]);
  });
});
