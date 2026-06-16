import { describe, expect, it } from "vitest";

import {
  CLIENT_FEATURE_POSTURE_NAMES,
  CONTROL_PLANE_WORKSPACE_FEATURE_FLAGS,
  featurePostureFlags,
} from "./control-plane";

/**
 * C2 byte-for-byte parity anchor. `CLIENT_FEATURE_POSTURES` was reshaped from
 * raw flag overrides into module-key bundles. This pins the expanded output of
 * `featurePostureFlags` to the exact flag/enabled list the previous flat
 * flag-override maps produced, proving the reshape is behavior-preserving.
 *
 * LEGACY_POSTURE_OVERRIDES is the literal pre-refactor data structure.
 */
const LEGACY_POSTURE_OVERRIDES: Record<string, Record<string, boolean>> = {
  standard: {},
  minimal: {
    TOOL_LINKS: false,
    BUILD_ARTIFACTS: false,
    CONTEXT_MAPS: false,
    MEETING_RECORDERS: false,
    MEETING_CONTEXTUAL_INTELLIGENCE: false,
    CONTEXT_MAP_AI: false,
    SLACK_MEETING_ACTION_REVIEW: false,
    AI_WORKSPACES: false,
    OPENWORK_DEFAULT: false,
    EXECUTION_PACKETS: false,
    MANAGED_ENTERPRISE_SERVICES: false,
  },
  enterprise: {
    AGENT_GOVERNANCE: true,
    SETTINGS_GENERAL: true,
    MEETING_RECORDERS: true,
    MEETING_CONTEXTUAL_INTELLIGENCE: true,
    AI_WORKSPACES: true,
    EXECUTION_PACKETS: true,
    MANAGED_ENTERPRISE_SERVICES: true,
  },
};

function legacyPostureFlags(posture: string) {
  const overrides = LEGACY_POSTURE_OVERRIDES[posture] ?? {};
  return CONTROL_PLANE_WORKSPACE_FEATURE_FLAGS.map((definition) => ({
    flag: definition.flag,
    enabled: overrides[definition.flag] ?? definition.defaultEnabled,
  }));
}

describe("CLIENT_FEATURE_POSTURES (module-key bundles)", () => {
  it("supports exactly the prior posture names", () => {
    expect([...CLIENT_FEATURE_POSTURE_NAMES].sort()).toEqual(["enterprise", "minimal", "standard"]);
  });

  for (const posture of ["standard", "minimal", "enterprise"] as const) {
    it(`expands "${posture}" to the exact legacy flag set`, () => {
      expect(featurePostureFlags(posture)).toEqual(legacyPostureFlags(posture));
    });
  }
});
