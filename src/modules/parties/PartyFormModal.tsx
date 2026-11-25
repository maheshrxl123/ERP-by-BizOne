import {
  IconChevronDown,
  IconChevronUp,
  IconMapPin,
  IconPlus,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { isValidGstin, todayLocalIso } from '../../core/format';
import { supabase } from '../../core/supabase';
import type {
  BalanceDirection,
  PartyAddressRecord,
  PartyBalanceRecord,
  PartyRecord,
  PartyType,
} from '../../types/decorbiz';

interface PartyFormModalProps {
  open: boolean;
  editingParty?: PartyBalanceRecord | null;
  onClose: () => void;
  onSaved: (party: PartyRecord) => void;
}


interface EditableAddressRow extends PartyAddressRecord {
  localId: string;
}

const EMPTY_ADDRESS: Omit<EditableAddressRow, 'localId'> = {
  label: 'Primary',
  address_line1: '',
  address_line2: '',
  city: '',
  state: '',
  state_code: '',
  pincode: '',
  is_default: true,
};

export function PartyFormModal({
  open,
  editingParty,
  onClose,
  onSaved,
}: PartyFormModalProps) {
  const { language, showToast, t } = useApp();

  const [name, setName] = useState('');
  const [partyType, setPartyType] = useState<PartyType>('customer');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [gstin, setGstin] = useState('');
  const [openingBalance, setOpeningBalance] = useState('0');
  const [openingDir, setOpeningDir] = useState<BalanceDirection>('to_receive');
  const [openingDate, setOpeningDate] = useState(todayLocalIso());
  const [creditLimit, setCreditLimit] = useState('0');
  const [creditDays, setCreditDays] = useState('0');
  const [notes, setNotes] = useState('');
  const [addresses, setAddresses] = useState<EditableAddressRow[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [loadingAddrs, setLoadingAddrs] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErrorMsg(null);
    if (editingParty) {
      setName(editingParty.name);
      setPartyType(editingParty.party_type);
      setPhone(editingParty.phone ?? '');
      setEmail(editingParty.email ?? '');
      setGstin(editingParty.gstin ?? '');
      setOpeningBalance(String(editingParty.opening_balance ?? 0));
      setOpeningDir(editingParty.opening_balance_type ?? 'to_receive');
      setOpeningDate(editingParty.opening_balance_date || todayLocalIso());
      setCreditLimit(String(editingParty.credit_limit ?? 0));
      setCreditDays(String(editingParty.credit_days ?? 0));
      setNotes(editingParty.notes ?? '');
      setShowAdvanced(
        Boolean(
          editingParty.credit_limit > 0 ||
            editingParty.credit_days > 0 ||
            editingParty.notes
        )
      );

      setLoadingAddrs(true);
      void (async () => {
        try {
          const { data, error: addrErr } = await supabase
            .from('party_addresses')
            .select('*')
            .eq('party_id', editingParty.party_id)
            .order('is_default', { ascending: false })
            .order('created_at', { ascending: true });
          if (addrErr) throw addrErr;
          const rows = ((data as PartyAddressRecord[] | null) ?? []).map((row) => ({
            ...row,
            localId: row.id || crypto.randomUUID(),
          }));
          setAddresses(rows);
          if (rows.length > 0) setShowAdvanced(true);
        } catch (err) {
          setErrorMsg(
            err instanceof Error ? err.message : 'Unable to load party addresses.'
          );
        } finally {
          setLoadingAddrs(false);
        }
      })();
    } else {
      setName('');
      setPartyType('customer');
      setPhone('');
      setEmail('');
      setGstin('');
      setOpeningBalance('0');
      setOpeningDir('to_receive');
      setOpeningDate(todayLocalIso());
      setCreditLimit('0');
      setCreditDays('0');
      setNotes('');
      setAddresses([]);
      setShowAdvanced(false);
    }
  }, [open, editingParty]);

  if (!open) return null;

  const handlePartyTypeChange = (nextType: PartyType) => {
    setPartyType(nextType);
    if (!editingParty) {
      setOpeningDir(nextType === 'supplier' ? 'to_give' : 'to_receive');
    }
  };

  const addAddressRow = () => {
    setShowAdvanced(true);
    setAddresses((prev) => [
      ...prev,
      {
        ...EMPTY_ADDRESS,
        localId: crypto.randomUUID(),
        label: prev.length === 0 ? 'Primary' : `Branch ${prev.length + 1}`,
        is_default: prev.length === 0,
      },
    ]);
  };

  const updateAddressField = (
    localId: string,
    field: keyof PartyAddressRecord,
    value: string | boolean
  ) => {
    setAddresses((prev) =>
      prev.map((row) => {
        if (field === 'is_default' && value === true) {
          return { ...row, is_default: row.localId === localId };
        }
        return row.localId === localId ? { ...row, [field]: value } : row;
      })
    );
  };

  const removeAddressRow = (localId: string) => {
    setAddresses((prev) => {
      const next = prev.filter((row) => row.localId !== localId);
      if (next.length > 0 && !next.some((a) => a.is_default)) {
        next[0] = { ...next[0], is_default: true };
      }
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setErrorMsg(
        language === 'hi' ? 'पार्टी का नाम आवश्यक है।' : 'Party name is required.'
      );
      return;
    }

    const cleanGstin = gstin.trim().toUpperCase();
    if (cleanGstin && !isValidGstin(cleanGstin)) {
      setErrorMsg(
        language === 'hi'
          ? 'कृपया सही 15-अक्षर का जीएसटीआईएन दर्ज करें।'
          : 'Please enter a valid 15-character GSTIN.'
      );
      return;
    }

    const obVal = Number(openingBalance || 0);
    if (!Number.isFinite(obVal) || obVal < 0) {
      setErrorMsg(
        language === 'hi'
          ? 'शुरुआती बाकी 0 या उससे अधिक होनी चाहिए।'
          : 'Opening balance must be zero or positive.'
      );
      return;
    }

    const clVal = Number(creditLimit || 0);
    const cdVal = Number.parseInt(creditDays || '0', 10);
    if (!Number.isFinite(clVal) || clVal < 0 || !Number.isFinite(cdVal) || cdVal < 0) {
      setErrorMsg(
        language === 'hi'
          ? 'उधार सीमा और दिन 0 या उससे अधिक होने चाहिए।'
          : 'Credit limit and credit days must be zero or positive.'
      );
      return;
    }

    for (const a of addresses) {
      const hasLine1 = a.address_line1.trim().length > 0;
      const hasSecondary = Boolean(
        a.address_line2?.trim() ||
          a.city?.trim() ||
          a.state?.trim() ||
          a.state_code?.trim() ||
          a.pincode?.trim()
      );
      if (!hasLine1 && hasSecondary) {
        setErrorMsg(
          language === 'hi'
            ? 'अधूरे पते में गली/दुकान का पता (लाइन 1) भरें या खाली पता हटाएं।'
            : 'Please enter the street/shop address line for each address, or remove incomplete rows.'
        );
        return;
      }
      const code = a.state_code?.trim().toUpperCase() || '';
      if (code && !/^[0-9]{2}$/.test(code)) {
        setErrorMsg(
          language === 'hi'
            ? 'राज्य कोड 2 अंकों का होना चाहिए (उदा. 27)।'
            : 'State code must be a 2-digit GST state code (e.g. 27).'
        );
        return;
      }
    }

    const cleanAddresses = addresses
      .filter((a) => a.address_line1.trim().length > 0)
      .map((a, idx, arr) => ({
        label: a.label.trim() || 'Primary',
        address_line1: a.address_line1.trim(),
        address_line2: a.address_line2?.trim() || null,
        city: a.city?.trim() || null,
        state: a.state?.trim() || null,
        state_code: a.state_code?.trim().toUpperCase() || null,
        pincode: a.pincode?.trim() || null,
        is_default: arr.some((x) => x.is_default) ? Boolean(a.is_default) : idx === 0,
      }));

    setSaving(true);
    try {
      const { data, error } = await supabase.rpc('save_party', {
        p_party_id: editingParty ? editingParty.party_id : null,
        p_name: trimmedName,
        p_party_type: partyType,
        p_phone: phone.trim() || null,
        p_email: email.trim() || null,
        p_gstin: cleanGstin || null,
        p_opening_balance: obVal,
        p_opening_balance_type: openingDir,
        p_opening_balance_date: openingDate || todayLocalIso(),
        p_credit_limit: clVal,
        p_credit_days: cdVal,
        p_notes: notes.trim() || null,
        p_addresses: cleanAddresses,
        p_expected_version: editingParty ? editingParty.version : null,
      });
      if (error) throw error;

      const saved = data as PartyRecord;
      showToast(
        editingParty
          ? language === 'hi'
            ? 'पार्टी विवरण अपडेट किया गया।'
            : 'Party updated.'
          : language === 'hi'
            ? 'नई पार्टी जोड़ी गई।'
            : 'Party added.',
        'success'
      );
      onSaved(saved);
      onClose();
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : language === 'hi'
            ? 'पार्टी सहेजने में त्रुटि हुई।'
            : 'Unable to save party.'
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={editingParty ? t('parties.editParty') : t('parties.addParty')}
        className="w-full sm:max-w-xl max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-[var(--border)] bg-[var(--surface)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 px-5 py-4 border-b border-[var(--border)] bg-[var(--surface)] flex items-center justify-between">
          <h2 className="text-base font-semibold">
            {editingParty ? t('parties.editParty') : t('parties.addParty')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
          >
            <IconX size={18} stroke={2} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {errorMsg && (
            <div className="p-3 rounded-lg border border-[var(--give)]/40 bg-[var(--give-soft)] text-xs sm:text-sm text-[var(--give)]">
              {errorMsg}
            </div>
          )}

          {/* Party Type */}
          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">
              {t('parties.type')}
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  { id: 'customer', label: t('parties.customer') },
                  { id: 'supplier', label: t('parties.supplier') },
                  { id: 'both', label: t('parties.both') },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => handlePartyTypeChange(opt.id)}
                  className={`min-h-[42px] px-2 rounded-lg border text-xs sm:text-sm font-medium transition-colors ${
                    partyType === opt.id
                      ? 'border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                      : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Party Name */}
          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
              {t('parties.name')} *
            </label>
            <input
              type="text"
              required
              maxLength={160}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={
                language === 'hi' ? 'उदा. गुप्ता जनरल स्टोर' : 'e.g. Gupta General Store'
              }
              className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
            />
          </div>

          {/* Phone & Email */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                {t('parties.phone')}
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="98XXXXXXXX"
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                {t('parties.email')}
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="party@example.com"
                className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
              />
            </div>
          </div>

          {/* GSTIN */}
          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
              {t('parties.gstin')}
            </label>
            <input
              type="text"
              maxLength={15}
              value={gstin}
              onChange={(e) => setGstin(e.target.value.toUpperCase())}
              placeholder="27AAPFU0939F1ZV"
              className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm font-mono uppercase focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
            />
          </div>

          {/* Opening Balance */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3.5 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                  {t('parties.openingBalance')}
                </label>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={openingBalance}
                  onChange={(e) => setOpeningBalance(e.target.value)}
                  className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                  {t('parties.openingDirection')}
                </label>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => setOpeningDir('to_receive')}
                    className={`h-11 px-2 rounded-lg border text-xs font-semibold ${
                      openingDir === 'to_receive'
                        ? 'border-[var(--receive)] bg-[var(--receive-soft)] text-[var(--receive-text)]'
                        : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
                    }`}
                  >
                    {t('parties.youllGet')} (+)
                  </button>
                  <button
                    type="button"
                    onClick={() => setOpeningDir('to_give')}
                    className={`h-11 px-2 rounded-lg border text-xs font-semibold ${
                      openingDir === 'to_give'
                        ? 'border-[var(--give)] bg-[var(--give-soft)] text-[var(--give)]'
                        : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]'
                    }`}
                  >
                    {t('parties.youllGive')} (-)
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                  {t('parties.openingDate')}
                </label>
                <input
                  type="date"
                  value={openingDate}
                  onChange={(e) => setOpeningDate(e.target.value)}
                  className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                />
              </div>
            </div>

            {editingParty && (
              <p className="text-[11px] text-[var(--text-muted)]">
                {language === 'hi'
                  ? 'शुरुआती बाकी बदलने पर खाता बही में एक नया समायोजन (adjustment) दर्ज होगा — पिछली प्रविष्टियाँ बदली नहीं जातीं।'
                  : 'Changing opening balance posts an immutable adjustment entry in the khata ledger.'}
              </p>
            )}
          </div>

          {/* Collapsible Credit Limit, Credit Days, Addresses & Notes */}
          <div className="rounded-xl border border-[var(--border)] overflow-hidden">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="w-full px-4 py-3 flex items-center justify-between text-xs sm:text-sm font-medium bg-[var(--surface)] hover:bg-[var(--surface-muted)]"
            >
              <span>
                {t('parties.creditTerms')} &amp; {t('parties.addresses')}
              </span>
              {showAdvanced ? (
                <IconChevronUp size={17} stroke={2} />
              ) : (
                <IconChevronDown size={17} stroke={2} />
              )}
            </button>

            {showAdvanced && (
              <div className="p-4 border-t border-[var(--border)] space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                      {t('parties.creditLimit')}
                    </label>
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="1"
                      value={creditLimit}
                      onChange={(e) => setCreditLimit(e.target.value)}
                      className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                      {t('parties.creditDays')}
                    </label>
                    <input
                      type="number"
                      inputMode="numeric"
                      min="0"
                      step="1"
                      value={creditDays}
                      onChange={(e) => setCreditDays(e.target.value)}
                      className="w-full h-11 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                    />
                  </div>
                </div>

                {/* Multi-address section */}
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)]">
                      <IconMapPin size={15} stroke={2} />
                      <span>{t('parties.addresses')}</span>
                    </span>
                    <button
                      type="button"
                      onClick={addAddressRow}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[var(--border)] text-xs font-medium hover:bg-[var(--surface-muted)]"
                    >
                      <IconPlus size={14} stroke={2} />
                      <span>{t('parties.addAddress')}</span>
                    </button>
                  </div>

                  {loadingAddrs ? (
                    <p className="text-xs text-[var(--text-muted)]">
                      {t('common.loading')}
                    </p>
                  ) : (
                    addresses.map((addr) => (
                      <div
                        key={addr.localId}
                        className="p-3 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] space-y-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <input
                            type="text"
                            value={addr.label}
                            onChange={(e) =>
                              updateAddressField(addr.localId, 'label', e.target.value)
                            }
                            placeholder="Label (Billing / Godown)"
                            className="h-9 px-2.5 rounded-md border border-[var(--border)] bg-[var(--surface)] text-xs font-medium w-40"
                          />
                          <div className="flex items-center gap-3">
                            <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer">
                              <input
                                type="radio"
                                name="defaultPartyAddr"
                                checked={addr.is_default}
                                onChange={() =>
                                  updateAddressField(addr.localId, 'is_default', true)
                                }
                              />
                              <span>
                                {language === 'hi' ? 'मुख्य पता' : 'Default'}
                              </span>
                            </label>
                            <button
                              type="button"
                              onClick={() => removeAddressRow(addr.localId)}
                              aria-label="Remove address"
                              className="p-1 text-[var(--give)] hover:bg-[var(--give-soft)] rounded"
                            >
                              <IconTrash size={15} stroke={2} />
                            </button>
                          </div>
                        </div>

                        <input
                          type="text"
                          value={addr.address_line1}
                          onChange={(e) =>
                            updateAddressField(
                              addr.localId,
                              'address_line1',
                              e.target.value
                            )
                          }
                          placeholder={
                            language === 'hi'
                              ? 'मकान नं, गली, बाजार *'
                              : 'Shop / Street Address *'
                          }
                          className="w-full h-10 px-2.5 rounded-md border border-[var(--border)] bg-[var(--surface)] text-xs sm:text-sm"
                        />

                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                          <input
                            type="text"
                            value={addr.city ?? ''}
                            onChange={(e) =>
                              updateAddressField(addr.localId, 'city', e.target.value)
                            }
                            placeholder={language === 'hi' ? 'शहर' : 'City'}
                            className="h-9 px-2.5 rounded-md border border-[var(--border)] bg-[var(--surface)] text-xs"
                          />
                          <input
                            type="text"
                            value={addr.state ?? ''}
                            onChange={(e) =>
                              updateAddressField(addr.localId, 'state', e.target.value)
                            }
                            placeholder={language === 'hi' ? 'राज्य' : 'State'}
                            className="h-9 px-2.5 rounded-md border border-[var(--border)] bg-[var(--surface)] text-xs"
                          />
                          <input
                            type="text"
                            maxLength={2}
                            value={addr.state_code ?? ''}
                            onChange={(e) =>
                              updateAddressField(
                                addr.localId,
                                'state_code',
                                e.target.value.toUpperCase()
                              )
                            }
                            placeholder={language === 'hi' ? 'कोड (27)' : 'Code (27)'}
                            className="h-9 px-2.5 rounded-md border border-[var(--border)] bg-[var(--surface)] text-xs font-mono uppercase tabular-nums"
                          />
                          <input
                            type="text"
                            value={addr.pincode ?? ''}
                            onChange={(e) =>
                              updateAddressField(addr.localId, 'pincode', e.target.value)
                            }
                            placeholder={language === 'hi' ? 'पिनकोड' : 'Pincode'}
                            className="h-9 px-2.5 rounded-md border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
                          />
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <div>
                  <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
                    {t('parties.notes')}
                  </label>
                  <textarea
                    rows={2}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="w-full p-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary-dark)]"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="h-11 px-4 rounded-lg border border-[var(--border)] text-sm font-medium hover:bg-[var(--surface-muted)]"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="h-11 px-5 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-sm font-semibold disabled:opacity-60"
            >
              {saving ? t('profile.saving') : t('parties.saveParty')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
