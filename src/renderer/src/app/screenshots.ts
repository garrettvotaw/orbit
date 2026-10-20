import type { ImageAttachment } from '../../../shared/types';
import { base64Bytes, fitSize, MAX_BYTES, MAX_EDGE } from './pure/screenshots';

/** A screenshot waiting in a lane's composer; the id keeps the thumbnails apart. */
export interface Screenshot extends ImageAttachment {
  id: string;
}

/** Types the model reads as they are, so a small one goes through untouched. */
const SENDABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Tried in order when an image has to be redrawn: a screenshot keeps its sharp edges as PNG if it can. */
const ENCODINGS: Array<{ type: string; quality?: number }> = [
  { type: 'image/png' },
  { type: 'image/jpeg', quality: 0.85 },
  { type: 'image/jpeg', quality: 0.7 },
];

/** The image files in a paste, a drop, or a file picker. */
export function imageFiles(source: { files: FileList | null } | null): File[] {
  return [...(source?.files ?? [])].filter((f) => f.type.startsWith('image/'));
}

function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('Could not read that image.'));
    reader.readAsDataURL(blob);
  });
}

/**
 * A pasted or dropped image, ready to send: kept as it is when it already fits, otherwise
 * redrawn with its longest edge at `MAX_EDGE` and encoded small enough to go.
 */
export async function toScreenshot(file: Blob): Promise<Screenshot> {
  const id = crypto.randomUUID();
  const bitmap = await createImageBitmap(file);
  const size = fitSize(bitmap.width, bitmap.height, MAX_EDGE);
  const resized = size.width !== bitmap.width || size.height !== bitmap.height;
  if (!resized && SENDABLE.has(file.type) && file.size <= MAX_BYTES) {
    bitmap.close();
    return { id, mediaType: file.type, data: await base64Of(file) };
  }
  const canvas = new OffscreenCanvas(size.width, size.height);
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();
  for (const { type, quality } of ENCODINGS) {
    const data = await base64Of(await canvas.convertToBlob({ type, quality }));
    if (base64Bytes(data) <= MAX_BYTES) return { id, mediaType: type, data };
  }
  throw new Error('That screenshot is too big to send, even shrunk.');
}
