import JSZip from 'jszip';

const unescapeXml = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

const colNum = (c) => [...c].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colName = (n) => {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

const REF_TOKEN = /(?:(?:'((?:[^']|'')+)'|([A-Za-z_][\w.]*))!)?(\$?)([A-Z]{1,3})(\$?)(\d+)(?::(\$?)([A-Z]{1,3})(\$?)(\d+))?(%)?/g;

/** Shifts relative references of a shared-formula master to a child cell. */
function shiftFormula(formula, fromRef, toRef) {
  const [, fc, fr] = /([A-Z]+)(\d+)/.exec(fromRef);
  const [, tc, tr] = /([A-Z]+)(\d+)/.exec(toRef);
  const dc = colNum(tc) - colNum(fc);
  const dr = +tr - +fr;
  const one = (ca, col, ra, row) => `${ca}${ca ? col : colName(colNum(col) + dc)}${ra}${ra ? row : +row + dr}`;
  return formula.replace(REF_TOKEN, (_m, q, plain, ca1, c1, ra1, r1, ca2, c2, ra2, r2, pct) => {
    const prefix = q ? `'${q}'!` : plain ? `${plain}!` : '';
    const first = one(ca1, c1, ra1, r1);
    return prefix + first + (c2 ? ':' + one(ca2, c2, ra2, r2) : '') + (pct ?? '');
  });
}

/**
 * Minimal formula evaluator for the template (+ - * / %, SUM, cross-sheet refs).
 * Test-only: it throws on anything else so unsupported formulas cannot pass silently.
 */
export async function loadEvaluator(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const wb = await zip.file('xl/workbook.xml').async('string');
  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const target = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [/Id="([^"]+)"/.exec(m[0])[1], /Target="([^"]+)"/.exec(m[0])[1]]));
  const files = new Map();
  for (const m of wb.matchAll(/<sheet [^>]*>/g)) {
    const name = unescapeXml(/name="([^"]+)"/.exec(m[0])[1]);
    const rid = /r:id="([^"]+)"/.exec(m[0])[1];
    files.set(name, `xl/${target.get(rid).replace(/^\/?(xl\/)?/, '')}`);
  }
  const sheets = new Map();
  for (const [name, file] of files) {
    const xml = await zip.file(file).async('string');
    const cells = new Map();
    const masters = new Map();
    for (const m of xml.matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const body = m[3] ?? '';
      const f = /<f([^>]*?)(?:\/>|>([^<]*)<\/f>)/.exec(body);
      const v = /<v>([^<]*)<\/v>/.exec(body);
      const isText = /t="(s|str|inlineStr)"/.test(m[2]);
      let formula = null;
      if (f) {
        const si = /si="(\d+)"/.exec(f[1])?.[1];
        const shared = /t="shared"/.test(f[1]);
        if (f[2]) {
          formula = unescapeXml(f[2]);
          if (shared) masters.set(si, { ref: m[1], formula });
        } else if (shared) {
          const mst = masters.get(si);
          if (!mst) throw new Error(`Shared formula ${si} has no master before ${m[1]}`);
          formula = shiftFormula(mst.formula, mst.ref, m[1]);
        }
      }
      cells.set(m[1], { formula, value: v && !isText ? Number(v[1]) : null });
    }
    sheets.set(name, cells);
  }

  const cache = new Map();
  const stack = new Set();
  function cellValue(sheet, ref) {
    ref = ref.replace(/\$/g, '');
    const key = `${sheet}!${ref}`;
    if (cache.has(key)) return cache.get(key);
    const cells = sheets.get(sheet);
    if (!cells) throw new Error(`Unknown sheet ${sheet}`);
    const c = cells.get(ref);
    let out = 0;
    if (c) {
      if (c.formula) {
        if (stack.has(key)) throw new Error(`Circular reference at ${key}`);
        stack.add(key);
        out = evaluate(sheet, c.formula);
        stack.delete(key);
      } else out = c.value ?? 0;
    }
    cache.set(key, out);
    return out;
  }
  function range(sheet, a, b) {
    const [, ca, ra] = /([A-Z]+)(\d+)/.exec(a.replace(/\$/g, ''));
    const [, cb, rb] = /([A-Z]+)(\d+)/.exec(b.replace(/\$/g, ''));
    const out = [];
    for (let r = +ra; r <= +rb; r++) for (let c = colNum(ca); c <= colNum(cb); c++) out.push(cellValue(sheet, `${colName(c)}${r}`));
    return out;
  }
  function evaluate(sheet, formula) {
    const ref = /(?:'((?:[^']|'')+)'|([A-Za-z_][\w.]*))?!?(\$?[A-Z]{1,3}\$?\d+)(?::(\$?[A-Z]{1,3}\$?\d+))?(%)?/g;
    const token = /(?:(?:'((?:[^']|'')+)'|([A-Za-z_][\w.]*))!)?(\$?[A-Z]{1,3}\$?\d+)(?::(\$?[A-Z]{1,3}\$?\d+))?(%)?/g;
    void ref;
    if (/[A-Za-z]+\(/.test(formula.replace(/SUM\(/g, ''))) throw new Error(`Unsupported function in ${sheet}: ${formula}`);
    const js = formula.replace(token, (_m, q, plain, a, b, pct) => {
      const sh = (q ?? plain ?? sheet).replace(/''/g, "'");
      const expr = b ? `R(${JSON.stringify(sh)},${JSON.stringify(a)},${JSON.stringify(b)})` : `V(${JSON.stringify(sh)},${JSON.stringify(a)})`;
      return pct ? `(${expr}/100)` : expr;
    });
    if (/[^\d\s+\-*/().,RVSUM"A-Za-z_!$:'&]/.test(js)) throw new Error(`Unsupported formula ${formula}`);
    const SUM = (...args) => args.flat().reduce((s, x) => s + (Number(x) || 0), 0);
    // eslint-disable-next-line no-new-func
    const r = new Function('R', 'V', 'SUM', `return (${js});`)((s, a, b) => range(s, a, b), cellValue, SUM);
    return Number.isFinite(r) ? r : 0;
  }
  return { get: (sheet, ref) => cellValue(sheet, ref), sheetNames: [...files.keys()] };
}
