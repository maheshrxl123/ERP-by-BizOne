import {
  IconCalculator,
  IconLoader2,
  IconMapPin,
  IconRefresh,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { formatINR } from '../../core/format';
import { hasCapability } from '../../core/permissions';
import { supabase } from '../../core/supabase';
import {
  calculateTileBoxes,
  DECORBIZ_WORKSPACE_META,
} from '../../packs/registry';
import type {
  HardwareEstimateRecord,
  ItemCatalogRecord,
  PartyBalanceRecord,
  PartySiteRecord,
} from '../../types/decorbiz';
import type { AppDestination, NavigationAction } from '../dashboard/HomeScreen';

interface PackWorkspaceScreenProps {
  onNavigate: (
    next: AppDestination,
    settingsTab?: string,
    opts?: {
      partyId?: string | null;
      itemId?: string | null;
      billId?: string | null;
      action?: NavigationAction | null;
    }
  ) => void;
}

export function PackWorkspaceScreen({ onNavigate }: PackWorkspaceScreenProps) {
  const { profile, language, showToast, isModuleEnabled } = useApp();
  const canCreateBills = hasCapability(profile?.role, 'create_bills');
  const canViewReports = hasCapability(profile?.role, 'reports');

  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<ItemCatalogRecord[]>([]);
  const [parties, setParties] = useState<PartyBalanceRecord[]>([]);

  const [activeTab, setActiveTab] = useState<'estimator' | 'sites'>('estimator');
  const [calcDim1, setCalcDim1] = useState('240');
  const [calcDim2, setCalcDim2] = useState('16');
  const [calcExtra, setCalcExtra] = useState('10');
  const [estItemId, setEstItemId] = useState('');
  const [estPartyId, setEstPartyId] = useState('');
  const [estSiteId, setEstSiteId] = useState('');
  const [estTitle, setEstTitle] = useState('');
  const [estimates, setEstimates] = useState<HardwareEstimateRecord[]>([]);
  const [sites, setSites] = useState<PartySiteRecord[]>([]);
  const [sitePartyId, setSitePartyId] = useState('');
  const [siteName, setSiteName] = useState('');
  const [siteContact, setSiteContact] = useState('');
  const [sitePhone, setSitePhone] = useState('');
  const [siteAddress, setSiteAddress] = useState('');
  const [savingHw, setSavingHw] = useState(false);

  const loadWorkspaceData = useCallback(async () => {
    setLoading(true);
    try {
      const [itemsRes, partiesRes, estRes, sitesRes] = await Promise.all([
        supabase
          .from('item_catalog_view')
          .select('*')
          .eq('is_active', true)
          .order('name', { ascending: true })
          .limit(300),
        isModuleEnabled('parties')
          ? supabase
              .from('party_balances')
              .select('*')
              .eq('is_active', true)
              .order('name', { ascending: true })
              .limit(300)
          : Promise.resolve({ data: [], error: null }),
        supabase
          .from('hardware_estimates')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(50),
        supabase
          .from('party_sites')
          .select('*')
          .order('site_name', { ascending: true })
          .limit(200),
      ]);

      const loadedItems = (itemsRes.data as ItemCatalogRecord[]) || [];
      const loadedParties = (partiesRes.data as PartyBalanceRecord[]) || [];
      setItems(loadedItems);
      setParties(loadedParties);
      setEstimates((estRes.data as HardwareEstimateRecord[]) || []);
      setSites((sitesRes.data as PartySiteRecord[]) || []);

      const tileItem =
        loadedItems.find((i) => i.product_line === 'tiles_slabs') || loadedItems[0];
      if (tileItem) {
        setEstItemId((prev) => prev || tileItem.id);
        const specSqft = Number(
          (tileItem.specs as { sqft_per_box?: number | string } | null)?.sqft_per_box ||
            tileItem.pack_metadata?.sqft_per_box ||
            0
        );
        if (specSqft > 0) {
          setCalcDim2((prev) => (prev === '16' ? String(specSqft) : prev));
        }
      }
      if (loadedParties.length > 0) {
        setEstPartyId((prev) => prev || loadedParties[0].party_id);
        setSitePartyId((prev) => prev || loadedParties[0].party_id);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to load workspace.', 'error');
    } finally {
      setLoading(false);
    }
  }, [isModuleEnabled, showToast]);

  useEffect(() => {
    void loadWorkspaceData();
  }, [loadWorkspaceData]);

  const hardwarePreview = useMemo(() => {
    const d1 = Number(calcDim1 || 0);
    const d2 = Number(calcDim2 || 0);
    const ex = Number(calcExtra || 0);
    const r = calculateTileBoxes(d1, d2, ex);
    return {
      qtyNeeded: r.boxesNeeded,
      unitLabel: 'Boxes',
      detail: `${r.totalSqFtWithWastage} sq.ft incl. ${ex}% wastage · covers ${r.actualCoveredSqFt} sq.ft`,
    };
  }, [calcDim1, calcDim2, calcExtra]);

  const handleEstItemChange = (nextId: string) => {
    setEstItemId(nextId);
    const it = items.find((x) => x.id === nextId);
    const specSqft = Number(
      (it?.specs as { sqft_per_box?: number | string } | null)?.sqft_per_box ||
        it?.pack_metadata?.sqft_per_box ||
        0
    );
    if (specSqft > 0) {
      setCalcDim2(String(specSqft));
    }
  };

  const handleSaveEstimate = async () => {
    const item = items.find((i) => i.id === estItemId);
    if (!item) {
      showToast('Select a material item for the estimate.', 'error');
      return;
    }
    const qty = Math.max(1, hardwarePreview.qtyNeeded);
    const estTotal = Number((qty * item.selling_price).toFixed(2));
    setSavingHw(true);
    try {
      const { error } = await supabase.rpc('save_hardware_estimate', {
        p_title: estTitle.trim() || `Tile Estimate · ${item.name}`,
        p_party_id: estPartyId || null,
        p_site_id: estSiteId || null,
        p_calc_inputs: {
          calcType: 'tiles',
          dim1: Number(calcDim1 || 0),
          dim2: Number(calcDim2 || 0),
          extra: Number(calcExtra || 0),
          result: hardwarePreview,
        },
        p_lines: [
          {
            item_id: item.id,
            entered_qty: qty,
            entered_unit_id: item.base_unit_id,
            unit_price: item.selling_price,
            discount_pct: 0,
            tax_inclusive: item.tax_inclusive,
          },
        ],
        p_estimated_total: estTotal,
        p_notes: hardwarePreview.detail,
        p_id: null,
      });
      if (error) throw error;
      showToast('Estimate saved.', 'success');
      setEstTitle('');
      await loadWorkspaceData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to save estimate.', 'error');
    } finally {
      setSavingHw(false);
    }
  };

  const handleConvertEstimate = async (estId: string) => {
    setSavingHw(true);
    try {
      const { data, error } = await supabase.rpc('convert_estimate_to_quotation', {
        p_estimate_id: estId,
      });
      if (error) throw error;
      showToast('Converted to quotation.', 'success');
      await loadWorkspaceData();
      if (data?.id) {
        onNavigate('bills', undefined, { billId: data.id });
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Conversion failed.', 'error');
    } finally {
      setSavingHw(false);
    }
  };

  const handleSaveSite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sitePartyId || !siteName.trim()) return;
    setSavingHw(true);
    try {
      const { error } = await supabase.rpc('save_party_site', {
        p_party_id: sitePartyId,
        p_site_name: siteName.trim(),
        p_contact_name: siteContact.trim() || null,
        p_contact_phone: sitePhone.trim() || null,
        p_address: siteAddress.trim() || null,
        p_site_id: null,
        p_is_active: true,
      });
      if (error) throw error;
      showToast('Contractor site added.', 'success');
      setSiteName('');
      setSiteContact('');
      setSitePhone('');
      setSiteAddress('');
      await loadWorkspaceData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to add site.', 'error');
    } finally {
      setSavingHw(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight inline-flex items-center gap-2">
            <IconCalculator size={24} stroke={2} className="text-[var(--primary-dark)]" />
            <span>
              {language === 'hi'
                ? DECORBIZ_WORKSPACE_META.workspaceLabelHi
                : DECORBIZ_WORKSPACE_META.workspaceLabelEn}
            </span>
          </h1>
          <p className="text-sm text-[var(--text-muted)] mt-0.5">
            {language === 'hi'
              ? DECORBIZ_WORKSPACE_META.summaryHi
              : DECORBIZ_WORKSPACE_META.summaryEn}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadWorkspaceData()}
            className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] text-xs font-medium inline-flex items-center gap-1.5"
          >
            <IconRefresh size={15} stroke={2} />
            <span>{language === 'hi' ? 'रीफ्रेश' : 'Refresh'}</span>
          </button>
          {canViewReports && isModuleEnabled('reports') && (
            <button
              type="button"
              onClick={() => onNavigate('reports')}
              className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] text-xs font-medium"
            >
              {language === 'hi' ? 'रिपोर्ट्स देखें' : 'View Reports'}
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="py-12 flex items-center justify-center gap-2 text-sm text-[var(--text-muted)]">
          <IconLoader2 size={18} stroke={2} className="animate-spin" />
          <span>Loading material estimator & sites...</span>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex items-center gap-2 border-b border-[var(--border)] pb-3">
            {[
              { key: 'estimator', label: 'Tile Area-to-Boxes Estimator', icon: IconCalculator },
              { key: 'sites', label: `Contractor Sites (${sites.length})`, icon: IconMapPin },
            ].map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key as typeof activeTab)}
                  className={`h-10 px-4 rounded-lg text-xs font-semibold inline-flex items-center gap-2 transition-colors ${
                    active
                      ? 'bg-[var(--primary)] text-[var(--on-primary)] shadow-sm'
                      : 'bg-[var(--surface)] border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-muted)]'
                  }`}
                >
                  <Icon size={16} stroke={2} />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>

          {activeTab === 'estimator' && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <section className="lg:col-span-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4 shadow-sm">
                <div>
                  <h2 className="text-sm font-semibold">Tile Boxes Calculator</h2>
                  <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                    Select a tile item to auto-fill box coverage, or enter area &amp; wastage manually.
                  </p>
                </div>
                <div className="grid grid-cols-3 gap-2.5">
                  <div>
                    <label className="block text-xs font-medium mb-1">Area (sq.ft)</label>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={calcDim1}
                      onChange={(e) => setCalcDim1(e.target.value)}
                      className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Sq.ft / Box</label>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={calcDim2}
                      onChange={(e) => setCalcDim2(e.target.value)}
                      className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Wastage %</label>
                    <input
                      type="number"
                      min="0"
                      max="50"
                      step="any"
                      value={calcExtra}
                      onChange={(e) => setCalcExtra(e.target.value)}
                      className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs tabular-nums"
                    />
                  </div>
                </div>
                <div className="p-4 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] space-y-1.5 text-xs">
                  <div className="flex justify-between items-center">
                    <span className="text-[var(--text-muted)] font-medium">Required Quantity</span>
                    <span className="font-bold text-base tabular-nums text-[var(--primary-dark)]">
                      {hardwarePreview.qtyNeeded} {hardwarePreview.unitLabel}
                    </span>
                  </div>
                  <p className="text-[var(--text-muted)] text-[11px]">{hardwarePreview.detail}</p>
                </div>
                <div className="space-y-3 pt-3 border-t border-[var(--border)]">
                  <div>
                    <label className="block text-xs font-medium mb-1">Estimate Title</label>
                    <input
                      value={estTitle}
                      onChange={(e) => setEstTitle(e.target.value)}
                      placeholder="e.g., Living Room Flooring"
                      className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Tile / Material Item</label>
                    <select
                      value={estItemId}
                      onChange={(e) => handleEstItemChange(e.target.value)}
                      className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                    >
                      {items.map((it) => (
                        <option key={it.id} value={it.id}>
                          {it.name} ({formatINR(it.selling_price)}/{it.base_unit_code})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs font-medium mb-1">Customer / Party</label>
                      <select
                        value={estPartyId}
                        onChange={(e) => setEstPartyId(e.target.value)}
                        className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                      >
                        <option value="">Walk-in Customer</option>
                        {parties.map((p) => (
                          <option key={p.party_id} value={p.party_id}>{p.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">Contractor Site</label>
                      <select
                        value={estSiteId}
                        onChange={(e) => setEstSiteId(e.target.value)}
                        className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                      >
                        <option value="">No Site</option>
                        {sites
                          .filter((s) => !estPartyId || s.party_id === estPartyId)
                          .map((s) => (
                            <option key={s.id} value={s.id}>{s.site_name}</option>
                          ))}
                      </select>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={savingHw}
                    onClick={() => void handleSaveEstimate()}
                    className="w-full h-10 rounded-lg bg-[var(--primary)] hover:bg-[var(--primary-dark)] text-[var(--on-primary)] text-xs font-semibold disabled:opacity-50 shadow-sm"
                  >
                    {savingHw ? 'Saving...' : 'Save Material Estimate'}
                  </button>
                </div>
              </section>

              <section className="lg:col-span-7 rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden shadow-sm">
                <div className="px-5 py-4 border-b border-[var(--border)] bg-[var(--surface-muted)] flex items-center justify-between">
                  <h2 className="text-sm font-semibold">Saved Project Estimates</h2>
                  <span className="text-xs text-[var(--text-muted)]">{estimates.length} estimates</span>
                </div>
                {estimates.length === 0 ? (
                  <div className="p-8 text-xs text-[var(--text-muted)] text-center">
                    No saved material estimates yet. Use the calculator on the left to create and save estimates.
                  </div>
                ) : (
                  <div className="divide-y divide-[var(--border)]">
                    {estimates.map((est) => (
                      <div key={est.id} className="p-4 flex flex-wrap items-center justify-between gap-3 text-xs hover:bg-[var(--surface-muted)]/40 transition-colors">
                        <div>
                          <p className="font-semibold text-sm text-[var(--text)]">{est.title}</p>
                          <p className="text-[var(--text-muted)] mt-0.5">
                            <span className="font-mono">{est.estimate_number}</span> · {est.party_name}
                            {est.site_name ? ` · Site: ${est.site_name}` : ''}
                          </p>
                          {est.notes && <p className="text-[var(--text-muted)] mt-1 italic">{est.notes}</p>}
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="font-bold text-sm tabular-nums">{formatINR(est.estimated_total)}</span>
                          {est.status === 'open' && canCreateBills ? (
                            <button
                              type="button"
                              disabled={savingHw}
                              onClick={() => void handleConvertEstimate(est.id)}
                              className="h-9 px-3 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold shadow-sm hover:opacity-90"
                            >
                              Convert → Quotation
                            </button>
                          ) : (
                            <span className="px-2.5 py-1 rounded-md bg-[var(--surface-muted)] font-medium uppercase tracking-wider text-[11px]">
                              {est.status}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {activeTab === 'sites' && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <form
                onSubmit={handleSaveSite}
                className="lg:col-span-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4 shadow-sm"
              >
                <h2 className="text-sm font-semibold">Add Contractor / Delivery Site</h2>
                <div>
                  <label className="block text-xs font-medium mb-1">Party / Customer *</label>
                  <select
                    required
                    value={sitePartyId}
                    onChange={(e) => setSitePartyId(e.target.value)}
                    className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                  >
                    {parties.map((p) => (
                      <option key={p.party_id} value={p.party_id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Site Name *</label>
                  <input
                    required
                    value={siteName}
                    onChange={(e) => setSiteName(e.target.value)}
                    placeholder="e.g., Brigade Meadows Phase 2"
                    className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Site Supervisor Name</label>
                  <input
                    value={siteContact}
                    onChange={(e) => setSiteContact(e.target.value)}
                    placeholder="e.g., Ramesh Kumar"
                    className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Site Phone</label>
                  <input
                    value={sitePhone}
                    onChange={(e) => setSitePhone(e.target.value)}
                    placeholder="e.g., 9876543210"
                    className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Site Address</label>
                  <input
                    value={siteAddress}
                    onChange={(e) => setSiteAddress(e.target.value)}
                    placeholder="Plot / Street / Area"
                    className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
                  />
                </div>
                <button
                  type="submit"
                  disabled={savingHw}
                  className="w-full h-10 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold shadow-sm hover:opacity-90 disabled:opacity-50"
                >
                  Add Site
                </button>
              </form>

              <section className="lg:col-span-8 rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden shadow-sm">
                <div className="px-5 py-4 border-b border-[var(--border)] bg-[var(--surface-muted)] flex items-center justify-between">
                  <h2 className="text-sm font-semibold">Active Contractor Sites</h2>
                  <span className="text-xs text-[var(--text-muted)]">{sites.length} sites</span>
                </div>
                <div className="divide-y divide-[var(--border)]">
                  {sites.length === 0 ? (
                    <div className="p-8 text-xs text-[var(--text-muted)] text-center">
                      No contractor or delivery sites recorded yet. Add one using the form on the left.
                    </div>
                  ) : (
                    sites.map((s) => {
                      const pName = parties.find((p) => p.party_id === s.party_id)?.name || 'Party';
                      return (
                        <div key={s.id} className="p-4 flex flex-wrap justify-between items-start gap-3 text-xs hover:bg-[var(--surface-muted)]/40 transition-colors">
                          <div>
                            <p className="font-semibold text-sm text-[var(--text)]">{s.site_name}</p>
                            <p className="text-[var(--text-muted)] mt-0.5">
                              Client: <strong className="text-[var(--text)]">{pName}</strong>
                              {s.contact_name ? ` · Supervisor: ${s.contact_name}` : ''}
                              {s.contact_phone ? ` · Ph: ${s.contact_phone}` : ''}
                            </p>
                            {s.address && <p className="text-[var(--text-muted)] mt-1">{s.address}</p>}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </section>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
