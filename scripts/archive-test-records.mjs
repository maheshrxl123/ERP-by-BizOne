import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: ['.env.local', '.env'] });

const APPLY = process.argv.includes('--apply');

const url = (process.env.VITE_SUPABASE_URL || '').trim();
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

if (!url || !serviceKey) {
  console.error(
    'Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Configure .env or run supabase/migrations/0029_phase1_6_fixes.sql in Supabase SQL Editor.'
  );
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const TEST_NAME_FILTER = 'name.ilike.ZZTEST-%,name.ilike.QA Test%';
const TEST_CODE_FILTER = 'code.ilike.ZZTEST%,code.ilike.QATEST%';
const TEST_TITLE_FILTER = 'title.ilike.ZZTEST%,title.ilike.QA Test%';
const TEST_ZONE_FILTER = 'zone_name.ilike.ZZTEST%,zone_name.ilike.QA Test%';

async function inspectAndArchive() {
  console.log(`=== DecorBiz Synthetic Test Record Audit (${APPLY ? 'APPLY ARCHIVE' : 'DRY-RUN'}) ===`);
  console.log('Policy: Non-destructive soft-archival only (is_active=false, is_published_online=false). Zero DELETEs.');

  const [itemsRes, partiesRes, couponsRes, bannersRes, zonesRes] = await Promise.all([
    admin.from('items').select('id, name, sku, is_active, is_published_online').or(TEST_NAME_FILTER),
    admin.from('parties').select('id, name, phone, gstin, is_active').or(TEST_NAME_FILTER),
    admin.from('store_coupons').select('id, code, is_active').or(TEST_CODE_FILTER),
    admin.from('store_banners').select('id, title, is_active').or(TEST_TITLE_FILTER),
    admin.from('store_delivery_zones').select('id, zone_name, is_active').or(TEST_ZONE_FILTER),
  ]);

  const summary = {
    items: itemsRes.data || [],
    parties: partiesRes.data || [],
    store_coupons: couponsRes.data || [],
    store_banners: bannersRes.data || [],
    store_delivery_zones: zonesRes.data || [],
  };

  for (const [table, rows] of Object.entries(summary)) {
    console.log(`\n[${table}] ${rows.length} synthetic record(s) found:`);
    for (const r of rows) {
      console.log(' -', JSON.stringify(r));
    }
  }

  if (!APPLY) {
    console.log('\nDry-run complete. Pass --apply to archive active synthetic rows without deleting business data.');
    return;
  }

  const activeItems = summary.items.filter((r) => r.is_active || r.is_published_online).map((r) => r.id);
  const activeParties = summary.parties.filter((r) => r.is_active).map((r) => r.id);
  const activeCoupons = summary.store_coupons.filter((r) => r.is_active).map((r) => r.id);
  const activeBanners = summary.store_banners.filter((r) => r.is_active).map((r) => r.id);
  const activeZones = summary.store_delivery_zones.filter((r) => r.is_active).map((r) => r.id);

  if (activeItems.length > 0) {
    const { error } = await admin
      .from('items')
      .update({ is_active: false, is_published_online: false })
      .in('id', activeItems);
    if (error) throw error;
  }
  if (activeParties.length > 0) {
    const { error } = await admin.from('parties').update({ is_active: false }).in('id', activeParties);
    if (error) throw error;
  }
  if (activeCoupons.length > 0) {
    const { error } = await admin.from('store_coupons').update({ is_active: false }).in('id', activeCoupons);
    if (error) throw error;
  }
  if (activeBanners.length > 0) {
    const { error } = await admin.from('store_banners').update({ is_active: false }).in('id', activeBanners);
    if (error) throw error;
  }
  if (activeZones.length > 0) {
    const { error } = await admin.from('store_delivery_zones').update({ is_active: false }).in('id', activeZones);
    if (error) throw error;
  }

  console.log('\nNon-destructive archival complete:', {
    archivedItems: activeItems.length,
    archivedParties: activeParties.length,
    archivedCoupons: activeCoupons.length,
    archivedBanners: activeBanners.length,
    archivedZones: activeZones.length,
  });
}

inspectAndArchive().catch((err) => {
  console.error('Archive script failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
