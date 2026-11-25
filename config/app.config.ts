export type BusinessPackKey = 'decorbiz';

export interface PackOption {
  key: BusinessPackKey;
  labelEn: string;
  labelHi: string;
  descriptionEn: string;
  descriptionHi: string;
  requiredModules: string[];
}

export const DECORBIZ_PACK: PackOption = {
  key: 'decorbiz',
  labelEn: 'DecorBiz Tiles & Sanitaryware ERP',
  labelHi: 'डेकोरबिज़ टाइल्स और सैनिटरीवेयर ईआरपी',
  descriptionEn:
    'Tiles area & material estimator, contractor site billing, godowns, accounting, and GST invoices.',
  descriptionHi:
    'टाइल क्षेत्र और सामग्री कैलकुलेटर, कॉन्ट्रैक्टर साइट बिलिंग, गोदाम, अकाउंटिंग और जीएसटी चालान।',
  requiredModules: [],
};

export const APP_CONFIG = {
  appName: import.meta.env.VITE_APP_NAME || 'DecorBiz',
  maintainer: 'DecorBiz',
  license: 'Apache-2.0',
  version: '1.0.0',
  defaultLocale: 'en-IN',
  currencyCode: 'INR',
  currencySymbol: '₹',
  defaultPack: 'decorbiz' as BusinessPackKey,
};
