/**
 * BizOne ERP — Business Pack Registry & Pure Domain Calculators
 * Shared cleanly between browser UI and Node verification suites (no DOM/import.meta usage).
 */
import type {
  ItemBatchRecord,
  PriceTier,
  WholesaleSlab,
} from '../types/bizone';

export type PackKey =
  | 'kirana'
  | 'medical'
  | 'clothing'
  | 'hardware'
  | 'general_retail'
  | 'wholesale'
  | 'service';

export interface PackWorkflowMeta {
  key: PackKey;
  workspaceLabelEn: string;
  workspaceLabelHi: string;
  summaryEn: string;
  summaryHi: string;
  recommendedModules: string[];
  requiredModules: string[];
  highlightsEn: string[];
  highlightsHi: string[];
}

export const PACK_WORKFLOWS: Record<PackKey, PackWorkflowMeta> = {
  general_retail: {
    key: 'general_retail',
    workspaceLabelEn: 'Retail Margin & Counter Tools',
    workspaceLabelHi: 'रिटेल मार्जिन और काउंटर टूल',
    summaryEn: 'Fast barcode & SKU billing, category pricing presets, and margin control.',
    summaryHi: 'तेज़ बारकोड और SKU बिलिंग, श्रेणी मूल्य और मार्जिन नियंत्रण।',
    recommendedModules: ['parties', 'inventory', 'billing', 'payments', 'purchases', 'expenses', 'reports', 'backup'],
    requiredModules: [],
    highlightsEn: ['Quick margin & discount preset desk', 'Fast GST & MRP summary', 'Bulk catalog price adjustments'],
    highlightsHi: ['त्वरित मार्जिन और छूट डेस्क', 'तेज़ जीएसटी और एमआरपी सारांश', 'बल्क कैटलॉग मूल्य समायोजन'],
  },
  kirana: {
    key: 'kirana',
    workspaceLabelEn: 'Kirana & Loose Weight Desk',
    workspaceLabelHi: 'किराना और खुला वजन डेस्क',
    summaryEn: 'Loose-weight ₹ <-> kg/g calculator, carton-to-packet units, and MRP customer savings.',
    summaryHi: 'खुला वजन ₹ <-> किग्रा/ग्राम कैलकुलेटर, कार्टन से पैकेट इकाई और एमआरपी बचत।',
    recommendedModules: ['parties', 'inventory', 'billing', 'payments', 'purchases', 'expenses', 'reports', 'backup'],
    requiredModules: [],
    highlightsEn: ['₹ Amount <-> Weight quick converter', 'MRP savings on customer bills', 'Perishable & rack alerts'],
    highlightsHi: ['₹ राशि <-> वजन त्वरित कन्वर्टर', 'ग्राहक बिल पर एमआरपी बचत', 'रैक और कम स्टॉक अलर्ट'],
  },
  medical: {
    key: 'medical',
    workspaceLabelEn: 'Pharmacy Compliance & Expiry',
    workspaceLabelHi: 'फार्मेसी और एक्सपायरी डेस्क',
    summaryEn: 'FEFO batch selection, expired stock lockout, salt substitutes, and Schedule H/H1 register.',
    summaryHi: 'FEFO बैच चयन, एक्सपायर स्टॉक लॉक, सॉल्ट विकल्प और शेड्यूल H/H1 रजिस्टर।',
    recommendedModules: ['parties', 'inventory', 'billing', 'payments', 'purchases', 'expenses', 'reports', 'backup', 'batch_expiry'],
    requiredModules: ['batch_expiry'],
    highlightsEn: ['30 / 60 / 90-day near-expiry watch', 'Drug salt substitute finder', 'Schedule H/H1 & Rx audit register'],
    highlightsHi: ['30 / 60 / 90 दिन एक्सपायरी निगरानी', 'सॉल्ट विकल्प खोजक', 'शेड्यूल H/H1 और प्रिस्क्रिप्शन रजिस्टर'],
  },
  clothing: {
    key: 'clothing',
    workspaceLabelEn: 'Size × Colour Variant Matrix',
    workspaceLabelHi: 'साइज × रंग वेरिएंट मैट्रिक्स',
    summaryEn: 'Size and colour matrix SKU generator, stock grid, and fabric/season catalog fields.',
    summaryHi: 'साइज और रंग मैट्रिक्स SKU जनरेटर, स्टॉक ग्रिड और फैब्रिक/सीजन विवरण।',
    recommendedModules: ['parties', 'inventory', 'billing', 'payments', 'purchases', 'expenses', 'reports', 'backup', 'variants'],
    requiredModules: ['variants'],
    highlightsEn: ['Bulk Size × Colour matrix editor', 'Per-variant SKU & MRP tracking', 'Stock breakdown by size & colour'],
    highlightsHi: ['बल्क साइज × रंग मैट्रिक्स संपादक', 'वेरिएंट SKU और MRP ट्रैकिंग', 'साइज और रंग अनुसार स्टॉक'],
  },
  hardware: {
    key: 'hardware',
    workspaceLabelEn: 'Estimator, Sites & Warranty',
    workspaceLabelHi: 'अनुमान, साइट और वारंटी',
    summaryEn: 'Tiles area & paint/wire material calculator, contractor sites, and serial warranty tracking.',
    summaryHi: 'टाइल क्षेत्र और पेंट/तार सामग्री कैलकुलेटर, कॉन्ट्रैक्टर साइट और वारंटी ट्रैकिंग।',
    recommendedModules: ['parties', 'inventory', 'billing', 'payments', 'purchases', 'expenses', 'reports', 'backup'],
    requiredModules: [],
    highlightsEn: ['Tile box, paint & wire cut estimator', '1-click Estimate -> Quotation', 'Serial number warranty claims'],
    highlightsHi: ['टाइल बॉक्स, पेंट और तार कैलकुलेटर', '1-क्लिक अनुमान -> कोटेशन', 'सीरियल नंबर वारंटी क्लेम'],
  },
  wholesale: {
    key: 'wholesale',
    workspaceLabelEn: 'Price Tiers & Quantity Slabs',
    workspaceLabelHi: 'मूल्य स्तर और मात्रा स्लैब',
    summaryEn: 'Tiered B2B pricing (Wholesale A/B/VIP), quantity break slabs, and party negotiated rates.',
    summaryHi: 'स्तरीय B2B मूल्य निर्धारण, मात्रा स्लैब और पार्टी के विशेष रेट कार्ड।',
    recommendedModules: ['parties', 'inventory', 'billing', 'payments', 'purchases', 'expenses', 'reports', 'backup', 'tax'],
    requiredModules: [],
    highlightsEn: ['Wholesale A/B/VIP tier pricing', 'Automatic quantity-slab billing', 'Party custom negotiated rate cards'],
    highlightsHi: ['थोक A/B/VIP टियर मूल्य निर्धारण', 'स्वचालित मात्रा-स्लैब बिलिंग', 'पार्टी विशेष रेट कार्ड'],
  },
  service: {
    key: 'service',
    workspaceLabelEn: 'Service Jobs & SAC Desk',
    workspaceLabelHi: 'सर्विस जॉब और SAC डेस्क',
    summaryEn: 'SAC non-stock service items, work orders, job expense tagging, and job profitability.',
    summaryHi: 'SAC सेवा आइटम, वर्क ऑर्डर, जॉब खर्च टैगिंग और जॉब लाभप्रदता।',
    recommendedModules: ['parties', 'inventory', 'billing', 'payments', 'purchases', 'expenses', 'reports', 'backup'],
    requiredModules: [],
    highlightsEn: ['Track open -> in-progress -> billed jobs', 'Tag job expenses & invoices', 'Live job margin comparison'],
    highlightsHi: ['वर्क ऑर्डर स्थिति ट्रैकिंग', 'जॉब खर्च और बिल लिंक करें', 'लाइव जॉब लाभप्रदता'],
  },
};

