import sharp from "sharp";
import { AppError } from "./errors";

const MAX_AVATAR_SIZE_PX = 256;
const WEBP_QUALITY = 80;
const MAX_UPLOAD_SIZE_BYTES = 5 * 1024 * 1024; // 5MB before processing

/**
 * Processes an uploaded image buffer to be used as an avatar.
 * Validates the size, resizes it to a max of 256x256, converts to WebP,
 * and returns it as a base64 data URL.
 */
export async function processAvatarUpload(buffer: Buffer): Promise<string> {
  if (buffer.length === 0) {
    throw new AppError(400, "INVALID_INPUT", "Empty file provided.");
  }

  if (buffer.length > MAX_UPLOAD_SIZE_BYTES) {
    throw new AppError(400, "PAYLOAD_TOO_LARGE", `Image exceeds maximum allowed size of ${MAX_UPLOAD_SIZE_BYTES / (1024 * 1024)}MB.`);
  }

  try {
    const processedBuffer = await sharp(buffer)
      .resize({
        width: MAX_AVATAR_SIZE_PX,
        height: MAX_AVATAR_SIZE_PX,
        fit: "cover",
        position: "center",
        withoutEnlargement: true,
      })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();

    const base64Data = processedBuffer.toString("base64");
    return `data:image/webp;base64,${base64Data}`;
  } catch (error) {
    throw new AppError(400, "INVALID_INPUT", "Failed to process image. Ensure it is a valid image file.");
  }
}
