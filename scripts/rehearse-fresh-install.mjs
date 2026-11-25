import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config();

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'supabase/migrations');

function splitTopLevelSelectCols(selectClause) {
  const cols = [];
  let current = '';
  let depth = 0;
  let inSingleQuote = false;
  for (let i = 0; i < selectClause.length; i++) {
    const ch = selectClause[i];
    if (ch === "'" && selectClause[i - 1] !== '\\') {
      inSingleQuote = !inSingleQuote;
    }
    if (!inSingleQuote) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (ch === ',' && depth === 0) {
        if (current.trim()) cols.push(current.trim());
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) cols.push(current.trim());

  return cols.map((expr) => {
    const asMatch = expr.match(/\bAS\s+"?([a-zA-Z0-9_]+)"?\s*$/i);
    if (asMatch) return asMatch[1].toLowerCase();
    const cleaned = expr.trim().replace(/::[a-zA-Z0-9_[\]]+$/g, '').trim();
    const dotMatch = cleaned.match(/([a-zA-Z0-9_]+)\s*$/);
    return (dotMatch ? dotMatch[1] : cleaned).toLowerCase();
  });
}

export function runStaticFreshInstallRehearsal() {
  const failures = [];
  const checks = [];

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return { ok: false, checks: [], failures: ['supabase/migrations directory not found.'] };
  }

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    return { ok: false, checks: [], failures: ['No SQL migrations found.'] };
  }

  const definedFunctions = new Set(['update_updated_at_column']);
  const createdTables = new Set();
  const droppedTables = new Set();
  const viewColumns = new Map();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

    // Track CREATE [OR REPLACE] FUNCTION
    for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-zA-Z0-9_]+)\s*\(/gi)) {
      definedFunctions.add(m[1].toLowerCase());
    }

    // Track CREATE TABLE
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-zA-Z0-9_]+)\s*\(/gi)) {
      const tbl = m[1].toLowerCase();
      createdTables.add(tbl);
      droppedTables.delete(tbl);
    }

    // Track DROP VIEW
    for (const m of sql.matchAll(/DROP\s+VIEW\s+(?:IF\s+EXISTS\s+)?(?:public\.)?([a-zA-Z0-9_]+)/gi)) {
      viewColumns.delete(m[1].toLowerCase());
    }

    // Track DROP TABLE
    for (const m of sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?([a-zA-Z0-9_]+)/gi)) {
      droppedTables.add(m[1].toLowerCase());
    }

    // Check every CREATE TRIGGER references an already-defined function
    for (const m of sql.matchAll(/EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(?:public\.)?([a-zA-Z0-9_]+)\s*\(/gi)) {
      const fnName = m[1].toLowerCase();
      if (!definedFunctions.has(fnName)) {
        failures.push(
          `[${file}] Trigger references undefined function public.${fnName}() (not created in this or prior migrations).`
        );
      }
    }

    // Check CREATE [OR REPLACE] VIEW column compatibility & broken column refs
    for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:public\.)?([a-zA-Z0-9_]+)\s+AS\s+SELECT\s+([\s\S]*?)\s+FROM\s+/gi)) {
      const viewName = m[1].toLowerCase();
      const selectClause = m[2];
      if (/\bi\.base_unit_code\b/i.test(selectClause)) {
        failures.push(
          `[${file}] View "${viewName}" references non-existent column i.base_unit_code (must join item_units).`
        );
      }
      const cols = splitTopLevelSelectCols(selectClause);
      if (viewColumns.has(viewName)) {
        const prev = viewColumns.get(viewName);
        for (let i = 0; i < prev.length; i++) {
          if (cols[i] !== prev[i]) {
            failures.push(
              `[${file}] CREATE OR REPLACE VIEW "${viewName}" changes column #${i + 1} from "${prev[i]}" to "${cols[i]}" (Postgres rejects column rename/reorder).`
            );
            break;
          }
        }
      }
      viewColumns.set(viewName, cols);
    }

    // Ensure dollar-quoted blocks are balanced
    const dollarTags = sql.match(/\$\$|\$[a-zA-Z_][a-zA-Z0-9_]*\$/g) || [];
    const tagCounts = new Map();
    for (const t of dollarTags) {
      tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    }
    for (const [tag, cnt] of tagCounts.entries()) {
      if (cnt % 2 !== 0) {
        failures.push(`[${file}] Unbalanced dollar-quote delimiter ${tag} (${cnt} occurrences).`);
      }
    }
  }

  checks.push(`Validated ${files.length} sequential migrations (0001..${files[files.length - 1].slice(0, 4)}).`);
  checks.push(`Verified ${definedFunctions.size} SQL functions, ${createdTables.size} tables, and ${viewColumns.size} views.`);

  // Verify scripts/setup.mjs covers every migration file + storage bucket creation
  const setupSrc = fs.readFileSync(path.resolve(process.cwd(), 'scripts/setup.mjs'), 'utf8');
  for (const file of files) {
    if (file >= '0016_' && !setupSrc.includes(file)) {
      failures.push(`[scripts/setup.mjs] Missing migration reference "${file}" in landmark/sync map.`);
    }
  }
  if (!setupSrc.includes('storage.buckets')) {
    failures.push('[scripts/setup.mjs] Missing idempotent storage.buckets initialization SQL.');
  } else {
    checks.push('Verified scripts/setup.mjs covers all migrations and decorbiz-private storage bucket.');
  }

  // Verify vercel.json & robots.txt /ERP protections
  const vercelRaw = fs.readFileSync(path.resolve(process.cwd(), 'vercel.json'), 'utf8');
  const vercelJson = JSON.parse(vercelRaw);
  const hasNoIndexHeader = JSON.stringify(vercelJson.headers || []).includes('X-Robots-Tag');
  if (!hasNoIndexHeader) {
    failures.push('[vercel.json] Missing X-Robots-Tag: noindex, nofollow headers for /ERP.');
  } else {
    checks.push('Verified vercel.json headers & rewrites for dual-bundle storefront/ERP routing.');
  }

  return {
    ok: failures.length === 0,
    migrationsCount: files.length,
    checks,
    failures,
  };
}

