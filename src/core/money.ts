export type BillDocumentType =
  | 'tax_invoice'
  | 'bill_of_supply'
  | 'quotation'
  | 'credit_note';

export interface BillLineCalcInput {
  enteredQty: number;
  unitPrice: number;
  discountPct: number;
  gstRate: number;
  taxInclusive: boolean;
}

export interface BillLineCalcResult {
  grossAmount: number;
  discountAmount: number;
  taxableAmount: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  taxAmount: number;
  lineTotal: number;
  effectiveGstRate: number;
}

export interface BillCalcSummary {
  lines: BillLineCalcResult[];
  gstApplied: boolean;
  isInterstate: boolean;
  subtotalTaxable: number;
  discountTotal: number;
  cgstTotal: number;
  sgstTotal: number;
  igstTotal: number;
  taxTotal: number;
  extraCharges: number;
  roundOff: number;
  grandTotal: number;
}

/**
 * Decimal-safe round half away from zero matching PostgreSQL `round(numeric, scale)`.
 */
export function roundHalfUp(value: number, decimals = 2): number {
  if (!Number.isFinite(value) || value === 0) return 0;
  const sign = value < 0 ? -1 : 1;
  const absStr = Math.abs(value).toFixed(decimals + 6);
  const rounded = Math.round(Number(`${absStr}e${decimals}`));
  const result = sign * Number(`${rounded}e-${decimals}`);
  return Object.is(result, -0) ? 0 : result;
}

export function calculateBillPreview(params: {
  gstRegistered: boolean;
  taxModuleEnabled?: boolean;
  docType: BillDocumentType;
  businessStateCode?: string | null;
  placeOfSupplyStateCode?: string | null;
  extraCharges?: number;
  autoRoundOff?: boolean;
  lines: BillLineCalcInput[];
}): BillCalcSummary {
  const gstApplied =
    Boolean(params.gstRegistered) &&
    (params.taxModuleEnabled ?? true) &&
    params.docType !== 'bill_of_supply';

  const bizState = (params.businessStateCode ?? '').trim().toUpperCase();
  const posState = (params.placeOfSupplyStateCode ?? '').trim().toUpperCase();
  const isInterstate =
    gstApplied && bizState.length > 0 && posState.length > 0 && bizState !== posState;

  let subtotalTaxable = 0;
  let discountTotal = 0;
  let cgstTotal = 0;
  let sgstTotal = 0;
  let igstTotal = 0;

  const lines: BillLineCalcResult[] = params.lines.map((line) => {
    const qty = Math.max(0, Number.isFinite(line.enteredQty) ? line.enteredQty : 0);
    const price = Math.max(0, Number.isFinite(line.unitPrice) ? line.unitPrice : 0);
    const discPct = Math.min(
      100,
      Math.max(0, Number.isFinite(line.discountPct) ? line.discountPct : 0)
    );
    const effectiveGstRate = gstApplied
      ? Math.min(100, Math.max(0, Number.isFinite(line.gstRate) ? line.gstRate : 0))
      : 0;

    const grossAmount = roundHalfUp(qty * price, 2);
    const discountAmount = roundHalfUp((grossAmount * discPct) / 100, 2);
    const lineAfterDisc = roundHalfUp(grossAmount - discountAmount, 2);

    let taxableAmount = lineAfterDisc;
    let taxAmount = 0;
    let lineTotal = lineAfterDisc;

    if (effectiveGstRate > 0) {
      if (line.taxInclusive) {
        taxableAmount = roundHalfUp(lineAfterDisc / (1 + effectiveGstRate / 100), 2);
        taxAmount = roundHalfUp(lineAfterDisc - taxableAmount, 2);
        lineTotal = lineAfterDisc;
      } else {
        taxableAmount = lineAfterDisc;
        taxAmount = roundHalfUp((taxableAmount * effectiveGstRate) / 100, 2);
        lineTotal = roundHalfUp(taxableAmount + taxAmount, 2);
      }
    }

    let cgstAmount = 0;
    let sgstAmount = 0;
    let igstAmount = 0;

    if (taxAmount > 0) {
      if (isInterstate) {
        igstAmount = taxAmount;
      } else {
        cgstAmount = roundHalfUp(taxAmount / 2, 2);
        sgstAmount = roundHalfUp(taxAmount - cgstAmount, 2);
      }
    }

    subtotalTaxable = roundHalfUp(subtotalTaxable + taxableAmount, 2);
    discountTotal = roundHalfUp(discountTotal + discountAmount, 2);
    cgstTotal = roundHalfUp(cgstTotal + cgstAmount, 2);
    sgstTotal = roundHalfUp(sgstTotal + sgstAmount, 2);
    igstTotal = roundHalfUp(igstTotal + igstAmount, 2);

    return {
      grossAmount,
      discountAmount,
      taxableAmount,
      cgstAmount,
      sgstAmount,
      igstAmount,
      taxAmount,
      lineTotal,
      effectiveGstRate,
    };
  });

  const taxTotal = roundHalfUp(cgstTotal + sgstTotal + igstTotal, 2);
  const extraCharges = roundHalfUp(
    Math.max(0, Number.isFinite(params.extraCharges ?? 0) ? (params.extraCharges ?? 0) : 0),
    2
  );
  const preRound = roundHalfUp(subtotalTaxable + taxTotal + extraCharges, 2);

  const autoRoundOff = params.autoRoundOff ?? true;
  const roundOff = autoRoundOff
    ? roundHalfUp(roundHalfUp(preRound, 0) - preRound, 2)
    : 0;
  const grandTotal = roundHalfUp(preRound + roundOff, 2);

  return {
    lines,
    gstApplied,
    isInterstate,
    subtotalTaxable,
    discountTotal,
    cgstTotal,
    sgstTotal,
    igstTotal,
    taxTotal,
    extraCharges,
    roundOff,
    grandTotal,
  };
}

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];

