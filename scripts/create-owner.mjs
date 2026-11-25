import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
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

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error('VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

const [, , email, password, fullName = 'Business Owner', businessName = 'My Business'] = process.argv;
const pack = 'decorbiz';

if (!email || !password) {
  console.log('Usage: node scripts/create-owner.mjs <email> <password> [ownerName] [businessName]');
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

(async () => {
  const { data: existingBiz } = await admin
    .from('business')
    .select('id, name')
    .eq('id', 1)
    .maybeSingle();
  if (existingBiz) {
    throw new Error(`Workspace already initialized for "${existingBiz.name}".`);
  }

  const { data: created, error: authErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (authErr || !created.user) {
    throw new Error(authErr?.message || 'Failed to create owner user.');
  }

  const ownerId = created.user.id;
  try {
    const { error: profErr } = await admin.from('profiles').insert({
      id: ownerId,
      full_name: fullName,
      email,
      role: 'owner',
      is_active: true,
    });
    if (profErr) throw profErr;

    const { error: bizErr } = await admin.from('business').upsert({
      id: 1,
      name: businessName,
      pack,
    });
    if (bizErr) throw bizErr;
  } catch (err) {
    await admin.auth.admin.deleteUser(ownerId).catch(() => undefined);
    throw err;
  }

  console.log(`Owner created: ${email} (${ownerId}) for "${businessName}"`);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
