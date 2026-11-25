/**
 * CSV & XLSX Spreadsheet Import / Template / Export Engine
 * Built around `read-excel-file` + `write-excel-file` for XLSX and native RFC-4180 CSV.
 * Buffer parsing/mapping/validation helpers work safely in both browser and Node tests.
 */
import readXlsxFile from 'read-excel-file/universal';
import writeXlsxFile, { type Cell, type Row, type Sheet, type SheetData } from 'write-excel-file/universal';

export type ImportEntityType = 'parties' | 'items';

export interface ImportFieldSpec {
  key: string;
  labelEn: string;
  labelHi: string;
  required?: boolean;
  aliases: string[];
  example: string | number;
}

export const IMPORT_FIELD_SPECS: Record<ImportEntityType, ImportFieldSpec[]> = {
  parties: [
    { key: 'name', labelEn: 'Party Name *', labelHi: 'पार्टी का नाम *', required: true, aliases: ['name', 'party name', 'customer name', 'supplier name', 'party'], example: 'Sharma Traders' },
    { key: 'party_type', labelEn: 'Party Type (customer/supplier/both)', labelHi: 'प्रकार (customer/supplier/both)', aliases: ['party_type', 'type', 'category'], example: 'customer' },
    { key: 'phone', labelEn: 'Phone', labelHi: 'फ़ोन नंबर', aliases: ['phone', 'mobile', 'contact', 'mobile no', 'phone number'], example: '9876543210' },
    { key: 'email', labelEn: 'Email', labelHi: 'ईमेल', aliases: ['email', 'mail', 'email id'], example: 'accounts@sharma.example' },
    { key: 'gstin', labelEn: 'GSTIN', labelHi: 'जीएसटीआईएन', aliases: ['gstin', 'gst', 'gst number', 'gst no'], example: '27ABCDE1234F1Z5' },
    { key: 'opening_balance', labelEn: 'Opening Balance', labelHi: 'प्रारंभिक शेष', aliases: ['opening_balance', 'opening', 'balance', 'ob'], example: 2500 },
    { key: 'opening_balance_type', labelEn: 'Balance Type (to_receive/to_give)', labelHi: 'शेष प्रकार', aliases: ['opening_balance_type', 'balance_type', 'dr_cr'], example: 'to_receive' },
    { key: 'credit_limit', labelEn: 'Credit Limit', labelHi: 'क्रेडिट सीमा', aliases: ['credit_limit', 'limit'], example: 50000 },
    { key: 'credit_days', labelEn: 'Credit Days', labelHi: 'क्रेडिट दिन', aliases: ['credit_days', 'days', 'terms'], example: 30 },
    { key: 'address', labelEn: 'Address', labelHi: 'पता', aliases: ['address', 'address_line1', 'street'], example: 'Shop 12, Main Market' },
    { key: 'city', labelEn: 'City', labelHi: 'शहर', aliases: ['city', 'town'], example: 'Pune' },
    { key: 'state', labelEn: 'State', labelHi: 'राज्य', aliases: ['state'], example: 'Maharashtra' },
    { key: 'pincode', labelEn: 'Pincode', labelHi: 'पिन कोड', aliases: ['pincode', 'pin', 'zip'], example: '411001' },
    { key: 'notes', labelEn: 'Notes', labelHi: 'नोट्स', aliases: ['notes', 'remark', 'remarks'], example: 'Regular B2B customer' },
  ],
  items: [
    { key: 'name', labelEn: 'Item Name *', labelHi: 'आइटम का नाम *', required: true, aliases: ['name', 'item name', 'product name', 'item', 'product'], example: 'Kajaria Vitrified Floor Tile 600x600mm' },
    { key: 'sku', labelEn: 'SKU / Code', labelHi: 'SKU / कोड', aliases: ['sku', 'item code', 'code'], example: 'TILE-KAJ-600' },
    { key: 'barcode', labelEn: 'Barcode', labelHi: 'बारकोड', aliases: ['barcode', 'ean', 'upc'], example: '8901234567890' },
    { key: 'item_type', labelEn: 'Type (goods/service)', labelHi: 'प्रकार (goods/service)', aliases: ['item_type', 'type'], example: 'goods' },
    { key: 'category', labelEn: 'Category', labelHi: 'श्रेणी', aliases: ['category', 'group', 'category name'], example: 'Vitrified Tiles' },
    { key: 'brand', labelEn: 'Brand', labelHi: 'ब्रांड', aliases: ['brand', 'company', 'make'], example: 'Kajaria' },
    { key: 'unit', labelEn: 'Base Unit (box/pcs/sqft/sqm/kg/ltr/mtr)', labelHi: 'इकाई', aliases: ['unit', 'uom', 'base_unit', 'unit code'], example: 'box' },
    { key: 'selling_price', labelEn: 'Selling Price *', labelHi: 'बिक्री मूल्य *', required: true, aliases: ['selling_price', 'sale price', 'rate', 'price'], example: 850 },
    { key: 'mrp', labelEn: 'MRP', labelHi: 'एमआरपी', aliases: ['mrp', 'max retail price'], example: 950 },
    { key: 'purchase_price', labelEn: 'Purchase Cost', labelHi: 'खरीद मूल्य', aliases: ['purchase_price', 'cost', 'cost price', 'buy price'], example: 640 },
    { key: 'gst_rate', labelEn: 'GST %', labelHi: 'जीएसटी %', aliases: ['gst_rate', 'gst', 'tax', 'tax %', 'tax rate'], example: 18 },
    { key: 'hsn_code', labelEn: 'HSN / SAC Code', labelHi: 'HSN / SAC कोड', aliases: ['hsn_code', 'hsn', 'sac', 'sac_code'], example: '6907' },
    { key: 'opening_stock', labelEn: 'Opening Stock', labelHi: 'प्रारंभिक स्टॉक', aliases: ['opening_stock', 'stock', 'qty', 'opening qty'], example: 50 },
    { key: 'low_stock_alert', labelEn: 'Low Stock Alert', labelHi: 'कम स्टॉक अलर्ट', aliases: ['low_stock_alert', 'min stock', 'reorder level'], example: 10 },
  ],
};

