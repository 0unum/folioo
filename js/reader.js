// Reading pages: render them, take the PDF's own text where it has some,
// and read the rest with Tesseract. All rectangles are fractions of the page
// (0…1, origin top-left), so they work at any zoom.

import * as pdfjs from '../vendor/pdfjs/pdf.min.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;

const BASE = new URL('../', import.meta.url).href;

// ---------- settings ----------

export const LANGUAGES = [
  { id: 'auto', label: 'Automatic', detail: 'Finds Arabic, German or both on each page' },
  { id: 'german', label: 'Deutsch', detail: 'German: umlauts, ß and „quotes“' },
  { id: 'arabic', label: 'العربية', detail: 'Arabic, with English for Latin words' },
  { id: 'english', label: 'English', detail: 'English only' },
];

export const QUALITIES = [
  { id: 'best', label: 'Best', detail: 'Reads at full resolution, and reads unsure lines a second time, larger. Slower.' },
  { id: 'fast', label: 'Fast', detail: 'One pass at lower resolution. About twice as fast, with more lost letters.' },
];

export const defaultOCR = () => ({ language: 'auto', quality: 'best', forceOCR: false, keepPageNumbers: false });

/** What matters for "was this page read with today's settings?" */
export const readKey = s => `${s.language}|${s.quality}|${s.forceOCR ? 1 : 0}`;

export function ocrSummary(s) {
  const lang = LANGUAGES.find(l => l.id === s.language)?.label ?? s.language;
  return `${lang} · ${s.quality === 'best' ? 'Best' : 'Fast'}${s.forceOCR ? ' · scanning every page' : ''}`;
}

/** Seconds a page takes on a phone, learned as pages are read. */
export const pace = { ocr: { best: 14, fast: 7 }, text: 0.3 };

// ---------- opening ----------

export class Source {
  constructor(kind, files) {
    this.kind = kind;   // 'pdf' | 'images'
    this.files = files; // [{ name, type, data: ArrayBuffer }]
    this.pdf = null;
    this.images = [];
    this.textCache = new Map();
  }

  static async open(files) {
    const pdfFile = files.find(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (pdfFile) {
      const s = new Source('pdf', [pdfFile]);
      // pdf.js takes ownership of the buffer it is given, so hand it a copy.
      s.pdf = await pdfjs.getDocument({ data: new Uint8Array(pdfFile.data.slice(0)), isEvalSupported: false }).promise;
      s.pageCount = s.pdf.numPages;
      return s;
    }
    const s = new Source('images', files);
    for (const f of files) {
      const blob = new Blob([f.data], { type: f.type || 'image/jpeg' });
      s.images.push(await createImageBitmap(blob));
    }
    s.pageCount = s.images.length;
    return s;
  }

  async size(n) {
    if (this.kind === 'images') {
      const im = this.images[n - 1];
      return { w: im.width, h: im.height };
    }
    const page = await this.pdf.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    return { w: vp.width, h: vp.height };
  }

  /** Draw page n into a new canvas `width` pixels wide (capped for iPhone canvas limits). */
  async render(n, width) {
    const { w, h } = await this.size(n);
    let scale = width / w;
    const maxPixels = 14e6;
    if (w * h * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / (w * h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (this.kind === 'images') {
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.images[n - 1], 0, 0, canvas.width, canvas.height);
    } else {
      const page = await this.pdf.getPage(n);
      await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale }), background: '#fff' }).promise;
    }
    return canvas;
  }

  /** The PDF's own text for page n, as lines with positions; [] if it has none. */
  async textLines(n) {
    if (this.kind !== 'pdf') return [];
    if (this.textCache.has(n)) return this.textCache.get(n);
    const page = await this.pdf.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const lines = [];
    let cur = null;
    for (const it of content.items) {
      if (!it.str) { if (it.hasEOL && cur) cur.eol = true; continue; }
      const t = pdfjs.Util.transform(vp.transform, it.transform);
      const size = Math.hypot(t[2], t[3]) || 1;
      const x = t[4], base = t[5];
      const width = it.width * (vp.scale ?? 1);
      const sameLine = cur && !cur.eol && Math.abs(base - cur.base) < size * 0.5 && x > cur.x1 - size * 2;
      if (!sameLine) {
        cur = { parts: [], x0: x, x1: x + width, base, size, rtl: 0 };
        lines.push(cur);
      }
      cur.parts.push({ s: it.str, x, w: width, rtl: it.dir === 'rtl' });
      cur.x0 = Math.min(cur.x0, x);
      cur.x1 = Math.max(cur.x1, x + width);
      cur.size = Math.max(cur.size, size);
      if (it.hasEOL) cur.eol = true;
    }
    const out = [];
    for (const l of lines) {
      const rtl = l.parts.filter(p => p.rtl).length > l.parts.length / 2;
      const parts = rtl ? [...l.parts].sort((a, b) => b.x - a.x) : l.parts;
      let text = '';
      let prev = null;
      for (const p of parts) {
        const gap = prev ? (rtl ? prev.x - (p.x + p.w) : p.x - (prev.x + prev.w)) : 0;
        if (prev && gap > l.size * 0.12 && !/\s$/.test(text) && !/^\s/.test(p.s)) text += ' ';
        text += p.s;
        prev = p;
      }
      text = text.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      out.push({
        t: text,
        r: [l.x0 / vp.width, (l.base - l.size * 0.85) / vp.height, (l.x1 - l.x0) / vp.width, (l.size * 1.1) / vp.height],
        h: l.size / vp.height,
      });
    }
    this.textCache.set(n, out);
    return out;
  }

  async hasText(n) {
    const lines = await this.textLines(n);
    return lines.reduce((a, l) => a + l.t.replace(/\s/g, '').length, 0) >= 25;
  }
}

