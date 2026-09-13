/** Strict CSV data boundary. Spreadsheet escaping is intentionally explicit. */
const MAX_CONTENT_LENGTH = 10 * 1024 * 1024;
const MAX_ROWS = 10000;
const MAX_COLUMNS = 256;
const MAX_FIELD_LENGTH = 65536;

function spreadsheetCell(value: unknown): string {
  if (value !== null && value !== undefined && !['string','number','bigint','boolean'].includes(typeof value)) throw new Error('CSV cells must be scalar values');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('CSV cannot represent nonfinite numbers');
  let text = String(value ?? '');
  if (Array.from(text).some((char) => char.charCodeAt(0) < 32 && !['\t','\n','\r'].includes(char))) throw new Error('CSV contains unsupported control data');
  // Quotes alone do not stop formula execution. Cover leading whitespace and
  // full-width formula operators as well as ASCII operators/control prefixes.
  if (/^[\s\uFEFF]*[=+@\-＝＋－＠]/u.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function serializeCsv(data: Record<string, unknown>[]): string {
  if (data.length === 0) return '';
  const headers = Object.keys(data[0]);
  if (!headers.length || headers.length > MAX_COLUMNS) throw new Error('CSV requires 1–256 columns');
  const known = new Set(headers);
  const rows = data.map((row) => {
    if (Object.keys(row).some((key) => !known.has(key))) throw new Error('CSV rows contain inconsistent columns');
    return headers.map((header) => spreadsheetCell(row[header])).join(',');
  });
  return [headers.map(spreadsheetCell).join(','), ...rows].join('\r\n');
}

export function exportToCsv(filename: string, data: Record<string, unknown>[]): void {
  if (data.length === 0) return;
  const blob = new Blob([serializeCsv(data)], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  try {
    link.href = url;
    link.download = filename;
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
}

export function parseCsv(content: string): Record<string, string>[] {
  if (typeof content !== 'string' || content.length > MAX_CONTENT_LENGTH) throw new Error('CSV exceeds the 10 MiB character limit');
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
  // Reject lossy Unicode/control data before parsing or submitting any mutation.
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code === 0 || (code < 32 && ![9,10,13].includes(code))) throw new Error('CSV contains unsupported control data');
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = content.charCodeAt(++i);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) throw new Error('CSV contains invalid Unicode');
    } else if (code >= 0xDC00 && code <= 0xDFFF) throw new Error('CSV contains invalid Unicode');
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let state: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  let touched = false;
  const pushField = () => {
    row.push(field);
    if (row.length > MAX_COLUMNS) throw new Error('CSV exceeds 256 columns');
    field = ''; state = 'start';
  };
  const pushRow = () => {
    if (touched || row.length || field.length) {
      pushField(); rows.push(row);
      if (rows.length > MAX_ROWS + 1) throw new Error('CSV imports are limited to 10,000 data rows');
    }
    row = []; field = ''; state = 'start'; touched = false;
  };
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (state === 'quoted') {
      if (char === '"') {
        if (content[i+1] === '"') { field += '"'; i++; }
        else state = 'closed';
      } else field += char;
    } else if (char === ',') {
      touched = true; pushField();
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && content[i+1] === '\n') i++;
      pushRow();
    } else if (state === 'closed') {
      throw new Error('CSV has data after a closing quote');
    } else if (char === '"') {
      if (state !== 'start') throw new Error('CSV has a quote inside an unquoted field');
      state = 'quoted'; touched = true;
    } else {
      field += char; state = 'plain'; touched = true;
    }
    if (field.length > MAX_FIELD_LENGTH) throw new Error('CSV field exceeds 65,536 characters');
  }
  if (state === 'quoted') throw new Error('CSV has an unterminated quoted field');
  pushRow();
  if (!rows.length) return [];
  const headers = rows[0].map((header) => header.trim());
  if (headers.some((header) => !header) || new Set(headers).size !== headers.length) throw new Error('CSV headers must be nonempty and unique');
  return rows.slice(1).map((values, index) => {
    if (values.length !== headers.length) throw new Error(`CSV row ${index+2} has ${values.length} values; expected ${headers.length}`);
    const result: Record<string, string> = Object.create(null);
    headers.forEach((header, i) => { result[header] = values[i]; });
    return result;
  });
}
