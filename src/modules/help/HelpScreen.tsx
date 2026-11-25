import { IconKeyboard, IconSearch } from '@tabler/icons-react';
import { useState } from 'react';
import { useApp } from '../../app/AppProvider';

const HELP_TOPICS = [
  {
    titleEn: 'Billing, Quotations & Returns',
    titleHi: 'बिलिंग, कोटेशन और बिक्री वापसी',
    bodyEn:
      'Create Tax Invoices, Bills of Supply, and Quotations with CGST+SGST or IGST determined automatically by Place of Supply. Convert quotations to invoices or record partial/full Sales Returns (Credit Notes) with instant stock & khata sync.',
    bodyHi:
      'आपूर्ति राज्य (Place of Supply) के अनुसार CGST+SGST या IGST के साथ टैक्स इनवॉइस, बिल ऑफ सप्लाई और कोटेशन बनाएं। कोटेशन को बिल में बदलें या क्रेडिट नोट (वापसी) दर्ज करें।',
  },
  {
    titleEn: 'Parties & Khata Ledger',
    titleHi: 'पार्टी और खाता बही',
    bodyEn:
      'Track customers and suppliers with running credit balances ("You\'ll get" / "You\'ll give"), overdue alerts, bilingual WhatsApp/UPI payment reminders, and printable/CSV statements.',
    bodyHi:
      'ग्राहकों और सप्लायरों का बकाया खाता ("लेना है" / "देना है"), देय तिथि अलर्ट, व्हाट्सएप/यूपीआई रिमाइंडर और प्रिंट/CSV स्टेटमेंट प्रबंधित करें।',
  },
  {
    titleEn: 'Payments & Bill Allocations',
    titleHi: 'भुगतान और बिल समायोजन',
    bodyEn:
      'Record received or given payments by Cash, UPI, Card, Bank Transfer, or Cheque. Auto-allocate payments FIFO to oldest open dues or choose specific bills manually, and reverse erroneous entries with an audit trail.',
    bodyHi:
      'नकद, यूपीआई, कार्ड, बैंक या चेक से भुगतान दर्ज करें और पुराने बिलों में स्वतः या मैन्युअल रूप से समायोजित करें। गलत प्रविष्टि को सुरक्षित रूप से रिवर्स भी किया जा सकता है।',
  },
  {
    titleEn: 'Items, Units & Live Stock',
    titleHi: 'सामान, इकाइयाँ और स्टॉक',
    bodyEn:
      'Manage catalogue items with SKU, auto-generated barcodes, multi-photo galleries, and alternate unit conversions (e.g. 1 Box = 12 Pcs). Every bill, return, and stock adjustment writes to an immutable stock ledger.',
    bodyHi:
      'SKU, बारकोड लेबल, एक से अधिक फोटो और वैकल्पिक इकाइयों (जैसे 1 बॉक्स = 12 पीस) के साथ सामान सूची और लाइव स्टॉक ट्रैक करें।',
  },
  {
    titleEn: 'Single-Business & Role Access',
    titleHi: 'सिंगल-बिज़नेस और भूमिका एक्सेस',
    bodyEn:
      'One DecorBiz workspace serves one business. Owners manage staff, modules, and price/discount override policies; Managers, Cashiers, Storekeepers, Accountants, and Viewers see only their permitted tools.',
    bodyHi:
      'एक डेकोरबिज़ वर्कस्पेस एक व्यवसाय के लिए है। ओनर स्टाफ, मॉड्यूल और छूट सीमा तय करते हैं; अन्य भूमिकाएं केवल अनुमत स्क्रीन ही देख सकती हैं।',
  },
  {
    titleEn: 'Print, Thermal Layouts & Share Links',
    titleHi: 'प्रिंट, थर्मल और शेयर लिंक',
    bodyEn:
      'Print invoices in A4, A5, or 80mm thermal layout with shop logo and UPI QR code, or generate expiring view-only customer share links.',
    bodyHi:
      'दुकान के लोगो और यूपीआई क्यूआर के साथ A4, A5 या 80mm थर्मल में बिल प्रिंट करें या ग्राहक के लिए समय-सीमित शेयर लिंक बनाएं।',
  },
  {
    titleEn: 'User Profile & Private Storage',
    titleHi: 'प्रोफ़ाइल और सुरक्षित फाइल स्टोरेज',
    bodyEn:
      'Staff can update their name, phone, avatar, and password under My Profile. Business logos, UPI QR images, and item photos are stored privately with short-lived signed URLs.',
    bodyHi:
      'स्टाफ मेरी प्रोफ़ाइल में अपना नाम, फोन, फोटो और पासवर्ड बदल सकते हैं। सभी फोटो निजी स्टोरेज में सुरक्षित रहती हैं।',
  },
  {
    titleEn: 'Purchases & Supplier Returns',
    titleHi: 'खरीद और सप्लायर वापसी',
    bodyEn:
      'Enter supplier purchase bills with freight, GST input tax, and optional scanned bill attachments. Posting updates stock and supplier Khata automatically, and Purchase Returns (Debit Notes) deduct stock cleanly.',
    bodyHi:
      'भाड़ा, इनपुट जीएसटी और बिल स्कैन के साथ सप्लायर खरीद बिल दर्ज करें। इससे स्टॉक और सप्लायर खाता अपने आप अपडेट होता है।',
  },
  {
    titleEn: 'Daily Expenses & Receipt Uploads',
    titleHi: 'दैनिक खर्च और रसीद अपलोड',
    bodyEn:
      'Log rent, electricity, transport, salaries, and miscellaneous expenses with payment mode and receipt files. Cashiers can view and manage only their own logged expenses.',
    bodyHi:
      'किराया, बिजली, परिवहन, वेतन और अन्य खर्च रसीद के साथ दर्ज करें। कैशियर केवल अपने द्वारा दर्ज किए गए खर्च ही देख सकते हैं।',
  },
  {
    titleEn: 'Day Book, GST & Standard Reports',
    titleHi: 'डे बुक, जीएसटी और मानक रिपोर्ट',
    bodyEn:
      'Review reconciled Day Book, Cash Book, Bank Book, Profit Estimate, GST Output vs Input summary, HSN totals, Stock Valuation, Party Dues Ageing, and export CSV or printable reports.',
    bodyHi:
      'डे बुक, कैश व बैंक बुक, अनुमानित लाभ, जीएसटी व HSN सारांश, स्टॉक मूल्यांकन और पार्टी बकाया अवधि (Ageing) देखें और CSV/प्रिंट करें।',
  },
  {
    titleEn: 'Local Backup & Owner Restore',
    titleHi: 'लोकल बैकअप और ओनर रीस्टोर',
    bodyEn:
      'Export complete workspace JSON snapshots verified by SHA-256 checksums under Settings -> Backup & Storage. Only the Owner can restore a snapshot, after password verification and an automatic pre-restore safety download.',
    bodyHi:
      'सेटिंग्स -> बैकअप और स्टोरेज से SHA-256 सत्यापित JSON बैकअप डाउनलोड करें। केवल ओनर पासवर्ड सत्यापन के बाद बैकअप रीस्टोर कर सकते हैं।',
  },
  {
    titleEn: 'Optional Integrations',
    titleHi: 'वैकल्पिक एकीकरण',
    bodyEn:
      'AI, Google Drive, SMTP, and WhatsApp credentials are never required for setup. Owners can configure and encrypt them anytime under Settings -> Integrations.',
    bodyHi:
      'एआई, गूगल ड्राइव या व्हाट्सएप सेटअप के लिए आवश्यक नहीं हैं। इन्हें सेटिंग्स -> एकीकरण में जोड़ा जा सकता है।',
  },
];

