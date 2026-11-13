import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

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

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF;

const VALID_PNG_BASE64 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]).toString('base64');

async function runAdminSql(query) {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    }
  );
  if (!res.ok) {
    throw new Error(`Admin SQL failed (${res.status}): ${await res.text()}`);
  }
}

test('Phase P1 end-to-end authentication, RBAC, storage, and setup lifecycle', async () => {
  assert.ok(SUPABASE_URL && SUPABASE_ANON_KEY && SERVICE_ROLE_KEY, 'Supabase env vars required');

  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const healthRes = await fetch(`${BASE_URL}/api/health`);
  assert.equal(healthRes.status, 200);
  const health = await healthRes.json();
  assert.equal(health.ok, true);
  assert.equal(health.supabaseConfigured, true);
  assert.equal(health.encryptionConfigured, true);

  const statusRes = await fetch(`${BASE_URL}/api/setup/status`);
  assert.equal(statusRes.status, 200);
  const setupStatus = await statusRes.json();
  const startedFresh = Boolean(setupStatus.needsSetup);

  const createdUserIds = [];
  const uploadedPaths = [];
  const createdFileIds = [];
  const stamp = Date.now();
  const ownerEmail = `owner.e2e.${stamp}@example.com`;
  const staffEmail = `cashier.e2e.${stamp}@example.com`;
  const ownerPassword = 'BizOneOwner!2026';
  const staffPassword = 'BizOneStaff!2026';

  // Snapshot existing integration & module rows when running against an initialized workspace
  const { data: prevAiInt } = await supabaseAdmin
    .from('integration_settings')
    .select('*')
    .eq('integration_key', 'ai_provider')
    .maybeSingle();
  const { data: prevModules } = await supabaseAdmin
    .from('modules_state')
    .select('module_key, enabled, updated_by');
  const { data: prevBizSteps } = await supabaseAdmin
    .from('business')
    .select('onboarding_steps')
    .eq('id', 1)
    .maybeSingle();

  try {
    // Unauthenticated API protection
    const unauthAdmin = await fetch(`${BASE_URL}/api/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(unauthAdmin.status, 401);

    const unauthUpload = await fetch(`${BASE_URL}/api/files/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(unauthUpload.status, 401);

    let testOwnerId;

    if (startedFresh) {
      // 1. First-time initialization on empty DB
      const initRes = await fetch(`${BASE_URL}/api/setup/initialize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessName: 'Shree Ganesh Medical & General',
          ownerName: 'Ramesh Agarwal',
          email: ownerEmail,
          password: ownerPassword,
          pack: 'medical',
          gstRegistered: true,
          gstin: '27AAPFU0939F1ZV',
          fyStartMonth: 4,
        }),
      });
      assert.equal(initRes.status, 201);
      const initData = await initRes.json();
      assert.equal(initData.ok, true);
      testOwnerId = initData.ownerId;
      createdUserIds.push(testOwnerId);
    } else {
      // Create temporary test Owner without modifying existing business/owner
      const { data: tempAuth, error: tempAuthErr } =
        await supabaseAdmin.auth.admin.createUser({
          email: ownerEmail,
          password: ownerPassword,
          email_confirm: true,
          user_metadata: { full_name: 'E2E Test Owner' },
        });
      assert.equal(tempAuthErr, null);
      testOwnerId = tempAuth.user.id;
      createdUserIds.push(testOwnerId);

      const { error: tempProfErr } = await supabaseAdmin.from('profiles').insert({
        id: testOwnerId,
        full_name: 'E2E Test Owner',
        email: ownerEmail,
        role: 'owner',
        is_active: true,
      });
      assert.equal(tempProfErr, null);
    }

    // 2. Re-initialization must ALWAYS be blocked once workspace exists
    const dupInitRes = await fetch(`${BASE_URL}/api/setup/initialize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessName: 'Rogue Business',
        ownerName: 'Attacker',
        email: `rogue.${stamp}@example.com`,
        password: 'Password123!',
        pack: 'kirana',
        gstRegistered: false,
        fyStartMonth: 4,
      }),
    });
    assert.equal(dupInitRes.status, 409);

    // 3. Owner sign-in via Supabase Auth
    const ownerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: ownerSignIn, error: ownerLoginErr } =
      await ownerClient.auth.signInWithPassword({
        email: ownerEmail,
        password: ownerPassword,
      });
    assert.equal(ownerLoginErr, null);
    assert.ok(ownerSignIn.session?.access_token);
    const ownerToken = ownerSignIn.session.access_token;

    if (startedFresh) {
      // Medical pack must have enabled batch_expiry & prevent disabling it
      const { data: modRows } = await ownerClient.from('modules_state').select('*');
      const batchMod = modRows?.find((m) => m.module_key === 'batch_expiry');
      assert.equal(batchMod?.enabled, true);

      const { error: disablePackModErr } = await ownerClient.rpc('toggle_module', {
        p_key: 'batch_expiry',
        p_enabled: false,
      });
      assert.ok(disablePackModErr, 'Medical pack must block disabling batch_expiry');

      // Last-Owner protection when only 1 active Owner exists
      const deactivateOwnerRes = await fetch(
        `${BASE_URL}/api/admin/users/${encodeURIComponent(testOwnerId)}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ownerToken}`,
          },
          body: JSON.stringify({ is_active: false }),
        }
      );
      assert.equal(deactivateOwnerRes.status, 400);
    }

    // 4. Upload PNG to private Storage & verify invalid magic bytes rejected
    const badUploadRes = await fetch(`${BASE_URL}/api/files/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        fileName: 'malware.png',
        mimeType: 'image/png',
        base64: Buffer.from('MZ_NOT_A_PNG_EXECUTABLE').toString('base64'),
        purpose: 'attachment',
      }),
    });
    assert.equal(badUploadRes.status, 400);

    const fileUploadRes = await fetch(`${BASE_URL}/api/files/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        fileName: 'e2e-test.png',
        mimeType: 'image/png',
        base64: VALID_PNG_BASE64,
        purpose: 'attachment',
      }),
    });
    assert.equal(fileUploadRes.status, 201);
    const uploadedData = await fileUploadRes.json();
    assert.ok(uploadedData.file?.id);
    assert.ok(uploadedData.file?.signedUrl);
    uploadedPaths.push(uploadedData.file.storage_path);
    createdFileIds.push(uploadedData.file.id);

    const signedUrlRes = await fetch(`${BASE_URL}/api/files/signed-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ fileId: uploadedData.file.id }),
    });
    assert.equal(signedUrlRes.status, 200);
    const signedUrlData = await signedUrlRes.json();
    assert.ok(signedUrlData.signedUrl);

    // 5. Create Cashier staff member & verify RBAC / RLS isolation
    const addStaffRes = await fetch(`${BASE_URL}/api/admin/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        fullName: 'Sunita Verma',
        email: staffEmail,
        phone: '9811122233',
        password: staffPassword,
        role: 'cashier',
      }),
    });
    assert.equal(addStaffRes.status, 201);
    const staffData = await addStaffRes.json();
    assert.ok(staffData.profile?.id);
    createdUserIds.push(staffData.profile.id);

    const staffClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: staffSignIn, error: staffLoginErr } =
      await staffClient.auth.signInWithPassword({
        email: staffEmail,
        password: staffPassword,
      });
    assert.equal(staffLoginErr, null);
    const staffToken = staffSignIn.session.access_token;

    // Cashier can read business & update own profile
    const { data: bizRead, error: bizReadErr } = await staffClient
      .from('business')
      .select('id, name')
      .eq('id', 1)
      .single();
    assert.equal(bizReadErr, null);
    assert.ok(bizRead.name);

    const { data: ownProf, error: ownProfErr } = await staffClient.rpc(
      'update_own_profile',
      {
        p_full_name: 'Sunita Verma (Counter 1)',
        p_phone: '9811199999',
        p_avatar_file_id: null,
        p_preferred_language: 'hi',
        p_preferred_theme: 'dark',
      }
    );
    assert.equal(ownProfErr, null);
    assert.equal(ownProf.preferred_language, 'hi');

    // Cashier CANNOT escalate own role
    const { error: escalateErr } = await staffClient
      .from('profiles')
      .update({ role: 'owner' })
      .eq('id', staffData.profile.id);
    assert.ok(escalateErr, 'Trigger must block self-role escalation');

    // Cashier CANNOT mutate business settings, toggle modules, read audit_logs, or call admin routes
    const { error: staffBizErr } = await staffClient.rpc('update_business_profile', {
      p_name: 'Hijacked',
      p_gst_registered: false,
    });
    assert.ok(staffBizErr);

    const { error: staffModErr } = await staffClient.rpc('toggle_module', {
      p_key: 'ai',
      p_enabled: true,
    });
    assert.ok(staffModErr);

    const { data: auditRows } = await staffClient.from('audit_logs').select('id');
    assert.equal(auditRows?.length ?? 0, 0);

    const staffUsersApiRes = await fetch(`${BASE_URL}/api/admin/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${staffToken}`,
      },
      body: JSON.stringify({
        fullName: 'Hacker',
        email: 'hacker@example.com',
        password: 'Password123!',
        role: 'manager',
      }),
    });
    assert.equal(staffUsersApiRes.status, 403);

    const staffIntRes = await fetch(`${BASE_URL}/api/integrations`, {
      headers: { Authorization: `Bearer ${staffToken}` },
    });
    assert.equal(staffIntRes.status, 403);

    // Owner can deactivate & reactivate staff
    const deactStaffRes = await fetch(
      `${BASE_URL}/api/admin/users/${encodeURIComponent(staffData.profile.id)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({ is_active: false }),
      }
    );
    assert.equal(deactStaffRes.status, 200);
    const deactStaff = await deactStaffRes.json();
    assert.equal(deactStaff.profile.is_active, false);

    // 6. Encrypted integration save & mask verification (Owner)
    const saveIntRes = await fetch(`${BASE_URL}/api/integrations/ai_provider`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        enabled: true,
        configPublic: { provider: 'gemini', model: 'gemini-2.5-flash' },
        secret: 'sk-test-super-secret-value',
      }),
    });
    assert.equal(saveIntRes.status, 200);
    const savedInt = await saveIntRes.json();
    assert.equal(savedInt.integration.has_secret, true);
    assert.equal(savedInt.integration.encrypted_secret, undefined);

    const delIntRes = await fetch(`${BASE_URL}/api/integrations/ai_provider`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(delIntRes.status, 200);
    const deletedInt = await delIntRes.json();
    assert.equal(deletedInt.integration.has_secret, false);

    // 7. Delete uploaded file cleanly via API
    const delFileRes = await fetch(
      `${BASE_URL}/api/files/${encodeURIComponent(uploadedData.file.id)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${ownerToken}` },
      }
    );
    assert.equal(delFileRes.status, 200);

    // 8. Audit fixes verification: UUID validation, unknown integration 404, malformed JSON 400, module graph, GSTIN SQL check, BEFORE DELETE trigger
    const badStaffIdRes = await fetch(`${BASE_URL}/api/admin/users/not-a-uuid`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ is_active: false }),
    });
    assert.equal(badStaffIdRes.status, 400);

    const badSignedUrlRes = await fetch(`${BASE_URL}/api/files/signed-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ fileId: 'bad-id' }),
    });
    assert.equal(badSignedUrlRes.status, 400);

    const unknownIntRes = await fetch(`${BASE_URL}/api/integrations/nonexistent_slot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(unknownIntRes.status, 404);

    const malformedJsonRes = await fetch(`${BASE_URL}/api/files/signed-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: '{"broken": ',
    });
    assert.equal(malformedJsonRes.status, 400);
    const malformedJsonBody = await malformedJsonRes.json();
    assert.equal(typeof malformedJsonBody.error, 'string');

    const unknownApiRes = await fetch(`${BASE_URL}/api/nonexistent_route_check`);
    assert.equal(unknownApiRes.status, 404);
    const unknownApiBody = await unknownApiRes.json();
    assert.equal(unknownApiBody.error, 'API route not found.');

    // Staff CANNOT attach business file_links directly via RLS
    const { error: staffLinkErr } = await staffClient.from('file_links').insert({
      file_id: '00000000-0000-0000-0000-000000000000',
      entity_type: 'business',
      entity_id: '1',
    });
    assert.ok(staffLinkErr, 'Non-owner must not insert business file_links');

    // Module dependency graph enforcement in toggle_module RPC
    const { error: disablePartiesErr } = await ownerClient.rpc('toggle_module', {
      p_key: 'parties',
      p_enabled: false,
    });
    assert.ok(disablePartiesErr, 'Must block disabling parties while payments/purchases enabled');

    const { error: enableAcctErr } = await ownerClient.rpc('toggle_module', {
      p_key: 'accounting',
      p_enabled: true,
    });
    assert.equal(enableAcctErr, null, 'Should enable accounting when billing is active');

    const { error: disableBillingErr } = await ownerClient.rpc('toggle_module', {
      p_key: 'billing',
      p_enabled: false,
    });
    assert.ok(disableBillingErr, 'Must block disabling billing while accounting is active');

    const { error: disableAcctErr } = await ownerClient.rpc('toggle_module', {
      p_key: 'accounting',
      p_enabled: false,
    });
    assert.equal(disableAcctErr, null);

    const { error: badGstinErr } = await ownerClient.rpc('update_business_profile', {
      p_name: 'Temp Invalid Check',
      p_gst_registered: true,
      p_gstin: 'BADGSTIN123',
    });
    assert.ok(badGstinErr, 'RPC must reject invalid GSTIN format');

    // Verify BEFORE DELETE trigger (RETURN OLD) lets admin cleanly delete non-owner staff auth + profile rows
    const { error: deleteStaffAuthErr } = await supabaseAdmin.auth.admin.deleteUser(
      staffData.profile.id
    );
    assert.equal(deleteStaffAuthErr, null);
    const { data: deletedProfileRow } = await supabaseAdmin
      .from('profiles')
      .select('id')
      .eq('id', staffData.profile.id)
      .maybeSingle();
    assert.equal(deletedProfileRow, null, 'Staff profile must be cascade-deleted cleanly');
  } finally {
    // Clean up ONLY test artifacts created during this test
    if (uploadedPaths.length > 0) {
      await supabaseAdmin.storage.from('bizone-private').remove(uploadedPaths);
    }
    for (const fid of createdFileIds) {
      await supabaseAdmin.from('files').delete().eq('id', fid);
    }
    if (createdUserIds.length > 0) {
      await supabaseAdmin.from('audit_logs').delete().in('actor_id', createdUserIds);
      await supabaseAdmin.from('audit_logs').delete().in('entity_id', createdUserIds);
    }
    if (prevAiInt) {
      await supabaseAdmin
        .from('integration_settings')
        .update({
          enabled: prevAiInt.enabled,
          config_public: prevAiInt.config_public,
          encrypted_secret: prevAiInt.encrypted_secret,
          has_secret: prevAiInt.has_secret,
          last_checked_at: prevAiInt.last_checked_at,
          status: prevAiInt.status,
        })
        .eq('integration_key', 'ai_provider');
    }

    if (startedFresh) {
      await supabaseAdmin.from('business').delete().eq('id', 1);
      await supabaseAdmin
        .from('audit_logs')
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000');

      const defaultEnabled = [
        'billing',
        'parties',
        'inventory',
        'purchases',
        'payments',
        'expenses',
        'reports',
        'tax',
        'backup',
      ];
      await supabaseAdmin
        .from('modules_state')
        .update({ enabled: true, updated_by: null })
        .in('module_key', defaultEnabled);
      await supabaseAdmin
        .from('modules_state')
        .update({ enabled: false, updated_by: null })
        .not('module_key', 'in', `(${defaultEnabled.join(',')})`);

      if (createdUserIds.length > 0 && ACCESS_TOKEN && PROJECT_REF) {
        const idList = createdUserIds.map((id) => `'${id}'`).join(', ');
        await runAdminSql(`
          ALTER TABLE public.profiles DISABLE TRIGGER trg_guard_profiles;
          DELETE FROM public.profiles WHERE id IN (${idList});
          DELETE FROM auth.users WHERE id IN (${idList});
          ALTER TABLE public.profiles ENABLE TRIGGER trg_guard_profiles;
        `);
      }
    } else {
      // Restore modules_state and onboarding_steps snapshots, and remove only temporary test users
      if (prevModules && prevModules.length > 0) {
        for (const mod of prevModules) {
          await supabaseAdmin
            .from('modules_state')
            .update({ enabled: mod.enabled, updated_by: mod.updated_by })
            .eq('module_key', mod.module_key);
        }
      }
      if (prevBizSteps?.onboarding_steps) {
        await supabaseAdmin
          .from('business')
          .update({ onboarding_steps: prevBizSteps.onboarding_steps })
          .eq('id', 1);
      }
      for (const uid of createdUserIds) {
        await supabaseAdmin.auth.admin.deleteUser(uid);
      }
    }
  }
});
