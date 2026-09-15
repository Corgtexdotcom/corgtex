import { describe, expect, it, vi } from "vitest";
import { inspectSource, resolveSourceImage, LABEL } from "./bootstrap-synthetic-ops.mjs";
import { SOURCE_IMAGE, SOURCE_CONFIG_IMAGE } from "./synthetic-ops-source.mjs";

const image = Id => JSON.stringify([{ Id, Architecture: "arm64", Os: "linux" }]);

describe("pinned synthetic image identity across Docker stores", () => {
  it("uses the index identity when the daemon supports it", async () => {
    const docker = vi.fn().mockResolvedValue(image(SOURCE_IMAGE));
    await expect(resolveSourceImage(docker)).resolves.toBe(SOURCE_IMAGE);
    expect(docker.mock.calls).toEqual([[["image", "inspect", SOURCE_IMAGE]]]);
  });
  it("resolves only the pinned config identity when index lookup fails", async () => {
    const docker = vi.fn().mockRejectedValueOnce({ code: "CHILD_FAILED" }).mockResolvedValueOnce(image(SOURCE_CONFIG_IMAGE));
    await expect(resolveSourceImage(docker)).resolves.toBe(SOURCE_CONFIG_IMAGE);
    expect(docker.mock.calls).toEqual([[["image", "inspect", SOURCE_IMAGE]], [["image", "inspect", SOURCE_CONFIG_IMAGE]]]);
  });
  it.each(["CHILD_DEADLINE", "CHILD_INTERRUPTED", "CHILD_OUTPUT_LIMIT"])("does not retry %s", async code => {
    const docker = vi.fn().mockRejectedValue({ code });
    await expect(resolveSourceImage(docker)).rejects.toMatchObject({ code });
    expect(docker).toHaveBeenCalledTimes(1);
  });
  it.each([
    { metadata: [{ Id: "sha256:unrelated", Architecture: "arm64", Os: "linux" }] },
    { metadata: [{ Id: SOURCE_CONFIG_IMAGE, Architecture: "amd64", Os: "linux" }] },
    { metadata: [{ Id: SOURCE_CONFIG_IMAGE, Architecture: "arm64", Os: "windows" }] },
    { metadata: [] },
  ])("rejects mismatched or absent image metadata", async ({ metadata }) => {
    const docker = vi.fn().mockResolvedValue(JSON.stringify(metadata));
    await expect(resolveSourceImage(docker)).rejects.toMatchObject({ code: "SOURCE_IMAGE_MISMATCH" });
    expect(docker).toHaveBeenCalledTimes(1);
  });
  it("binds the running container to the selected image identity", async () => {
    const id = "12345678-1234-1234-1234-123456789abc";
    const owned = { id, network: `syn-ops-${id}`, container: `syn-source-${id}`, image: SOURCE_CONFIG_IMAGE };
    const network = { Internal: true, EnableIPv6: false, Labels: { [LABEL]: id }, IPAM: { Config: [{ Gateway: "172.20.0.1" }] } };
    const container = { Image: SOURCE_CONFIG_IMAGE, Config: { Labels: { [LABEL]: id } }, HostConfig: {},
      NetworkSettings: { Networks: { [owned.network]: { IPAddress: "172.20.0.2" } } } };
    const docker = vi.fn(async args => JSON.stringify([args[0] === "network" ? network : container]));
    await expect(inspectSource(docker, owned)).resolves.toEqual({ address: "172.20.0.2", gateway: "172.20.0.1" });
    container.Image = SOURCE_IMAGE;
    await expect(inspectSource(docker, owned)).rejects.toMatchObject({ code: "FIXTURE_NETWORK_OR_OWNER_DRIFT" });
  });
});
