import { IconKeyboard, IconSearch } from '@tabler/icons-react';
import { useState } from 'react';
import { useApp } from '../../app/AppProvider';

const HELP_TOPICS = [
  {
    titleEn: 'Single-Business & Role Access',
    titleHi: 'सिंगल-बिज़नेस और भूमिका एक्सेस',
    bodyEn:
      'One BizOne workspace serves one business. Only the Business Owner can add staff, switch modules, or modify business settings.',
    bodyHi:
      'एक बिज़वन वर्कस्पेस एक व्यवसाय के लिए है। केवल ओनर ही स्टाफ जोड़ सकते हैं और मॉड्यूल बदल सकते हैं।',
  },
  {
    titleEn: 'User Profile vs Business Profile',
    titleHi: 'उपयोगकर्ता प्रोफ़ाइल बनाम व्यवसाय प्रोफ़ाइल',
    bodyEn:
      'Every signed-in staff member can update their own display name, phone number, profile photo, and password under My Profile. Business logo and GSTIN live in Settings.',
    bodyHi:
      'हर लॉग-इन स्टाफ मेरी प्रोफ़ाइल में अपना नाम, फोन, फोटो और पासवर्ड बदल सकता है। व्यवसाय का लोगो और GSTIN सेटिंग्स में हैं।',
  },
  {
    titleEn: 'Private File & Photo Storage',
    titleHi: 'सुरक्षित फाइल और फोटो स्टोरेज',
    bodyEn:
      'Profile photos, business logos, and UPI QR images are stored in a private Supabase Storage bucket and served through short-lived signed URLs.',
    bodyHi:
      'प्रोफ़ाइल फोटो, लोगो और यूपीआई क्यूआर निजी सुपाबेस स्टोरेज में सुरक्षित रखे जाते हैं।',
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
          Quick start documentation and keyboard shortcuts for BizOne ERP Phase 1.
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
