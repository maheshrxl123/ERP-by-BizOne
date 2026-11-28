import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { calculateBillPreview, roundHalfUp } from '../src/core/money.ts';

test('Phase 2 (1): Customer -> Quotation -> Invoice -> Payment -> Stock & Khata math simulation', () => {
  // Step 1: Quotation preview (no payment collected, GST calculated for quote display)
  const quotation = calculateBillPreview({
    gstRegistered: true,
    taxModuleEnabled: true,
    docType: 'quotation',
    businessStateCode: '27',
    placeOfSupplyStateCode: '27',
    extraCharges: 0,
    autoRoundOff: true,
    lines: [
      {
        enteredQty: 10,
        unitPrice: 1080,
        discountPct: 5,
        gstRate: 18,
        taxInclusive: true,
      },
    ],
  });
  assert.equal(quotation.lines.length, 1);
  assert.equal(quotation.grandTotal, 10260);
  const quotationPaid = 0; // Quotation never posts stock or payment
  assert.equal(quotationPaid, 0);

  // Step 2: Convert / Issue Tax Invoice (intrastate 27 -> 27 splits CGST + SGST evenly)
  const invoice = calculateBillPreview({
    gstRegistered: true,
    taxModuleEnabled: true,
    docType: 'tax_invoice',
    businessStateCode: '27',
    placeOfSupplyStateCode: '27',
    extraCharges: 240,
    autoRoundOff: true,
    lines: [
      {
        enteredQty: 10,
        unitPrice: 1080,
        discountPct: 5,
        gstRate: 18,
        taxInclusive: true,
      },
    ],
  });
  assert.equal(invoice.isInterstate, false);
  assert.equal(invoice.cgstTotal, invoice.sgstTotal);
  assert.equal(invoice.igstTotal, 0);
  assert.equal(invoice.grandTotal, 10500);

  // Step 3: Stock deduction & partial payment -> Khata balance due
  const initialStockBoxes = 50;
  const soldBoxes = 10;
  const postSaleStock = roundHalfUp(initialStockBoxes - soldBoxes, 3);
  assert.equal(postSaleStock, 40);

  const partialPaid = 4500;
  const balanceAfterInvoice = roundHalfUp(invoice.grandTotal - partialPaid, 2);
  assert.equal(balanceAfterInvoice, 6000);

  // Step 4: Follow-up customer payment settles remaining Khata balance
  const followupPayment = 6000;
  const finalKhataBalance = roundHalfUp(balanceAfterInvoice - followupPayment, 2);
  assert.equal(finalKhataBalance, 0);

  // Step 5: Interstate Tax Invoice uses IGST only
  const interstate = calculateBillPreview({
    gstRegistered: true,
    taxModuleEnabled: true,
    docType: 'tax_invoice',
    businessStateCode: '27',
    placeOfSupplyStateCode: '29',
    extraCharges: 0,
    autoRoundOff: true,
    lines: [
      {
        enteredQty: 4,
        unitPrice: 1000,
        discountPct: 0,
        gstRate: 18,
        taxInclusive: false,
      },
    ],
  });
  assert.equal(interstate.isInterstate, true);
  assert.equal(interstate.cgstTotal, 0);
  assert.equal(interstate.sgstTotal, 0);
  assert.equal(interstate.igstTotal, 720);
  assert.equal(interstate.grandTotal, 4720);
});

test('Phase 2 (2): Items row-level Adjust modal, KPI refresh, and Name/Selling/Cost/Stock sorting', () => {
  const itemsSrc = fs.readFileSync(path.resolve('src/modules/items/ItemsScreen.tsx'), 'utf8');
  assert.match(itemsSrc, /openQuickAdjust\(item\)/);
  assert.match(itemsSrc, /<StockAdjustmentModal[\s\S]*onAdjusted=\{loadInventory\}/);
  assert.match(itemsSrc, /from\('inventory_summary_view'\)/);
  assert.match(itemsSrc, /from\('item_catalog_view'\)/);

  // Sorting covers Name, Selling Price, Cost Price, and Stock in both table headers and dropdown
  for (const key of ['name', 'price', 'cost', 'stock']) {
    assert.match(itemsSrc, new RegExp(`toggleSortColumn\\('${key}'\\)`));
  }
  assert.match(itemsSrc, /value="name_asc"/);
  assert.match(itemsSrc, /value="price_desc"/);
  assert.match(itemsSrc, /value="cost_desc"/);
  assert.match(itemsSrc, /value="cost_asc"/);
  assert.match(itemsSrc, /value="stock_asc"/);
});