export function HelpScreen() {
  const { language, t } = useApp();
  const [query, setQuery] = useState('');

  const filtered = HELP_TOPICS.filter((topic) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      topic.titleEn.toLowerCase().includes(q) ||
      topic.bodyEn.toLowerCase().includes(q) ||
      topic.titleHi.toLowerCase().includes(q) ||
      topic.bodyHi.toLowerCase().includes(q)
    );
  });

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-6 space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">
          {t('nav.help')}
        </h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          {language === 'hi'
            ? 'डेकोरबिज़ उपयोग मार्गदर्शिका और कीबोर्ड शॉर्टकट।'
            : 'Quick start documentation and keyboard shortcuts for DecorBiz.'}
        </p>
      </div>

      <div className="relative">
        <IconSearch
          size={18}
          stroke={2}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search help topics..."
          className="w-full h-11 pl-10 pr-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filtered.map((item) => (
          <article
            key={item.titleEn}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-2"
          >
            <h2 className="text-base font-semibold">
              {language === 'hi' ? item.titleHi : item.titleEn}
            </h2>
            <p className="text-sm text-[var(--text-muted)] leading-relaxed">
              {language === 'hi' ? item.bodyHi : item.bodyEn}
            </p>
          </article>
        ))}
      </div>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3">
        <div className="flex items-center gap-2 text-base font-semibold">
          <IconKeyboard size={18} stroke={2} className="text-[var(--primary-dark)]" />
          <span>Desktop Shortcuts</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div className="flex items-center justify-between p-3 rounded-lg bg-[var(--surface-muted)]">
            <span>Global Search</span>
            <kbd className="px-2 py-0.5 rounded border border-[var(--border)] bg-[var(--surface)] font-mono text-xs">
              Ctrl / Cmd + K
            </kbd>
          </div>
          <div className="flex items-center justify-between p-3 rounded-lg bg-[var(--surface-muted)]">
            <span>Close Dialog / Sheet</span>
            <kbd className="px-2 py-0.5 rounded border border-[var(--border)] bg-[var(--surface)] font-mono text-xs">
              Esc
            </kbd>
          </div>
        </div>
      </section>
    </div>
  );
}
