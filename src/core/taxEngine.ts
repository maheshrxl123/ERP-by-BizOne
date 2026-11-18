import { roundHalfUp } from './money.ts';

export interface TaxLineInput {
  itemId?: string;
  itemName: string;
  hsnCode: string | null;
  qty: number;
  unitPrice: number;
  discountPct: number;
  gstRate: number;
  taxInclusive: boolean;
  isInterstate: boolean;
  gstRegistered: boolean;
}

export interface TaxLineResult {
  grossAmount: number;
  discountAmount: number;
  taxableAmount: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  taxAmount: number;
  lineTotal: number;
}

export interface Gstr2bCandidateRow {
  supplierGstin: string;
  invoiceNo: string;
  invoiceDate: string;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
}

export interface PurchaseItcCandidate {
  id: string;
  purchaseNumber: string | null;
  supplierInvoiceNo: string | null;
  partyGstin: string | null;
  taxableValue: number;
  cgstTotal: number;
  sgstTotal: number;
  igstTotal: number;
  taxTotal: number;
}

export interface ItcReconciliationResultRow extends Gstr2bCandidateRow {
  matchStatus: 'matched' | 'mismatch' | 'missing_in_books';
  matchedPurchaseId: string | null;
  matchedPurchaseNumber: string | null;
  booksTax: number;
  portalTax: number;
  varianceAmount: number;
}

export interface TaxEngine {
  readonly code: string;
  computeLineTax(input: TaxLineInput): TaxLineResult;
  reconcileItc2B(
    portalRows: Gstr2bCandidateRow[],
    purchaseBills: PurchaseItcCandidate[]
  ): {
    rows: ItcReconciliationResultRow[];
    matchedCount: number;
    mismatchCount: number;
    missingInBooksCount: number;
    totalPortalItc: number;
    totalBooksItc: number;
    netVariance: number;
  };
}

function round2(n: number): number {
  return roundHalfUp(Number(n || 0), 2);
}

export class IndiaGstTaxEngine implements TaxEngine {
  readonly code = 'IN_GST';

  computeLineTax(input: TaxLineInput): TaxLineResult {
    const qty = Math.max(0, Number(input.qty || 0));
    const rate = Math.max(0, Number(input.unitPrice || 0));
    const discPct = Math.min(100, Math.max(0, Number(input.discountPct || 0)));
    const effRate = input.gstRegistered ? Math.max(0, Number(input.gstRate || 0)) : 0;

    const grossAmount = round2(qty * rate);
    const discountAmount = round2((grossAmount * discPct) / 100);
    const netAmount = round2(grossAmount - discountAmount);

    let taxableAmount = netAmount;
    let taxAmount = 0;

    if (effRate > 0) {
      if (input.taxInclusive) {
        taxableAmount = round2((netAmount * 100) / (100 + effRate));
        taxAmount = round2(netAmount - taxableAmount);
      } else {
        taxAmount = round2((taxableAmount * effRate) / 100);
      }
    }

    let cgstAmount = 0;
    let sgstAmount = 0;
    let igstAmount = 0;

    if (taxAmount > 0) {
      if (input.isInterstate) {
        igstAmount = taxAmount;
      } else {
        cgstAmount = round2(taxAmount / 2);
        sgstAmount = round2(taxAmount - cgstAmount);
      }
    }

    const lineTotal = round2(taxableAmount + taxAmount);

    return {
      grossAmount,
      discountAmount,
      taxableAmount,
      cgstAmount,
      sgstAmount,
      igstAmount,
      taxAmount,
      lineTotal,
    };
  }

  reconcileItc2B(
    portalRows: Gstr2bCandidateRow[],
    purchaseBills: PurchaseItcCandidate[]
  ) {
    let matchedCount = 0;
    let mismatchCount = 0;
    let missingInBooksCount = 0;
    let totalPortalItc = 0;
    let totalBooksItc = 0;

    const rows: ItcReconciliationResultRow[] = portalRows.map((row) => {
      const normGstin = row.supplierGstin.trim().toUpperCase();
      const normInv = row.invoiceNo.trim().toUpperCase();
      const portalTax = round2(Number(row.cgst || 0) + Number(row.sgst || 0) + Number(row.igst || 0));
      totalPortalItc = round2(totalPortalItc + portalTax);

      const found = purchaseBills.find(
        (pb) =>
          (pb.partyGstin || '').trim().toUpperCase() === normGstin &&
          (pb.supplierInvoiceNo || pb.purchaseNumber || '').trim().toUpperCase() === normInv
      );

      if (!found) {
        missingInBooksCount += 1;
        return {
          ...row,
          matchStatus: 'missing_in_books',
          matchedPurchaseId: null,
          matchedPurchaseNumber: null,
          booksTax: 0,
          portalTax,
          varianceAmount: portalTax,
        };
      }

      const booksTax = round2(Number(found.taxTotal || 0));
      totalBooksItc = round2(totalBooksItc + booksTax);
      const varianceAmount = round2(portalTax - booksTax);

      if (Math.abs(varianceAmount) <= 1.0) {
        matchedCount += 1;
        return {
          ...row,
          matchStatus: 'matched',
          matchedPurchaseId: found.id,
          matchedPurchaseNumber: found.purchaseNumber,
          booksTax,
          portalTax,
          varianceAmount,
        };
      }

      mismatchCount += 1;
      return {
        ...row,
        matchStatus: 'mismatch',
        matchedPurchaseId: found.id,
        matchedPurchaseNumber: found.purchaseNumber,
        booksTax,
        portalTax,
        varianceAmount,
      };
    });

    return {
      rows,
      matchedCount,
      mismatchCount,
      missingInBooksCount,
      totalPortalItc,
      totalBooksItc,
      netVariance: round2(totalPortalItc - totalBooksItc),
    };
  }
}

export const defaultTaxEngine: TaxEngine = new IndiaGstTaxEngine();
