import { marked } from 'marked';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

marked.use({
  gfm: true,
  breaks: true,
  async: false,
  // Raw HTML in the assistant's text is shown as text, never interpreted.
  renderer: { html: ({ text }) => escapeHtml(text) },
});

/**
 * Markdown as the assistant writes it, rendered to HTML for the feed. Angular's `innerHTML`
 * sanitizer removes anything active before it reaches the page, so this only shapes the text.
 */
export function renderMarkdown(text: string): string {
  return marked.parse(text) as string;
}
