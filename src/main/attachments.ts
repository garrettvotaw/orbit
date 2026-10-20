import type { ImageAttachment } from '../shared/types.ts';

type ContentBlock =
  { type: 'image'; source: { type: 'base64'; media_type: string; data: string } } | { type: 'text'; text: string };

/** What a user message carries: plain words, or the screenshots first and then the words. */
export function userContent(text: string, images: ImageAttachment[]): string | ContentBlock[] {
  if (!images.length) return text;
  const blocks: ContentBlock[] = images.map((i) => ({
    type: 'image',
    source: { type: 'base64', media_type: i.mediaType, data: i.data },
  }));
  return text ? [...blocks, { type: 'text', text }] : blocks;
}

/** The words as the feed shows them, with a note of how many screenshots went along. */
export function withScreenshots(text: string, count: number): string {
  if (!count) return text;
  const note = count === 1 ? '[screenshot]' : `[${count} screenshots]`;
  return text ? `${text}\n${note}` : note;
}
