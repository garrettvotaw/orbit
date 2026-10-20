import type { FeedEntry } from './types.ts';

export interface AskOption {
  label: string;
  /** What to send back when this option is picked. */
  reply: string;
}

/** What a lane raised with needs_you: the question, and the choices it laid out. */
export interface Ask {
  text: string;
  options: AskOption[];
}

/** The lane's closing words: the run of text entries at the very end of the feed, joined. */
export function latestSay(entries: FeedEntry[]): string | null {
  const tail: string[] = [];
  for (let i = entries.length - 1; i >= 0 && entries[i].kind === 'text'; i--) tail.unshift(entries[i].text);
  const text = tail.join('\n\n').trim();
  return text || null;
}