// ---------- shared block building ----------

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/g;
const LATIN = /[A-Za-zÀ-ÖØ-öø-ÿĀ-ž]/g;

export function arabicShare(text) {
  const a = (text.match(ARABIC) || []).length;
  const l = (text.match(LATIN) || []).length;
  return a + l === 0 ? 0 : a / (a + l);
}
export const isRTL = text => arabicShare(text) > 0.5;

const PAGE_NUMBER = /^\s*[-–—(\[]?\s*\d{1,4}\s*[-–—)\]]?\s*$/;
const BULLET = /^\s*([-–•●▪■◦*·]|\d{1,2}[.)]|[a-zA-Z][.)])\s+/;

let blockSeq = 0;
export const newId = () => `b${Date.now().toString(36)}${(blockSeq++).toString(36)}`;

/** Lines grouped into paragraphs → blocks with kinds. */
function blocksFromParagraphs(paras, origin, settings) {
  const heights = paras.flatMap(p => p.lines.map(l => l.h)).filter(h => h > 0).sort((a, b) => a - b);
  const median = heights.length ? heights[Math.floor(heights.length / 2)] : 0.02;
  const blocks = [];
  for (const p of paras) {
    const lines = p.lines.filter(l => l.t.trim());
    if (!lines.length) continue;
    const avgH = lines.reduce((a, l) => a + l.h, 0) / lines.length;
    const joined = joinLines(lines.map(l => l.t));
    let kind = 'paragraph', level = 0, text = joined;
    const bulletLines = lines.filter(l => BULLET.test(l.t)).length;
    if (lines.length <= 3 && avgH > median * 1.32 && joined.length < 160 && !PAGE_NUMBER.test(joined)) {
      kind = 'heading';
      level = avgH > median * 2 ? 1 : avgH > median * 1.6 ? 2 : 3;
    } else if (bulletLines >= 2 && bulletLines >= lines.length * 0.5) {
      kind = 'list';
      // One item per marker; continuation lines join the item above.
      const items = [];
      for (const l of lines) {
        if (BULLET.test(l.t) || !items.length) items.push(l.t.trim());
        else items[items.length - 1] = joinLines([items[items.length - 1], l.t]);
      }
      text = items.map(i => i.replace(/^\s*[-–•●▪■◦*·]\s+/, '- ')).join('\n');
    }
    const x0 = Math.min(...lines.map(l => l.r[0])), y0 = Math.min(...lines.map(l => l.r[1]));
    const x1 = Math.max(...lines.map(l => l.r[0] + l.r[2])), y1 = Math.max(...lines.map(l => l.r[1] + l.r[3]));
    const isNumber = PAGE_NUMBER.test(text);
    blocks.push({
      id: newId(), text, original: text, kind, level, origin,
      rect: [x0, y0, x1 - x0, y1 - y0],
      lines: lines.map(l => ({ t: l.t, r: l.r })),
      removed: isNumber && !settings.keepPageNumbers,
      pageNumber: isNumber || undefined,
    });
  }
  return blocks;
}

/** Join wrapped lines; keep "Wort- trennung" for the export's hyphen joining to decide. */
function joinLines(lines) {
  return lines.map(s => s.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ');
}

/** Two blocks side by side means the page is set in columns. */
export function columnCount(blocks) {
  const bs = blocks.filter(b => !b.removed && b.kind !== 'heading' && b.rect[2] < 0.6);
  for (let i = 0; i < bs.length; i++) {
    for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i].rect, b = bs[j].rect;
      const vOverlap = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
      const apart = a[0] + a[2] < b[0] || b[0] + b[2] < a[0];
      if (apart && vOverlap > Math.min(a[3], b[3]) * 0.5) return 2;
    }
  }
  return 1;
}