const TENS = [
  '',
  '',
  'Twenty',
  'Thirty',
  'Forty',
  'Fifty',
  'Sixty',
  'Seventy',
  'Eighty',
  'Ninety',
];

function twoDigitWords(n: number): string {
  if (n === 0) return '';
  if (n < 20) return ONES[n];
  return `${TENS[Math.floor(n / 10)]}${n % 10 > 0 ? ` ${ONES[n % 10]}` : ''}`.trim();
}

function threeDigitWords(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundreds > 0) parts.push(`${ONES[hundreds]} Hundred`);
  if (rest > 0) parts.push(twoDigitWords(rest));
  return parts.join(' ');
}

function integerToIndianWords(num: number): string {
  if (num <= 0) return 'Zero';
  const crores = Math.floor(num / 10_000_000);
  const lakhs = Math.floor((num % 10_000_000) / 100_000);
  const thousands = Math.floor((num % 100_000) / 1000);
  const remainder = num % 1000;

  const parts: string[] = [];
  if (crores > 0) parts.push(`${integerToIndianWords(crores)} Crore`);
  if (lakhs > 0) parts.push(`${twoDigitWords(lakhs)} Lakh`);
  if (thousands > 0) parts.push(`${twoDigitWords(thousands)} Thousand`);
  if (remainder > 0) parts.push(threeDigitWords(remainder));
  return parts.join(' ').trim();
}

export function amountInWordsINR(amount: number): string {
  const clean = Math.max(0, roundHalfUp(amount, 2));
  const rupees = Math.floor(clean);
  const paise = Math.round((clean - rupees) * 100);
  const rupeeText = `${integerToIndianWords(rupees)} ${rupees === 1 ? 'Rupee' : 'Rupees'}`;
  if (paise > 0) {
    return `${rupeeText} and ${twoDigitWords(paise)} Paise Only`;
  }
  return `${rupeeText} Only`;
}
