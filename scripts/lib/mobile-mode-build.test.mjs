import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  assertUnchangedMobileModeBuild,
  INSPECTED_MOBILE_MODE_SOURCES,
  inspectMobileModeBuild,
  MOBILE_SHELL_SOURCE_PATH,
  mobileModeStorageKey,
  readMobileShellSourceBlob,
  resolveMobileModeBuild,
} from "./mobile-mode-build.mjs";

const LEGACY_SHA = "eb423aca0618638cf7cd742dcb84397c492ba09b";
const SCOPED_BLOB = "f1e7c033043897dc1d140bb84d0d3fba4641293c";
const LEGACY_BLOB = "bd5d6d6a52443da19938aca6a999dd0da69b332f";

function healthyBuild(gitSha) {
  return {
    status: "ok",
    release: {
      gitSha,
      runtime: { gitSha, source: "baked", evidence: "baked" },
      configured: { gitSha },
      drift: { gitSha: false, imageTag: false, version: false, details: [] },
    },
  };
}

describe("client readiness mobile mode build binding", () => {
  it("selects the inspected legacy source and only its global storage key", async () => {
    const build = await resolveMobileModeBuild(healthyBuild(LEGACY_SHA), {
      readSourceBlob: vi.fn().mockResolvedValue(LEGACY_BLOB),
    });
    expect(build).toEqual({
      gitSha: LEGACY_SHA,
      sourceBlobSha: LEGACY_BLOB,
      ...INSPECTED_MOBILE_MODE_SOURCES[LEGACY_BLOB],
    });
    expect(mobileModeStorageKey(build, "/workspaces/workspace-1")).toBe("corgtex.mobileMode");
  });

  it("recognizes a newer commit only when it has the same inspected scoped source blob", async () => {
    const newerSha = "a".repeat(40);
    const build = await resolveMobileModeBuild(healthyBuild(newerSha), {
      readSourceBlob: vi.fn().mockResolvedValue(SCOPED_BLOB),
    });
    expect(build.inspectedGitSha).not.toBe(newerSha);
    expect(mobileModeStorageKey(build, "/es/workspaces/workspace-1/settings"))
      .toBe("corgtex.mobileMode.workspace-1");
    expect(mobileModeStorageKey(build, "/workspaces/workspace-2"))
      .toBe("corgtex.mobileMode.workspace-2");
  });

  it("resolves the real checked-out source object for the scoped contract", async () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(await readMobileShellSourceBlob(head)).toBe(SCOPED_BLOB);
    await expect(readMobileShellSourceBlob("x".repeat(40))).rejects.toThrow("full serving Git SHA");
  });

  it("resolves an older accepted release from full history when the verifier checkout is shallow", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "corgtex-mobile-build-"));
    const source = path.join(temp, "source");
    const verifier = path.join(temp, "verifier");
    const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    try {
      await mkdir(source);
      git(source, "init", "-q", "--initial-branch=main");
      const shellPath = path.join(source, MOBILE_SHELL_SOURCE_PATH);
      await mkdir(path.dirname(shellPath), { recursive: true });
      await writeFile(shellPath, await readFile(path.join(process.cwd(), MOBILE_SHELL_SOURCE_PATH)));
      git(source, "add", ".");
      git(source, "-c", "user.name=Smoke Test", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "accepted");
      const acceptedSha = git(source, "rev-parse", "HEAD");
      await writeFile(path.join(source, "later.txt"), "verifier checkout\n");
      git(source, "add", ".");
      git(source, "-c", "user.name=Smoke Test", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "later");
      git(temp, "clone", "-q", "--depth=1", pathToFileURL(source).href, verifier);
      git(verifier, "clone", "-q", source, ".accepted-source");
      expect(() => git(verifier, "cat-file", "-e", `${acceptedSha}^{commit}`)).toThrow();
      expect(await readMobileShellSourceBlob(acceptedSha, verifier)).toBe(SCOPED_BLOB);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("rejects missing, drifting, mismatched, and unavailable serving source before storage verification", async () => {
    const unavailable = vi.fn().mockRejectedValue(new Error("missing source"));
    const noSha = healthyBuild(null);
    const drift = healthyBuild(LEGACY_SHA);
    drift.release.drift.imageTag = true;
    const notBaked = healthyBuild(LEGACY_SHA);
    notBaked.release.runtime.source = "configured";
    for (const health of [noSha, drift, notBaked]) {
      await expect(resolveMobileModeBuild(health, { readSourceBlob: unavailable })).rejects.toThrow("BUILD_UNVERIFIED");
    }
    expect(unavailable).not.toHaveBeenCalled();
    await expect(resolveMobileModeBuild(healthyBuild(LEGACY_SHA), {
      expectedGitSha: "b".repeat(40),
    })).rejects.toThrow("did not match expected");
    await expect(readMobileShellSourceBlob("b".repeat(40))).rejects.toThrow("BUILD_UNKNOWN");
    expect(() => mobileModeStorageKey(null, "/workspaces/workspace-1")).toThrow("BUILD_UNKNOWN");
  });

  it("fails an unknown source object without accepting either storage key", async () => {
    const unknownBlob = "c".repeat(40);
    await expect(resolveMobileModeBuild(healthyBuild(LEGACY_SHA), {
      readSourceBlob: vi.fn().mockResolvedValue(unknownBlob),
    })).rejects.toMatchObject({
      message: expect.stringContaining("BUILD_UNKNOWN"),
      mobileModeBuild: { gitSha: LEGACY_SHA, sourceBlobSha: unknownBlob, contract: null },
    });
  });

  it("refuses a release change during QA even if both commits use the same source contract", async () => {
    const initial = await resolveMobileModeBuild(healthyBuild(LEGACY_SHA), {
      readSourceBlob: vi.fn().mockResolvedValue(LEGACY_BLOB),
    });
    const same = await resolveMobileModeBuild(healthyBuild(LEGACY_SHA), {
      readSourceBlob: vi.fn().mockResolvedValue(LEGACY_BLOB),
    });
    expect(() => assertUnchangedMobileModeBuild(initial, same)).not.toThrow();
    expect(() => assertUnchangedMobileModeBuild(initial, { ...same, gitSha: "a".repeat(40) }))
      .toThrow("BUILD_CHANGED");
  });

  it("reads health for build evidence through a synthetic fetch", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => healthyBuild(LEGACY_SHA) });
    const build = await inspectMobileModeBuild("https://synthetic.invalid", {
      fetchImpl,
      readSourceBlob: vi.fn().mockResolvedValue(LEGACY_BLOB),
    });
    expect(fetchImpl.mock.calls[0][0].href).toBe("https://synthetic.invalid/api/health");
    expect(build).toMatchObject({ gitSha: LEGACY_SHA, sourceBlobSha: LEGACY_BLOB, contract: "legacy-global-v1" });
  });
});
