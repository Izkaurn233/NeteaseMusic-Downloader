const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

const c = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  magenta: paint('35'),
  cyan: paint('36'),
  gray: paint('90'),
};

function width(str) {
  let w = 0;
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    w += cp >= 0x1100 && /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  }
  return w;
}

function pad(str, len, align = 'left') {
  const s = String(str ?? '');
  const gap = Math.max(0, len - width(s));
  return align === 'right' ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
}

function truncate(str, len) {
  const s = String(str ?? '');
  if (width(s) <= len) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = width(ch);
    if (w + cw > len - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

function table(columns, rows) {
  const widths = columns.map((col) =>
    Math.max(width(col.title), ...rows.map((r) => width(truncate(r[col.key] ?? '', col.max ?? 40)))),
  );
  const head = columns.map((col, i) => pad(col.title, widths[i], col.align)).join('  ');
  const lines = rows.map((row, idx) =>
    columns
      .map((col, i) => {
        const raw = truncate(row[col.key] ?? '', col.max ?? 40);
        const colored = col.color ? col.color(raw) : raw;
        const fill = ' '.repeat(Math.max(0, widths[i] - width(raw)));
        return col.align === 'right' ? fill + colored : colored + fill;
      })
      .join('  '),
  );
  return [c.gray(head), c.gray('─'.repeat(width(head))), ...lines].join('\n');
}

function duration(ms) {
  if (!ms || ms < 0) return '--:--';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function size(bytes) {
  if (!bytes) return '-';
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)}MB` : `${(bytes / 1024).toFixed(0)}KB`;
}

function joinNames(list) {
  return (list || []).map((x) => x.name).join('/');
}

module.exports = { c, pad, truncate, table, duration, size, joinNames, width };