export interface ParsedSpreadsheetResult {
  sheetNames: string[];
  selectedSheet: string;
  headers: string[];
  rows: Array<Record<string, unknown>>;
}

export interface InvalidImportRow {
  row: number;
  name: string;
  error: string;
  raw: Record<string, unknown>;
}

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function normalizeHeaderKey(header: string): string {
  return String(header || '')
    .trim()
    .toLowerCase()
    .replace(/[*()%/]/g, ' ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseCsvMatrix(csvInput: string): string[][] {
  const text = csvInput.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      row.push(cell);
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }

  row.push(cell);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows;
}

function isZipMagicHeader(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function isLegacyXlsMagicHeader(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0
  );
}

export async function parseSpreadsheetBuffer(
  data: ArrayBuffer | Uint8Array,
  fileName = 'import.xlsx',
  preferredSheet?: string
): Promise<ParsedSpreadsheetResult> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength === 0) {
    throw new Error('Spreadsheet file is empty.');
  }

  if (isLegacyXlsMagicHeader(bytes)) {
    throw new Error('Legacy binary .xls files are not supported. Please save the file as .xlsx or .csv.');
  }

  let sheetNames: string[] = [];
  let selectedSheet = 'Sheet1';
  let matrix: unknown[][] = [];

  if (isZipMagicHeader(bytes)) {
    const sheets = await readXlsxFile(bytes);
    if (!sheets || sheets.length === 0) {
      throw new Error('Spreadsheet does not contain any sheets.');
    }
    sheetNames = sheets.map((s) => s.sheet);
    selectedSheet =
      preferredSheet && sheetNames.includes(preferredSheet)
        ? preferredSheet
        : sheetNames[0];
    const target = sheets.find((s) => s.sheet === selectedSheet) || sheets[0];
    matrix = (target.data || [])
      .map((row) =>
        (row || []).map((cell) => {
          if (cell instanceof Date) return cell.toISOString().slice(0, 10);
          return cell ?? '';
        })
      )
      .filter((row) => row.some((v) => String(v).trim() !== ''));
  } else {
    if (fileName.toLowerCase().endsWith('.xlsx')) {
      throw new Error('Invalid .xlsx file format. Please upload a valid .xlsx or .csv file.');
    }
    const decoded = new TextDecoder('utf-8').decode(bytes);
    sheetNames = ['Sheet1'];
    selectedSheet = 'Sheet1';
    matrix = parseCsvMatrix(decoded);
  }

  if (matrix.length === 0) {
    return { sheetNames, selectedSheet, headers: [], rows: [] };
  }

  const rawHeaders = (matrix[0] || []).map((h, i) => {
    const label = String(h ?? '').trim();
    return label || `Column_${i + 1}`;
  });
  const rows: Array<Record<string, unknown>> = [];

  for (let r = 1; r < matrix.length; r += 1) {
    const arr = matrix[r] || [];
    const obj: Record<string, unknown> = {};
    let hasValue = false;
    rawHeaders.forEach((header, idx) => {
      const val = arr[idx] ?? '';
      if (String(val).trim() !== '') hasValue = true;
      obj[header] = val;
    });
    if (hasValue) rows.push(obj);
  }

  return {
    sheetNames,
    selectedSheet,
    headers: rawHeaders,
    rows,
  };
}