/** The PDF's own text, grouped into paragraphs. */
export function blocksFromTextLines(lines, settings) {
  const paras = [];
  let cur = null, prev = null;
  for (const l of lines) {
    const gap = prev ? l.r[1] - (prev.r[1] + prev.r[3]) : 0;
    const overlapX = prev ? Math.min(l.r[0] + l.r[2], prev.r[0] + prev.r[2]) - Math.max(l.r[0], prev.r[0]) : 0;
    const sameSize = prev && Math.abs(l.h - prev.h) < Math.max(l.h, prev.h) * 0.2;
    const fresh = !prev || gap > prev.h * 0.9 || gap < -prev.h * 2 || overlapX <= 0 || !sameSize;
    if (fresh) { cur = { lines: [] }; paras.push(cur); }
    cur.lines.push(l);
    prev = l;
  }
  return blocksFromParagraphs(paras, 'text', settings);
}

// ---------- OCR ----------

let worker = null;
let workerLangs = null;
let onProgress = null;

const tessOptions = () => ({
  workerPath: BASE + 'vendor/tesseract/worker.min.js',
  corePath: BASE + 'vendor/tesseract/core/',
  langPath: BASE + 'vendor/lang',
  workerBlobURL: false,
  gzip: true,
  cacheMethod: 'none', // the service worker already keeps the language files offline
  logger: m => onProgress?.(m),
});

async function getWorker(langs) {
  if (!window.Tesseract) throw new Error('The reading engine didn’t load. Close Folio and open it again.');
  if (!worker) {
    worker = await window.Tesseract.createWorker(langs, 1, tessOptions());
    workerLangs = langs;
  } else if (workerLangs !== langs) {
    await worker.reinitialize(langs, 1);
    workerLangs = langs;
  }
  return worker;
}

/** Stop mid-page: the only way to interrupt Tesseract is to end its worker. */
export async function stopOCR() {
  const w = worker;
  worker = null; workerLangs = null;
  if (w) { try { await w.terminate(); } catch {} }
}

/** Tesseract language string for a setting, given what earlier pages looked like. */
// Invisible direction marks Tesseract leaves around Latin runs in Arabic lines.
const BIDI_MARKS = /[\u200e\u200f\u061c\u202a-\u202e]/g;
// In Arabic text the models often give Latin punctuation; set the Arabic forms.
const arabicPunct = t => /[\u0600-\u06ff]/.test(t)
  ? t.replace(/([\u0600-\u06ff])\s*,/g, '$1،').replace(/([\u0600-\u06ff])\s*;/g, '$1؛').replace(/([\u0600-\u06ff])\s*\?/g, '$1؟')
  : t;

function langsFor(settings, guess) {
  switch (settings.language) {
    case 'german': return 'deu';
    case 'arabic': return 'ara+eng';
    case 'english': return 'eng';
    default: return guess || 'ara+deu';
  }
}

/** Grayscale and stretch contrast: faint, yellowed scans read noticeably better. */
function prepare(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
    d[i] = g; hist[g]++;
  }
  const total = d.length / 4;
  let lo = 0, hi = 255, acc = 0;
  for (; lo < 255; lo++) { acc += hist[lo]; if (acc > total * 0.005) break; }
  acc = 0;
  for (; hi > 0; hi--) { acc += hist[hi]; if (acc > total * 0.02) break; }
  const span = Math.max(40, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / span));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function cropLine(canvas, bbox, targetHeight) {
  const pad = Math.round((bbox.y1 - bbox.y0) * 0.35);
  const x = Math.max(0, bbox.x0 - pad), y = Math.max(0, bbox.y0 - pad);
  const w = Math.min(canvas.width - x, bbox.x1 - bbox.x0 + pad * 2);
  const h = Math.min(canvas.height - y, bbox.y1 - bbox.y0 + pad * 2);
  const scale = Math.max(1, Math.min(3, targetHeight / (bbox.y1 - bbox.y0)));
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale); c.height = Math.round(h * scale);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(canvas, x, y, w, h, 0, 0, c.width, c.height);
  return c;
}

/** Characters that only show up when a line was misread as noise. */
const junk = t => {
  const letters = (t.match(/[\p{L}\p{N}]/gu) || []).length;
  return letters === 0 || letters < t.replace(/\s/g, '').length * 0.45;
};

async function recognize(w, canvas, psm) {
  await w.setParameters({ tessedit_pageseg_mode: String(psm), preserve_interword_spaces: '1' });
  const { data } = await w.recognize(canvas, {}, { blocks: true, text: true });
  return data;
}

/**
 * Read one page image. Returns { blocks, langs, confidence }.
 * `state.guess` carries what earlier pages looked like when the language is Automatic.
 */
