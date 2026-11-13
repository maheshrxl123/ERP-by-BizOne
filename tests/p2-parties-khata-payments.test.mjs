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

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF;

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
  return res.json();
}

function collectLeafPaths(obj, prefix = '') {
  const paths = [];
  for (const [key, val] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      paths.push(...collectLeafPaths(val, next));
    } else {
      paths.push([next, String(val)]);
    }
  }
  return paths;
}

test('Phase P2 unit checks: Hindi & English i18n parity and PRD glossary terms', () => {
  const en = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), 'src/i18n/en.json'), 'utf8')
  );
  const hi = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), 'src/i18n/hi.json'), 'utf8')
  );

  for (const section of ['parties', 'payments']) {
    const enLeaves = new Map(collectLeafPaths(en[section], section));
    const hiLeaves = new Map(collectLeafPaths(hi[section], section));
    assert.equal(
      enLeaves.size,
      hiLeaves.size,
      `${section} EN and HI key counts must match`
    );
    for (const [k] of enLeaves) {
      assert.ok(hiLeaves.has(k), `Missing Hindi translation for ${k}`);
      assert.ok(
        hiLeaves.get(k).trim().length > 0,
        `Empty Hindi translation for ${k}`
      );
    }
  }

  // Mandatory PRD Section 25 Hindi glossary terms
  assert.equal(hi.nav.parties, 'पार्टी');
  assert.equal(hi.parties.youllGet, 'लेना है');
  assert.equal(hi.parties.youllGive, 'देना है');
  assert.equal(hi.parties.supplier, 'सप्लायर');
  assert.equal(hi.parties.customer, 'ग्राहक');
  assert.equal(hi.payments.receivePayment, 'पैसे लें');
  assert.equal(hi.payments.givePayment, 'पैसे दें');
  assert.equal(hi.payments.modes.cash, 'नकद');
  assert.ok(hi.parties.khataLedger.includes('खाता'));
});

