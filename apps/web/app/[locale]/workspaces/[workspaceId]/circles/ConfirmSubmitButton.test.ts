import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: vi.fn(),
    useState: vi.fn(() => [true, vi.fn()]),
  };
});

import { ConfirmSubmitButton } from "./ConfirmSubmitButton";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Role archive confirmation", () => {
  it("prevents the form submission when the user cancels", () => {
    vi.stubGlobal("React", React);
    const confirm = vi.fn(() => false);
    vi.stubGlobal("window", { confirm });
    const preventDefault = vi.fn();
    const button = ConfirmSubmitButton({ children: "Archive", message: "Archive this role?" });

    button.props.onClick({ preventDefault } as never);

    expect(confirm).toHaveBeenCalledWith("Archive this role?");
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("allows submission after confirmation", () => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("window", { confirm: vi.fn(() => true) });
    const preventDefault = vi.fn();
    const button = ConfirmSubmitButton({ children: "Archive", message: "Archive this role?" });

    button.props.onClick({ preventDefault } as never);

    expect(preventDefault).not.toHaveBeenCalled();
  });
});
