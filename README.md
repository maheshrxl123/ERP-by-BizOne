# DecorBiz (v1.0.0)

**DecorBiz** is a free, open-source, self-hosted, phone-first small-business ERP built with **React 19, Vite 8, TypeScript, Tailwind CSS v4, Express, and Supabase (PostgreSQL + RLS + Storage)**. Purpose-built for Indian shops, traders, workshops, and MSMEs with full bilingual **English & Hindi (`EN` / `HI`)** support.

---

## Key Highlights

- **Single-Business Workspace & 6-Role RBAC**: One Supabase project serves one business cleanly (`owner`, `manager`, `cashier`, `storekeeper`, `accountant`, `viewer`) enforced by PostgreSQL Row Level Security (RLS), role capability guards, and immutable audit logs.
- **Parties & Khata (Clear `To Receive` vs `To Pay` Tracking)**:
  - Customer & supplier ledgers with distinct **To Receive (You'll Get)** (`+`) and **To Pay (You'll Give)** (`-`) balances.
  - Opening balances, credit limits & credit days, FIFO auto-allocation or manual bill-by-bill settlement, payment reversals, printable/PDF/CSV statements, and WhatsApp/UPI payment reminders.
- **Items, Multi-Unit Inventory & Barcodes**:
  - Product & service catalogue, base + alternate units with conversion factors (e.g., `1 Box = 12 Pcs`), barcode/SKU label printing, multi-photo gallery, stock adjustments, and real-time cost valuation.
- **GST Billing, POS-Lite & Offline Queue**:
  - GST Tax Invoices (`CGST+SGST` intrastate / `IGST` interstate), Bills of Supply, Quotations (one-click convert to Invoice), Sales Returns / Credit Notes, dynamic UPI QR codes, revocable public share links, A4 & 80mm/58mm thermal print layouts.
  - **POS-Lite Counter Billing**: Fast item grid, barcode scan, decimal & integer quantities, parked/held bills, split Cash + UPI tender validation, cash register shift open/close variance, and idempotent offline queue sync (`idempotency_key`).
- **Purchases, Expenses & Business Reports**:
  - Supplier purchase bills (auto-updating stock & purchase price), purchase returns/debit notes, expense vouchers with receipt attachments, Day Book, Cash Book, Bank Book, Profit Estimate (hidden from Cashier/Storekeeper), Party Dues Ageing, GST Summary, and HSN Summary.
- **7 Trade-Specific Business Packs**:
  1. **Kirana / Grocery**: Loose weight ↔ amount calculator (`₹50` → `kg`/`gm`), quick MRP discount presets.
  2. **Medical Store / Pharmacy**: Batch numbers, Mfg/Expiry dates, automatic **FEFO** batch picking, expired batch sale lockout, near-expiry alerts, and Schedule H/H1/X prescription register.
  3. **Clothing / Footwear**: Size × Colour variant matrix generator, style code, fabric & season attributes.
  4. **Hardware / Tiles / Sanitary / Timber**: Area (`sq.ft` → boxes), paint coverage, and wire length calculators + party-specific rate cards & contractor project sites.
  5. **General Retail / Electronics**: Serial/IMEI tracking, warranty months, and MRP savings display on invoices.
  6. **Wholesale / Distribution**: Multi-tier pricing (`Retail`, `Wholesale`, `Distributor`, `Special`), minimum order qty, and margin checks.
  7. **Service / Repair / Workshop**: Job cards (`received` → `diagnosing` → `in_progress` → `ready` → `delivered`), device/serial intake, spare parts + labour billing.
- **Double-Entry Accounting & Advanced GST**:
  - Chart of Accounts, balanced `Dr = Cr` vouchers (`Journal`, `Contra`, `Receipt`, `Payment`), Guided Opening Balance Migration, Trial Balance, Profit & Loss, Balance Sheet, and Bank Reconciliation.
  - GSTR-1 (B2B, B2C state summary, Credit Notes CSV export), GSTR-3B, GSTR-2B ITC auto-reconciliation, NIC/GSP E-Invoice IRN/QR & E-Way Bill panel, and TDS/TCS registers.
