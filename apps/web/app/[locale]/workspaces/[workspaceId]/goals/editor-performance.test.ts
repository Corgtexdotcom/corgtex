import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ goals: [] as any[], editable: 0 }));
const actor = { kind: "user", user: { id: "synthetic-author" } };
const listCircles = vi.hoisted(() => vi.fn(async () => [{ id: "circle-1", name: "Synthetic circle" }]));
vi.mock("@corgtex/domain", () => ({
  listGoals: async () => fixture.goals,
  getGoalTree: async () => fixture.goals,
  listCircles,
  listHumanMembers: async () => [{ id: "member-1", user: { displayName: "Synthetic owner", email: "owner@example.test" } }],
  requireWorkspaceMembership: async () => ({ id: "member-1", role: "MEMBER" }),
  getGoal: vi.fn(), getWorkspaceArchiveRecord: vi.fn(), getMyGoalSlice: vi.fn(), listRecognitions: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requirePageActor: async () => actor }));
vi.mock("@/lib/workspace-feature-flags", () => ({ requireWorkspaceFeature: vi.fn() }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/components/MarkdownRenderer", () => ({ MarkdownRenderer: () => null }));
vi.mock("./actions", () => ({
  addKeyResultFormAction: vi.fn(), updateKeyResultFormAction: vi.fn(), deleteKeyResultFormAction: vi.fn(),
  archiveGoalFormAction: vi.fn(), createGoalFormAction: vi.fn(), editGoalFormAction: vi.fn(),
  returnGoalToDraftFormAction: vi.fn(), updateGoalFormAction: vi.fn(),
}));
import GoalsPage from "./page";

const measurements: object[] = [];
beforeEach(() => listCircles.mockClear());
afterAll(() => {
  vi.unstubAllGlobals();
  if (process.env.GOAL_EDITOR_BENCHMARK === "1") {
    mkdirSync(".artifacts/pun-93", { recursive: true });
    writeFileSync(`.artifacts/pun-93/${process.env.GOAL_EDITOR_BENCHMARK_LABEL ?? "render"}.json`, JSON.stringify(measurements, null, 2));
  }
});

// These are actual page JSX construction + React static SSR measurements with
// synthetic domain reads. HTML bytes exclude Flight; no production timings.
describe("Goals editor construction", () => {
  for (const count of [100, 500, 1000]) {
    for (const editable of [0, count]) {
      it(`constructs linear closed-editor choices for N=${count}, E=${editable}`, async () => {
        fixture.goals = Array.from({ length: count }, (_, index) => ({
          id: `goal-${index}`, title: `Synthetic Goal ${index}`, cadence: "QUARTERLY", level: "COMPANY",
          status: "DRAFT", version: 3, progressPercent: 0, keyResults: [], childGoals: [],
          authorUserId: index < editable ? actor.user.id : "another-author", isPrivate: true,
        }));
        let goalOptions = 0;
        let circleOptions = 0;
        let ownerOptions = 0;
        vi.stubGlobal("React", { ...React, createElement: (...args: Parameters<typeof React.createElement>) => {
          if (args[0] === "option") {
            const value = String((args[1] as { value?: string })?.value ?? "");
            if (value.startsWith("goal-")) goalOptions++;
            if (value.startsWith("circle-")) circleOptions++;
            if (value.startsWith("member-")) ownerOptions++;
          }
          return React.createElement(...args);
        } });
        const render = async () => {
          goalOptions = circleOptions = ownerOptions = 0;
          const start = performance.now();
          const page = await GoalsPage({ params: Promise.resolve({ workspaceId: "synthetic-workspace" }), searchParams: Promise.resolve({}) });
          const html = renderToStaticMarkup(page);
          return { ms: performance.now() - start, htmlBytes: Buffer.byteLength(html), goalOptions, circleOptions, ownerOptions };
        };
        const samples = [];
        if (process.env.GOAL_EDITOR_BENCHMARK === "1") for (let index = 0; index < 3; index++) await render();
        for (let index = 0; index < (process.env.GOAL_EDITOR_BENCHMARK === "1" ? 7 : 1); index++) samples.push(await render());
        samples.sort((a, b) => a.ms - b.ms);
        const result = { count, editable, ...samples[Math.floor(samples.length / 2)] };
        measurements.push(result);
        // The unchanged create form may construct one complete choice set. An
        // editable row must not construct any extra selector while menus are shut.
        expect(result.goalOptions).toBe(count);
        expect(result.circleOptions).toBe(1);
        expect(result.ownerOptions).toBe(1);
        expect(listCircles).toHaveBeenCalledWith("synthetic-workspace");
      });
    }
  }
});
