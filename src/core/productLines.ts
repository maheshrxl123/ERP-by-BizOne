export const PRODUCT_LINE_KEYS = [
  'tiles_slabs',
  'sanitaryware',
  'faucets_cp',
  'tile_adhesive',
  'other_general',
] as const;

export type ProductLineKey = (typeof PRODUCT_LINE_KEYS)[number];
export type TaxonomyScopeKey = 'all' | ProductLineKey;

export interface ProductLineDefinition {
  readonly key: ProductLineKey;
  readonly labelEn: string;
  readonly labelHi: string;
  readonly shortLabelEn: string;
  readonly shortLabelHi: string;
  readonly descriptionEn: string;
  readonly descriptionHi: string;
  readonly defaultUnitCode: string;
  readonly defaultHsn: string;
  readonly defaultGst: number;
}

export const PRODUCT_LINES: readonly ProductLineDefinition[] = Object.freeze([
  Object.freeze({
    key: 'tiles_slabs',
    labelEn: 'Tiles & Slabs',
    labelHi: 'टाइल्स और स्लैब्स',
    shortLabelEn: 'Tiles & Slabs',
    shortLabelHi: 'टाइल्स',
    descriptionEn: 'Wall, floor, vitrified, porcelain, marble, granite & quartz slabs.',
    descriptionHi: 'दीवार, फर्श, विट्रीफाइड, पोर्सिलेन, मार्बल, ग्रेनाइट और क्वार्ट्ज।',
    defaultUnitCode: 'BOX',
    defaultHsn: '6907',
    defaultGst: 18,
  }),
  Object.freeze({
    key: 'sanitaryware',
    labelEn: 'Sanitaryware',
    labelHi: 'सैनिटरीवेयर',
    shortLabelEn: 'Sanitaryware',
    shortLabelHi: 'सैनिटरीवेयर',
    descriptionEn: 'WCs, wash basins, urinals, cisterns, bathtubs, pedestals & shower trays.',
    descriptionHi: 'डब्ल्यूसी, वॉश बेसिन, यूरिनल, सिस्टर्न, बाथटब, पेडेस्टल और शॉवर ट्रे।',
    defaultUnitCode: 'PCS',
    defaultHsn: '6910',
    defaultGst: 18,
  }),
  Object.freeze({
    key: 'faucets_cp',
    labelEn: 'Faucets & CP Fittings',
    labelHi: 'नल्स और सीपी फिटिंग्स',
    shortLabelEn: 'Faucets & CP',
    shortLabelHi: 'नल्स व सीपी',
    descriptionEn: 'Taps, mixers, showers, valves, health faucets & bathroom accessories.',
    descriptionHi: 'टैप्स, मिक्सर, शॉवर, वाल्व, हेल्थ फॉसेट और बाथरूम एक्सेसरीज़।',
    defaultUnitCode: 'PCS',
    defaultHsn: '8481',
    defaultGst: 18,
  }),
  Object.freeze({
    key: 'tile_adhesive',
    labelEn: 'Tile Adhesive & Grout',
    labelHi: 'टाइल एडहेसिव और ग्राउट',
    shortLabelEn: 'Adhesive',
    shortLabelHi: 'एडहेसिव',
    descriptionEn: 'Cement-based & epoxy adhesives, tile grouts & waterproofing compounds.',
    descriptionHi: 'सीमेंट व इपॉक्सी एडहेसिव, ग्राउट और वॉटरप्रूफिंग।',
    defaultUnitCode: 'BAG',
    defaultHsn: '3214',
    defaultGst: 18,
  }),
  Object.freeze({
    key: 'other_general',
    labelEn: 'Other / General',
    labelHi: 'अन्य / सामान्य',
    shortLabelEn: 'Other / General',
    shortLabelHi: 'अन्य',
    descriptionEn: 'Spacers, trims, bath cabinets, mirrors, tools & allied showroom items.',
    descriptionHi: 'स्पेसर, ट्रिम, बाथ कैबिनेट, मिरर, टूल्स और अन्य शोरूम उत्पाद।',
    defaultUnitCode: 'PCS',
    defaultHsn: '',
    defaultGst: 18,
  }),
]);

export function isValidProductLine(value: unknown): value is ProductLineKey {
  return (
    typeof value === 'string' &&
    (PRODUCT_LINE_KEYS as readonly string[]).includes(value)
  );
}

export function isValidTaxonomyScope(value: unknown): value is TaxonomyScopeKey {
  return value === 'all' || isValidProductLine(value);
}

export function getProductLineMeta(
  value: string | null | undefined
): ProductLineDefinition {
  return (
    PRODUCT_LINES.find((line) => line.key === value) ||
    PRODUCT_LINES[PRODUCT_LINES.length - 1]
  );
}

export function getProductLineLabel(
  value: string | null | undefined,
  language: 'en' | 'hi' = 'en'
): string {
  const meta = getProductLineMeta(value);
  return language === 'hi' ? meta.labelHi : meta.labelEn;
}

export function filterTaxonomyByProductLine<
  T extends { product_line?: string | null },
>(rows: readonly T[], line: ProductLineKey | 'all'): T[] {
  if (line === 'all') return [...rows];
  return rows.filter(
    (row) => !row.product_line || row.product_line === 'all' || row.product_line === line
  );
}
