import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from './markdown.ts';

test("renderMarkdown turns the skill's preview into headings, lists, code, and links", () => {
  const html = renderMarkdown(
    [
      '## PR #7107 Review — 3 comments',
      '',
      '1. **[major]** `libs/x/feature-flag.service.ts:92`',
      '   This JSDoc still describes the old gate.',
      '',
      '```ts',
      "expect(body).toHaveProperty('featureFlagOverrides');",
      '```',
      '',
      'See [the review](https://github.com/o/r/pull/7107#pullrequestreview-1).',
    ].join('\n'),
  );
  assert.match(html, /<h2[^>]*>PR #7107 Review — 3 comments<\/h2>/);
  assert.match(
    html,
    /<ol>\s*<li>.*<strong>\[major\]<\/strong> <code>libs\/x\/feature-flag\.service\.ts:92<\/code>/s,
  );
  assert.match(
    html,
    /<pre><code class="language-ts">expect\(body\)\.toHaveProperty\(&#39;featureFlagOverrides&#39;\);/,
  );
  assert.match(
    html,
    /<a href="https:\/\/github\.com\/o\/r\/pull\/7107#pullrequestreview-1">the review<\/a>/,
  );
});

test('renderMarkdown keeps single line breaks and escapes raw html', () => {
  const html = renderMarkdown('line one\nline two\n\n<script>alert(1)</script> & <b>bold?</b>');
  assert.match(html, /line one<br>line two/);
  assert.ok(!/<script>alert/.test(html), 'script tags are not emitted as tags');
  assert.match(html, /&lt;script&gt;|<p>&lt;script/);
});