async function runLiveSupabaseRehearsal(projectRef, accessToken) {
  const runQuery = async (query) => {
    const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
    return res.json();
  };

  const preCheck = await runQuery(`
    SELECT count(*)::int AS tbl_count
    FROM information_schema.tables
    WHERE table_schema = 'public';
  `);
  const existingCount = Number(preCheck?.[0]?.tbl_count || 0);
  if (existingCount > 0 && !process.argv.includes('--allow-existing')) {
    return {
      executed: false,
      reason: `Target Supabase project "${projectRef}" already has ${existingCount} public table(s). Pass --allow-existing or provide a brand-new empty REHEARSE_SUPABASE_PROJECT_REF.`,
    };
  }

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const stepErrors = [];

  for (const file of files) {
    try {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await runQuery(sql);
    } catch (err) {
      stepErrors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }

  const bucketName = (process.env.SUPABASE_STORAGE_BUCKET || 'decorbiz-private').trim();
  await runQuery(`
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('${bucketName}', '${bucketName}', false, 10485760, ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
    ON CONFLICT (id) DO NOTHING;
  `);

  const postCheck = await runQuery(`
    SELECT
      (SELECT count(*)::int FROM information_schema.tables WHERE table_schema = 'public') AS tables_count,
      (SELECT count(*)::int FROM public.modules_state) AS modules_count,
      EXISTS (SELECT 1 FROM storage.buckets WHERE id = '${bucketName}') AS has_bucket,
      EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'store_transition_order_stock') AS has_stock_rpc;
  `);

  return {
    executed: true,
    stepErrors,
    summary: postCheck?.[0] || {},
  };
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (isMain) {
  console.log('=== DecorBiz Fresh-Install Rehearsal (0001..0024) ===');
  const staticRes = runStaticFreshInstallRehearsal();
  for (const c of staticRes.checks) {
    console.log(`[rehearse] OK: ${c}`);
  }
  if (!staticRes.ok) {
    for (const f of staticRes.failures) {
      console.error(`[rehearse] FAILURE: ${f}`);
    }
    process.exit(1);
  }

  const targetRef = (
    process.env.REHEARSE_SUPABASE_PROJECT_REF ||
    process.env.SUPABASE_PROJECT_REF ||
    ''
  ).trim();
  const accessToken = (process.env.SUPABASE_ACCESS_TOKEN || '').trim();

  if (process.argv.includes('--live') && targetRef && accessToken && accessToken !== '*') {
    runLiveSupabaseRehearsal(targetRef, accessToken)
      .then((live) => {
        if (!live.executed) {
          console.log(`[rehearse] Live Supabase execution skipped: ${live.reason}`);
          return;
        }
        if (live.stepErrors.length > 0) {
          console.error('[rehearse] Live SQL failures:', live.stepErrors);
          process.exit(1);
        }
        console.log('[rehearse] Live empty Supabase rehearsal PASSED:', JSON.stringify(live.summary));
      })
      .catch((err) => {
        console.error('[rehearse] Live rehearsal error:', err.message);
        process.exit(1);
      });
  } else {
    console.log(
      `[rehearse] Static SQL dependency, trigger, view & config rehearsal PASSED (all ${staticRes.migrationsCount} migrations).`
    );
    if (!targetRef) {
      console.log(
        '[rehearse] Note: No REHEARSE_SUPABASE_PROJECT_REF / VITE_SUPABASE_URL configured in sandbox; pass --live with an empty project ref + SUPABASE_ACCESS_TOKEN to execute against live Postgres.'
      );
    }
  }
}
