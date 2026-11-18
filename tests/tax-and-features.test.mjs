import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  calculateBillPreview,
  convertRateTaxMode,
  roundHalfUp,
} from '../src/core/money.ts';
import { defaultTaxEngine } from '../src/core/taxEngine.ts';

function collectLeafKeys(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      out.push(...collectLeafKeys(v, p));
    } else {
      out.push([p, String(v)]);
    }
  }
  return out;
}

function walkSourceFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkSourceFiles(full));
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

test('convertRateTaxMode handles inclusive <-> exclusive conversions cleanly without float drift', () => {
  assert.equal(convertRateTaxMode(100, 18, false, true), 118);
  assert.equal(convertRateTaxMode(118, 18, true, false), 100);
  assert.equal(convertRateTaxMode(105, 5, true, false), 100);
  assert.equal(convertRateTaxMode(280.14, 12, true, false), 250.13);
  assert.equal(convertRateTaxMode(250, 0, true, false), 250);
  assert.equal(convertRateTaxMode(250, 12, true, true), 250);
  assert.equal(convertRateTaxMode(250, 12, false, false), 250);
});

test('calculateBillPreview matches IndiaGstTaxEngine across IEEE-754 tricky inclusive & exclusive mixed GST lines', () => {
  const inputs = [
    { name: 'Tricky 12% Incl', qty: 1, unitPrice: 280.14, discountPct: 0, gstRate: 12, taxInclusive: true },
    { name: 'MRP 5% Incl', qty: 3, unitPrice: 99.99, discountPct: 5, gstRate: 5, taxInclusive: true },
    { name: 'B2B 18% Excl', qty: 2, unitPrice: 149.5, discountPct: 10, gstRate: 18, taxInclusive: false },
    { name: 'Luxury 28% Incl', qty: 1, unitPrice: 1120, discountPct: 7.5, gstRate: 28, taxInclusive: true },
  ];

  for (const isInterstate of [false, true]) {
    const preview = calculateBillPreview({
      gstRegistered: true,
      taxModuleEnabled: true,
      docType: 'tax_invoice',
      businessStateCode: '27',
      placeOfSupplyStateCode: isInterstate ? '07' : '27',
      isInterstate,
      extraCharges: 0,
      autoRoundOff: false,
      lines: inputs.map((x) => ({
        enteredQty: x.qty,
        unitPrice: x.unitPrice,
        discountPct: x.discountPct,
        gstRate: x.gstRate,
        taxInclusive: x.taxInclusive,
      })),
    });

    let sumTaxable = 0;
    let sumTax = 0;
    inputs.forEach((x, idx) => {
      const engineLine = defaultTaxEngine.computeLineTax({
        itemName: x.name,
        hsnCode: '1234',
        qty: x.qty,
        unitPrice: x.unitPrice,
        discountPct: x.discountPct,
        gstRate: x.gstRate,
        taxInclusive: x.taxInclusive,
        isInterstate,
        gstRegistered: true,
      });
      const prevLine = preview.lines[idx];
      assert.equal(prevLine.grossAmount, engineLine.grossAmount);
      assert.equal(prevLine.discountAmount, engineLine.discountAmount);
      assert.equal(prevLine.taxableAmount, engineLine.taxableAmount);
      assert.equal(prevLine.cgstAmount, engineLine.cgstAmount);
      assert.equal(prevLine.sgstAmount, engineLine.sgstAmount);
      assert.equal(prevLine.igstAmount, engineLine.igstAmount);
      assert.equal(prevLine.taxAmount, engineLine.taxAmount);
      assert.equal(prevLine.lineTotal, engineLine.lineTotal);
      assert.equal(
        roundHalfUp(prevLine.taxableAmount + prevLine.taxAmount, 2),
        prevLine.lineTotal
      );
      sumTaxable = roundHalfUp(sumTaxable + engineLine.taxableAmount, 2);
      sumTax = roundHalfUp(sumTax + engineLine.taxAmount, 2);
    });

    assert.equal(preview.subtotalTaxable, sumTaxable);
    assert.equal(preview.taxTotal, sumTax);
    assert.equal(preview.grandTotal, roundHalfUp(sumTaxable + sumTax, 2));
  }

  // Specific check for IEEE-754 drift case: 280.14 inclusive at 12%
  // 28014 / 112 = 250.125 -> round half up = 250.13 taxable, 30.01 tax
  const tricky = defaultTaxEngine.computeLineTax({
    itemName: 'Drift Check',
    hsnCode: null,
    qty: 1,
    unitPrice: 280.14,
    discountPct: 0,
    gstRate: 12,
    taxInclusive: true,
    isInterstate: false,
    gstRegistered: true,
  });
  assert.equal(tricky.taxableAmount, 250.13);
  assert.equal(tricky.taxAmount, 30.01);
  assert.equal(tricky.lineTotal, 280.14);
});