- **Multi-Location Godowns & Operational Tools**:
  - Multiple godowns/branches, inter-location stock transfers, Physical Stock Count reconciliation, Sales/Purchase Orders, Delivery Challans, CRM Leads, Cheque Register, Recurring Rules, and WhatsApp/SMS/Email templates.
- **Optional DecorBiz AI Assistant**:
  - Remains completely off until the Owner configures their own API key in **Settings → Integrations** (Google Gemini, OpenAI, Anthropic Claude, OpenRouter, xAI Grok, or Custom HTTPS).
  - Enforces strict tool allowlisting, role-based profit/cost masking, prompt-injection sanitization, and Owner-only SHA-256 proposal approval tokens.

---

## Quick Start (Local Development)

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables (`.env`)
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Generate your 64-character hex encryption key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Fill in `.env`:
```dotenv
VITE_SUPABASE_URL="https://YOUR_PROJECT_REF.supabase.co"
VITE_SUPABASE_ANON_KEY="YOUR_SUPABASE_ANON_KEY"
VITE_APP_NAME="DecorBiz"

SUPABASE_SERVICE_ROLE_KEY="YOUR_SUPABASE_SERVICE_ROLE_KEY"
APP_ENCRYPTION_KEY="YOUR_64_HEX_CHAR_ENCRYPTION_KEY"
```

### 3. Apply Database Migrations & Start Server
```bash
npm run check-env
npm run rehearse  # Verify 0001..0023 SQL dependencies & view compatibility
npm run setup     # Or run supabase/migrations/0001..0023.sql in Supabase SQL Editor
npm run dev       # Starts Storefront (/) + ERP (/ERP) + API on http://localhost:3000
```

---

## Deploying to Vercel via GitHub (Testing, Demo & Production)

DecorBiz includes built-in Vercel support (`vercel.json` + `api/index.ts`) so deploying from GitHub works out of the box:

1. Push this repository to **GitHub**.
2. Import the repository at [vercel.com/new](https://vercel.com/new).
3. Add these 4 Environment Variables in Vercel Project Settings:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `APP_ENCRYPTION_KEY`
4. Click **Deploy**.
5. Open your Vercel URL to complete the **First-Time Business Setup** screen, and optionally click **Load Sample Demo Data** in **Settings → Business Profile** to populate sample data for testing and live demos.

For complete step-by-step documentation, read:
- **[Supabase & Vercel Deployment Guide](docs/deployment-supabase-vercel.md)**
- **[Backup & Restore Guide](docs/backup-and-restore.md)**
- **[Business Owner Manual](docs/owner-manual.md)**
- **[Staff Operations Guide](docs/staff-guide.md)**
- **[Owner Break-Glass Recovery Guide](docs/owner-break-glass-recovery.md)**
- **[Full Upgrade & Architecture Reference](docs/deployment-and-upgrade.md)**

---

## Verification & Testing Commands

```bash
npm run check-env       # Verify environment variables & block client secret leaks
npm run lint            # TypeScript strict check (tsc --noEmit)
npm run build           # Production dual-bundle Vite + PWA build & ERP leak check
npm run security-audit  # Secrets scan + dependency vulnerability audit
npm run rehearse        # Fresh-install SQL rehearsal (0001..0023)
npm test                # Run automated test suites
```

---

## License & Governance

- **License**: [Apache License 2.0](LICENSE)
- **Security Policy**: [SECURITY.md](SECURITY.md)
- **Contributing**: [CONTRIBUTING.md](CONTRIBUTING.md)
- **Trademarks**: [TRADEMARKS.md](TRADEMARKS.md)
- **Changelog**: [CHANGELOG.md](CHANGELOG.md)
