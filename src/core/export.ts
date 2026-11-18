/**
 * CSV & Printable Report Export Helpers (UTF-8 BOM for Excel + INR formatting + zero inline scripts)
 */

export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const raw = String(value);
  // Neutralize CSV formula injection (=, +, -, @, tab, CR)
  const neutralized = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  if (/[",\n\r]/.test(neutralized)) {
    return `"${neutralized.replace(/"/g, '""')}"`;
  }
  return neutralized;
}

export function downloadCsvFile(
  filename: string,
  headers: string[],
  rows: Array<Array<unknown>>
): void {
  const lines = [
    headers.map(escapeCsvCell).join(','),
    ...rows.map((row) => row.map(escapeCsvCell).join(',')),
  ];
  const csvContent = `\uFEFF${lines.join('\r\n')}`;
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function printReportHtml(
  title: string,
  subtitle: string,
  headers: string[],
  rows: Array<Array<string | number>>,
  businessName?: string
): void {
  const win = document.createElement('iframe');
  win.style.position = 'fixed';
  win.style.right = '0';
  win.style.bottom = '0';
  win.style.width = '0';
  win.style.height = '0';
  win.style.border = '0';
  document.body.appendChild(win);

  const doc = win.contentWindow?.document;
  if (!doc) {
    document.body.removeChild(win);
    window.print();
    return;
  }

  const headHtml = headers
    .map((h) => `<th>${escapeHtml(h)}</th>`)
    .join('');
  const bodyHtml = rows
    .map(
      (r) =>
        `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`
    )
    .join('');

  doc.open();
  doc.write(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; padding: 24px; color: #0f172a; font-size: 12px; }
  h1 { margin: 0 0 4px 0; font-size: 18px; }
  .meta { color: #475569; margin-bottom: 16px; font-size: 11px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; }
  th { background: #f1f5f9; font-weight: 600; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
  ${businessName ? `<div class="meta"><strong>${escapeHtml(businessName)}</strong></div>` : ''}
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">${escapeHtml(subtitle)}</div>
  <table>
    <thead><tr>${headHtml}</tr></thead>
    <tbody>${bodyHtml}</tbody>
  </table>
</body>
</html>`);
  doc.close();

  win.contentWindow?.focus();
  window.setTimeout(() => {
    win.contentWindow?.print();
    window.setTimeout(() => {
      if (win.parentNode) win.parentNode.removeChild(win);
    }, 1000);
  }, 150);
}
