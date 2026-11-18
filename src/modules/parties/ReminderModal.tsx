import {
  IconBrandWhatsapp,
  IconCheck,
  IconCopy,
  IconShare,
  IconX,
} from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { buildDueReminderText, copyToClipboard, formatINR } from '../../core/format';
import { supabase } from '../../core/supabase';
import type { OpenObligationRecord, PartyBalanceRecord } from '../../types/bizone';

interface ReminderModalProps {
  open: boolean;
  party: PartyBalanceRecord;
  onClose: () => void;
}

function sanitizeWhatsappPhone(raw: string | null | undefined): string {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

export function ReminderModal({ open, party, onClose }: ReminderModalProps) {
  const { business, signedUrlCache, language, showToast, t } = useApp();
  const [msgLang, setMsgLang] = useState<'en' | 'hi'>(language);
  const [openRefs, setOpenRefs] = useState<
    Array<{ referenceNo: string; remainingAmount: number; dueDate?: string | null }>
  >([]);
  const [copied, setCopied] = useState(false);

  const upiQrUrl = business?.upi_qr_file_id
    ? signedUrlCache[business.upi_qr_file_id]
    : undefined;

  useEffect(() => {
    if (!open) return;
    let active = true;
    setMsgLang(language);
    setCopied(false);

    supabase
      .from('party_open_obligations')
      .select('reference_no, remaining_amount, due_date')
      .eq('party_id', party.party_id)
      .eq('direction_needed', 'receive')
      .order('entry_date', { ascending: true })
      .limit(5)
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          showToast(error.message, 'error');
          return;
        }
        const rows = (data as Array<Pick<OpenObligationRecord, 'reference_no' | 'remaining_amount' | 'due_date'>> | null) ?? [];
        setOpenRefs(
          rows.map((r) => ({
            referenceNo: r.reference_no,
            remainingAmount: Number(r.remaining_amount),
            dueDate: r.due_date,
          }))
        );
      });

    return () => {
      active = false;
    };
  }, [open, party.party_id, language, showToast]);

  const reminderText = useMemo(
    () =>
      buildDueReminderText({
        lang: msgLang,
        businessName: business?.name || 'BizOne Store',
        businessPhone: business?.phone,
        upiId: business?.upi_id,
        partyName: party.name,
        dueAmount: Number(party.to_receive || 0),
        openRefs,
      }),
    [msgLang, business, party.name, party.to_receive, openRefs]
  );

  if (!open) return null;

  const waPhone = sanitizeWhatsappPhone(party.phone);
  const whatsappHref = waPhone
    ? `https://wa.me/${waPhone}?text=${encodeURIComponent(reminderText)}`
    : `https://wa.me/?text=${encodeURIComponent(reminderText)}`;

  const handleCopy = async () => {
    const ok = await copyToClipboard(reminderText);
    if (ok) {
      setCopied(true);
      showToast(
        language === 'hi' ? 'रिमाइंडर कॉपी किया गया।' : 'Reminder copied.',
        'success'
      );
      setTimeout(() => setCopied(false), 2000);
    } else {
      showToast('Clipboard permission unavailable.', 'error');
    }
  };

  const handleShare = async () => {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({
          title: `${t('parties.reminderTitle')} - ${party.name}`,
          text: reminderText,
        });
        return;
      } catch {
        // User cancelled or share unsupported; fall back to copy
      }
    }
    await handleCopy();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('parties.reminderTitle')}
        className="w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-[var(--border)] bg-[var(--surface)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-[var(--border)] flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">{t('parties.reminderTitle')}</h2>
            <p className="text-xs text-[var(--text-muted)] tabular-nums">
              {party.name} ·{' '}
              {Number(party.to_give) > 0 && Number(party.to_receive) === 0
                ? `${t('parties.youllGive')} ${formatINR(party.to_give)}`
                : `${t('parties.youllGet')} ${formatINR(party.to_receive)}`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
          >
            <IconX size={18} stroke={2} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--text-muted)]">
              {language === 'hi' ? 'संदेश की भाषा' : 'Message Language'}
            </span>
            <div className="inline-flex rounded-lg border border-[var(--border)] p-0.5 bg-[var(--surface-muted)]">
              <button
                type="button"
                onClick={() => setMsgLang('en')}
                className={`px-3 py-1 rounded-md text-xs font-medium ${
                  msgLang === 'en'
                    ? 'bg-[var(--surface)] text-[var(--text)]'
                    : 'text-[var(--text-muted)]'
                }`}
              >
                English
              </button>
              <button
                type="button"
                onClick={() => setMsgLang('hi')}
                className={`px-3 py-1 rounded-md text-xs font-medium ${
                  msgLang === 'hi'
                    ? 'bg-[var(--surface)] text-[var(--text)]'
                    : 'text-[var(--text-muted)]'
                }`}
              >
                हिन्दी
              </button>
            </div>
          </div>

          <pre className="p-3.5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] text-xs sm:text-sm whitespace-pre-wrap font-sans leading-relaxed">
            {reminderText}
          </pre>

          {upiQrUrl && (
            <div className="p-3 rounded-xl border border-[var(--border)] flex items-center gap-3">
              <img
                src={upiQrUrl}
                alt="Business UPI QR"
                className="w-16 h-16 rounded-lg object-contain border border-[var(--border)] bg-white"
              />
              <div className="min-w-0">
                <p className="text-xs font-semibold">
                  {language === 'hi' ? 'दुकान यूपीआई क्यूआर' : 'Shop UPI QR'}
                </p>
                <p className="text-xs text-[var(--text-muted)] truncate">
                  {business?.upi_id || 'UPI ID configured'}
                </p>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={handleCopy}
              className="h-11 px-4 rounded-lg border border-[var(--border)] text-sm font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)]"
            >
              {copied ? <IconCheck size={17} stroke={2} /> : <IconCopy size={17} stroke={2} />}
              <span>{t('parties.copyReminder')}</span>
            </button>

            <button
              type="button"
              onClick={handleShare}
              className="h-11 px-4 rounded-lg border border-[var(--border)] text-sm font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)]"
            >
              <IconShare size={17} stroke={2} />
              <span>{t('parties.shareStatement')}</span>
            </button>

            <a
              href={whatsappHref}
              target="_blank"
              rel="noopener noreferrer"
              className="h-11 px-4 rounded-lg bg-[var(--receive)] text-white text-sm font-semibold inline-flex items-center gap-1.5 hover:opacity-95"
            >
              <IconBrandWhatsapp size={18} stroke={2} />
              <span>{t('parties.openWhatsapp')}</span>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
