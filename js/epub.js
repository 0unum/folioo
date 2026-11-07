// The e-book: the read text as an EPUB 3 that opens in Apple Books, Kobo,
// Calibre, Google Play Books… Set like the Edition — vermilion page marks,
// small-capital heads, a fleuron at the close — and it keeps the scan's page
// numbers as real e-book page numbers (Books shows them as "print page").
import { isRTL, arabicShare } from './reader.js';

export const defaultEpub = () => ({
  author: '',
  chapters: 'auto',   // auto | pages | headings | one
  cover: true,
  pageMarks: true,    // a small vermilion page number where each source page begins
});

const x = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inline = t => x(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|\s)\*(\S.*?\S)\*(?=\s|$)/g, '$1<i>$2</i>');

let bookLang = 'en';
function langOf(text, fallback = bookLang) {
  if (arabicShare(text) > 0.5) return 'ar';
  if (/[äöüßÄÖÜ]|\b(der|die|das|und|nicht|ist|ein|eine|mit|auf)\b/i.test(text)) return 'de';
  if (/\b(the|and|of|is|with|this|that)\b/i.test(text)) return 'en';
  return fallback === 'ar' ? 'en' : fallback;
}

const CSS = `@charset "utf-8";
body { margin: 0 5%; font-family: "Iowan Old Style", Palatino, Georgia, "Geeza Pro", "Noto Naskh Arabic", serif; line-height: 1.5; }
p { margin: 0; text-indent: 0; }
p + p { text-indent: 1.2em; }
p[dir="rtl"] { line-height: 1.8; }
p.lead::first-line { font-variant: small-caps; letter-spacing: .03em; }
h1, h2, h3 { font-weight: normal; page-break-after: avoid; break-after: avoid; }
h1 { font-size: 1.5em; text-align: center; margin: 2.2em 0 1em; line-height: 1.2; }
h2 { font-size: 1em; text-align: center; font-variant: small-caps; letter-spacing: .12em; margin: 1.8em 0 .8em; }
h3 { font-size: 1em; font-style: italic; margin: 1.4em 0 .5em; }
h1[dir="rtl"], h2[dir="rtl"] { font-variant: normal; letter-spacing: 0; font-weight: bold; }
ul { margin: .6em 0; padding-inline-start: 1.2em; }
li { margin: .15em 0; }
.folio { display: block; text-align: center; color: #B2442B; font-size: .75em; letter-spacing: .1em; margin: 1.6em 0 1em; text-indent: 0; }
.folio + p, h1 + p, h2 + p, h3 + p { text-indent: 0; }
.folio::before, .folio::after { content: " — "; color: #C9BBA5; }
.title { text-align: center; margin-top: 30%; }
.title .eyebrow { font-variant: small-caps; letter-spacing: .14em; color: #6B6257; font-size: .85em; margin-bottom: 2em; }
.title h1 { font-size: 2.1em; margin: 0 0 .4em; }
.title .sub { font-style: italic; color: #6B6257; }
.title .by { margin-top: 2.4em; font-variant: small-caps; letter-spacing: .1em; }
.fleuron { text-align: center; color: #B2442B; font-size: 1.4em; margin: 1.8em 0; text-indent: 0; }
.colophon { text-align: center; font-style: italic; color: #6B6257; font-size: .8em; text-indent: 0; }
.cover { margin: 0; padding: 0; text-align: center; }
.cover img { max-width: 100%; max-height: 100%; }
`;

