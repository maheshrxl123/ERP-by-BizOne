import dotenv from 'dotenv';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const explicitEnvKeys = new Set(
  Object.keys(process.env).filter((k) => {
    const v = process.env[k]?.trim() ?? '';
    return v.length >= 2 && v !== '*';
  })
);

// Prioritize secrets from active AI Studio dev server process over stale .env entries
try {
  if (fs.existsSync('/proc')) {
    const pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
    for (const pid of pids) {
      try {
        const envRaw = fs
          .readFileSync(`/proc/${pid}/environ`, 'utf8')
          .split('\0');
        if (envRaw.some((e) => e.startsWith('VITE_SUPABASE_URL='))) {
          for (const entry of envRaw) {
            const idx = entry.indexOf('=');
            if (idx > 0) {
              const k = entry.slice(0, idx);
              const v = entry.slice(idx + 1).trim();
              if (!explicitEnvKeys.has(k) && v && v !== '*' && v.length >= 2) {
                process.env[k] = v;
              }
            }
          }
        }
      } catch {
        // Ignore inaccessible PIDs
      }
    }
  }
} catch {
  // Non-Linux or restricted /proc environment
}

dotenv.config();

// Load .env only for variables still missing
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
  for (const [k, v] of Object.entries(parsed)) {
    const cur = process.env[k]?.trim() ?? '';
    if ((cur.length < 2 || cur === '*') && v) {
      process.env[k] = v;
    }
  }
}

console.log('=== DecorBiz Supabase Migration & Setup Check ===');

execSync('node scripts/check-env.mjs', { stdio: 'inherit', env: process.env });

const url = (process.env.VITE_SUPABASE_URL || '').trim();
const anonKey = (process.env.VITE_SUPABASE_ANON_KEY || '').trim();
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const accessToken = (process.env.SUPABASE_ACCESS_TOKEN || '').trim();

const rawProjectRef = (process.env.SUPABASE_PROJECT_REF || '').trim();
const derivedProjectRef =
  url.match(/https?:\/\/([a-z0-9-]+)\.supabase\.co/i)?.[1] ?? '';
const projectRef =
  rawProjectRef && rawProjectRef !== '*' && rawProjectRef.length > 3
    ? rawProjectRef
    : derivedProjectRef;

