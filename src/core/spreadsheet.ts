/**
 * CSV & XLSX Spreadsheet Import / Template / Export Engine
 * Built around SheetJS (`xlsx`) for real CSV & Excel (.xlsx/.xls) support.
 * Pure buffer parsing/mapping/validation helpers are safe in both browser and Node tests.
 */
import * as XLSX from 'xlsx';

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
    { key: 'price_tier', labelEn: 'Price Tier (standard/wholesale_a/wholesale_b/vip)', labelHi: 'मूल्य स्तर', aliases: ['price_tier', 'tier', 'rate tier'], example: 'standard' },
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
    { key: 'name', labelEn: 'Item Name *', labelHi: 'आइटम का नाम *', required: true, aliases: ['name', 'item name', 'product name', 'item', 'product'], example: 'Paracetamol 650mg Strip' },
    { key: 'sku', labelEn: 'SKU / Code', labelHi: 'SKU / कोड', aliases: ['sku', 'item code', 'code'], example: 'MED-PCM-650' },
    { key: 'barcode', labelEn: 'Barcode', labelHi: 'बारकोड', aliases: ['barcode', 'ean', 'upc'], example: '8901234567890' },
    { key: 'item_type', labelEn: 'Type (goods/service)', labelHi: 'प्रकार (goods/service)', aliases: ['item_type', 'type'], example: 'goods' },
    { key: 'category', labelEn: 'Category', labelHi: 'श्रेणी', aliases: ['category', 'group', 'category name'], example: 'Medicines' },
    { key: 'brand', labelEn: 'Brand', labelHi: 'ब्रांड', aliases: ['brand', 'company', 'make'], example: 'Micro Labs' },
    { key: 'unit', labelEn: 'Base Unit (pcs/kg/g/box/ltr/mtr/hr)', labelHi: 'इकाई', aliases: ['unit', 'uom', 'base_unit', 'unit code'], example: 'pcs' },
    { key: 'selling_price', labelEn: 'Selling Price *', labelHi: 'बिक्री मूल्य *', required: true, aliases: ['selling_price', 'sale price', 'rate', 'price'], example: 32 },
    { key: 'mrp', labelEn: 'MRP', labelHi: 'एमआरपी', aliases: ['mrp', 'max retail price'], example: 35 },
    { key: 'purchase_price', labelEn: 'Purchase Cost', labelHi: 'खरीद मूल्य', aliases: ['purchase_price', 'cost', 'cost price', 'buy price'], example: 22 },
    { key: 'gst_rate', labelEn: 'GST %', labelHi: 'जीएसटी %', aliases: ['gst_rate', 'gst', 'tax', 'tax %', 'tax rate'], example: 12 },
    { key: 'hsn_code', labelEn: 'HSN / SAC Code', labelHi: 'HSN / SAC कोड', aliases: ['hsn_code', 'hsn', 'sac', 'sac_code'], example: '3004' },
    { key: 'opening_stock', labelEn: 'Opening Stock', labelHi: 'प्रारंभिक स्टॉक', aliases: ['opening_stock', 'stock', 'qty', 'opening qty'], example: 50 },
    { key: 'low_stock_alert', labelEn: 'Low Stock Alert', labelHi: 'कम स्टॉक अलर्ट', aliases: ['low_stock_alert', 'min stock', 'reorder level'], example: 10 },
    { key: 'salt', labelEn: 'Salt / Composition (Medical)', labelHi: 'सॉल्ट (मेडिकल)', aliases: ['salt', 'composition', 'salt name'], example: 'Paracetamol 650mg' },
    { key: 'schedule', labelEn: 'Schedule (OTC/H/H1/X)', labelHi: 'शेड्यूल (OTC/H/H1)', aliases: ['schedule', 'drug schedule'], example: 'OTC' },
    { key: 'warranty_months', labelEn: 'Warranty Months (Hardware)', labelHi: 'वारंटी (महीने)', aliases: ['warranty_months', 'warranty'], example: 12 },
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

