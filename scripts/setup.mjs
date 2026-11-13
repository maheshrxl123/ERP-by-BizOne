import dotenv from 'dotenv';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config();
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
  for (const [k, v] of Object.entries(parsed)) {
    const cur = process.env[k]?.trim() ?? '';
    if (cur.length < 2 && v) {
      process.env[k] = v;
    }
  }
}

console.log('=== BizOne ERP Phase 1 Setup Check ===');

execSync('node scripts/check-env.mjs', { stdio: 'inherit' });

const url = process.env.VITE_SUPABASE_URL;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
const projectRef = process.env.SUPABASE_PROJECT_REF;

async function verifyConnectivity() {
  const res = await fetch(`${url}/rest/v1/modules_state?select=module_key&limit=1`, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${serviceKey || anonKey}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Supabase REST check failed (${res.status}). Ensure migrations are applied.`);
  }
  console.log('[setup] Connected to Supabase project:', url);
}

async function applyMigrationsIfToken() {
  if (!accessToken || !projectRef) {
    console.log('[setup] SUPABASE_ACCESS_TOKEN or SUPABASE_PROJECT_REF not set; skipping automatic SQL push.');
    return;
  }

  const migrationFiles = fs
    .readdirSync('supabase/migrations')
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of migrationFiles) {
    const sql = fs.readFileSync(`supabase/migrations/${file}`, 'utf8');
    const res = await fetch(
      `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: sql }),
      }
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed applying ${file}: ${text}`);
    }
    console.log(`[setup] Applied migration: ${file}`);
  }
}

(async () => {
  await applyMigrationsIfToken();
  await verifyConnectivity();
  console.log('[setup] BizOne ERP Phase 1 backend is ready.');
})().catch((err) => {
  console.error('[setup] Error:', err.message);
  process.exit(1);
});
