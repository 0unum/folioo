// Writing the text out: Markdown or plain text, with the choices from the Export sheet.
import { isRTL } from './reader.js';

export const defaultExport = () => ({
  format: 'markdown',        // markdown | plain
  pageMarker: 'comment',     // none | comment | heading | rule | bracket
  markerText: 'Page {n}',
  headings: 'keep',          // keep | demote | bold | plain
  keepLists: true,
  spacing: 'airy',           // airy | compact
  joinHyphens: true,         // "struktu- riert" → "strukturiert"
  dropPageNumbers: true,
  unifyQuotes: false,        // „…“ «…» → "…"
  wrapColumn: 0,
  addTitle: false,
  title: '',
  frontMatter: false,
  includeSkipped: false,     // pages left out and blocks removed
  rtlMarks: false,           // U+200F before Arabic lines
  rules: [],                 // { enabled, action: replace|removeLine, find, replace, regex, caseSensitive }
});

export const PRESETS = [
  { name: 'Markdown', options: {} },
  { name: 'Study notes', options: { pageMarker: 'heading', markerText: 'Seite {n}', addTitle: true, frontMatter: true } },
  { name: 'Clean text', options: { format: 'plain', pageMarker: 'none', headings: 'plain', keepLists: false, unifyQuotes: true } },
  { name: 'Book', options: { pageMarker: 'rule', markerText: '{n}', wrapColumn: 80 } },
];

export const MARKERS = [['none', 'None'], ['comment', 'Hidden comment'], ['heading', 'Heading'], ['rule', 'Divider line'], ['bracket', '[Page N]']];
export const HEADINGS = [['keep', 'As found'], ['demote', 'One level down'], ['bold', 'Bold text'], ['plain', 'Plain text']];

export function render(pages, { title, source, options: o, single = false }) {
  const out = [];
  const used = pages.filter(p => o.includeSkipped || !p.excluded);

  if (!single && o.frontMatter) {
    const date = new Date().toISOString().slice(0, 10);
    out.push(`---\ntitle: "${(title || '').replace(/"/g, "'")}"\nsource: "${source}"\npages: ${used.length}\ncreated: ${date}\n---`);
  }
  if (!single && o.addTitle) {
    const t = o.title || title;
    out.push(o.format === 'markdown' ? `# ${t}` : t.toUpperCase());
  }
  const sep = o.spacing === 'airy' ? '\n\n' : '\n';
  for (const page of used) {
    const parts = [];
    const m = marker(page.n, o);
    if (m) parts.push(m);
    for (const b of page.blocks || []) {
      if (!o.includeSkipped && b.removed) continue;
      const s = write(b, o);
      if (s) parts.push(s);
    }
    if (parts.length) out.push(parts.join(sep));
  }
  let text = out.join('\n\n');
  text = applyRules(text, o.rules || []);
  if (o.wrapColumn > 0) text = wrap(text, o.wrapColumn);
  if (o.rtlMarks) text = text.split('\n').map(l => (isRTL(l) ? '‏' + l : l)).join('\n');
  return text.trim() + '\n';
}

function marker(n, o) {
  const label = o.markerText.replaceAll('{n}', String(n));
  switch (o.pageMarker) {
    case 'comment': return o.format === 'markdown' ? `<!-- ${label} -->` : null;
    case 'heading': return o.format === 'markdown' ? `## ${label}` : `${label}\n${'='.repeat(label.length)}`;
    case 'rule': return o.format === 'markdown' ? `---\n*${label}*` : `—— ${label} ——`;
    case 'bracket': return `[${label}]`;
    default: return null;
  }
}

export function write(b, o) {
  let t = b.text;
  if (o.dropPageNumbers && /^\s*[-–—(\[]?\s*\d{1,4}\s*[-–—)\]]?\s*$/.test(t)) return null;
  if (o.joinHyphens) t = t.replace(/(\p{Ll})- (\p{Ll})/gu, '$1$2');
  if (o.unifyQuotes) t = t.replace(/[„“”«»]/g, '"').replace(/[‚‘’]/g, "'");
  switch (b.kind) {
    case 'heading':
      if (o.format === 'plain' || o.headings === 'plain') return t;
      if (o.headings === 'keep') return '#'.repeat(Math.max(1, b.level || 1)) + ' ' + t;
      if (o.headings === 'demote') return '#'.repeat(Math.min(6, (b.level || 1) + 1)) + ' ' + t;
      return `**${t}**`;
    case 'list':
      if (o.keepLists && o.format === 'markdown') return t;
      return t.split('\n').map(l => l.replace(/^\s*[-*•]\s+/, o.format === 'plain' ? '• ' : '')).join('\n');
    default:
      return t;
  }
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function ruleRegex(r, global = true) {
  try {
    return new RegExp(r.regex ? r.find : escapeRegex(r.find), (global ? 'g' : '') + 'u' + (r.caseSensitive ? '' : 'i'));
  } catch { return null; }
}

function applyRules(text, rules) {
  let t = text;
  for (const r of rules) {
    if (!r.enabled || !r.find) continue;
    const re = ruleRegex(r, r.action === 'replace');
    if (!re) continue;
    if (r.action === 'replace') t = t.replace(re, r.replace ?? '');
    else t = t.split('\n').filter(l => !re.test(l)).join('\n');
  }
  return t;
}

function wrap(text, width) {
  return text.split('\n').map(line => {
    if (line.length <= width || /^(\||#|<!--)/.test(line)) return line;
    const lines = [];
    let cur = '';
    for (const w of line.split(' ')) {
      if (cur && cur.length + 1 + w.length > width) { lines.push(cur); cur = ''; }
      cur += (cur ? ' ' : '') + w;
    }
    if (cur) lines.push(cur);
    return lines.join('\n');
  }).join('\n');
}

export function stats(text) {
  return { words: (text.match(/\S+/g) || []).length, chars: [...text].length, lines: text.split('\n').length };
}
