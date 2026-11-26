/**
 * DecorBiz — Estimator & Domain Calculators
 * Shared cleanly between browser UI and Node verification suites (no DOM/import.meta usage).
 */

export interface DecorBizWorkspaceMeta {
  key: 'decorbiz';
  workspaceLabelEn: string;
  workspaceLabelHi: string;
  summaryEn: string;
  summaryHi: string;
  recommendedModules: string[];
  requiredModules: string[];
  highlightsEn: string[];
  highlightsHi: string[];
}

export const DECORBIZ_WORKSPACE_META: DecorBizWorkspaceMeta = {
  key: 'decorbiz',
  workspaceLabelEn: 'Material Estimator & Sites',
  workspaceLabelHi: 'सामग्री अनुमान और साइटें',
  summaryEn:
    'Tile area-to-boxes calculator, contractor delivery sites, and 1-click estimate-to-quotation workflows.',
  summaryHi:
    'टाइल क्षेत्र से बॉक्स कैलकुलेटर, कॉन्ट्रैक्टर डिलीवरी साइटें और 1-क्लिक अनुमान से कोटेशन वर्कफ़्लो।',
  recommendedModules: [
    'parties',
    'inventory',
    'billing',
    'payments',
    'purchases',
    'expenses',
    'reports',
    'backup',
  ],
  requiredModules: [],
  highlightsEn: [
    'Tiles & slabs area-to-boxes calculator',
    '1-click Estimate -> Quotation',
    'Contractor site tracking on bills',
  ],
  highlightsHi: [
    'टाइल और स्लैब क्षेत्र से बॉक्स कैलकुलेटर',
    '1-क्लिक अनुमान -> कोटेशन',
    'बिल पर कॉन्ट्रैक्टर साइट ट्रैकिंग',
  ],
};

export function getPackWorkspaceTitle(_pack: string | null | undefined, lang: 'en' | 'hi'): string {
  return lang === 'hi'
    ? DECORBIZ_WORKSPACE_META.workspaceLabelHi
    : DECORBIZ_WORKSPACE_META.workspaceLabelEn;
}

export function round2(n: number): number {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

// ----------------------------------------------------------------------------
// Tiles Material Estimator
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
