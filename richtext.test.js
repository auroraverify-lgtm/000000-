import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRichText } from '../public/js/util.js';

test('formats rich message text while escaping untrusted HTML and URLs', () => {
  const rendered = formatRichText(
    '**жирный** *курсив* ~~удалённый~~ `код`\n> цитата\n[сайт](https://example.com/path) www.example.org @member1 <img src=x onerror=alert(1)>',
    new Set(['member1']),
  );

  assert.match(rendered, /<strong>жирный<\/strong>/);
  assert.match(rendered, /<em>курсив<\/em>/);
  assert.match(rendered, /<del>удалённый<\/del>/);
  assert.match(rendered, /<code>код<\/code>/);
  assert.match(rendered, /<blockquote class="msg-quote">цитата<\/blockquote>/);
  assert.match(rendered, /href="https:\/\/example\.com\/path"/);
  assert.match(rendered, /href="https:\/\/www\.example\.org"/);
  assert.match(rendered, /class="mention" data-mention="@member1"/);
  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(rendered, /<img src=x/);
});

test('does not turn non-http markdown URLs into clickable links', () => {
  const rendered = formatRichText('[опасная](javascript:alert(1))');

  assert.doesNotMatch(rendered, /href=/);
  assert.match(rendered, /javascript:alert/);
});