export function autoMapColumns(
  headers: string[],
  entityType: ImportEntityType
): Record<string, string> {
  const specs = IMPORT_FIELD_SPECS[entityType];
  const mapping: Record<string, string> = {};
  const normalizedHeaders = headers.map((h) => ({
    original: h,
    norm: normalizeHeaderKey(h),
  }));

  for (const spec of specs) {
    const candidateTokens = [spec.key, ...spec.aliases].map((a) => normalizeHeaderKey(a));
    const exact = normalizedHeaders.find((h) => candidateTokens.includes(h.norm));
    if (exact) {
      mapping[spec.key] = exact.original;
      continue;
    }
    const partial = normalizedHeaders.find((h) =>
      candidateTokens.some((t) => h.norm && (h.norm.includes(t) || t.includes(h.norm)))
    );
    if (partial) {
      mapping[spec.key] = partial.original;
    }
  }

  return mapping;
}

export function mapAndValidateImportRows(
  rows: Array<Record<string, unknown>>,
  mapping: Record<string, string>,
  entityType: ImportEntityType
): {
  validRows: Array<Record<string, unknown>>;
  invalidRows: InvalidImportRow[];
} {
  const validRows: Array<Record<string, unknown>> = [];
  const invalidRows: InvalidImportRow[] = [];

  const pick = (row: Record<string, unknown>, fieldKey: string): string => {
    const col = mapping[fieldKey];
    if (!col) return '';
    return String(row[col] ?? '').trim();
  };

  const parseNum = (raw: string, fieldLabel: string): number => {
    if (!raw) return 0;
    const cleaned = raw.replace(/[₹,\s]/g, '');
    const n = Number(cleaned);
    if (!Number.isFinite(n)) {
      throw new Error(`${fieldLabel} "${raw}" is not a valid number.`);
    }
    if (n < 0) {
      throw new Error(`${fieldLabel} cannot be negative.`);
    }
    return n;
  };

  rows.forEach((rawRow, idx) => {
    const rowNumber = idx + 2;
    const name = pick(rawRow, 'name');

    try {
      if (!name) {
        throw new Error(entityType === 'parties' ? 'Party Name is required.' : 'Item Name is required.');
      }

      if (entityType === 'parties') {
        const gstin = pick(rawRow, 'gstin').toUpperCase();
        if (gstin && !GSTIN_REGEX.test(gstin)) {
          throw new Error(`Invalid GSTIN format "${gstin}".`);
        }

        const ptypeRaw = pick(rawRow, 'party_type').toLowerCase();
        const party_type =
          ptypeRaw && ['customer', 'supplier', 'both'].includes(ptypeRaw)
            ? ptypeRaw
            : ptypeRaw
              ? (() => {
                  throw new Error(`Invalid party_type "${ptypeRaw}" (expected customer, supplier, or both).`);
                })()
              : 'customer';

        const ob = parseNum(pick(rawRow, 'opening_balance'), 'Opening Balance');
        const credit_limit = parseNum(pick(rawRow, 'credit_limit'), 'Credit Limit');
        const credit_days = Math.round(parseNum(pick(rawRow, 'credit_days'), 'Credit Days'));
        const obTypeRaw = pick(rawRow, 'opening_balance_type').toLowerCase();
        const opening_balance_type = obTypeRaw === 'to_give' ? 'to_give' : 'to_receive';

        validRows.push({
          name,
          party_type,
          phone: pick(rawRow, 'phone') || null,
          email: pick(rawRow, 'email') || null,
          gstin: gstin || null,
          opening_balance: ob,
          opening_balance_type,
          credit_limit,
          credit_days,
          address: pick(rawRow, 'address') || null,
          city: pick(rawRow, 'city') || null,
          state: pick(rawRow, 'state') || null,
          pincode: pick(rawRow, 'pincode') || null,
          notes: pick(rawRow, 'notes') || null,
        });
      } else {
        const sellingRaw = pick(rawRow, 'selling_price');
        const selling_price = parseNum(sellingRaw, 'Selling Price');
        const mrpRaw = pick(rawRow, 'mrp');
        const mrp = mrpRaw ? parseNum(mrpRaw, 'MRP') : null;
        const purchaseRaw = pick(rawRow, 'purchase_price');
        const purchase_price = purchaseRaw ? parseNum(purchaseRaw, 'Purchase Price') : null;
        const gst_rate = parseNum(pick(rawRow, 'gst_rate'), 'GST %');
        if (gst_rate > 28) {
          throw new Error(`GST % (${gst_rate}) must be between 0 and 28.`);
        }
        const opening_stock = parseNum(pick(rawRow, 'opening_stock'), 'Opening Stock');
        const low_stock_alert = parseNum(pick(rawRow, 'low_stock_alert'), 'Low Stock Alert');

        const typeRaw = pick(rawRow, 'item_type').toLowerCase();
        const item_type = typeRaw === 'service' ? 'service' : 'goods';

        validRows.push({
          name,
          sku: pick(rawRow, 'sku') || null,
          barcode: pick(rawRow, 'barcode') || null,
          item_type,
          category: pick(rawRow, 'category') || null,
          brand: pick(rawRow, 'brand') || null,
          unit: pick(rawRow, 'unit') || 'pcs',
          selling_price,
          mrp,
          purchase_price,
          gst_rate,
          hsn_code: pick(rawRow, 'hsn_code') || null,
          opening_stock,
          low_stock_alert,
        });
      }
    } catch (err) {
      invalidRows.push({
        row: rowNumber,
        name: name || `(Row ${rowNumber})`,
        error: err instanceof Error ? err.message : 'Validation failed.',
        raw: rawRow,
      });
    }
  });

  return { validRows, invalidRows };
}