test('Bill of Supply produces zero tax regardless of taxInclusive flag', () => {
  const bos = calculateBillPreview({
    gstRegistered: true,
    taxModuleEnabled: true,
    docType: 'bill_of_supply',
    businessStateCode: '27',
    placeOfSupplyStateCode: '27',
    autoRoundOff: false,
    lines: [
      { enteredQty: 2, unitPrice: 118, discountPct: 0, gstRate: 18, taxInclusive: true },
      { enteredQty: 1, unitPrice: 100, discountPct: 0, gstRate: 18, taxInclusive: false },
    ],
  });
  assert.equal(bos.gstApplied, false);
  assert.equal(bos.taxTotal, 0);
  assert.equal(bos.subtotalTaxable, 336);
  assert.equal(bos.grandTotal, 336);
});

test('EN and HI localization files maintain 100% key parity including new billing & purchase keys', () => {
  const en = JSON.parse(fs.readFileSync(path.resolve('src/i18n/en.json'), 'utf8'));
  const hi = JSON.parse(fs.readFileSync(path.resolve('src/i18n/hi.json'), 'utf8'));

  const enLeaves = collectLeafKeys(en);
  const hiLeaves = collectLeafKeys(hi);
  const enMap = new Map(enLeaves);
  const hiMap = new Map(hiLeaves);

  for (const [k, v] of enLeaves) {
    assert.ok(hiMap.has(k), `Missing Hindi key: ${k}`);
    assert.ok(v.trim().length > 0, `Empty English key: ${k}`);
  }
  for (const [k, v] of hiLeaves) {
    assert.ok(enMap.has(k), `Missing English key: ${k}`);
    assert.ok(v.trim().length > 0, `Empty Hindi key: ${k}`);
  }

  for (const requiredKey of [
    'bills.fastAddTitle',
    'bills.aiSmartOrder',
    'bills.scanCamera',
    'bills.taxInclBadge',
    'bills.taxExclBadge',
    'purchases.aiScanTitle',
    'purchases.uploadInvoiceScan',
    'purchases.snapInvoicePhoto',
    'purchases.rateTaxBasis',
  ]) {
    assert.ok(enMap.has(requiredKey), `Expected i18n key missing: ${requiredKey}`);
  }
});

test('Codebase uses modern Gemini model, keeps @google/genai server-only, and replaced obsolete bill/purchase modals', () => {
  const serverSrc = fs.readFileSync(path.resolve('server.ts'), 'utf8');
  const srcFiles = walkSourceFiles(path.resolve('src'));

  assert.equal(/gemini-(1\.5|2\.0|2\.5)-flash/i.test(serverSrc), false);
  for (const file of srcFiles) {
    const content = fs.readFileSync(file, 'utf8');
    assert.equal(
      /gemini-(1\.5|2\.0|2\.5)-flash/i.test(content),
      false,
      `Deprecated Gemini model string found in ${file}`
    );
    if (!file.includes(`${path.sep}server${path.sep}`)) {
      assert.equal(
        /from ['"]@google\/genai['"]/.test(content),
        false,
        `Client file must not import @google/genai: ${file}`
      );
    }
  }

  assert.equal(fs.existsSync(path.resolve('src/modules/bills/NewBillScreen.tsx')), true);
  assert.equal(fs.existsSync(path.resolve('src/modules/purchases/NewPurchaseScreen.tsx')), true);
  assert.equal(fs.existsSync(path.resolve('src/modules/bills/BillFormModal.tsx')), false);
  assert.equal(fs.existsSync(path.resolve('src/modules/purchases/PurchaseFormModal.tsx')), false);
});
