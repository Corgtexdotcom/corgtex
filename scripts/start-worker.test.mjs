import { EventEmitter } from "node:events";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runWorker, workerCommand } from "./start-worker.mjs";

describe("start-worker", () => {
  it("runs the production worker through the tsx entry point", () => {
    const command = workerCommand("/app");

    expect(command.command).toBe(process.execPath);
    expect(command.args).toEqual([
      path.join("/app", "node_modules", "tsx", "dist", "cli.mjs"),
      path.join("/app", "apps", "worker", "src", "index.ts"),
    ]);
    expect(command.cwd).toBe("/app");
  });

  it("exits cleanly when the parent forwards shutdown to the worker", () => {
    const child = new EventEmitter();
    child.kill = vi.fn();
    const processObj = new EventEmitter();
    processObj.env = {};
    processObj.exit = vi.fn();
    const spawnFn = vi.fn(() => child);

    runWorker({ command: "node", args: ["worker"], cwd: "/app" }, { spawnFn, processObj });
    processObj.emit("SIGTERM");
    child.emit("exit", null, "SIGTERM");

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(processObj.exit).toHaveBeenCalledWith(0);
  });

  it("preserves failure status when the worker exits from an unexpected signal", () => {
    const child = new EventEmitter();
    child.kill = vi.fn();
    const processObj = new EventEmitter();
    processObj.env = {};
    processObj.exit = vi.fn();
    const spawnFn = vi.fn(() => child);

    runWorker({ command: "node", args: ["worker"], cwd: "/app" }, { spawnFn, processObj });
    child.emit("exit", null, "SIGABRT");

    expect(processObj.exit).toHaveBeenCalledWith(134);
  });
});
