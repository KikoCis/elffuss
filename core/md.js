// Minimal, SAFE markdown for the chat (agent plugin style): escape ALL
// the HTML first, then apply a bounded set of transformations.
// Supports: ``` code blocks, `inline`, **bold**, *italics*, #### headings,
// - or numbered lists, and line breaks.
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const SENT = '\u0000'; // sentinel: impossible in normal text. Written as an
// escape, not as a literal NUL: a literal one makes git treat this source
// file as BINARY, so it never shows in a diff and `grep` skips it without
// saying so. The value is identical; only the spelling changes.

export function renderMarkdown(text) {
  // 1) set the code blocks aside (their insides are never touched)
  const blocks = [];
  let t = String(text).replace(/```(\w*)[ \t]*\n?([\s\S]*?)(?:```|$)/g, (_, lang, body) => {
    blocks.push({ lang, body });
    return SENT + (blocks.length - 1) + SENT;
  });

  t = esc(t);
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  t = t.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>');
  t = t.replace(/^#{1,6}\s*(.+)$/gm, '<h4>$1</h4>');
  t = t.replace(/^\s*[-•]\s+(.+)$/gm, '<li>$1</li>');
  t = t.replace(/^\s*\d+\.\s+(.+)$/gm, '<li class="num">$1</li>');
  t = t.replace(/(?:<li[^>]*>.*<\/li>\n?)+/g, m => '<ul>' + m.replace(/\n/g, '') + '</ul>');

  // line breaks: no <br> glued to block-level tags
  t = t.replace(/\n(?=<(?:ul|h4))/g, '').replace(/(<\/(?:ul|h4)>)\n/g, '$1');
  t = t.replace(/\n/g, '<br>');

  // 2) put the code blocks back
  t = t.replace(new RegExp(SENT + '(\\d+)' + SENT, 'g'), (_, i) => {
    const { lang, body } = blocks[+i];
    return `<pre class="codeblock">${lang ? `<span class="lang">${esc(lang)}</span>` : ''}<code>${esc(body.replace(/\n$/, ''))}</code></pre>`;
  });
  return t;
}