test('Phase P2 E2E: Parties, Khata, Allocations, Reversals, Statements, Concurrency, and RBAC', async () => {
  assert.ok(
    SUPABASE_URL && SUPABASE_ANON_KEY && SERVICE_ROLE_KEY,
    'Supabase environment variables must be configured'
  );
  assert.ok(
    ACCESS_TOKEN && PROJECT_REF,
    'SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF required for clean test teardown'
  );

  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const stamp = Date.now();
  const password = 'BizOneTest!2026';
  const createdUserIds = [];
  const createdPartyIds = [];
  let createdWorkspaceTemp = false;

  const createTempUser = async (role, tag) => {
    const email = `p2.${tag}.${stamp}@example.com`;
    const { data: authData, error: authErr } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: `P2 ${tag}` },
      });
    assert.equal(authErr, null);
    createdUserIds.push(authData.user.id);

    const { error: profErr } = await supabaseAdmin.from('profiles').insert({
      id: authData.user.id,
      full_name: `P2 ${tag}`,
      email,
      role,
      is_active: true,
    });
    assert.equal(profErr, null);

    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: loginErr } = await client.auth.signInWithPassword({
      email,
      password,
    });
    assert.equal(loginErr, null);
    return { id: authData.user.id, email, client };
  };

  try {
    // Ensure business exists if running against empty DB, otherwise preserve existing workspace
    const { data: existingBiz } = await supabaseAdmin
      .from('business')
      .select('id')
      .eq('id', 1)
      .maybeSingle();

    if (!existingBiz) {
      createdWorkspaceTemp = true;
      await supabaseAdmin.from('business').insert({
        id: 1,
        name: 'P2 Test Kirana',
        pack: 'kirana',
        gst_registered: false,
        fy_start_month: 4,
      });
    }

    const owner = await createTempUser('owner', 'owner');
    const manager = await createTempUser('manager', 'manager');
    const cashier = await createTempUser('cashier', 'cashier');
    const storekeeper = await createTempUser('storekeeper', 'storekeeper');
    const viewer = await createTempUser('viewer', 'viewer');

    // 1. Opening Balance + Adjustment + Optimistic Version Lock + Multi-Address
    const { data: cust, error: custErr } = await owner.client.rpc('save_party', {
      p_party_id: null,
      p_name: `Ramesh Kirana Customer ${stamp}`,
      p_party_type: 'customer',
      p_phone: '9876543210',
      p_email: 'ramesh@example.com',
      p_gstin: '27AAPFU0939F1ZV',
      p_opening_balance: 1500,
      p_opening_balance_type: 'to_receive',
      p_opening_balance_date: '2026-04-01',
      p_credit_limit: 5000,
      p_credit_days: 15,
      p_notes: 'Monthly grocery credit customer',
      p_addresses: [
        {
          label: 'Shop',
          address_line1: '12 Main Bazaar',
          city: 'Pune',
          state: 'Maharashtra',
          pincode: '411001',
          is_default: true,
        },
      ],
    });
    assert.equal(custErr, null);
    assert.ok(cust?.id);
    createdPartyIds.push(cust.id);

    // Verify customer net balance = +1500 (You'll Get)
    const { data: bal1 } = await owner.client
      .from('party_balances')
      .select('*')
      .eq('party_id', cust.id)
      .single();
    assert.equal(Number(bal1.net_balance), 1500);
    assert.equal(Number(bal1.to_receive), 1500);
    assert.equal(Number(bal1.to_give), 0);

    // Stale version conflict must be rejected
    const { error: staleErr } = await owner.client.rpc('save_party', {
      p_party_id: cust.id,
      p_name: cust.name,
      p_party_type: 'customer',
      p_expected_version: 99,
    });
    assert.ok(staleErr, 'Stale expected version must fail');

    // Adjust opening balance 1500 -> 2000 posts an immutable 'adjustment' entry (+500)
    const { data: custUpdated, error: adjErr } = await owner.client.rpc(
      'save_party',
      {
        p_party_id: cust.id,
        p_name: cust.name,
        p_party_type: 'customer',
        p_phone: '9876543210',
        p_opening_balance: 2000,
        p_opening_balance_type: 'to_receive',
        p_opening_balance_date: '2026-04-01',
        p_credit_limit: 5000,
        p_credit_days: 15,
        p_expected_version: bal1.version,
      }
    );
    assert.equal(adjErr, null);
    assert.equal(custUpdated.version, 2);

    const { data: custLedgerAfterAdj } = await owner.client
      .from('party_ledger_entries')
      .select('*')
      .eq('party_id', cust.id)
      .order('entry_date', { ascending: true })
      .order('created_at', { ascending: true });
    assert.equal(custLedgerAfterAdj.length, 2);
    assert.equal(custLedgerAfterAdj[0].entry_type, 'opening_balance');
    assert.equal(Number(custLedgerAfterAdj[0].signed_amount), 1500);
    assert.equal(custLedgerAfterAdj[1].entry_type, 'adjustment');
    assert.equal(Number(custLedgerAfterAdj[1].signed_amount), 500);

    // 2. Post Overdue Khata Due on Customer (+1000 => total net = 3000)
    const { data: dueEntry, error: dueErr } = await cashier.client.rpc(
      'post_khata_due',
      {
        p_party_id: cust.id,
        p_direction: 'to_receive',
        p_amount: 1000,
        p_entry_date: '2026-04-10',
        p_due_date: '2026-04-15',
        p_note: 'April credit basket',
        p_idempotency_key: `due-${stamp}`,
      }
    );
    assert.equal(dueErr, null);
    assert.ok(dueEntry?.reference_no?.startsWith('KHT-'));

    const { data: bal2 } = await owner.client
      .from('party_balances')
      .select('*')
      .eq('party_id', cust.id)
      .single();
    assert.equal(Number(bal2.net_balance), 3000);
    assert.equal(bal2.is_overdue, true);

    // 3. Supplier Direction & Balance Check (-2500 => You'll Give = 2500)
    const { data: sup, error: supErr } = await owner.client.rpc('save_party', {
      p_party_id: null,
      p_name: `Mahalaxmi Wholesale Supplier ${stamp}`,
      p_party_type: 'supplier',
      p_phone: '9822011223',
      p_opening_balance: 2500,
      p_opening_balance_type: 'to_give',
      p_opening_balance_date: '2026-04-02',
    });
    assert.equal(supErr, null);
    createdPartyIds.push(sup.id);

    const { data: supDue, error: supDueErr } = await owner.client.rpc(
      'post_khata_due',
      {
        p_party_id: sup.id,
        p_direction: 'to_give',
        p_amount: 1000,
        p_entry_date: '2026-04-12',
        p_note: 'Supplier credit bill',
      }
    );
    assert.equal(supDueErr, null);

    const { data: supBal } = await owner.client
      .from('party_balances')
      .select('*')
      .eq('party_id', sup.id)
      .single();
    assert.equal(Number(supBal.net_balance), -3500);
    assert.equal(Number(supBal.to_give), 3500);
    assert.equal(Number(supBal.to_receive), 0);

    // 4. Partial Receive Payment with FIFO Auto-Allocation (1200 against OB 1500)
    const { data: pay1, error: pay1Err } = await cashier.client.rpc(
      'post_payment',
      {
        p_party_id: cust.id,
        p_direction: 'receive',
        p_amount: 1200,
        p_mode: 'upi',
        p_payment_date: '2026-04-18',
        p_reference_no: 'UTR998877',
        p_auto_allocate: true,
        p_idempotency_key: `pay1-${stamp}`,
      }
    );
    assert.equal(pay1Err, null);
    assert.ok(pay1.payment_number.startsWith('REC-'));
    assert.equal(Number(pay1.allocated_amount), 1200);
    assert.equal(Number(pay1.advance_amount), 0);

    const { data: custObsAfterPay1 } = await owner.client
      .from('party_open_obligations')
      .select('*')
      .eq('party_id', cust.id)
      .order('entry_date', { ascending: true });
    assert.equal(custObsAfterPay1.length, 2);
    assert.equal(custObsAfterPay1[0].entry_type, 'opening_balance');
    assert.equal(Number(custObsAfterPay1[0].remaining_amount), 300); // 1500 - 1200
    assert.equal(custObsAfterPay1[1].entry_type, 'khata_due');
    assert.equal(Number(custObsAfterPay1[1].remaining_amount), 1000);

    // 5. Overpayment / Customer Advance (Receive 2500 -> allocates remaining 300 + 1000 dues + 1200 on-account advance; net = 3000 - 1200 - 2500 = -700 => You'll Give 700)
    const { data: pay2, error: pay2Err } = await owner.client.rpc(
      'post_payment',
      {
        p_party_id: cust.id,
        p_direction: 'receive',
        p_amount: 2500,
        p_mode: 'cash',
        p_payment_date: '2026-04-20',
        p_auto_allocate: true,
        p_idempotency_key: `pay2-${stamp}`,
      }
    );
    assert.equal(pay2Err, null);
    assert.equal(Number(pay2.allocated_amount), 1300); // 300 + 1000
    assert.equal(Number(pay2.advance_amount), 1200);

    const { data: balAfterAdvance } = await owner.client
      .from('party_balances')
      .select('*')
      .eq('party_id', cust.id)
      .single();
    assert.equal(Number(balAfterAdvance.net_balance), -700);
    assert.equal(Number(balAfterAdvance.to_give), 700);
    assert.equal(Number(balAfterAdvance.to_receive), 0);

    // 6. Manual Allocation on Supplier Give Payment (allocates specifically to supDue 1000)
    const { data: supPay, error: supPayErr } = await owner.client.rpc(
      'post_payment',
      {
        p_party_id: sup.id,
        p_direction: 'give',
        p_amount: 1000,
        p_mode: 'bank_transfer',
        p_payment_date: '2026-04-20',
        p_auto_allocate: false,
        p_allocations: [{ ledger_entry_id: supDue.id, amount: 1000 }],
        p_idempotency_key: `sup-pay-${stamp}`,
      }
    );
    assert.equal(supPayErr, null);
    assert.ok(supPay.payment_number.startsWith('PAY-'));
    assert.equal(Number(supPay.allocated_amount), 1000);
    assert.equal(Number(supPay.advance_amount), 0);

    const { data: supObsAfter } = await owner.client
      .from('party_open_obligations')
      .select('*')
      .eq('party_id', sup.id);
    assert.equal(supObsAfter.length, 1);
    assert.equal(supObsAfter[0].entry_type, 'opening_balance');

    // 7. Immutability & Payment Reversal Permissions (Cashier denied, Manager allowed)
    const { error: delPayErr } = await owner.client
      .from('payments')
      .delete()
      .eq('id', pay2.id);
    assert.ok(delPayErr, 'Direct delete on payments must be denied');

    const { error: mutLedgerErr } = await owner.client
      .from('party_ledger_entries')
      .update({ signed_amount: 1 })
      .eq('id', dueEntry.id);
    assert.ok(mutLedgerErr, 'Direct update on ledger entries must be denied');

    const { error: cashierRevErr } = await cashier.client.rpc(
      'reverse_payment',
      { p_payment_id: pay2.id, p_reason: 'Cashier attempt' }
    );
    assert.ok(cashierRevErr, 'Cashier must NOT be able to reverse payments');

    const { data: reversedPay2, error: mgrRevErr } = await manager.client.rpc(
      'reverse_payment',
      { p_payment_id: pay2.id, p_reason: 'Cheque dishonored' }
    );
    assert.equal(mgrRevErr, null);
    assert.equal(reversedPay2.status, 'reversed');

    // Double reversal must fail cleanly
    const { error: doubleRevErr } = await owner.client.rpc('reverse_payment', {
      p_payment_id: pay2.id,
      p_reason: 'Double attempt',
    });
    assert.ok(doubleRevErr, 'Already reversed payment cannot be reversed again');

    // Open dues restored after pay2 reversal (remaining OB 300 + dueEntry 1000 + adj 500 => net = 1800)
    const { data: balAfterRev } = await owner.client
      .from('party_balances')
      .select('*')
      .eq('party_id', cust.id)
      .single();
    assert.equal(Number(balAfterRev.net_balance), 1800);

    // 8. Statement Totals & Running Balance Reconciliation
    const { data: stmtFull, error: stmtFullErr } = await owner.client.rpc(
      'get_party_statement',
      { p_party_id: cust.id, p_from_date: null, p_to_date: null }
    );
    assert.equal(stmtFullErr, null);
    assert.equal(Number(stmtFull.opening_balance), 0);
    assert.equal(
      Math.round(
        (Number(stmtFull.opening_balance) +
          Number(stmtFull.period_debit) -
          Number(stmtFull.period_credit)) *
          100
      ) / 100,
      Number(stmtFull.closing_balance)
    );
    assert.equal(Number(stmtFull.closing_balance), Number(balAfterRev.net_balance));
    const lastRow = stmtFull.rows[stmtFull.rows.length - 1];
    assert.equal(Number(lastRow.running_balance), Number(stmtFull.closing_balance));

    // Date-windowed statement reconciliation
    const { data: stmtSlice, error: stmtSliceErr } = await owner.client.rpc(
      'get_party_statement',
      {
        p_party_id: cust.id,
        p_from_date: '2026-04-10',
        p_to_date: '2026-04-20',
      }
    );
    assert.equal(stmtSliceErr, null);
    assert.equal(
      Math.round(
        (Number(stmtSlice.opening_balance) +
          Number(stmtSlice.period_debit) -
          Number(stmtSlice.period_credit)) *
          100
      ) / 100,
      Number(stmtSlice.closing_balance)
    );

    // 9. Concurrent Idempotency & Parallel Numbering Serialization
    const sharedKey = `concurrent-idemp-${stamp}`;
    const [c1, c2, c3] = await Promise.all([
      owner.client.rpc('post_payment', {
        p_party_id: cust.id,
        p_direction: 'receive',
        p_amount: 200,
        p_mode: 'cash',
        p_payment_date: '2026-04-21',
        p_idempotency_key: sharedKey,
      }),
      owner.client.rpc('post_payment', {
        p_party_id: cust.id,
        p_direction: 'receive',
        p_amount: 200,
        p_mode: 'cash',
        p_payment_date: '2026-04-21',
        p_idempotency_key: sharedKey,
      }),
      owner.client.rpc('post_payment', {
        p_party_id: cust.id,
        p_direction: 'receive',
        p_amount: 200,
        p_mode: 'cash',
        p_payment_date: '2026-04-21',
        p_idempotency_key: sharedKey,
      }),
    ]);
    assert.equal(c1.error, null);
    assert.equal(c2.error, null);
    assert.equal(c3.error, null);
    assert.equal(c1.data.id, c2.data.id);
    assert.equal(c1.data.id, c3.data.id);

    // Parallel distinct payments must allocate unique sequential payment_numbers and reconcile exact balance
    const [d1, d2, d3] = await Promise.all([
      owner.client.rpc('post_payment', {
        p_party_id: cust.id,
        p_direction: 'receive',
        p_amount: 100,
        p_mode: 'upi',
        p_payment_date: '2026-04-22',
        p_idempotency_key: `parallel-1-${stamp}`,
      }),
      owner.client.rpc('post_payment', {
        p_party_id: cust.id,
        p_direction: 'receive',
        p_amount: 150,
        p_mode: 'upi',
        p_payment_date: '2026-04-22',
        p_idempotency_key: `parallel-2-${stamp}`,
      }),
      owner.client.rpc('post_payment', {
        p_party_id: cust.id,
        p_direction: 'receive',
        p_amount: 250,
        p_mode: 'upi',
        p_payment_date: '2026-04-22',
        p_idempotency_key: `parallel-3-${stamp}`,
      }),
    ]);
    assert.equal(d1.error, null);
    assert.equal(d2.error, null);
    assert.equal(d3.error, null);
    const uniqueNumbers = new Set([
      d1.data.payment_number,
      d2.data.payment_number,
      d3.data.payment_number,
    ]);
    assert.equal(uniqueNumbers.size, 3, 'All concurrent payments must have unique receipt numbers');

    // Previous balance 1800 - 200 (idemp) - (100 + 150 + 250) = 1100
    const { data: balAfterParallel } = await owner.client
      .from('party_balances')
      .select('net_balance')
      .eq('party_id', cust.id)
      .single();
    assert.equal(Number(balAfterParallel.net_balance), 1100);

    // 10. Archive Guard (non-zero denied, settle -> archive allowed for manager, denied for cashier)
    const { error: nonZeroArchiveErr } = await owner.client.rpc(
      'archive_party',
      { p_party_id: cust.id, p_is_active: false }
    );
    assert.ok(nonZeroArchiveErr, 'Must block archiving party with non-zero balance');

    const { error: settleErr } = await owner.client.rpc('post_payment', {
      p_party_id: cust.id,
      p_direction: 'receive',
      p_amount: 1100,
      p_mode: 'cash',
      p_payment_date: '2026-04-23',
      p_idempotency_key: `settle-${stamp}`,
    });
    assert.equal(settleErr, null);

    const { error: cashierArchErr } = await cashier.client.rpc(
      'archive_party',
      { p_party_id: cust.id, p_is_active: false }
    );
    assert.ok(cashierArchErr, 'Cashier must not archive party');

    const { data: archivedParty, error: mgrArchErr } = await manager.client.rpc(
      'archive_party',
      { p_party_id: cust.id, p_is_active: false }
    );
    assert.equal(mgrArchErr, null);
    assert.equal(archivedParty.is_active, false);

    // 11. Role Visibility & Permission Checks (Storekeeper and Viewer blocked)
    for (const denied of [storekeeper, viewer]) {
      const { data: pRows } = await denied.client.from('parties').select('id');
      assert.equal(pRows?.length ?? 0, 0);

      const { data: payRows } = await denied.client.from('payments').select('id');
      assert.equal(payRows?.length ?? 0, 0);

      const { error: rpcPartyErr } = await denied.client.rpc('save_party', {
        p_name: 'Unauthorized',
        p_party_type: 'customer',
      });
      assert.ok(rpcPartyErr);

      const { error: rpcPayErr } = await denied.client.rpc('post_payment', {
        p_party_id: sup.id,
        p_direction: 'give',
        p_amount: 100,
        p_mode: 'cash',
      });
      assert.ok(rpcPayErr);

      const { error: rpcStmtErr } = await denied.client.rpc(
        'get_party_statement',
        { p_party_id: sup.id }
      );
      assert.ok(rpcStmtErr);
    }
  } finally {
    // Clean up ONLY test parties, their ledger/payment records, and temporary test users
    if (createdPartyIds.length > 0 && ACCESS_TOKEN && PROJECT_REF) {
      const pidList = createdPartyIds.map((id) => `'${id}'`).join(', ');
      await runAdminSql(`
        ALTER TABLE public.payment_allocations DISABLE TRIGGER trg_guard_payment_alloc_immutable;
        ALTER TABLE public.payments DISABLE TRIGGER trg_guard_payment_immutable;
        ALTER TABLE public.party_ledger_entries DISABLE TRIGGER trg_guard_ledger_immutable;

        DELETE FROM public.payment_allocations WHERE party_id IN (${pidList});
        DELETE FROM public.party_ledger_entries WHERE party_id IN (${pidList});
        DELETE FROM public.payments WHERE party_id IN (${pidList});
        DELETE FROM public.party_addresses WHERE party_id IN (${pidList});
        DELETE FROM public.parties WHERE id IN (${pidList});

        ALTER TABLE public.payment_allocations ENABLE TRIGGER trg_guard_payment_alloc_immutable;
        ALTER TABLE public.payments ENABLE TRIGGER trg_guard_payment_immutable;
        ALTER TABLE public.party_ledger_entries ENABLE TRIGGER trg_guard_ledger_immutable;
      `);
    }

    if (createdUserIds.length > 0) {
      await supabaseAdmin.from('audit_logs').delete().in('actor_id', createdUserIds);
      await supabaseAdmin.from('audit_logs').delete().in('entity_id', createdUserIds);
      for (const uid of createdUserIds) {
        await supabaseAdmin.auth.admin.deleteUser(uid);
      }
    }

    if (createdWorkspaceTemp) {
      await supabaseAdmin.from('business').delete().eq('id', 1);
    }
  }
});
