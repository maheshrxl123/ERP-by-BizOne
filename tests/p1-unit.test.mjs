import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { MODULE_REGISTRY } from '../config/modules.config.ts';
import { formatINR, getInitials, isValidGstin } from '../src/core/format.ts';
import { hasCapability, ROLE_LABELS } from '../src/core/permissions.ts';

test('formatINR formats Indian rupee grouping accurately', () => {
  assert.equal(formatINR(0), '₹0.00');
  assert.equal(formatINR(123456.78), '₹1,23,456.78');
  assert.equal(formatINR(-9500), '-₹9,500.00');
  assert.equal(formatINR(Number.NaN), '₹0.00');
});

test('getInitials derives concise avatar initials', () => {
  assert.equal(getInitials('Ramesh Gupta'), 'RG');
  assert.equal(getInitials('Anita'), 'AN');
  assert.equal(getInitials('   '), 'U');
});

test('isValidGstin validates 15-char Indian GSTINs and allows blank optional input', () => {
  assert.equal(isValidGstin(''), true);
  assert.equal(isValidGstin('27AAPFU0939F1ZV'), true);
  assert.equal(isValidGstin('27aapfu0939f1zv'), true);
  assert.equal(isValidGstin('INVALID123'), false);
  assert.equal(isValidGstin('99AAPFU0939F1Z'), false);
});

test('ROLE_LABELS and hasCapability enforce fixed RBAC matrix', () => {
  const roles = ['owner', 'manager', 'cashier', 'storekeeper', 'accountant', 'viewer'];
  for (const role of roles) {
    assert.ok(ROLE_LABELS[role]?.en);
    assert.ok(ROLE_LABELS[role]?.hi);
  }

  assert.equal(hasCapability('owner', 'manage_settings'), true);
  assert.equal(hasCapability('manager', 'manage_settings'), false);
  assert.equal(hasCapability('manager', 'void_bill'), true);
  assert.equal(hasCapability('cashier', 'create_bills'), true);
  assert.equal(hasCapability('cashier', 'view_profit'), false);
  assert.equal(hasCapability('storekeeper', 'stock_adjustment'), true);
  assert.equal(hasCapability('storekeeper', 'create_bills'), false);
  assert.equal(hasCapability('accountant', 'export_data'), true);
  assert.equal(hasCapability('viewer', 'reports'), true);
  assert.equal(hasCapability('viewer', 'create_bills'), false);
  assert.equal(hasCapability(null, 'reports'), false);
});

test('MODULE_REGISTRY keeps unique keys and valid dependency references', () => {
  const keys = new Set(MODULE_REGISTRY.map((m) => m.key));
  assert.equal(keys.size, MODULE_REGISTRY.length);
  assert.ok(keys.has('billing'));
  assert.ok(keys.has('accounting'));

  for (const mod of MODULE_REGISTRY) {
    for (const dep of mod.dependsOn) {
      assert.ok(keys.has(dep), `Module ${mod.key} depends on missing key ${dep}`);
    }
  }
});

test('check-env rejects secret leaks in VITE_ variables and passes current .env', () => {
  const baseEnv = {
    ...process.env,
    VITE_SUPABASE_URL:
      process.env.VITE_SUPABASE_URL && !process.env.VITE_SUPABASE_URL.includes('YOUR_')
        ? process.env.VITE_SUPABASE_URL
        : 'https://demo-project-ref.supabase.co',
    VITE_SUPABASE_ANON_KEY:
      process.env.VITE_SUPABASE_ANON_KEY && !process.env.VITE_SUPABASE_ANON_KEY.includes('YOUR_')
        ? process.env.VITE_SUPABASE_ANON_KEY
        : 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.demo_anon_key_value',
  };
  const output = execFileSync('node', ['scripts/check-env.mjs'], {
    encoding: 'utf8',
    env: baseEnv,
  });
  assert.match(output, /Environment configuration verified cleanly/);

  assert.throws(() => {
    execFileSync('node', ['scripts/check-env.mjs'], {
      encoding: 'utf8',
      env: {
        ...baseEnv,
        VITE_LEAKED_SERVICE_ROLE_KEY: 'forbidden',
      },
    });
  });
});
