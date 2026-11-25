import fs from 'node:fs';
import path from 'node:path';

const distDir = path.resolve('dist');
if (!fs.existsSync(distDir)) {
  console.log('[check-bundle] dist directory not found, skipping bundle check.');
  process.exit(0);
}

const indexPath = path.join(distDir, 'index.html');
if (!fs.existsSync(indexPath)) {
  console.error('[check-bundle] Error: dist/index.html missing.');
  process.exit(1);
}

const indexContent = fs.readFileSync(indexPath, 'utf8');
const forbiddenKeywords = [
  'AppShell',
  'SettingsScreen',
  'BillsScreen',
  'ItemsScreen',
  'issue_bill',
  'item_catalog_view',
  'save_item',
];

for (const kw of forbiddenKeywords) {
  if (indexContent.includes(kw)) {
    console.error(`[check-bundle] FAILURE: Storefront index.html contains forbidden ERP keyword "${kw}".`);
    process.exit(1);
  }
}

// Collect all JS/CSS assets directly referenced by dist/index.html (and avoid scanning erp-only chunks)
const referencedAssets = new Set();
const srcMatches = indexContent.matchAll(/(?:src|href)=["']\/?(assets\/[^"']+\.(?:js|css))["']/g);
for (const m of srcMatches) {
  referencedAssets.add(m[1]);
}

const scanned = new Set();
const queue = Array.from(referencedAssets);
while (queue.length > 0) {
  const rel = queue.shift();
  if (!rel || scanned.has(rel)) continue;
  scanned.add(rel);
  const fullPath = path.join(distDir, rel);
  if (!fs.existsSync(fullPath)) continue;
  const content = fs.readFileSync(fullPath, 'utf8');
  for (const kw of forbiddenKeywords) {
    if (content.includes(kw)) {
      console.error(`[check-bundle] FAILURE: Storefront asset "${rel}" contains forbidden ERP keyword "${kw}".`);
      process.exit(1);
    }
  }
  if (rel.endsWith('.js')) {
    const depMatches = content.matchAll(/["']\.\/([^"']+\.js)["']/g);
    for (const dm of depMatches) {
      const nextRel = path.posix.join(path.posix.dirname(rel), dm[1]);
      if (!scanned.has(nextRel)) queue.push(nextRel);
    }
  }
}

const erpHtmlPath = path.join(distDir, 'ERP', 'erp.html');
if (!fs.existsSync(erpHtmlPath)) {
  console.error('[check-bundle] FAILURE: dist/ERP/erp.html missing. ERP bundle must build to dist/ERP with base /ERP/.');
  process.exit(1);
}
const erpHtml = fs.readFileSync(erpHtmlPath, 'utf8');
if (!erpHtml.includes('/ERP/assets/')) {
  console.error('[check-bundle] FAILURE: dist/ERP/erp.html does not reference /ERP/assets/ base path.');
  process.exit(1);
}
if (erpHtml.includes('registerSW.js') || erpHtml.includes('manifest.webmanifest')) {
  console.error('[check-bundle] FAILURE: dist/ERP/erp.html should not inject storefront PWA service worker.');
  process.exit(1);
}

console.log(`[check-bundle] SUCCESS: Storefront bundle clean (${scanned.size} asset(s) scanned) & ERP bundle isolated at /ERP/.`);
process.exit(0);
