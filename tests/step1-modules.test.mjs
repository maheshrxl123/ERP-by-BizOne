import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { MODULE_REGISTRY } from '../config/modules.config.ts';
import { createModuleGate } from '../src/server/moduleGate.ts';

const REQUIRED_OPTIONAL_MODULES = [
  'locations',
  'accounting',
  'gst_returns',
  'einvoice',
  'ai',
  'messaging',
  'google_drive_backup',
  'hindi',
  'pos',
  'online_payments',
  'email_notifications',
  'online_store',
];

test('Step 1 Item 3: MODULE_REGISTRY defines all 12 optional feature toggles cleanly', () => {
  const byKey = new Map(MODULE_REGISTRY.map((m) => [m.key, m]));
  for (const key of REQUIRED_OPTIONAL_MODULES) {
    const entry = byKey.get(key);
    assert.ok(entry, `Missing optional module in MODULE_REGISTRY: ${key}`);
    assert.equal(entry.level, 'advanced', `Module ${key} should be toggleable (level: 'advanced')`);
    assert.ok(entry.nameEn.length > 0 && entry.nameHi.length > 0);
  }
});

test('Step 1 Item 3: 0017_decorbiz_step1_modules.sql seeds all new optional toggles and updates toggle_module', () => {
  const sql = fs.readFileSync(
    path.resolve(process.cwd(), 'supabase/migrations/0017_decorbiz_step1_modules.sql'),
    'utf8'
  );
  for (const key of [
    'gst_returns',
    'google_drive_backup',
    'hindi',
    'pos',
    'online_payments',
    'email_notifications',
    'online_store',
  ]) {
    assert.ok(sql.includes(`'${key}'`), `Migration 0017 missing module key ${key}`);
  }
  assert.ok(sql.includes('CREATE OR REPLACE FUNCTION public.toggle_module'));
});

test('Step 1 Item 3: createModuleGate returns 403 when disabled and 200 when enabled', async () => {
  const state = new Map(REQUIRED_OPTIONAL_MODULES.map((k) => [k, false]));
  state.set('inventory', true);

  const gate = createModuleGate(async (key) => Boolean(state.get(key)));
  const testApp = express();

  for (const key of REQUIRED_OPTIONAL_MODULES) {
    testApp.get(`/feature/${key}`, gate(key), (_req, res) => {
      res.json({ ok: true, key });
    });
  }
  testApp.get('/feature/combo-store', gate('online_store', 'inventory'), (_req, res) => {
    res.json({ ok: true });
  });

  const server = await new Promise((resolve) => {
    const s = testApp.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const addr = server.address();
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    // Every disabled optional feature returns HTTP 403
    for (const key of REQUIRED_OPTIONAL_MODULES) {
      const res = await fetch(`${baseUrl}/feature/${key}`);
      assert.equal(res.status, 403, `Expected 403 for disabled feature ${key}`);
      const body = await res.json();
      assert.equal(body.moduleKey, key);
    }

    // Enable each optional feature -> returns HTTP 200
    for (const key of REQUIRED_OPTIONAL_MODULES) {
      state.set(key, true);
      const res = await fetch(`${baseUrl}/feature/${key}`);
      assert.equal(res.status, 200, `Expected 200 for enabled feature ${key}`);
    }

    // Dependency gate: disabling inventory blocks combo-store with 403
    state.set('inventory', false);
    const depRes = await fetch(`${baseUrl}/feature/combo-store`);
    assert.equal(depRes.status, 403);
    const depBody = await depRes.json();
    assert.equal(depBody.moduleKey, 'inventory');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Step 1 Item 3: server routes gate optional feature APIs with requireModuleEnabled / isModuleEnabledServer', () => {
  const parts = [fs.readFileSync(path.resolve(process.cwd(), 'server.ts'), 'utf8')];
  const collect = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(full);
      else if (entry.name.endsWith('.ts')) parts.push(fs.readFileSync(full, 'utf8'));
    }
  };
  collect(path.resolve(process.cwd(), 'src/server'));
  const serverSrc = parts.join('\n');
  for (const routeAndGate of [
    "requireModuleEnabled('ai')",
    "requireModuleEnabled('google_drive_backup')",
    "requireModuleEnabled('messaging')",
    "requireModuleEnabled('einvoice', 'tax', 'billing')",
    "requireModuleEnabled('locations', 'inventory')",
    "requireModuleEnabled('accounting', 'billing')",
    "requireModuleEnabled('gst_returns', 'tax')",
    "requireModuleEnabled('pos', 'billing')",
    "requireModuleEnabled('online_payments')",
    "requireModuleEnabled('email_notifications')",
    "requireModuleEnabled('online_store', 'inventory')",
    "requireModuleEnabled('hindi')",
  ]) {
    assert.ok(serverSrc.includes(routeAndGate), `Missing API gate in server routes: ${routeAndGate}`);
  }
});