export function getPackWorkflow(pack?: string | null): PackWorkflowMeta {
  const key = (pack || 'general_retail') as PackKey;
  return PACK_WORKFLOWS[key] || PACK_WORKFLOWS.general_retail;
}

export function getPackWorkspaceTitle(pack: string | null | undefined, lang: 'en' | 'hi'): string {
  const wf = getPackWorkflow(pack);
  return lang === 'hi' ? wf.workspaceLabelHi : wf.workspaceLabelEn;
}

export function getRecommendedModulesForPack(pack: string | null | undefined): string[] {
  return getPackWorkflow(pack).recommendedModules;
}

export function round2(n: number): number {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

export function round3(n: number): number {
  return Math.round((Number(n || 0) + Number.EPSILON) * 1000) / 1000;
}

// ----------------------------------------------------------------------------
// Kirana Calculators
// ----------------------------------------------------------------------------
export function computeLooseWeightFromAmount(
  amountRs: number,
  pricePerUnit: number,
  conversionFactor = 1
): { enteredQty: number; baseQty: number; actualAmount: number } {
  if (!Number.isFinite(amountRs) || amountRs <= 0 || !Number.isFinite(pricePerUnit) || pricePerUnit <= 0) {
    return { enteredQty: 0, baseQty: 0, actualAmount: 0 };
  }
  const factor = conversionFactor > 0 ? conversionFactor : 1;
  const effectiveUnitRate = pricePerUnit * factor;
  const enteredQty = round3(amountRs / effectiveUnitRate);
  const baseQty = round3(enteredQty * factor);
  const actualAmount = round2(enteredQty * effectiveUnitRate);
  return { enteredQty, baseQty, actualAmount };
}

export function computeAmountFromWeight(
  enteredQty: number,
  pricePerUnit: number,
  conversionFactor = 1
): number {
  if (!Number.isFinite(enteredQty) || enteredQty <= 0 || !Number.isFinite(pricePerUnit) || pricePerUnit <= 0) {
    return 0;
  }
  const factor = conversionFactor > 0 ? conversionFactor : 1;
  return round2(enteredQty * pricePerUnit * factor);
}

export function computeMrpSavings(
  mrp: number | null | undefined,
  unitPrice: number,
  qty: number
): number {
  if (!mrp || !Number.isFinite(mrp) || mrp <= unitPrice || qty <= 0) return 0;
  return round2((mrp - unitPrice) * qty);
}

// ----------------------------------------------------------------------------
// Medical Helpers (FEFO + Expiry Status)
// ----------------------------------------------------------------------------
export function daysUntilExpiry(expiryDate: string, refDateIso?: string): number {
  const refStr = refDateIso || new Date().toISOString().slice(0, 10);
  const expMs = new Date(`${expiryDate.slice(0, 10)}T00:00:00Z`).getTime();
  const refMs = new Date(`${refStr.slice(0, 10)}T00:00:00Z`).getTime();
  if (!Number.isFinite(expMs) || !Number.isFinite(refMs)) return 0;
  return Math.round((expMs - refMs) / 86_400_000);
}

export function classifyBatchExpiry(
  expiryDate: string,
  refDateIso?: string,
  nearWindowDays = 90
): 'expired' | 'near_expiry' | 'ok' {
  const days = daysUntilExpiry(expiryDate, refDateIso);
  if (days < 0) return 'expired';
  if (days <= nearWindowDays) return 'near_expiry';
  return 'ok';
}

export function sortBatchesFefo<T extends Pick<ItemBatchRecord, 'expiry_date' | 'qty_on_hand' | 'is_active' | 'created_at'>>(
  batches: T[],
  refDateIso?: string
): T[] {
  const refStr = refDateIso || new Date().toISOString().slice(0, 10);
  return batches
    .filter((b) => b.is_active && Number(b.qty_on_hand || 0) > 0 && b.expiry_date >= refStr)
    .slice()
    .sort((a, b) => {
      if (a.expiry_date !== b.expiry_date) return a.expiry_date.localeCompare(b.expiry_date);
      return (a.created_at || '').localeCompare(b.created_at || '');
    });
}

// ----------------------------------------------------------------------------
// Clothing Size x Color Matrix Generator
// ----------------------------------------------------------------------------
export interface VariantMatrixDraftRow {
  size: string;
  color: string;
  sku: string;
  barcode: string;
  selling_price: number;
  mrp: number | null;
  purchase_price: number | null;
  qty_on_hand: number;
  is_active: boolean;
}

export function generateVariantMatrixCombinations(input: {
  sizes: string[];
  colors: string[];
  baseSku?: string | null;
  sellingPrice: number;
  mrp?: number | null;
  purchasePrice?: number | null;
  defaultQty?: number;
}): VariantMatrixDraftRow[] {
  const cleanSizes = input.sizes.map((s) => s.trim()).filter(Boolean);
  const cleanColors = input.colors.map((c) => c.trim()).filter(Boolean);
  const effectiveColors = cleanColors.length > 0 ? cleanColors : ['Default'];
  const skuPrefix = (input.baseSku || 'ITEM').trim().toUpperCase().replace(/[^A-Z0-9-]+/g, '');
  const out: VariantMatrixDraftRow[] = [];

  for (const size of cleanSizes) {
    for (const color of effectiveColors) {
      const sizeCode = size.toUpperCase().replace(/[^A-Z0-9]+/g, '');
      const colorCode = color.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 4);
      const sku = `${skuPrefix}-${sizeCode}${colorCode && colorCode !== 'DEFA' ? `-${colorCode}` : ''}`;
      out.push({
        size,
        color,
        sku,
        barcode: '',
        selling_price: round2(input.sellingPrice),
        mrp: input.mrp != null ? round2(input.mrp) : null,
        purchase_price: input.purchasePrice != null ? round2(input.purchasePrice) : null,
        qty_on_hand: Number(input.defaultQty || 0),
        is_active: true,
      });
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// Hardware Material Estimators
// ----------------------------------------------------------------------------
export function calculateTileBoxes(
  areaSqFt: number,
  sqftPerBox: number,
  wastagePct = 10
): { totalSqFtWithWastage: number; boxesNeeded: number; actualCoveredSqFt: number } {
  if (areaSqFt <= 0 || sqftPerBox <= 0) {
    return { totalSqFtWithWastage: 0, boxesNeeded: 0, actualCoveredSqFt: 0 };
  }
  const safeWastage = Math.max(0, Math.min(50, wastagePct));
  const totalSqFtWithWastage = round2(areaSqFt * (1 + safeWastage / 100));
  const boxesNeeded = Math.ceil(totalSqFtWithWastage / sqftPerBox);
  const actualCoveredSqFt = round2(boxesNeeded * sqftPerBox);
  return { totalSqFtWithWastage, boxesNeeded, actualCoveredSqFt };
}

export function calculatePaintLitres(
  wallAreaSqFt: number,
  coats = 2,
  coverageSqFtPerLitre = 110
): { totalSqFtToCoat: number; litresNeeded: number } {
  if (wallAreaSqFt <= 0 || coats <= 0 || coverageSqFtPerLitre <= 0) {
    return { totalSqFtToCoat: 0, litresNeeded: 0 };
  }
  const totalSqFtToCoat = round2(wallAreaSqFt * coats);
  const litresNeeded = Math.ceil(totalSqFtToCoat / coverageSqFtPerLitre);
  return { totalSqFtToCoat, litresNeeded };
}

export function calculateWireCoils(
  requiredMeters: number,
  metersPerCoil = 90
): { coilsNeeded: number; surplusMeters: number } {
  if (requiredMeters <= 0 || metersPerCoil <= 0) {
    return { coilsNeeded: 0, surplusMeters: 0 };
  }
  const coilsNeeded = Math.ceil(requiredMeters / metersPerCoil);
  const surplusMeters = round2(coilsNeeded * metersPerCoil - requiredMeters);
  return { coilsNeeded, surplusMeters };
}

// ----------------------------------------------------------------------------
// Wholesale Price Resolver
// ----------------------------------------------------------------------------
export function resolveWholesaleUnitPrice(input: {
  basePrice: number;
  priceTier?: PriceTier | string | null;
  qty: number;
  slabs?: WholesaleSlab[] | null;
  partyCustomRate?: { custom_rate: number; min_qty: number } | null;
  conversionFactor?: number;
}): { unitPrice: number; source: 'custom_rate' | 'slab' | 'base' } {
  const factor = input.conversionFactor && input.conversionFactor > 0 ? input.conversionFactor : 1;
  const baseQty = input.qty * factor;
  const tier = input.priceTier || 'standard';

  if (input.partyCustomRate && baseQty >= Number(input.partyCustomRate.min_qty || 1)) {
    return {
      unitPrice: round2(Number(input.partyCustomRate.custom_rate) * factor),
      source: 'custom_rate',
    };
  }

  const slabs = Array.isArray(input.slabs) ? input.slabs : [];
  const eligible = slabs
    .filter((s) => {
      const minQ = Number(s.min_qty || 0);
      const t = s.tier || 'all';
      return baseQty >= minQ && (t === 'all' || t === tier);
    })
    .sort((a, b) => Number(b.min_qty || 0) - Number(a.min_qty || 0));

  if (eligible.length > 0) {
    return {
      unitPrice: round2(Number(eligible[0].rate) * factor),
      source: 'slab',
    };
  }

  return {
    unitPrice: round2(Number(input.basePrice || 0) * factor),
    source: 'base',
  };
}

// ----------------------------------------------------------------------------
// Service & General Retail Margin Helpers
// ----------------------------------------------------------------------------
export function calculateServiceJobMargin(input: {
  billedRevenue: number;
  estimatedAmount: number;
  expensesTotal: number;
}): { effectiveRevenue: number; netMargin: number; marginPct: number } {
  const effectiveRevenue =
    input.billedRevenue > 0 ? round2(input.billedRevenue) : round2(input.estimatedAmount);
  const netMargin = round2(effectiveRevenue - Number(input.expensesTotal || 0));
  const marginPct =
    effectiveRevenue > 0 ? round2((netMargin / effectiveRevenue) * 100) : 0;
  return { effectiveRevenue, netMargin, marginPct };
}

export function applyDiscountPreset(basePrice: number, discountPct: number): number {
  const pct = Math.max(0, Math.min(100, Number(discountPct || 0)));
  return round2(basePrice * (1 - pct / 100));
}

export function calculateMarginPct(sellingPrice: number, purchasePrice: number | null | undefined): number {
  if (!sellingPrice || sellingPrice <= 0 || purchasePrice == null || purchasePrice <= 0) return 0;
  return round2(((sellingPrice - purchasePrice) / sellingPrice) * 100);
}