async function runMgmtQuery(query) {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Management query failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function applyMigrationsIfToken() {
  if (!accessToken || accessToken === '*' || !projectRef) {
    console.log(
      '[setup] SUPABASE_ACCESS_TOKEN or projectRef not available; skipping automatic SQL push.'
    );
    return;
  }

  console.log(`[setup] Checking migrations on Supabase project: ${projectRef}`);

  // Ensure standard supabase_migrations.schema_migrations table exists
  await runMgmtQuery(`
    CREATE SCHEMA IF NOT EXISTS supabase_migrations;
    CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
      version text PRIMARY KEY,
      name text,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  // Check already recorded migrations and existing schema landmarks
  const stateRows = await runMgmtQuery(`
    SELECT
      COALESCE((SELECT json_agg(name) FROM supabase_migrations.schema_migrations), '[]'::json) AS applied_names,
      EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'business') AS has_p1,
      EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'parties') AS has_p2,
      EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'items') AS has_p3,
      EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'bills') AS has_p4,
      EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'purchase_bills') AS has_p5_9,
      EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'notifications') AS has_p5_10,
      EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'hardware_estimates') AS has_p6_11,
      EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'drive_connections') AS has_p6_12,
      EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ai_provider_profiles') AS has_p7_13,
      NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'item_batches') AS has_p16_clean,
      EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'online_store') AS has_p17_modules,
      EXISTS (SELECT 1 FROM public.integration_settings WHERE integration_key = 'online_payments') AS has_p18_int,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'items' AND column_name = 'product_line') AS has_p19_lines,
      EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'item_specs_tiles_slabs') AS has_p20_specs,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'stock_ledger' AND column_name = 'batch_lot') AS has_p21_variants,
      EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'staff_totp') AS has_p22_sec,
      EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'store_orders') AS has_p23_store,
      EXISTS (SELECT 1 FROM public.modules_state WHERE module_key = 'breakage_returns') AS has_p24_step2_mods,
      (
        EXISTS (SELECT 1 FROM information_schema.views WHERE table_schema = 'public' AND table_name = 'khata_totals_summary')
        AND has_table_privilege('authenticated', 'public.item_lot_balances', 'SELECT')
      ) AS has_p25_views,
      (
        pg_get_functiondef('public.reset_workspace_data(text)'::regprocedure) ILIKE '%WHERE true%'
        AND pg_get_functiondef('public.restore_workspace_backup(jsonb,text,text,text)'::regprocedure) ILIKE '%WHERE true%'
      ) AS has_p26_reset;
  `);

  const state = stateRows?.[0] || {};
  const recordedSet = new Set(
    Array.isArray(state.applied_names) ? state.applied_names.filter(Boolean) : []
  );

  const migrationFiles = fs
    .readdirSync('supabase/migrations')
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const landmarkMap = {
    '0001_phase1_foundation.sql': Boolean(state.has_p1),
    '0002_phase1_hardening.sql': Boolean(state.has_p1),
    '0003_audit_fixes.sql': Boolean(state.has_p1),
    '0004_phase2_parties_khata_payments.sql': Boolean(state.has_p2),
    '0005_phase3_items_inventory.sql': Boolean(state.has_p3),
    '0006_phase4_billing_sales.sql': Boolean(state.has_p4),
    '0007_audit_fixes_p4.sql': Boolean(state.has_p4),
    '0008_audit_fixes_p1_p4.sql': Boolean(state.has_p4),
    '0009_phase5_purchases_expenses.sql': Boolean(state.has_p5_9),
    '0010_phase5_reports_backup_notifications.sql': Boolean(state.has_p5_10),
    '0011_phase6_packs_data_management.sql': Boolean(state.has_p6_11),
    '0012_phase6_import_demo_backup_drive.sql': Boolean(state.has_p6_12),
    '0013_phase7_ai_advanced_v1.sql': Boolean(state.has_p7_13),
    '0016_decorbiz_step1_pack_cleanup.sql': Boolean(state.has_p16_clean),
    '0017_decorbiz_step1_modules.sql': Boolean(state.has_p17_modules),
    '0018_decorbiz_step1_integrations.sql': Boolean(state.has_p18_int),
    '0019_decorbiz_step2_product_lines.sql': Boolean(state.has_p19_lines),
    '0020_decorbiz_step2_item_specs.sql': Boolean(state.has_p20_specs),
    '0021_decorbiz_step2_variants_lots.sql': Boolean(state.has_p21_variants),
    '0022_decorbiz_step3_security.sql': Boolean(state.has_p22_sec),
    '0023_decorbiz_step4_ecommerce.sql': Boolean(state.has_p23_store),
    '0024_decorbiz_step2_modules_and_security.sql': Boolean(state.has_p24_step2_mods),
    '0025_decorbiz_fix_views_and_grants.sql': Boolean(state.has_p25_views),
    '0026_decorbiz_fix_reset_and_restore.sql': Boolean(state.has_p26_reset),
  };

  const forceSync = process.argv.includes('--force-sync');
  const syncFiles = new Set([
    '0011_phase6_packs_data_management.sql',
    '0012_phase6_import_demo_backup_drive.sql',
    '0013_phase7_ai_advanced_v1.sql',
    '0014_tax_fixes_and_ai_features.sql',
    '0015_service_role_and_phase1_grants.sql',
    '0016_decorbiz_step1_pack_cleanup.sql',
    '0017_decorbiz_step1_modules.sql',
    '0018_decorbiz_step1_integrations.sql',
    '0019_decorbiz_step2_product_lines.sql',
    '0020_decorbiz_step2_item_specs.sql',
    '0021_decorbiz_step2_variants_lots.sql',
    '0022_decorbiz_step3_security.sql',
    '0023_decorbiz_step4_ecommerce.sql',
    '0024_decorbiz_step2_modules_and_security.sql',
    '0025_decorbiz_fix_views_and_grants.sql',
    '0026_decorbiz_fix_reset_and_restore.sql',
    '0027_seed_all_product_lines.sql',
    '0028_remove_demo_data.sql',
    '0029_phase1_6_fixes.sql',
  ]);

  for (const file of migrationFiles) {
    const version = file.split('_')[0];
    const alreadyInDb = recordedSet.has(file) || Boolean(landmarkMap[file]);

    if (alreadyInDb && !(forceSync && syncFiles.has(file))) {
      if (!recordedSet.has(file)) {
        await runMgmtQuery(`
          INSERT INTO supabase_migrations.schema_migrations (version, name)
          VALUES ('${version}', '${file}')
          ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name;
        `);
      }
      console.log(`[setup] Verified applied migration: ${file}`);
      continue;
    }

    const sql = fs.readFileSync(`supabase/migrations/${file}`, 'utf8');
    await runMgmtQuery(sql);
    await runMgmtQuery(`
      INSERT INTO supabase_migrations.schema_migrations (version, name)
      VALUES ('${version}', '${file}')
      ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name, applied_at = now();
    `);
    console.log(`[setup] Applied/synced migration: ${file}`);
  }

  // Ensure private DecorBiz storage bucket exists
  const rawBucket = (process.env.SUPABASE_STORAGE_BUCKET || '')
    .replace(/^['"]+|['"]+$/g, '')
    .trim();
  const bucketName = /^[a-z0-9][a-z0-9._-]{1,61}$/.test(rawBucket)
    ? rawBucket
    : 'decorbiz-private';
  await runMgmtQuery(`
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      '${bucketName.replace(/'/g, "''")}',
      '${bucketName.replace(/'/g, "''")}',
      false,
      10485760,
      ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
    )
    ON CONFLICT (id) DO UPDATE
    SET public = false,
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;
  `);
  console.log(`[setup] Verified private storage bucket: ${bucketName}`);

  const summary = await runMgmtQuery(`
    NOTIFY pgrst, 'reload schema';
    SELECT
      (SELECT count(*)::int FROM supabase_migrations.schema_migrations) AS recorded_migrations,
      (SELECT count(*)::int FROM information_schema.tables WHERE table_schema = 'public') AS public_tables_count,
      (SELECT count(*)::int FROM information_schema.routines WHERE routine_schema = 'public') AS public_functions_count;
  `);
  console.log(
    '[setup] PostgREST schema reloaded. Live schema summary:',
    JSON.stringify(summary)
  );
}

async function verifyConnectivity() {
  const res = await fetch(
    `${url}/rest/v1/modules_state?select=module_key&limit=1`,
    {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${
          serviceKey && serviceKey !== '*' ? serviceKey : anonKey
        }`,
      },
    }
  );

  if (!res.ok) {
    throw new Error(
      `Supabase REST check failed (${res.status}). Ensure migrations are applied.`
    );
  }
  console.log('[setup] Connected to Supabase project:', url);
}

(async () => {
  await applyMigrationsIfToken();
  await verifyConnectivity();
  console.log(
    '[setup] All DecorBiz migrations (0001..0028) & private storage bucket are verified and live.'
  );
})().catch((err) => {
  console.error('[setup] Error:', err.message);
  process.exit(1);
});