function xhtml(title, lang, dir, body, extraHead = '') {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}"${dir === 'rtl' ? ' dir="rtl"' : ''}>
<head><meta charset="utf-8"/><title>${x(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/>${extraHead}</head>
<body>
${body}
</body>
</html>`;
}

function blockXHTML(b, lead) {
  const t = b.text.replace(/(\p{Ll})- (\p{Ll})/gu, '$1$2');
  const a = `xml:lang="${langOf(t)}" lang="${langOf(t)}" dir="${isRTL(t) ? 'rtl' : 'ltr'}"`;
  if (b.kind === 'heading') {
    const l = Math.min(3, Math.max(1, b.level || 2));
    return { html: `<h${l} ${a}>${inline(t.replace(/\n/g, ' '))}</h${l}>`, heading: t.replace(/\s+/g, ' ').trim(), level: l };
  }
  if (b.kind === 'list') {
    const items = t.split('\n').map(s => s.replace(/^\s*[-*•]\s+/, '')).filter(Boolean);
    return { html: `<ul ${a}>${items.map(i => `<li>${inline(i)}</li>`).join('')}</ul>` };
  }
  return { html: `<p ${a}${lead ? ' class="lead"' : ''}>${inline(t).replace(/\n/g, '<br/>')}</p>` };
}

/** Splits the kept text into chapters: [{ label, parts: [{html, heading?, level?, page?}] }]. */
function chaptersOf(doc, o) {
  const pages = doc.pages.filter(p => !p.excluded && (p.blocks || []).some(b => !b.removed && !b.pageNumber));
  const items = [];
  for (const p of pages) {
    items.push({ page: p.n });
    let lead = true;
    for (const b of p.blocks.filter(b => !b.removed && !b.pageNumber)) {
      const it = blockXHTML(b, lead && b.kind === 'paragraph');
      lead = b.kind === 'heading';
      items.push(it);
    }
  }
  const tops = items.filter(i => i.heading).map(i => i.level);
  const top = tops.length ? Math.min(...tops) : 0;
  const nTop = tops.filter(l => l === top).length;
  let mode = o.chapters;
  if (mode === 'auto') mode = nTop >= 2 ? 'headings' : pages.length > 1 && pages.length <= 400 ? 'pages' : 'one';
  if (mode === 'headings' && !nTop) mode = 'pages';

  const chapters = [];
  let cur = null;
  const open = label => { cur = { label, parts: [] }; chapters.push(cur); };
  for (const it of items) {
    if (it.page) {
      if (mode === 'pages') open(`Page ${it.page}`);
      if (!cur) open(mode === 'one' ? (doc.edition?.title || doc.name) : `Page ${it.page}`);
      cur.parts.push(it);
      continue;
    }
    if (mode === 'headings' && it.heading && it.level === top) {
      // Keep the page mark that came just before this heading with it.
      const mark = cur?.parts.at(-1)?.page ? cur.parts.pop() : null;
      if (cur && !cur.parts.some(p => p.html)) chapters.pop();
      open(it.heading);
      if (mark) cur.parts.push(mark);
    } else if (mode === 'pages' && it.heading && cur.label.startsWith('Page ') && !cur.named) {
      cur.label = it.heading; cur.named = true;
    }
    cur.parts.push(it);
  }
  return chapters.filter(c => c.parts.some(p => p.html));
}

// ---------- the cover ----------

function wrapLines(ctx, text, maxW) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

async function coverPNG(title, subtitle, author, pages) {
  const W = 1600, H = 2400;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const serif = '"Iowan Old Style", "New York", Palatino, Georgia, "Geeza Pro", serif';
  g.fillStyle = '#F6F2EA'; g.fillRect(0, 0, W, H);
  g.strokeStyle = '#D9CFBE'; g.lineWidth = 3; g.strokeRect(90, 90, W - 180, H - 180);
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  const rtl = isRTL(title);
  g.direction = rtl ? 'rtl' : 'ltr';

  g.fillStyle = '#6B6257';
  g.font = `40px ${serif}`;
  g.letterSpacing = '10px';
  g.fillText(`${pages} PAGES, READ AND SET`, W / 2, 620);
  g.letterSpacing = '0px';

  g.fillStyle = '#231F1A';
  let size = 150, lines;
  do { g.font = `${size}px ${serif}`; lines = wrapLines(g, title, W - 380); size -= 10; } while (lines.length > 4 && size > 70);
  size += 10;
  let y = 900;
  for (const l of lines) { g.fillText(l, W / 2, y); y += size * 1.15; }

  if (subtitle) {
    g.fillStyle = '#6B6257'; g.font = `italic 58px ${serif}`;
    g.direction = isRTL(subtitle) ? 'rtl' : 'ltr';
    y += 30;
    for (const l of wrapLines(g, subtitle, W - 420).slice(0, 3)) { g.fillText(l, W / 2, y); y += 76; }
  }

  g.fillStyle = '#B2442B'; g.font = `120px ${serif}`; g.direction = 'ltr';
  g.fillText('❧', W / 2, Math.max(y + 170, 1600));

  if (author) {
    g.fillStyle = '#231F1A'; g.font = `56px ${serif}`; g.letterSpacing = '6px';
    g.direction = isRTL(author) ? 'rtl' : 'ltr';
    g.fillText(author, W / 2, H - 300);
    g.letterSpacing = '0px';
  }
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  c.width = c.height = 0;
  return new Uint8Array(await blob.arrayBuffer());
}

// ---------- a small zip writer (EPUB is a zip with rules) ----------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = d => { let c = ~0; for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 255] ^ (c >>> 8); return ~c >>> 0; };

async function deflate(data) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const s = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  } catch { return null; }
}

async function zip(files) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = enc.encode(f.name);
    const raw = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const packed = f.store ? null : await deflate(raw);
    const body = packed && packed.length < raw.length ? packed : raw;
    const method = body === raw ? 0 : 8;
    const crc = crc32(raw);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, method, true);
    h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true); h.setUint32(14, crc, true);
    h.setUint32(18, body.length, true); h.setUint32(22, raw.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    chunks.push(new Uint8Array(h.buffer), name, body);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, method, true); cd.setUint16(12, dosTime, true); cd.setUint16(14, dosDate, true); cd.setUint32(16, crc, true);
    cd.setUint32(20, body.length, true); cd.setUint32(24, raw.length, true); cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/epub+zip' });
}

// ---------- the book ----------

/** doc: the session. Returns { blob, chapters }. */
export async function makeEPUB(doc, o) {
  const ed = doc.edition || {};
  const title = (ed.title || doc.name).replace(/\.(pdf|jpe?g|png|heic|webp|tiff?)$/i, '');
  const all = doc.pages.filter(p => !p.excluded).flatMap(p => (p.blocks || []).filter(b => !b.removed).map(b => b.text)).join(' ');
  const lang = langOf(all || title, 'en');
  bookLang = lang;
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const chapters = chaptersOf(doc, o);
  if (!chapters.length) throw new Error('There is no text to put in the book yet.');
  const id = 'urn:uuid:' + (crypto.randomUUID?.() || ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c => (c ^ Math.random() * 16 >> c / 4).toString(16)));
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const pageCount = doc.pages.filter(p => !p.excluded).length;

  const files = [{ name: 'mimetype', data: 'application/epub+zip', store: true }];
  files.push({ name: 'META-INF/container.xml', data: `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>` });
  files.push({ name: 'OEBPS/style.css', data: CSS });

  const manifest = [], spine = [], toc = [], pageList = [];
  if (o.cover) {
    files.push({ name: 'OEBPS/cover.png', data: await coverPNG(title, ed.subtitle, o.author, pageCount), store: true });
    files.push({ name: 'OEBPS/cover.xhtml', data: xhtml(title, lang, dir, `<div class="cover"><img src="cover.png" alt="${x(title)}"/></div>`) });
    manifest.push('<item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>',
      '<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>');
    spine.push('<itemref idref="cover" linear="yes"/>');
  }

  const tdir = isRTL(title) ? ' dir="rtl"' : '';
  files.push({ name: 'OEBPS/title.xhtml', data: xhtml(title, lang, dir, `<section class="title" epub:type="titlepage">
<p class="eyebrow">${pageCount} pages, read and set</p>
<h1${tdir}>${x(title)}</h1>
${ed.subtitle ? `<p class="sub"${isRTL(ed.subtitle) ? ' dir="rtl"' : ''}>${x(ed.subtitle)}</p>` : ''}
${o.author ? `<p class="by"${isRTL(o.author) ? ' dir="rtl"' : ''}>${x(o.author)}</p>` : ''}
<p class="fleuron">❧</p>
</section>`) });
  manifest.push('<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>');
  spine.push('<itemref idref="title"/>');

  chapters.forEach((ch, i) => {
    const file = `ch${String(i + 1).padStart(3, '0')}.xhtml`;
    const body = ch.parts.map(p => {
      if (!p.page) return p.html;
      pageList.push(`<li><a href="${file}#page-${p.page}">${p.page}</a></li>`);
      const mark = `<span epub:type="pagebreak" role="doc-pagebreak" id="page-${p.page}" aria-label="${p.page}" title="${p.page}"></span>`;
      return o.pageMarks ? `<p class="folio">${mark}${p.page}</p>` : mark;
    }).join('\n');
    const last = i === chapters.length - 1;
    const end = last ? `\n<p class="fleuron">❧</p>${ed.colophon ? `\n<p class="colophon">Read from ${x(doc.name)} and set in Folio, ${x(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }))}.</p>` : ''}` : '';
    files.push({ name: `OEBPS/${file}`, data: xhtml(ch.label, lang, dir, `<section epub:type="chapter" role="doc-chapter">\n${body}${end}\n</section>`) });
    manifest.push(`<item id="c${i + 1}" href="${file}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="c${i + 1}"/>`);
    toc.push(`<li><a href="${file}"${isRTL(ch.label) ? ' dir="rtl"' : ''}>${x(ch.label)}</a></li>`);
  });

  files.push({ name: 'OEBPS/nav.xhtml', data: xhtml(title, lang, dir, `<nav epub:type="toc" id="toc" role="doc-toc"><h1>Contents</h1><ol>
${toc.join('\n')}
</ol></nav>
${pageList.length ? `<nav epub:type="page-list" id="page-list" hidden="hidden"><h1>Pages</h1><ol>\n${pageList.join('\n')}\n</ol></nav>` : ''}
<nav epub:type="landmarks" id="landmarks" hidden="hidden"><ol>
${o.cover ? '<li><a epub:type="cover" href="cover.xhtml">Cover</a></li>' : ''}
<li><a epub:type="titlepage" href="title.xhtml">Title page</a></li>
<li><a epub:type="bodymatter" href="ch001.xhtml">Start</a></li>
</ol></nav>`) });
  manifest.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="css" href="style.css" media-type="text/css"/>');

  files.push({ name: 'OEBPS/content.opf', data: `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${lang}"${dir === 'rtl' ? ' dir="rtl"' : ''}>
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${id}</dc:identifier>
    <dc:title>${x(title)}</dc:title>
    <dc:language>${lang}</dc:language>
    ${o.author ? `<dc:creator id="author">${x(o.author)}</dc:creator>` : ''}
    ${ed.subtitle ? `<dc:description>${x(ed.subtitle)}</dc:description>` : ''}
    <dc:source>${x(doc.name)}</dc:source>
    <meta property="dcterms:modified">${modified}</meta>
    ${o.cover ? '<meta name="cover" content="cover-image"/>' : ''}
  </metadata>
  <manifest>
    ${manifest.join('\n    ')}
  </manifest>
  <spine${dir === 'rtl' ? ' page-progression-direction="rtl"' : ''}>
    ${spine.join('\n    ')}
  </spine>
</package>` });

  return { blob: await zip(files), chapters: chapters.length };
}
