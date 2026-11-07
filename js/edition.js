// The Edition: the text set as a small, quiet book. Folio's hand shows only in
// the setting — a vermilion folio between hairlines where each source page
// begins, small capitals for heads, a fleuron at the close. No watermark.
import { isRTL, arabicShare } from './reader.js';

export const defaultEdition = () => ({
  page: 'A5',            // A5 | A4 | Letter
  type: 'regular',       // regular | large
  keepColumns: true,     // pages set in two columns in the scan stay in two
  titlePage: true,
  marginNotes: true,     // "p. 12" beside each source page
  runningHeads: true,
  colophon: false,
  paperTint: true,
  justify: false,
  title: '',
  subtitle: '',
});

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function langOf(text) {
  const a = arabicShare(text);
  if (a > 0.5) return 'ar';
  return /[äöüßÄÖÜ]|\b(der|die|das|und|nicht|ist)\b/.test(text) ? 'de' : 'en';
}

/** Light inline Markdown for the few marks OCR text carries. */
function inline(t) {
  return esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|\s)\*(\S.*?\S)\*(?=\s|$)/g, '$1<i>$2</i>');
}

function blockHTML(b, firstAfterHead) {
  const t = b.text.replace(/(\p{Ll})- (\p{Ll})/gu, '$1$2');
  const lang = langOf(t);
  const dir = isRTL(t) ? 'rtl' : 'ltr';
  const attrs = `lang="${lang}" dir="${dir}"`;
  if (b.kind === 'heading') {
    const lvl = Math.min(3, Math.max(1, b.level || 2));
    return `<h${lvl + 1} class="ed-h${lvl}" ${attrs}>${inline(t)}</h${lvl + 1}>`;
  }
  if (b.kind === 'list') {
    const items = t.split('\n').map(l => l.replace(/^\s*[-*•]\s+/, '')).filter(Boolean);
    return `<ul class="ed-list" ${attrs}>${items.map(i => `<li>${inline(i)}</li>`).join('')}</ul>`;
  }
  return `<p class="ed-p${firstAfterHead ? ' ed-lead' : ''}" ${attrs}>${inline(t)}</p>`;
}

export function editionCSS(o, scope = '') {
  const S = scope ? scope + ' ' : '';
  const size = { A5: ['148mm', '210mm'], A4: ['210mm', '297mm'], Letter: ['8.5in', '11in'] }[o.page] || ['148mm', '210mm'];
  const base = (o.type === 'large' ? 1.18 : 1) * (o.page === 'A5' ? 10.5 : 11.5);
  return `
@page { size: ${size[0]} ${size[1]}; margin: 17mm 16mm 19mm 18mm; }
${S}.ed { --ink:#231F1A; --soft:#6B6257; --faint:#9C9284; --accent:#B2442B; --rule:#D9CFBE;
  font-family: ui-serif, "New York", "Iowan Old Style", "Palatino", Georgia, "Geeza Pro", "Noto Naskh Arabic", serif;
  font-size: ${base}pt; line-height: 1.5; color: var(--ink);
  font-variant-numeric: oldstyle-nums; hyphens: auto; -webkit-hyphens: auto;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
  ${o.paperTint ? 'background:#FBF8F1;' : 'background:#fff;'} }
${S}.ed * { box-sizing: border-box; }
${S}.ed-screen { max-width: 34em; margin: 0 auto; padding: 2.4em 1.6em 3em; }
${S}.ed-title { min-height: 70vh; display:flex; flex-direction:column; justify-content:center; text-align:center; break-after: page; page-break-after: always; }
${S}.ed-title .ed-eyebrow { font-variant: all-small-caps; letter-spacing: .14em; color: var(--soft); font-size: .9em; margin: 0 0 1.6em; }
${S}.ed-title h1 { font-weight: 400; font-size: 2.3em; line-height: 1.15; margin: 0 0 .4em; letter-spacing: -.005em; }
${S}.ed-title .ed-sub { font-style: italic; color: var(--soft); margin: 0; }
${S}.ed-fleuron { color: var(--accent); font-size: 1.4em; margin: 1.6em 0 0; text-align:center; }
${S}.ed-folio { display:flex; align-items:center; gap:.8em; margin: 1.8em 0 1.1em; color: var(--accent);
  font-size: .8em; letter-spacing: .08em; font-variant-numeric: lining-nums; break-after: avoid; }
${S}.ed-folio::before, ${S}.ed-folio::after { content:""; flex:1; border-top: .5pt solid var(--rule); }
${S}.ed-leaf { position: relative; }
${S}.ed-leaf.ed-cols { column-count: 2; column-gap: 1.6em; column-rule: .5pt solid var(--rule); }
${S}.ed-leaf.ed-cols .ed-h1, ${S}.ed-leaf.ed-cols .ed-h2 { column-span: all; }
${S}.ed-note { position:absolute; left:-4.2em; top:.25em; width:3.4em; text-align:right; font-style: italic;
  font-size: .72em; color: var(--faint); }
${S}.ed-p { margin: 0; text-align: ${o.justify ? 'justify' : 'start'}; orphans: 2; widows: 2; }
${S}.ed-p + .ed-p { text-indent: 1.2em; }
${S}.ed-p[dir=rtl] { line-height: 1.75; }
${S}.ed-lead::first-line { font-variant: small-caps; letter-spacing: .03em; }
${S}.ed-h1, ${S}.ed-h2, ${S}.ed-h3 { font-weight: 400; break-after: avoid; page-break-after: avoid; margin: 1.4em 0 .6em; }
${S}.ed-h1 { font-size: 1.5em; line-height: 1.2; text-align:center; }
${S}.ed-h2 { font-size: 1em; font-variant: all-small-caps; letter-spacing: .12em; text-align:center; }
${S}.ed-h3 { font-size: 1em; font-style: italic; }
${S}.ed-h2[dir=rtl], ${S}.ed-h1[dir=rtl] { font-variant: normal; letter-spacing: 0; font-weight: 600; }
${S}.ed-list { margin: .5em 0; padding-inline-start: 1.2em; }
${S}.ed-list li { margin: .15em 0; }
${S}.ed-list li::marker { color: var(--accent); }
${S}.ed-head { display:none; }
${S}.ed-close { text-align:center; color: var(--accent); margin: 2.2em 0 0; font-size: 1.3em; }
${S}.ed-colophon { text-align:center; font-style: italic; color: var(--soft); font-size: .8em; margin-top: .8em; }
@media print {
  ${S}.ed-screen { max-width: none; padding: 0; }
  ${S}.ed-head { display:block; position: fixed; top: -10mm; left: 0; right: 0; text-align:center;
    font-variant: all-small-caps; letter-spacing: .14em; font-size: 7.5pt; color: var(--faint); }
}
@media screen and (max-width: 600px) {
  ${S}.ed-note { position: static; display: block; width: auto; text-align: start; margin-bottom: .3em; }
}
${o.marginNotes ? '' : `${S}.ed-note { display:none; }`}
`;
}