export async function ocrPage(source, n, settings, state, progress) {
  onProgress = progress;
  const best = settings.quality === 'best';
  const { w: pw } = await source.size(n);
  const width = best ? 2400 : 1600;
  const canvas = prepare(await source.render(n, source.kind === 'images' ? Math.min(width, Math.max(pw, 1400)) : width));

  let langs = langsFor(settings, state.guess);
  let w = await getWorker(langs);
  let data = await recognize(w, canvas, 3);

  // Automatic: if a single-language guess reads badly, try both scripts and keep the better page.
  if (settings.language === 'auto' && langs !== 'ara+deu' && (data.confidence ?? 0) < 62) {
    w = await getWorker('ara+deu');
    const both = await recognize(w, canvas, 3);
    if ((both.confidence ?? 0) > (data.confidence ?? 0) + 3) { data = both; langs = 'ara+deu'; }
  }

  // Automatic: a page that turns out to be all one script reads cleaner with that script's
  // model alone — the mixed model slips Latin letters into Arabic words and the reverse.
  if (settings.language === 'auto' && langs === 'ara+deu') {
    const share = arabicShare(data.text || '');
    const single = share > 0.9 ? 'ara' : share < 0.03 && (data.text || '').length > 20 ? 'deu' : null;
    if (single) {
      w = await getWorker(single);
      const alone = await recognize(w, canvas, 3);
      if ((alone.confidence ?? 0) >= (data.confidence ?? 0) - 8) { data = alone; langs = single; }
    }
  }

  const W = canvas.width, H = canvas.height;
  const paras = [];
  const rereads = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      const p = { lines: [] };
      for (const line of para.lines || []) {
        const words = (line.words || []).filter(x => x.confidence > 15 || /[\p{L}\p{N}]{3,}/u.test(x.text));
        let text = (words.length ? words.map(x => x.text).join(' ') : line.text || '').replace(BIDI_MARKS, '').replace(/\s+/g, ' ').trim();
        text = arabicPunct(text);
        if (!text || junk(text)) continue;
        const b = line.bbox;
        const l = {
          t: text, conf: line.confidence ?? 0, bbox: b,
          r: [b.x0 / W, b.y0 / H, (b.x1 - b.x0) / W, (b.y1 - b.y0) / H],
          h: (b.y1 - b.y0) / H,
        };
        p.lines.push(l);
        if (best && l.conf < 80 && b.x1 - b.x0 > 20 && b.y1 - b.y0 > 6) rereads.push(l);
      }
      if (p.lines.length) paras.push(p);
    }
  }

  // Best: read unsure lines again on their own, enlarged — dropped letters come back.
  if (rereads.length) {
    for (const l of rereads.slice(0, 60)) {
      const crop = cropLine(canvas, l.bbox, 56);
      const again = await recognize(w, crop, 7);
      crop.width = crop.height = 0; // hand the memory back at once — iPhone keeps a tight canvas budget
      const t = arabicPunct((again.text || '').replace(BIDI_MARKS, '').replace(/\s+/g, ' ').trim());
      const conf = again.confidence ?? 0;
      if (t && !junk(t) && conf > l.conf + 4 && t.length >= l.t.length * 0.7 && t.length <= l.t.length * 1.4) {
        l.t = t;
        l.conf = conf;
      }
    }
  }

  canvas.width = canvas.height = 0;

  // Remember the script for the next pages when on Automatic.
  if (settings.language === 'auto') {
    const all = paras.flatMap(p => p.lines.map(l => l.t)).join(' ');
    const share = arabicShare(all);
    if (all.length > 40) state.guess = share < 0.02 ? 'deu' : share > 0.98 ? 'ara' : 'ara+deu';
  }

  // Tesseract lists right-to-left paragraphs in reading order already; columns come block by block.
  const blocks = blocksFromParagraphs(paras, 'ocr', settings);
  return { blocks, langs, confidence: data.confidence ?? 0 };
}

/** One page, read with whichever route fits. */
export async function readPage(source, n, settings, state, progress) {
  const started = performance.now();
  if (!settings.forceOCR && await source.hasText(n)) {
    const blocks = blocksFromTextLines(await source.textLines(n), settings);
    return { source: 'text', blocks, seconds: (performance.now() - started) / 1000 };
  }
  const r = await ocrPage(source, n, settings, state, progress);
  const seconds = (performance.now() - started) / 1000;
  // Learn this phone's pace, so the time left is honest.
  const k = settings.quality;
  pace.ocr[k] = pace.ocr[k] * 0.6 + seconds * 0.4;
  return { source: r.blocks.length ? 'ocr' : 'empty', blocks: r.blocks, langs: r.langs, seconds };
}
