import { describe, expect, it, vi } from "vitest";
import { processAvatarUpload } from "./avatar";

vi.mock("sharp", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      resize: vi.fn().mockReturnThis(),
      webp: vi.fn().mockReturnThis(),
      toBuffer: vi.fn().mockResolvedValue(Buffer.from("mock-processed-image")),
    })),
  };
});

describe("processAvatarUpload", () => {
  it("throws on empty buffer", async () => {
    await expect(processAvatarUpload(Buffer.from(""))).rejects.toThrow("Empty file provided.");
  });

  it("throws on overly large payload", async () => {
    const largeBuffer = Buffer.alloc(6 * 1024 * 1024); // 6MB
    await expect(processAvatarUpload(largeBuffer)).rejects.toThrow("Image exceeds maximum allowed size");
  });

  it("returns a data url", async () => {
    const validBuffer = Buffer.from("fake-image");
    const result = await processAvatarUpload(validBuffer);
    expect(result).toBe("data:image/webp;base64,bW9jay1wcm9jZXNzZWQtaW1hZ2U=");
  });
});