export function editionBody(doc, o) {
  const title = o.title || doc.name.replace(/\.[^.]+$/, '');
  const pages = doc.pages.filter(p => !p.excluded && (p.blocks || []).some(b => !b.removed));
  const parts = [];
  if (o.runningHeads) parts.push(`<div class="ed-head">${esc(title)}</div>`);
  if (o.titlePage) {
    parts.push(`<header class="ed-title">
      <p class="ed-eyebrow">${esc(doc.pages.length)} pages, read and set</p>
      <h1 ${isRTL(title) ? 'dir="rtl"' : ''}>${esc(title)}</h1>
      ${o.subtitle ? `<p class="ed-sub">${esc(o.subtitle)}</p>` : ''}
      <div class="ed-fleuron">❧</div>
    </header>`);
  }
  pages.forEach((p, i) => {
    const blocks = p.blocks.filter(b => !b.removed && !b.pageNumber);
    let afterHead = i === 0;
    const html = blocks.map(b => {
      const h = blockHTML(b, afterHead && b.kind === 'paragraph');
      afterHead = b.kind === 'heading' ? true : b.kind === 'paragraph' ? false : afterHead;
      return h;
    }).join('\n');
    const cols = o.keepColumns && p.cols === 2;
    parts.push(`<div class="ed-folio">${p.n}</div>
      <section class="ed-leaf${cols ? ' ed-cols' : ''}"><span class="ed-note">p. ${p.n}</span>${html}</section>`);
  });
  parts.push('<div class="ed-close">❧</div>');
  if (o.colophon) {
    const d = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    parts.push(`<p class="ed-colophon">Read from ${esc(doc.name)} and set in Folio, ${esc(d)}.</p>`);
  }
  return `<article class="ed"><div class="ed-screen">${parts.join('\n')}</div></article>`;
}

/** A standalone page: open it anywhere, print it to PDF from any browser. */
export function editionDocument(doc, o) {
  const title = o.title || doc.name.replace(/\.[^.]+$/, '');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>html,body{margin:0;background:${o.paperTint ? '#FBF8F1' : '#fff'}}${editionCSS(o)}</style></head>
<body>${editionBody(doc, o)}</body></html>`;
}
