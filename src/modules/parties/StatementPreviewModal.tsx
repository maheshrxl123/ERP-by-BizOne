import {
  IconCopy,
  IconDownload,
  IconPrinter,
  IconShare,
  IconX,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../../app/AppProvider';
import { downloadCsvFile } from '../../core/export';
import {
  copyToClipboard,
  formatDate,
  formatINR,
  toLocalIsoDate,
} from '../../core/format';
import { supabase } from '../../core/supabase';
import type { PartyAddressRecord, PartyStatementData } from '../../types/decorbiz';

interface StatementPreviewModalProps {
  open: boolean;
  partyId: string;
  partyPhone?: string | null;
  partyGstin?: string | null;
  defaultAddress?: PartyAddressRecord | null;
  onClose: () => void;
}

export function StatementPreviewModal({
  open,
  partyId,
  partyPhone,
  partyGstin,
  defaultAddress,
  onClose,
}: StatementPreviewModalProps) {
  const { business, signedUrlCache, language, showToast, t } = useApp();

  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [statement, setStatement] = useState<PartyStatementData | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const logoUrl = business?.logo_file_id
    ? signedUrlCache[business.logo_file_id]
    : undefined;
  const qrUrl = business?.upi_qr_file_id
    ? signedUrlCache[business.upi_qr_file_id]
    : undefined;

  useEffect(() => {
    if (!open || !partyId) return;
    let active = true;
    setLoading(true);
    setErrorMsg(null);

    void (async () => {
      try {
        const { data, error } = await supabase.rpc('get_party_statement', {
          p_party_id: partyId,
          p_from_date: fromDate || null,
          p_to_date: toDate || null,
        });
        if (!active) return;
        if (error) {
          setErrorMsg(error.message);
          return;
        }
        setStatement(data as PartyStatementData);
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [open, partyId, fromDate, toDate]);

  if (!open) return null;

  const applyPreset = (preset: 'all' | 'thisMonth' | 'lastMonth' | 'thisFy') => {
    const now = new Date();
    if (preset === 'all') {
      setFromDate('');
      setToDate('');
      return;
    }
    if (preset === 'thisMonth') {
      setFromDate(toLocalIsoDate(new Date(now.getFullYear(), now.getMonth(), 1)));
      setToDate(toLocalIsoDate(now));
      return;
    }
    if (preset === 'lastMonth') {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0);
      setFromDate(toLocalIsoDate(start));
      setToDate(toLocalIsoDate(end));
      return;
    }
    const fyStartMonth = (business?.fy_start_month ?? 4) - 1;
    const fyYear =
      now.getMonth() >= fyStartMonth ? now.getFullYear() : now.getFullYear() - 1;
    setFromDate(toLocalIsoDate(new Date(fyYear, fyStartMonth, 1)));
    setToDate(toLocalIsoDate(now));
  };

  const formatSignedLabel = (val: number) => {
    if (val > 0) return `${formatINR(val)} (${t('parties.youllGet')})`;
    if (val < 0) return `${formatINR(Math.abs(val))} (${t('parties.youllGive')})`;
    return `${formatINR(0)} (${t('parties.settled')})`;
  };

  const handleDownloadCsv = () => {
    if (!statement) return;
    const header = [
      'Date',
      'Reference No',
      'Entry Type',
      'Note',
      'Debit (+)',
      'Credit (-)',
      'Running Balance',
    ];
    const rows = statement.rows.map((row) => [
      row.entry_date,
      row.reference_no ?? '',
      row.entry_type,
      row.note ?? '',
      Number(row.debit_amount).toFixed(2),
      Number(row.credit_amount).toFixed(2),
      Number(row.running_balance ?? 0).toFixed(2),
    ]);
    downloadCsvFile(
      `${statement.party_name.replace(/[^a-zA-Z0-9_-]/g, '_')}_statement.csv`,
      header,
      rows
    );
  };

  const buildSummaryText = () => {
    if (!statement) return '';
    return [
      `${business?.name || 'DecorBiz'} - ${t('parties.statementTitle')}`,
      `${t('parties.party')}: ${statement.party_name}`,
      `${t('parties.openingForPeriod')}: ${formatSignedLabel(Number(statement.opening_balance))}`,
      `${t('parties.periodDebit')}: ${formatINR(Number(statement.period_debit))}`,
      `${t('parties.periodCredit')}: ${formatINR(Number(statement.period_credit))}`,
      `${t('parties.closingBalance')}: ${formatSignedLabel(Number(statement.closing_balance))}`,
    ].join('\n');
  };

  const handleCopySummary = async () => {
    const txt = buildSummaryText();
    if (!txt) return;
    const ok = await copyToClipboard(txt);
    showToast(
      ok
        ? language === 'hi'
          ? 'स्टेटमेंट सारांश कॉपी किया गया।'
          : 'Statement summary copied.'
        : language === 'hi'
          ? 'क्लिपबोर्ड अनुमति नहीं मिली।'
          : 'Clipboard permission denied.',
      ok ? 'success' : 'error'
    );
  };

  const handleShare = async () => {
    const txt = buildSummaryText();
    if (!txt) return;
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({
          title: `${statement?.party_name} - ${t('parties.statementTitle')}`,
          text: txt,
        });
        return;
      } catch {
        // Fallback to copy
      }
    }
    await handleCopySummary();
  };

  return createPortal(
    <div className="print-modal-root">
      <div
        className="print-modal-overlay fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4"
        onClick={onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('parties.statementTitle')}
          className="print-modal-dialog print-surface w-full sm:max-w-4xl max-h-[94vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-[var(--border)] bg-[var(--surface)]"
          onClick={(e) => e.stopPropagation()}
        >
        {/* Top Modal Controls */}
        <div className="no-print sticky top-0 z-10 px-5 py-4 border-b border-[var(--border)] bg-[var(--surface)] flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{t('parties.statementTitle')}</h2>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleDownloadCsv}
              disabled={!statement}
              className="h-9 px-3 rounded-lg border border-[var(--border)] text-xs font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)] disabled:opacity-50"
            >
              <IconDownload size={15} stroke={2} />
              <span>{t('parties.downloadCsv')}</span>
            </button>
            <button
              type="button"
              onClick={handleCopySummary}
              disabled={!statement}
              className="h-9 px-3 rounded-lg border border-[var(--border)] text-xs font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)] disabled:opacity-50"
            >
              <IconCopy size={15} stroke={2} />
              <span>{t('parties.copySummary')}</span>
            </button>
            <button
              type="button"
              onClick={handleShare}
              disabled={!statement}
              className="h-9 px-3 rounded-lg border border-[var(--border)] text-xs font-medium inline-flex items-center gap-1.5 hover:bg-[var(--surface-muted)] disabled:opacity-50"
            >
              <IconShare size={15} stroke={2} />
              <span>{t('parties.shareStatement')}</span>
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              disabled={!statement}
              className="h-9 px-3 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <IconPrinter size={15} stroke={2} />
              <span>{t('parties.printPdf')}</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('common.close')}
              className="w-9 h-9 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
            >
              <IconX size={18} stroke={2} />
            </button>
          </div>
        </div>

        {/* Date Filter Bar */}
        <div className="no-print px-5 py-3 border-b border-[var(--border)] bg-[var(--surface-muted)] flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                { id: 'all', label: language === 'hi' ? 'सभी' : 'All Time' },
                { id: 'thisMonth', label: language === 'hi' ? 'इस माह' : 'This Month' },
                { id: 'lastMonth', label: language === 'hi' ? 'पिछला माह' : 'Last Month' },
                { id: 'thisFy', label: language === 'hi' ? 'चालू वित्त वर्ष' : 'This FY' },
              ] as const
            ).map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => applyPreset(p.id)}
                className="px-2.5 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-medium hover:bg-[var(--primary-soft)]"
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="inline-flex items-center gap-1.5">
              <span className="text-[var(--text-muted)]">{t('parties.fromDate')}</span>
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="h-8 px-2 rounded border border-[var(--border)] bg-[var(--surface)] tabular-nums"
              />
            </label>
            <label className="inline-flex items-center gap-1.5">
              <span className="text-[var(--text-muted)]">{t('parties.toDate')}</span>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="h-8 px-2 rounded border border-[var(--border)] bg-[var(--surface)] tabular-nums"
              />
            </label>
          </div>
        </div>

        {/* Printable Statement Body */}
        <div className="p-5 sm:p-6 space-y-5">
          {errorMsg && (
            <div className="p-3 rounded-lg border border-[var(--give)]/40 bg-[var(--give-soft)] text-xs text-[var(--give)]">
              {errorMsg}
            </div>
          )}

          {loading ? (
            <div className="py-12 text-center text-sm text-[var(--text-muted)]">
              {t('common.loading')}
            </div>
          ) : statement ? (
            <>
              {/* Business & Party Header */}
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 pb-4 border-b border-[var(--border)]">
                <div className="flex items-start gap-3">
                  {logoUrl && (
                    <img
                      src={logoUrl}
                      alt={business?.name || 'Logo'}
                      className="w-12 h-12 rounded-lg object-cover border border-[var(--border)] shrink-0"
                    />
                  )}
                  <div>
                    <h3 className="text-lg font-bold">{business?.name || 'DecorBiz Store'}</h3>
                    {business?.address && (
                      <p className="text-xs text-[var(--text-muted)] max-w-sm">
                        {business.address}
                      </p>
                    )}
                    <p className="text-xs text-[var(--text-muted)] mt-0.5 tabular-nums">
                      {business?.phone ? `Ph: ${business.phone}` : ''}
                      {business?.gstin ? ` · GSTIN: ${business.gstin}` : ''}
                    </p>
                  </div>
                </div>

                <div className="sm:text-right">
                  <p className="text-xs uppercase tracking-wider text-[var(--text-muted)] font-semibold">
                    {t('parties.statementTitle')}
                  </p>
                  <p className="text-sm font-semibold mt-0.5">{statement.party_name}</p>
                  <p className="text-xs text-[var(--text-muted)] tabular-nums">
                    {partyPhone ? `${partyPhone}` : ''}
                    {partyGstin ? ` · GSTIN ${partyGstin}` : ''}
                  </p>
                  {defaultAddress && (
                    <p className="text-xs text-[var(--text-muted)]">
                      {[defaultAddress.address_line1, defaultAddress.city, defaultAddress.state]
                        .filter(Boolean)
                        .join(', ')}
                    </p>
                  )}
                </div>
              </div>

              {/* 4 Summary Numbers */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]">
                  <p className="text-[11px] text-[var(--text-muted)]">
                    {t('parties.openingForPeriod')}
                  </p>
                  <p className="text-sm font-semibold tabular-nums mt-1">
                    {formatSignedLabel(Number(statement.opening_balance))}
                  </p>
                </div>
                <div className="p-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]">
                  <p className="text-[11px] text-[var(--text-muted)]">
                    {t('parties.periodDebit')}
                  </p>
                  <p className="text-sm font-semibold tabular-nums mt-1">
                    {formatINR(Number(statement.period_debit))}
                  </p>
                </div>
                <div className="p-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]">
                  <p className="text-[11px] text-[var(--text-muted)]">
                    {t('parties.periodCredit')}
                  </p>
                  <p className="text-sm font-semibold tabular-nums mt-1">
                    {formatINR(Number(statement.period_credit))}
                  </p>
                </div>
                <div className="p-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]">
                  <p className="text-[11px] text-[var(--text-muted)]">
                    {t('parties.closingBalance')}
                  </p>
                  <p
                    className={`text-sm font-semibold tabular-nums mt-1 ${
                      Number(statement.closing_balance) > 0
                        ? 'text-[var(--receive-text)]'
                        : Number(statement.closing_balance) < 0
                          ? 'text-[var(--give)]'
                          : ''
                    }`}
                  >
                    {formatSignedLabel(Number(statement.closing_balance))}
                  </p>
                </div>
              </div>

              {/* Rows Table */}
              {statement.rows.length === 0 ? (
                <div className="py-10 text-center text-sm text-[var(--text-muted)] border border-[var(--border)] rounded-xl">
                  {t('parties.noLedgerEntries')}
                </div>
              ) : (
                <div className="overflow-x-auto border border-[var(--border)] rounded-xl">
                  <table className="w-full text-left border-collapse text-xs sm:text-sm">
                    <thead>
                      <tr className="border-b border-[var(--border)] bg-[var(--surface-muted)] text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                        <th className="py-2.5 px-3 font-medium">Date</th>
                        <th className="py-2.5 px-3 font-medium">Ref &amp; Particulars</th>
                        <th className="py-2.5 px-3 font-medium text-right">
                          {t('parties.debitLabel')}
                        </th>
                        <th className="py-2.5 px-3 font-medium text-right">
                          {t('parties.creditLabel')}
                        </th>
                        <th className="py-2.5 px-3 font-medium text-right">
                          {t('parties.runningBalance')}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border)]">
                      {statement.rows.map((row) => {
                        const rb = Number(row.running_balance ?? 0);
                        return (
                          <tr key={row.id} className={row.is_reversed ? 'opacity-65' : ''}>
                            <td className="py-2.5 px-3 whitespace-nowrap tabular-nums">
                              {formatDate(row.entry_date)}
                            </td>
                            <td className="py-2.5 px-3">
                              <div className="font-medium">
                                {row.reference_no || row.entry_type}
                              </div>
                              {row.note && (
                                <div className="text-[11px] text-[var(--text-muted)]">
                                  {row.note}
                                </div>
                              )}
                            </td>
                            <td className="py-2.5 px-3 text-right tabular-nums">
                              {Number(row.debit_amount) > 0
                                ? formatINR(Number(row.debit_amount))
                                : '—'}
                            </td>
                            <td className="py-2.5 px-3 text-right tabular-nums">
                              {Number(row.credit_amount) > 0
                                ? formatINR(Number(row.credit_amount))
                                : '—'}
                            </td>
                            <td className="py-2.5 px-3 text-right tabular-nums font-medium whitespace-nowrap">
                              {rb > 0
                                ? `${formatINR(rb)} Dr`
                                : rb < 0
                                  ? `${formatINR(Math.abs(rb))} Cr`
                                  : formatINR(0)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* UPI & Bank Details Footer when closing balance is due */}
              {(() => {
                const ps = (business?.pack_settings || {}) as Record<string, unknown>;
                const bName = typeof ps.bank_name === 'string' ? ps.bank_name : '';
                const bHolder =
                  typeof ps.bank_account_holder === 'string' ? ps.bank_account_holder : '';
                const bAc = typeof ps.bank_account_no === 'string' ? ps.bank_account_no : '';
                const bIfsc = typeof ps.bank_ifsc === 'string' ? ps.bank_ifsc : '';
                const bBranch = typeof ps.bank_branch === 'string' ? ps.bank_branch : '';
                const hasBank = Boolean(bName || bAc || bIfsc);
                if (
                  (!business?.upi_id && !qrUrl && !hasBank) ||
                  Number(statement.closing_balance) <= 0
                ) {
                  return null;
                }
                return (
                  <div className="pt-3 border-t border-[var(--border)] flex flex-wrap items-center justify-between gap-4">
                    <div className="text-xs text-[var(--text-muted)] space-y-1">
                      {(business?.upi_id || qrUrl) && (
                        <div>
                          <p className="font-medium text-[var(--text)]">
                            {language === 'hi' ? 'यूपीआई द्वारा भुगतान करें' : 'Pay via UPI'}
                          </p>
                          {business?.upi_id && <p className="font-mono">UPI ID: {business.upi_id}</p>}
                        </div>
                      )}
                      {hasBank && (
                        <div>
                          <p className="font-medium text-[var(--text)]">
                            {language === 'hi' ? 'बैंक खाता विवरण' : 'Bank Account Details'}
                          </p>
                          {bName && (
                            <p>
                              {bName}
                              {bBranch ? ` (${bBranch})` : ''}
                              {bHolder ? ` · A/c Holder: ${bHolder}` : ''}
                            </p>
                          )}
                          {(bAc || bIfsc) && (
                            <p className="font-mono">
                              {bAc && `A/c No: ${bAc}`}
                              {bAc && bIfsc && ' · '}
                              {bIfsc && `IFSC: ${bIfsc}`}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                    {qrUrl && (
                      <img
                        src={qrUrl}
                        alt="UPI QR"
                        className="w-16 h-16 rounded border border-[var(--border)] bg-white object-contain"
                      />
                    )}
                  </div>
                );
              })()}
            </>
          ) : null}
        </div>
      </div>
    </div>
    </div>,
    document.body
  );
}
