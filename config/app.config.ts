export type BusinessPackKey =
  | 'kirana'
  | 'medical'
  | 'clothing'
  | 'hardware'
  | 'general_retail'
  | 'wholesale'
  | 'service';

export interface PackOption {
  key: BusinessPackKey;
  labelEn: string;
  labelHi: string;
  descriptionEn: string;
  descriptionHi: string;
  requiredModules: string[];
}

export const APP_CONFIG = {
  appName: import.meta.env.VITE_APP_NAME || 'BizOne ERP',
  maintainer: 'BizOne Technologies',
  license: 'Apache-2.0',
  version: '0.1.0-phase1',
  defaultLocale: 'en-IN',
  currencyCode: 'INR',
  currencySymbol: '₹',
  defaultPack: 'general_retail' as BusinessPackKey,
};

export const BUSINESS_PACKS: PackOption[] = [
  {
    key: 'general_retail',
    labelEn: 'General Retail',
    labelHi: 'सामान्य रिटेल',
    descriptionEn: 'Barcode billing, brands, categories, discounts, and daily cash summary.',
    descriptionHi: 'बारकोड बिलिंग, ब्रांड, श्रेणी, छूट और दैनिक नकद सारांश।',
    requiredModules: [],
  },
  {
    key: 'kirana',
    labelEn: 'Kirana / Grocery',
    labelHi: 'किराना / ग्रोसरी',
    descriptionEn: 'Loose weight billing, carton-to-packet units, MRP savings, and udhaar focus.',
    descriptionHi: 'खुला वजन बिलिंग, कार्टन से पैकेट इकाई, एमआरपी बचत और उधार।',
    requiredModules: [],
  },
  {
    key: 'medical',
    labelEn: 'Medical Store',
    labelHi: 'मेडिकल स्टोर',
    descriptionEn: 'Batch & expiry enforcement, loose tablets, salt substitutes, and Schedule H/H1.',
    descriptionHi: 'बैच और एक्सपायरी, खुली गोली, सॉल्ट विकल्प और शेड्यूल H/H1।',
    requiredModules: ['batch_expiry'],
  },
  {
    key: 'clothing',
    labelEn: 'Clothing & Apparel',
    labelHi: 'कपड़ा व्यवसाय',
    descriptionEn: 'Size × colour variant matrix, fabric by metre, and seasonal stock.',
    descriptionHi: 'साइज × रंग वेरिएंट मैट्रिक्स, मीटर से कपड़ा और मौसमी स्टॉक।',
    requiredModules: ['variants'],
  },
  {
    key: 'hardware',
    labelEn: 'Hardware & Building Materials',
    labelHi: 'हार्डवेयर और निर्माण सामग्री',
    descriptionEn: 'Tiles area converter, pipes/wire cut lengths, site estimates, and warranties.',
    descriptionHi: 'टाइल क्षेत्र गणना, पाइप/तार कट लंबाई, साइट अनुमान और वारंटी।',
    requiredModules: [],
  },
  {
    key: 'wholesale',
    labelEn: 'Wholesale',
    labelHi: 'थोक व्यापार',
    descriptionEn: 'Price tiers, quantity slabs, credit periods, and dues ageing.',
    descriptionHi: 'मूल्य स्तर, मात्रा स्लैब, क्रेडिट अवधि और बकाया आयु।',
    requiredModules: [],
  },
  {
    key: 'service',
    labelEn: 'Service Business',
    labelHi: 'सेवा व्यवसाय',
    descriptionEn: 'SAC service items, quotations, job tracking, and expense tagging.',
    descriptionHi: 'SAC सेवा आइटम, कोटेशन, जॉब ट्रैकिंग और खर्च टैगिंग।',
    requiredModules: [],
  },
];