export function normalizeHeaderKey(header: string): string {
  return String(header || '')
    .trim()
    .toLowerCase()
    .replace(/[*()%/]/g, ' ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function parseSpreadsheetBuffer(
  data: ArrayBuffer | Uint8Array,
  _fileName = 'import.xlsx',
  preferredSheet?: string
): ParsedSpreadsheetResult {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const workbook = XLSX.read(bytes, { type: 'array', cellDates: false });
  const sheetNames = workbook.SheetNames || [];
  if (sheetNames.length === 0) {
    throw new Error('Spreadsheet does not contain any sheets.');
  }
  const selectedSheet =
    preferredSheet && sheetNames.includes(preferredSheet)
      ? preferredSheet
      : sheetNames[0];
  const sheet = workbook.Sheets[selectedSheet];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: '',
    blankrows: false,
  });

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
    const rowNumber = idx + 2; // 1-indexed header row + data offset
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

        const tierRaw = pick(rawRow, 'price_tier').toLowerCase();
        const price_tier = ['standard', 'wholesale_a', 'wholesale_b', 'vip'].includes(tierRaw)
          ? tierRaw
          : 'standard';

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
          price_tier,
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
        const warrantyRaw = pick(rawRow, 'warranty_months');
        const warranty_months = warrantyRaw ? Math.round(parseNum(warrantyRaw, 'Warranty Months')) : null;

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
          salt: pick(rawRow, 'salt') || null,
          schedule: pick(rawRow, 'schedule') || null,
          warranty_months,
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

export function buildTemplateWorkbookBuffer(
  entityType: ImportEntityType,
  format: 'xlsx' | 'csv'
): { buffer: Uint8Array; mimeType: string; filename: string } {
  const specs = IMPORT_FIELD_SPECS[entityType];
  const headers = specs.map((s) => s.key);
  const sampleRow = specs.map((s) => s.example);

  if (format === 'csv') {
    const csvWs = XLSX.utils.aoa_to_sheet([
      headers.map(sanitizeCsvCellValue),
      sampleRow.map(sanitizeCsvCellValue),
    ]);
    const csvText = `\uFEFF${XLSX.utils.sheet_to_csv(csvWs)}`;
    return {
      buffer: new TextEncoder().encode(csvText),
      mimeType: 'text/csv;charset=utf-8;',
      filename: `bizone-${entityType}-template.csv`,
    };
  }

  const ws = XLSX.utils.aoa_to_sheet([headers, sampleRow]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, entityType === 'parties' ? 'Parties' : 'Items');
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return {
    buffer: new Uint8Array(out),
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    filename: `bizone-${entityType}-template.xlsx`,
  };
}

export function buildExportWorkbookBuffer(
  sheets: Array<{ name: string; headers: string[]; rows: Array<Array<unknown>> }>,
  format: 'xlsx' | 'csv'
): { buffer: Uint8Array; mimeType: string } {
  if (format === 'csv') {
    const firstSheet = sheets[0];
    if (!firstSheet) {
      return {
        buffer: new TextEncoder().encode('\uFEFF'),
        mimeType: 'text/csv;charset=utf-8;',
      };
    }
    const csvWs = XLSX.utils.aoa_to_sheet([
      firstSheet.headers.map(sanitizeCsvCellValue),
      ...firstSheet.rows.map((r) => r.map(sanitizeCsvCellValue)),
    ]);
    const csvText = `\uFEFF${XLSX.utils.sheet_to_csv(csvWs)}`;
    return {
      buffer: new TextEncoder().encode(csvText),
      mimeType: 'text/csv;charset=utf-8;',
    };
  }

  const wb = XLSX.utils.book_new();
  sheets.forEach((s) => {
    const ws = XLSX.utils.aoa_to_sheet([s.headers, ...s.rows]);
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  });

  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return {
    buffer: new Uint8Array(out),
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}

export function buildErrorCsvText(
  invalidRows: Array<{ row: number; name: string; error: string }>
): string {
  const ws = XLSX.utils.aoa_to_sheet([
    ['Row', 'Name', 'Error'],
    ...invalidRows.map((r) => [
      r.row,
      sanitizeCsvCellValue(r.name),
      sanitizeCsvCellValue(r.error),
    ]),
  ]);
  return `\uFEFF${XLSX.utils.sheet_to_csv(ws)}`;
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

export function downloadImportTemplate(
  entityType: ImportEntityType,
  format: 'xlsx' | 'csv'
): void {
  const { buffer, mimeType, filename } = buildTemplateWorkbookBuffer(entityType, format);
  triggerBrowserDownload(buffer, filename, mimeType);
}

export function exportSheetsToBrowser(
  filenameBase: string,
  sheets: Array<{ name: string; headers: string[]; rows: Array<Array<unknown>> }>,
  format: 'xlsx' | 'csv'
): void {
  const { buffer, mimeType } = buildExportWorkbookBuffer(sheets, format);
  const ext = format === 'csv' ? '.csv' : '.xlsx';
  const filename = filenameBase.endsWith(ext) ? filenameBase : `${filenameBase}${ext}`;
  triggerBrowserDownload(buffer, filename, mimeType);
}