function sanitizeCsvCellValue(value: unknown): unknown {
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(value)) {
    return `'${value}`;
  }
  return value;
}

function encodeCsvCell(value: unknown, sanitizeFormula = true): string {
  const safeVal = sanitizeFormula ? sanitizeCsvCellValue(value) : value;
  const raw = safeVal === null || safeVal === undefined ? '' : String(safeVal);
  if (/[",\n\r]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function stringifyCsvRows(rows: Array<Array<unknown>>): string {
  const body = rows
    .map((row) => row.map((cell) => encodeCsvCell(cell, true)).join(','))
    .join('\r\n');
  return `\uFEFF${body}`;
}

function toExcelCell(value: unknown): Cell {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'boolean' || value instanceof Date || typeof value === 'string') {
    return value;
  }
  return String(value);
}

function toSheetData(rows: Array<Array<unknown>>): SheetData {
  return rows.map((row): Row => row.map((cell) => toExcelCell(cell)));
}

async function writeSheetsToXlsxUint8Array(
  sheets: Array<{ name: string; data: SheetData }>
): Promise<Uint8Array> {
  const entries: Sheet<Blob>[] =
    sheets.length > 0
      ? sheets.map((s, idx) => ({
          sheet: (s.name || `Sheet${idx + 1}`).slice(0, 31),
          data: s.data,
        }))
      : [{ sheet: 'Sheet1', data: [[]] }];

  const blob = await writeXlsxFile(entries).toBlob();
  const ab = await blob.arrayBuffer();
  return new Uint8Array(ab);
}

export async function buildTemplateWorkbookBuffer(
  entityType: ImportEntityType,
  format: 'xlsx' | 'csv'
): Promise<{ buffer: Uint8Array; mimeType: string; filename: string }> {
  const specs = IMPORT_FIELD_SPECS[entityType];
  const headers = specs.map((s) => s.key);
  const sampleRow = specs.map((s) => s.example);

  if (format === 'csv') {
    const csvText = stringifyCsvRows([headers, sampleRow]);
    return {
      buffer: new TextEncoder().encode(csvText),
      mimeType: 'text/csv;charset=utf-8;',
      filename: `decorbiz-${entityType}-template.csv`,
    };
  }

  const sheetName = entityType === 'parties' ? 'Parties' : 'Items';
  const buffer = await writeSheetsToXlsxUint8Array([
    { name: sheetName, data: toSheetData([headers, sampleRow]) },
  ]);
  return {
    buffer,
    mimeType: XLSX_MIME,
    filename: `decorbiz-${entityType}-template.xlsx`,
  };
}

export async function buildExportWorkbookBuffer(
  sheets: Array<{ name: string; headers: string[]; rows: Array<Array<unknown>> }>,
  format: 'xlsx' | 'csv'
): Promise<{ buffer: Uint8Array; mimeType: string }> {
  if (format === 'csv') {
    const firstSheet = sheets[0];
    if (!firstSheet) {
      return {
        buffer: new TextEncoder().encode('\uFEFF'),
        mimeType: 'text/csv;charset=utf-8;',
      };
    }
    const csvText = stringifyCsvRows([firstSheet.headers, ...firstSheet.rows]);
    return {
      buffer: new TextEncoder().encode(csvText),
      mimeType: 'text/csv;charset=utf-8;',
    };
  }

  const buffer = await writeSheetsToXlsxUint8Array(
    sheets.map((s) => ({
      name: s.name.slice(0, 31),
      data: toSheetData([s.headers, ...s.rows]),
    }))
  );
  return {
    buffer,
    mimeType: XLSX_MIME,
  };
}

export function buildErrorCsvText(
  invalidRows: Array<{ row: number; name: string; error: string }>
): string {
  return stringifyCsvRows([
    ['Row', 'Name', 'Error'],
    ...invalidRows.map((r) => [r.row, r.name, r.error]),
  ]);
}

// ----------------------------------------------------------------------------
// Browser Download Helpers
// ----------------------------------------------------------------------------
export function triggerBrowserDownload(
  bytes: Uint8Array | string,
  filename: string,
  mimeType: string
): void {
  const blobPart: BlobPart =
    typeof bytes === 'string'
      ? bytes
      : bytes.slice().buffer;
  const blob = new Blob([blobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadImportTemplate(
  entityType: ImportEntityType,
  format: 'xlsx' | 'csv'
): Promise<void> {
  const { buffer, mimeType, filename } = await buildTemplateWorkbookBuffer(entityType, format);
  triggerBrowserDownload(buffer, filename, mimeType);
}

export async function exportSheetsToBrowser(
  filenameBase: string,
  sheets: Array<{ name: string; headers: string[]; rows: Array<Array<unknown>> }>,
  format: 'xlsx' | 'csv'
): Promise<void> {
  const { buffer, mimeType } = await buildExportWorkbookBuffer(sheets, format);
  const ext = format === 'csv' ? '.csv' : '.xlsx';
  const filename = filenameBase.endsWith(ext) ? filenameBase : `${filenameBase}${ext}`;
  triggerBrowserDownload(buffer, filename, mimeType);
}
