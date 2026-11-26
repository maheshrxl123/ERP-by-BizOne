# DecorBiz (v1.0.0) — Complete Deployment, Configuration & Upgrade Guide

This guide walks you step-by-step through creating your environment variables, provisioning the Supabase PostgreSQL database, deploying **DecorBiz** to **Vercel via GitHub** (or a VPS / Cloud PaaS / Local PC), setting up advanced modules and optional integrations, and upgrading safely.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Step 1: Create Your Supabase Project & Environment Variables](#2-step-1-create-your-supabase-project--environment-variables)
3. [Step 2: Apply Database Migrations & Storage Bucket](#3-step-2-apply-database-migrations--storage-bucket)
4. [Step 3: Deploy on Vercel via GitHub (Testing & Production)](#4-step-3-deploy-on-vercel-via-github-testing--production)
5. [Step 4: First-Time Workspace Setup](#5-step-4-first-time-workspace-setup)
6. [Step 5: Enabling & Configuring Advanced Modules](#6-step-5-enabling--configuring-advanced-modules)
7. [Step 6: Setting Up Optional Integrations (AI, Google Drive, WhatsApp/SMS, SMTP, E-Invoice)](#7-step-6-setting-up-optional-integrations-ai-google-drive-whatsappsms-smtp-e-invoice)
8. [Alternative Deployment Modes (Cloud Run, Render, VPS, Local Shop PC)](#8-alternative-deployment-modes-cloud-run-render-vps-local-shop-pc)
9. [Backup, Restore & Version Upgrade Guide (`p5-v1` / `p6-v1` → `p7-v1`)](#9-backup-restore--version-upgrade-guide-p5-v1--p6-v1--p7-v1)
10. [Troubleshooting & Pre-Flight Verification](#10-troubleshooting--pre-flight-verification)

---

## 1. Architecture Overview

- **Single-Business Isolation**: One Supabase project and one deployment serve **one business workspace** with 6 fixed roles (`owner`, `manager`, `cashier`, `storekeeper`, `accountant`, `viewer`).
- **Frontend (Dual Vite Bundles)**: React 19 + TypeScript + Tailwind CSS v4 + Vite 8 — public storefront PWA at `dist/` (`/`) and isolated staff ERP console at `dist/ERP/` (`/ERP/`).
- **Backend API (`/api/*`)**: Express server (`server.ts`, also exported via `api/index.ts` for Vercel Serverless Functions) split into `/api/store/*` (customer auth & checkout) and `/api/erp/*` (staff auth + IP allowlist + TOTP enforcement) handling trusted operations that must never run in the browser:
  - First-time workspace & Owner initialization (`/api/erp/setup/*`)
  - Staff user creation, role updates, 2FA reset & deactivation (`/api/erp/admin/users*`, `/api/erp/auth/totp-*`)
  - Private file & image upload validation + signed URLs (`/api/erp/files/*`)
  - AES-256-GCM encrypted integration credentials (`/api/erp/integrations/*`)
  - Google Drive OAuth 2.0 flow & encrypted cloud backups (`/api/erp/integrations/google-drive/*`)
  - Allowlisted DecorBiz AI gateway & Owner proposal approvals (`/api/erp/ai/*`)
  - E-Invoice / E-Way Bill IRN & QR generation (`/api/erp/einvoice/*`)
  - Public revocable invoice share links (`/api/share/bill/:token`)

---

## 2. Step 1: Create Your Supabase Project & Environment Variables

### 2.1 Create a New Supabase Project
1. Sign in to [https://supabase.com/dashboard](https://supabase.com/dashboard) and click **New Project**.
2. Choose your organization, enter a project name (e.g., `decorbiz-erp`), set a strong database password, and select the closest region (e.g., **South Asia (Mumbai)** `ap-south-1`).
3. Wait ~60 seconds for your PostgreSQL database to finish provisioning.

### 2.2 Collect Your Environment Variables

| Variable | Exposure | Required? | How to Get / Generate It |
| :--- | :--- | :---: | :--- |
| `VITE_SUPABASE_URL` | Browser + Server | **Yes** | In Supabase Dashboard → **Project Settings → Data API** → copy **Project URL** (`https://<project_ref>.supabase.co`). |
| `VITE_SUPABASE_ANON_KEY` | Browser + Server | **Yes** | In Supabase Dashboard → **Project Settings → API Keys** → copy the `anon` (`public`) key. Protected by PostgreSQL Row Level Security (RLS). |
| `VITE_APP_NAME` | Browser | Optional | Display name (defaults to `"DecorBiz"`). |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server-Only** | **Yes** | In Supabase Dashboard → **Project Settings → API Keys** → reveal and copy the `service_role` (`secret`) key. **Never** prefix this with `VITE_`. |
| `APP_ENCRYPTION_KEY` | **Server-Only** | **Yes** | 32-byte (64-hex-character) master key used by the server to encrypt AI API keys, Google Drive tokens, SMTP, and WhatsApp credentials with AES-256-GCM. |
| `SUPABASE_PROJECT_REF` | Server / CLI | Optional | Your 20-character project ID from **Project Settings → General → Reference ID** (used by `npm run setup` to auto-apply SQL migrations). |
| `SUPABASE_ACCESS_TOKEN` | Server / CLI | Optional | Personal access token from [https://supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) (used by `npm run setup` to auto-apply SQL migrations via the Supabase Management API). |

### 2.3 How to Generate `APP_ENCRYPTION_KEY`
Run **one** of the following commands in your terminal to generate a cryptographically secure 64-character hex key:

**Using Node.js (works on Windows, macOS, and Linux):**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Using OpenSSL:**
```bash
openssl rand -hex 32
```

Copy the 64-character hex output (for example, `9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08`) and set it as `APP_ENCRYPTION_KEY`.

### 2.4 Create Your Local `.env` File
Copy `.env.example` to `.env` and fill in the values:
```bash
cp .env.example .env
```

```dotenv
VITE_SUPABASE_URL="https://abcdefghijklm.supabase.co"
VITE_SUPABASE_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
VITE_APP_NAME="DecorBiz"

SUPABASE_SERVICE_ROLE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
APP_ENCRYPTION_KEY="64_HEX_CHARACTER_RANDOM_KEY_FROM_ABOVE"

# Optional: only needed if running `npm run setup` automated migration script
SUPABASE_PROJECT_REF="abcdefghijklm"
SUPABASE_ACCESS_TOKEN="sbp_..."
```

Validate your `.env` at any time:
```bash
npm run check-env
```
> `npm run check-env` verifies that required variables are present and immediately blocks the build if a secret (`service_role` or encryption key) is accidentally placed inside a `VITE_*` variable.

---

## 3. Step 2: Apply Database Migrations & Storage Bucket

DecorBiz includes **24 sequential idempotent SQL migrations** (`0001_phase1_foundation.sql` through `0024_decorbiz_step2_modules_and_security.sql`) in `supabase/migrations/`. See **[Supabase & Vercel Deployment Guide](deployment-supabase-vercel.md)** for full details on migrations `0001` → `0024`, dual storefront (`/`) + ERP (`/ERP`) routing, `ALLOWED_ORIGINS`, and Razorpay setup.

Related guides in `/docs`:
- **[Supabase & Vercel Deployment Guide](deployment-supabase-vercel.md)**
- **[Backup & Restore Guide](backup-and-restore.md)**
- **[Business Owner Manual](owner-manual.md)**
- **[Staff Operations Guide](staff-guide.md)**
- **[Owner Break-Glass Recovery](owner-break-glass-recovery.md)**

### Option A: Automated Provisioning (`npm run setup`)
If you added `SUPABASE_PROJECT_REF` and `SUPABASE_ACCESS_TOKEN` to `.env`, run:
```bash
npm run rehearse
npm run setup
```
This script automatically:
- Applies `0001_*.sql` through `0024_*.sql` in order via the Supabase Management API.
- Creates the private storage bucket `decorbiz-private` (with 10 MB upload limit and MIME allowlist).

### Option B: Manual SQL Editor (No Access Token Needed)
1. Open **Supabase Dashboard → SQL Editor → New Query**.
2. Copy and run each file from `supabase/migrations/0001_phase1_foundation.sql` through `supabase/migrations/0024_decorbiz_step2_modules_and_security.sql` in numerical order.
3. Open **Supabase Dashboard → Storage** and create a **Private** bucket named `decorbiz-private` (or let `/api/erp/setup/initialize` create it automatically when you complete the in-app Setup screen at `/ERP`).

---

## 4. Step 3: Deploy on Vercel via GitHub (Testing & Production)

DecorBiz is pre-configured for **one-click GitHub → Vercel deployment** via `vercel.json` and `api/index.ts`.

### How Vercel Routing Works in DecorBiz
- **Dual Static SPA Build**: Vercel runs `npm run build` (`vite build && vite build --config vite.erp.config.ts && node scripts/check-bundle.mjs`) and outputs storefront PWA (`dist/`) and isolated ERP (`dist/ERP/`).
- **Serverless API (`/api/*`)**: `vercel.json` routes all `/api/*` requests to `api/index.ts`, which exports the Express application from `server.ts`.
- **SPA Deep-Link Fallback**: `/ERP` and `/ERP/*` rewrite to `/ERP/erp.html` (with `X-Robots-Tag: noindex, nofollow`), while storefront paths rewrite cleanly to `/index.html`.

### Step-by-Step GitHub to Vercel Deployment
1. **Push Repository to GitHub**:
   ```bash
   git init
   git add .
   git commit -m "chore: DecorBiz v1.0.0 ready for Vercel"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```
2. **Import Project in Vercel**:
   - Go to [https://vercel.com/new](https://vercel.com/new) and select **Import Git Repository**.
   - Select your GitHub repository.
   - Vercel automatically detects **Vite** from `vercel.json` (`Build Command: npm run build`, `Output Directory: dist`).
3. **Configure Environment Variables in Vercel**:
   In the Vercel project setup screen under **Environment Variables**, add the following 4 variables for **Production, Preview, and Development**:
   - `VITE_SUPABASE_URL` = `https://<your-project-ref>.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = `<your-supabase-anon-key>`
   - `SUPABASE_SERVICE_ROLE_KEY` = `<your-supabase-service-role-key>`
   - `APP_ENCRYPTION_KEY` = `<your-64-char-hex-key>`
   - *(Optional)* `VITE_APP_NAME` = `DecorBiz`
4. **Click Deploy**:
   - Vercel builds the frontend bundle and deploys the `/api/*` serverless function.
   - Once deployed, visit `https://<your-vercel-domain>.vercel.app/api/health` — it should return:
     ```json
     { "ok": true, "supabaseConfigured": true, "encryptionConfigured": true }
     ```
5. **Configure Supabase Auth URL for Password Reset & Email Links**:
   - In **Supabase Dashboard → Authentication → URL Configuration**:
     - Set **Site URL** to `https://<your-vercel-domain>.vercel.app`
     - Add `https://<your-vercel-domain>.vercel.app/**` under **Redirect URLs**.

---

## 5. Step 4: First-Time Workspace Setup

### 5.1 Launch Business Workspace (In-App Wizard)
1. Open your deployed URL (`https://<your-vercel-domain>.vercel.app`).
2. When the database has no business record yet, DecorBiz automatically opens the **Set Up Your Business** screen:
   - Enter **Business Name**, **Owner Full Name**, **Owner Email**, and **Owner Password**.
   - DecorBiz uses a single fixed **Tiles, Sanitaryware & Building Materials** workspace configuration (`decorbiz`).
   - Toggle **GST Registered Business** (and enter 15-character GSTIN if registered).
3. Click **Launch Business Workspace** — you are signed in immediately as the **Business Owner**.

---

## 6. Step 5: Enabling & Configuring Advanced Modules

Open **Settings → Modules & Features** (Owner only) to enable or disable optional modules at any time:

| Module Key | Name | Core Capabilities Unlocked |
| :--- | :--- | :--- |
| `pos` | **POS-Lite & Offline Queue** | Fast counter billing grid, barcode scan input, parked/held bills, split Cash+UPI payment, cash register open/close shift variance, and offline queue with `idempotency_key` sync. |
| `accounting` | **Double-Entry Accounting** | Chart of Accounts, Ledger Groups, balanced Vouchers (`Journal`, `Contra`, `Receipt`, `Payment`), Guided Opening Balance Migration, Trial Balance, P&L Statement, Balance Sheet, and Bank Reconciliation. |
| `einvoice` | **Advanced GST, E-Invoice & TDS** | GSTR-1 (B2B, B2C state summary, Credit Notes CSV export), GSTR-3B & HSN summary, GSTR-2B ITC auto-reconciliation, NIC/GSP E-Invoice IRN/QR & E-Way Bill generation, and TDS/TCS registers. |
| `locations` | **Multi-Location / Godowns** | Multiple godowns/branches/shops (`MAIN`, additional godowns), inter-location stock transfers (`transfer_location_stock`), and Physical Stock Count variance reconciliation. |
| `orders` | **Orders & Delivery Challans** | Sales Orders, Purchase Orders, Delivery Challans, and one-click conversion to GST Invoice. |
| `leads` | **CRM Leads & Quotations** | Prospect tracking (`new`, `contacted`, `quoted`, `won`, `lost`) with estimated deal values. |
| `cheques` | **Cheque / PDC Register** | Post-dated cheque tracking (`pending`, `cleared`, `bounced`, `cancelled`) for receivables and payables. |
| `recurring` | **Recurring Templates** | Weekly, monthly, and quarterly recurring invoice & expense rules. |
| `messaging` | **WhatsApp / SMS / Email Logs** | Bilingual (`EN`/`HI`) message templates and delivery audit logs. |
| `ai` | **DecorBiz AI Assistant** | Read-only business Q&A, 6 operational playbooks, and Owner-approved draft action proposals. |

---

## 7. Step 6: Setting Up Optional Integrations (AI, Google Drive, WhatsApp/SMS, SMTP, E-Invoice)

All external integrations are **100% optional** and disabled by default. Credentials are entered inside **Settings → Integrations**, encrypted on the server using `APP_ENCRYPTION_KEY` (AES-256-GCM), and **never** exposed to browser code or plain JSON backups.

### 7.1 DecorBiz AI Assistant (`Settings → Integrations → AI Provider`)
1. Enable the **DecorBiz AI** module in **Settings → Modules & Features**.
2. Go to **Settings → Integrations → AI Provider Configuration**.
3. Select your preferred provider and model:
   - **Google Gemini**: e.g., `gemini-4-hydrogen` (paste your Gemini API Key)
   - **OpenAI**: e.g., `gpt-4o-mini` or `gpt-4o`
   - **Anthropic Claude**: e.g., `claude-3-5-sonnet-latest`
   - **OpenRouter**: e.g., `openai/gpt-4o-mini`
   - **xAI Grok**: e.g., `grok-2-latest`
   - **Custom OpenAI-Compatible HTTPS Endpoint**: provide Base URL (`https://...`) + API Key + Model ID
4. Click **Save & Encrypt Key**, then click **Test Connection**.
5. Open **DecorBiz AI** from the sidebar to run natural-language queries, execute **Playbooks** (Collections Follow-up, Low-Stock Reorder, Near-Expiry Clearance, Monthly GST Pre-Check, Expense Spike Review, Slow/Dead Stock), or generate **Draft Action Proposals** that require explicit Owner approval.

### 7.2 Google Drive Cloud Backup (`Settings → Backup & Storage`)
1. Open [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials).
2. Enable the **Google Drive API** in your Google Cloud project.
3. Click **Create Credentials → OAuth client ID** → select **Web application**.
4. Under **Authorized redirect URIs**, add your deployment callback URL:
   - For Vercel: `https://<your-vercel-domain>.vercel.app/api/erp/integrations/google-drive/callback`
   - For Local Dev: `http://localhost:3000/api/erp/integrations/google-drive/callback`
5. Copy the **Client ID** and **Client Secret**, open **DecorBiz → Settings → Backup & Storage → Google Drive Cloud Backup**, and save them.
6. Click **Connect Google Drive** to complete the OAuth consent flow. You can now trigger **Upload Encrypted Cloud Backup Now** or restore directly from your Drive backup history.

### 7.3 NIC / GSP E-Invoice & E-Way Bill (`Settings → Integrations`)
1. Enable **Advanced GST & E-Invoice** in **Settings → Modules & Features**.
2. In **Settings → Integrations → E-Invoice GSP**, choose **Sandbox** (for testing) or **Production** (with your GSP Base URL, Client ID, Client Secret, and Username/Password).
3. In **GST & E-Invoice → E-Invoice & E-Way Bill**, select any issued Tax Invoice to generate a 64-character IRN, Ack No, and signed QR payload.

### 7.4 WhatsApp / SMS & SMTP Email Relay (`Settings → Integrations`)
- **WhatsApp / SMS Gateway**: Configure your webhook endpoint (`https://...`), API token, and sender ID to dispatch payment reminders and invoice notifications from **Messaging**. (Direct WhatsApp `wa.me` share links and copyable reminders always work even without a gateway API!)
- **SMTP Relay**: Configure your SMTP Host, Port (`587`/`465`), Username, Password, and From Email to send email statements and invoices.

---

## 8. Alternative Deployment Modes (Cloud Run, Render, VPS, Local Shop PC)

### Mode A: Render / Railway / Fly.io / Google Cloud Run
1. Build command: `npm ci && npm run build`
2. Start command: `npm start` (runs `node server.ts` serving both `dist/` and `/api/*` on `PORT=3000`)
3. Set `NODE_ENV=production` and configure the 4 required environment variables (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_ENCRYPTION_KEY`).

### Mode B: Single Ubuntu VPS (PM2 + Nginx / Caddy HTTPS)
```bash
git clone https://github.com/<your-org>/decorbiz.git
cd decorbiz
npm ci
cp .env.example .env
# Edit .env with your production keys
npm run check-env
npm run build
NODE_ENV=production pm2 start "node server.ts" --name decorbiz
```
Configure Caddy or Nginx to reverse-proxy `https://erp.yourdomain.com` to `http://127.0.0.1:3000`.

### Mode C: Local Shop Counter PC (LAN + Offline Queue)
1. Install Node.js 22+ on the shop PC and run `npm ci && npm run build && npm start`.
2. Open `http://localhost:3000` (or `http://<shop-pc-lan-ip>:3000` on phones/tablets on the shop Wi-Fi).
3. Enable **POS-Lite** so counter bills queue locally in `localStorage` if internet drops and sync idempotently when connectivity returns.

---

## 9. Backup, Restore & Version Upgrade Guide (`p5-v1` / `p6-v1` → `p7-v1`)

1. **Before Any Upgrade**:
   - Log in as **Owner** → **Settings → Backup & Storage**.
   - Click **Download Local Backup (.json)**. Optionally enter a passphrase to encrypt the backup with **PBKDF2-SHA256 (120,000 iterations) + AES-256-GCM**.
2. **Apply New SQL Migrations**:
   - Run any new migration files in `supabase/migrations/` sequentially (`0001` → `0024`). All migrations use `IF NOT EXISTS` and `CREATE OR REPLACE` for safe, non-destructive upgrades.
3. **Backward-Compatible Restore**:
   - DecorBiz `v1.0.0` exports schema version `p7-v1` (signed with a SHA-256 checksum over the canonical data payload).
   - Both `verifyBackupEnvelope()` and the PostgreSQL `restore_workspace_backup()` RPC accept `p5-v1`, `p6-v1`, and `p7-v1` backups and verify the SHA-256 checksum before restoring.

---

## 10. Troubleshooting & Pre-Flight Verification

Run the built-in verification suite before deploying:
```bash
npm run check-env   # Verifies required env vars & ensures zero secret leaks in VITE_*
npm run lint        # Runs TypeScript strict type-checking (tsc --noEmit)
npm run build       # Builds production Vite bundle + PWA service worker into dist/
npm test            # Runs unit, pack, security, CSV, tax engine & contract test suites
```

- **`/api/health` returns `"supabaseConfigured": false`**: Verify `VITE_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set in your hosting provider's Environment Variables and redeploy.
- **`/api/health` returns `"encryptionConfigured": false`**: Ensure `APP_ENCRYPTION_KEY` is at least 32 characters (64 hex chars recommended from `openssl rand -hex 32`).
- **Google Drive OAuth Redirect Error (`redirect_uri_mismatch`)**: Ensure the exact callback URL `https://<your-domain>/api/erp/integrations/google-drive/callback` is listed under Authorized Redirect URIs in Google Cloud Console.
