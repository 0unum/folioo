// A PDF that looks exactly like the scan — the original pages, untouched —
// with every read line laid over it as invisible text, so it can be
// searched, selected and copied.

const BASE = new URL('../', import.meta.url).href;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Couldn’t load ' + src));
    document.head.appendChild(s);
  });
}

async function libs() {
  if (!window.PDFLib) await loadScript(BASE + 'vendor/pdf-lib/pdf-lib.min.js');
  if (!window.fontkit) await loadScript(BASE + 'vendor/pdf-lib/fontkit.umd.min.js');
  return { PDFLib: window.PDFLib, fontkit: window.fontkit };
}

const invert = ([a, b, c, d, e, f]) => {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
};
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** Turn a photo into JPEG bytes pdf-lib can embed. */
async function jpegBytes(file) {
  if (/jpe?g/i.test(file.type)) return { kind: 'jpg', bytes: file.data };
  if (/png/i.test(file.type)) return { kind: 'png', bytes: file.data };
  const bmp = await createImageBitmap(new Blob([file.data], { type: file.type }));
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
  return { kind: 'jpg', bytes: await blob.arrayBuffer() };
}

/**
 * doc: the session; source: the open Source (for page geometry);
 * files: the original files. Returns PDF bytes.
 */
export async function makeSearchablePDF(doc, source, files, onStep) {
  const { PDFLib, fontkit } = await libs();
  const { PDFDocument, TextRenderingMode: TRM } = PDFLib;
  const op = PDFLib;

  let pdf;
  const pageMaps = []; // per page: matrix from viewport space (scale 1) to PDF user space, and viewport size

  if (source.kind === 'pdf') {
    pdf = await PDFDocument.load(files[0].data.slice(0), { ignoreEncryption: true, updateMetadata: false });
    for (let n = 1; n <= source.pageCount; n++) {
      const page = await source.pdf.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      pageMaps.push({ m: invert(vp.transform), w: vp.width, h: vp.height });
    }
  } else {
    pdf = await PDFDocument.create();
    for (const f of files) {
      const { kind, bytes } = await jpegBytes(f);
      const img = kind === 'png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      // Photos are taken at roughly 300 dpi of the page they show.
      const w = img.width * 72 / 300, h = img.height * 72 / 300;
      const page = pdf.addPage([w, h]);
      page.drawImage(img, { x: 0, y: 0, width: w, height: h });
      pageMaps.push({ m: [1, 0, 0, -1, 0, h], w, h });
    }
  }

  pdf.registerFontkit(fontkit);
  const fontBytes = await (await fetch(BASE + 'vendor/fonts/NotoNaskhArabic_400Regular.ttf')).arrayBuffer();
  const font = await pdf.embedFont(fontBytes, { subset: true });

  const pages = pdf.getPages();
  let lines = 0;
  for (const p of doc.pages) {
    const page = pages[p.n - 1];
    const map = pageMaps[p.n - 1];
    if (!page || !map || p.source !== 'ocr') continue; // pages with their own text keep it
    const key = page.node.newFontDictionary('FolioText', font.ref);
    const ops = [op.pushGraphicsState(), op.beginText(), op.setFontAndSize(key, 1), op.setTextRenderingMode(TRM.Invisible)];
    for (const b of p.blocks || []) {
      if (b.removed) continue;
      // Corrected blocks: the corrected words go on the first line's place, spread over the block.
      const items = b.text !== b.original || !b.lines?.length
        ? [{ t: b.text.replace(/\n/g, ' '), r: b.rect }]
        : b.lines;
      for (const l of items) {
        const t = l.t.trim();
        if (!t) continue;
        const [x, y, w, h] = l.r;
        // Viewport space: x right, y down. Baseline sits ~80% down the line box.
        const vx = x * map.w, vy = (y + h * 0.8) * map.h, vw = w * map.w, vh = h * map.h;
        const origin = apply(map.m, vx, vy);
        const right = apply(map.m, vx + vw, vy);
        const up = apply(map.m, vx, vy - vh);
        const dx = right[0] - origin[0], dy = right[1] - origin[1];
        const ux = up[0] - origin[0], uy = up[1] - origin[1];
        const len = Math.hypot(dx, dy) || 1, ulen = Math.hypot(ux, uy) || 1;
        const size = ulen * 0.85;
        let encoded, width;
        try {
          encoded = font.encodeText(t);
          width = font.widthOfTextAtSize(t, size);
        } catch { continue; }
        if (!width) continue;
        ops.push(
          op.setTextMatrix((dx / len) * size, (dy / len) * size, (ux / ulen) * size, (uy / ulen) * size, origin[0], origin[1]),
          op.setCharacterSqueeze(Math.max(1, Math.min(1000, (len / width) * 100))),
          op.showText(encoded),
        );
        lines++;
      }
    }
    ops.push(op.endText(), op.popGraphicsState());
    page.pushOperators(...ops);
    onStep?.(p.n);
  }
  pdf.setProducer('Folio');
  pdf.setCreator('Folio');
  const bytes = await pdf.save({ useObjectStreams: true });
  return { bytes, lines };
}
