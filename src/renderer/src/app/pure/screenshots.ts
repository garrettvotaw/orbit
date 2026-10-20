/** The longest edge a screenshot is sent at; the model reads finer detail than this poorly anyway. */
export const MAX_EDGE = 2000;
/** Bedrock's cap on one image, the tighter of the places a lane's model runs. */
export const MAX_BYTES = 3.75 * 1024 * 1024;
export const MAX_SCREENSHOTS = 5;

/** The size to draw an image at so its longest edge fits, keeping its shape; never larger than it is. */
export function fitSize(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** How many bytes a base64 string decodes to. */
export function base64Bytes(data: string): number {
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length * 3) / 4 - pad;
}

/** How many of `adding` still fit beside the `current` ones under the cap. */
export function roomFor(current: number, adding: number): number {
  return Math.max(0, Math.min(adding, MAX_SCREENSHOTS - current));
}
