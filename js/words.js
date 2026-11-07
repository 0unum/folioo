// Words, phrases and where they occur.
import { isRTL } from './reader.js';

export const defaultWordOptions = () => ({ ignoreCase: true, dropCommon: true, stripTashkeel: true, minLetters: 2, phraseLength: 2 });

const WORD = /[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*/gu;

const STOP = new Set(`
der die das den dem des ein eine einer eines einem einen und oder aber doch sondern denn als wie wenn dass daß
ist sind war waren bin bist sein seid wird werden wurde wurden hat haben hatte hatten habe kann können muss müssen
soll sollen will wollen darf dürfen mag mögen ich du er sie es wir ihr mich dich sich uns euch mir dir ihm ihn ihnen
mein dein unser euer meine deine seine unsere eure ihre nicht kein keine keinen auch noch schon nur sehr
so zu zum zur im in an am auf aus bei mit nach von vor über unter um durch für gegen ohne bis seit hier da dort
was wer wo wann warum welche welcher welches man alle alles viel mehr dann also ja nein nun immer wieder etwa
diese dieser dieses diesen diesem jede jeder jedes jeden ins vom beim ob weil damit
the a an and or but if then so of to in on at by for with from as is are was were be been being have has had do
does did not no it its this that these those he she they we you i me him her them us my your his their our
what which who whom where when why how all any each more most some such than too very can will just also into
over about up out there here would could should may might must shall
في من إلى الى على عن مع هذا هذه ذلك تلك هو هي هم هن أنا نحن أنت انت كان كانت يكون تكون التي الذي الذين
و أو او ثم لا لم لن ما قد كل بعض بين عند حتى إذا اذا إن ان أن كما لكن بل هل أي اي غير بعد قبل حيث منذ
ب ل ف ك به بها له لها فيه فيها منه منها عليه عليها`.split(/\s+/).filter(Boolean));

const letters = w => (w.match(/\p{L}/gu) || []).length;

export function normalise(w, o) {
  let t = w;
  if (o.stripTashkeel) t = t.replace(/[ً-ْـ]/g, '');
  return o.ignoreCase ? t.toLocaleLowerCase() : t;
}

const used = pages => pages.filter(p => !p.excluded);
const textBlocks = pages => used(pages).flatMap(p => (p.blocks || []).filter(b => !b.removed).map(b => ({ p: p.n, b })));

function counted(map, key, shown, page) {
  let s = map.get(key);
  if (!s) { s = { key, forms: new Map(), count: 0, pages: new Set() }; map.set(key, s); }
  s.count++;
  s.pages.add(page);
  s.forms.set(shown, (s.forms.get(shown) || 0) + 1);
}

function finish(map) {
  return [...map.values()].map(s => ({
    key: s.key,
    shown: [...s.forms.entries()].sort((a, b) => b[1] - a[1])[0][0],
    count: s.count,
    pages: [...s.pages].sort((a, b) => a - b),
  })).sort((a, b) => b.count - a.count || a.shown.localeCompare(b.shown));
}

export function frequencies(pages, o) {
  const map = new Map();
  for (const { p, b } of textBlocks(pages)) {
    for (const m of b.text.matchAll(WORD)) {
      const w = m[0];
      if (letters(w) < o.minLetters) continue;
      const k = normalise(w, o);
      if (o.dropCommon && STOP.has(k.toLocaleLowerCase())) continue;
      counted(map, k, w, p);
    }
  }
  return finish(map);
}

export function phrases(pages, o) {
  const map = new Map();
  const n = o.phraseLength;
  for (const { p, b } of textBlocks(pages)) {
    // Phrases don't run across sentence ends.
    for (const sentence of b.text.split(/[.!?;:،؛؟\n]+/)) {
      const ws = [...sentence.matchAll(WORD)].map(m => m[0]);
      for (let i = 0; i + n <= ws.length; i++) {
        const gram = ws.slice(i, i + n);
        const keys = gram.map(w => normalise(w, o));
        if (o.dropCommon && (STOP.has(keys[0].toLocaleLowerCase()) || STOP.has(keys[n - 1].toLocaleLowerCase()))) continue;
        if (gram.some(w => letters(w) < o.minLetters)) continue;
        counted(map, keys.join(' '), gram.join(' '), p);
      }
    }
  }
  return finish(map).filter(s => s.count > 1);
}

/** Every place a word or phrase appears, with a little text either side. */
export function contexts(stat, pages, o, limit = 60) {
  const out = [];
  const parts = stat.key.split(' ');
  for (const { p, b } of textBlocks(pages)) {
    const ws = [...b.text.matchAll(WORD)];
    for (let i = 0; i + parts.length <= ws.length; i++) {
      if (!parts.every((k, j) => normalise(ws[i + j][0], o) === k)) continue;
      const start = ws[i].index, end = ws[i + parts.length - 1].index + ws[i + parts.length - 1][0].length;
      out.push({
        page: p, block: b.id,
        before: b.text.slice(Math.max(0, start - 50), start),
        match: b.text.slice(start, end),
        after: b.text.slice(end, end + 50),
        rtl: isRTL(b.text),
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export function docStats(pages, o) {
  let words = 0, lettersN = 0, arabic = 0, latin = 0;
  const unique = new Set(), longest = new Set(), perPage = [];
  for (const p of used(pages)) {
    let n = 0;
    for (const b of (p.blocks || []).filter(b => !b.removed)) {
      for (const m of b.text.matchAll(WORD)) {
        const w = m[0];
        n++;
        unique.add(normalise(w, o));
        const L = letters(w);
        lettersN += L;
        if (/[؀-ۿ]/.test(w)) arabic++; else latin++;
        if (L >= 12) longest.add(w);
      }
    }
    words += n;
    perPage.push({ page: p.n, words: n });
  }
  return {
    words, unique: unique.size, letters: lettersN,
    arabicShare: arabic + latin ? arabic / (arabic + latin) : 0,
    minutes: words / 200,
    variety: words ? unique.size / words : 0,
    averageLength: words ? lettersN / words : 0,
    perPage,
    longest: [...longest].sort((a, b) => b.length - a.length).slice(0, 8),
  };
}

export function csv(list, pages, o) {
  const q = s => `"${String(s).replace(/"/g, '""')}"`;
  const lines = ['rank,word,count,pages,example'];
  list.forEach((w, i) => {
    const c = contexts(w, pages, o, 1)[0];
    const ex = c ? (c.before + c.match + c.after).trim() : '';
    lines.push(`${i + 1},${q(w.shown)},${w.count},${q(w.pages.join(' '))},${q(ex)}`);
  });
  return lines.join('\n') + '\n';
}