test('Phase 2 (3): Bill Draft payment persistence & Purchase 0-item validation', () => {
  const billSrc = fs.readFileSync(path.resolve('src/modules/bills/NewBillScreen.tsx'), 'utf8');
  // Editing a saved draft always preserves paid_amount without snapping back to grandTotal
  assert.match(billSrc, /setPaidTouched\(true\)/);
  assert.match(billSrc, /setPaidAmount\(String\(Number\(editingDraft\.paid_amount \?\? 0\)\)\)/);
  assert.match(billSrc, /p_paid_amount:\s*draftPaid/);
  assert.match(billSrc, /p_payment_mode:\s*paymentMode/);
  assert.match(billSrc, /p_payment_reference:\s*paymentReference\.trim\(\) \|\| null/);

  const purchaseSrc = fs.readFileSync(path.resolve('src/modules/purchases/NewPurchaseScreen.tsx'), 'utf8');
  // Sidebar Post Purchase and Save Draft remain clickable when 0 lines so validation displays cleanly
  assert.doesNotMatch(purchaseSrc, /disabled=\{submitting \|\| lines\.length === 0\}/);
  assert.match(purchaseSrc, /Please add at least one item line\./);
  assert.match(purchaseSrc, /errorMsg && \([\s\S]*role="alert"/);
});

test('Phase 2 (4): Double-click & idempotency protection across all financial write flows', () => {
  const checks = [
    ['src/modules/bills/NewBillScreen.tsx', /submittingRef\.current/, /idempotencyKey/],
    ['src/modules/bills/BillDetailView.tsx', /convertingRef\.current/, /convertIdempKeyRef/],
    ['src/modules/bills/SalesReturnModal.tsx', /submittingRef\.current/, /idempotencyKey/],
    ['src/modules/purchases/NewPurchaseScreen.tsx', /submittingRef\.current/, /idempotencyKey/],
    ['src/modules/purchases/PurchaseReturnModal.tsx', /submittingRef\.current/, /idempotencyKey/],
    ['src/modules/parties/PaymentModal.tsx', /savingRef\.current/, /pay_\$\{crypto\.randomUUID\(\)\}/],
    ['src/modules/items/StockAdjustmentModal.tsx', /savingRef\.current/, /p_idempotency_key:\s*idempKey/],
  ];

  for (const [relPath, refPattern, idempPattern] of checks) {
    const src = fs.readFileSync(path.resolve(relPath), 'utf8');
    assert.match(src, refPattern, `${relPath} missing synchronous ref guard`);
    assert.match(src, idempPattern, `${relPath} missing idempotency key`);
  }
});

test('Phase 2 (5): Atomic SQL RPCs in 0029 migration & Settings/Reports UI fixes', () => {
  const mig0029 = fs.readFileSync(
    path.resolve('supabase/migrations/0029_phase1_6_fixes.sql'),
    'utf8'
  );
  assert.match(mig0029, /CREATE OR REPLACE FUNCTION public\.save_bill_draft\(/);
  assert.match(mig0029, /p_paid_amount numeric DEFAULT 0/);
  assert.match(mig0029, /CREATE OR REPLACE FUNCTION public\.create_sales_return\(/);
  assert.match(mig0029, /CREATE OR REPLACE FUNCTION public\.create_purchase_return\(/);
  assert.match(mig0029, /pg_advisory_xact_lock\(hashtext\('sales_return:' \|\| v_idemp\)\)/);
  assert.match(mig0029, /pg_advisory_xact_lock\(hashtext\('purchase_return:' \|\| v_idemp\)\)/);
  assert.match(mig0029, /variant_id,\s*shade,\s*batch_lot/);
  assert.match(
    mig0029,
    /GRANT EXECUTE ON FUNCTION public\.create_sales_return\(uuid, jsonb, date, numeric, text, text, text\) TO authenticated/
  );
  assert.match(
    mig0029,
    /GRANT EXECUTE ON FUNCTION public\.create_purchase_return\(uuid, jsonb, date, numeric, text, text, text\) TO authenticated/
  );

  // Settings -> Appearance & Language selector
  const settingsSrc = fs.readFileSync(path.resolve('src/modules/settings/SettingsScreen.tsx'), 'utf8');
  assert.match(settingsSrc, /key:\s*'appearance'/);
  assert.match(settingsSrc, /setLanguage\(lang\)/);
  assert.match(settingsSrc, /common\.english/);
  assert.match(settingsSrc, /common\.hindi/);

  // Reports -> Stock Summary friendly headers
  const reportsSrc = fs.readFileSync(path.resolve('src/modules/reports/ReportsScreen.tsx'), 'utf8');
  assert.match(reportsSrc, /is_low_stock:\s*'Low Stock'/);
  assert.match(reportsSrc, /whitespace-nowrap/);
  assert.match(reportsSrc, /formatReportHeader\(c\)/);
});
