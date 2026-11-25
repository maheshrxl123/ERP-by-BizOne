# DecorBiz — Supabase & Vercel Deployment Guide

This guide covers deploying **DecorBiz** (public retail storefront at `/` and private ERP console at `/ERP`) from a clean Supabase project and GitHub/Vercel repository.

---

## 1. Prerequisites

- Node.js **22+** (or Bun **1.2+** / `npm`)
- A **Supabase** account ([supabase.com](https://supabase.com))
- A **Vercel** account ([vercel.com](https://vercel.com)) connected to GitHub

---

## 2. Create the Supabase Project

1. Sign in to **Supabase Dashboard** → **New Project**.
2. Choose a region near your showroom (e.g., `ap-south-1` Mumbai), enter a strong database password, and wait ~60 seconds for provisioning.
3. Open **Project Settings → API** and collect:
   - `VITE_SUPABASE_URL` — Project URL (`https://<project_ref>.supabase.co`)
   - `VITE_SUPABASE_ANON_KEY` — Public `anon` key
   - `SUPABASE_SERVICE_ROLE_KEY` — Private `service_role` key (**never prefix with `VITE_`**)
4. Open **Project Settings → General** and copy the **Reference ID** (`SUPABASE_PROJECT_REF`).
5. *(Optional for CLI migration push)* Generate a Personal Access Token at `https://supabase.com/dashboard/account/tokens` (`SUPABASE_ACCESS_TOKEN`).

---

## 3. Environment Variables

Generate a 64-character hex master key for `APP_ENCRYPTION_KEY`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Create `.env` from `.env.example` and configure:

| Variable | Scope | Required | Purpose |
| :--- | :--- | :---: | :--- |
| `VITE_SUPABASE_URL` | Client + Server | Yes | Supabase project endpoint |
| `VITE_SUPABASE_ANON_KEY` | Client + Server | Yes | Public anon key enforced by PostgreSQL RLS |
| `VITE_APP_NAME` | Client | Optional | Display name (`DecorBiz`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Server Only | Yes | Server-side admin operations (`/api/*`) |
| `APP_ENCRYPTION_KEY` | Server Only | Yes | 64-hex AES-256-GCM key for stored integration secrets |
| `SUPABASE_STORAGE_BUCKET` | Server Only | Optional | Defaults to `decorbiz-private` |
| `ALLOWED_ORIGINS` | Server Only | Production | Comma-separated origin allowlist (e.g., `https://shop.yourdomain.com,https://www.yourdomain.com`) |
| `SUPABASE_PROJECT_REF` | CLI Only | For `setup` | 20-char Supabase project ID |
| `SUPABASE_ACCESS_TOKEN` | CLI Only | For `setup` | Supabase Management API token |
| `DECORBIZ_BREAKGLASS_TOKEN` | Server Only | Recommended | Secret header token (`x-break-glass-token`) to bypass IP allowlist during lockout |
| `DECORBIZ_BREAKGLASS_IP` | Server Only | Optional | Emergency static IP allowed when `allowed_ips` locks out the owner |
| `BYPASS_IP_ALLOWLIST` | Server Only | Emergency | Set `"true"` temporarily on Vercel/VPS, remove immediately after recovery |

### Getting `ALLOWED_ORIGINS` Step by Step

1. Deploy once on Vercel (or check your assigned custom domain).
2. Copy the exact origin **without trailing slash** (`https://my-decorbiz-app.vercel.app`).
3. If you also connect a custom domain (e.g., `https://sharma-tiles.in` and `https://www.sharma-tiles.in`), join them with commas and zero spaces:
   ```text
   ALLOWED_ORIGINS=https://sharma-tiles.in,https://www.sharma-tiles.in,https://my-decorbiz-app.vercel.app
   ```
4. Never end an origin with `/`.

---

## 4. Database Migrations & Storage Bucket (`0001` → `0024`)

DecorBiz ships **24 sequential, idempotent migrations** (`supabase/migrations/0001_phase1_foundation.sql` through `0024_decorbiz_step2_modules_and_security.sql`), covering core workspace foundation, parties & khata, items & multi-unit stock, GST billing, purchases & reports, 5 locked DecorBiz product lines with typed specs, variants/shade/batch lots, ERP security (`allowed_ips` + `staff_totp`), online storefront tables + reservation RPCs, and all 7 Step 2 optional showroom modules.

### Option A — Automated Provisioning (`npm run setup`)
```bash
npm run check-env
npm run rehearse
npm run setup
```
This validates environment variables, runs the fresh-install rehearsal, pushes all 24 migrations sequentially via Supabase Management API, reloads PostgREST schema cache, and creates the private `decorbiz-private` storage bucket (`10 MB` limit; JPEG, PNG, WebP, PDF only).

### Option B — Manual SQL Editor
1. Open **Supabase Dashboard → SQL Editor → New Query**.
2. Execute `0001_phase1_foundation.sql` through `0024_decorbiz_step2_modules_and_security.sql` strictly in order (`0001`, `0002`, ..., `0024`).
3. Under **Storage → Buckets**, create a **Private** bucket named `decorbiz-private` (or run `/api/erp/setup/initialize` on first launch, which creates it idempotently).

---

## 5. Deploy on Vercel

1. Push your repository to GitHub.
2. In Vercel → **Add New Project**, import the GitHub repo. Vercel reads `vercel.json`:
   - **Build Command**: `npm run build` (`vite build && vite build --config vite.erp.config.ts && node scripts/check-bundle.mjs`)
   - **Output Directory**: `dist` (Storefront SPA at `dist/index.html` and isolated ERP SPA at `dist/ERP/erp.html` with `/ERP/` base path)
   - **API Rewrite**: `/api/(.*)` → `/api/index.ts` (`/api/erp/*` for staff ERP, `/api/store/*` for storefront)
   - **Storefront Rewrite**: `/` and storefront paths → `/index.html`
   - **ERP Rewrite & Headers**: `/ERP` and `/ERP/*` → `/ERP/erp.html` with `X-Robots-Tag: noindex, nofollow`
3. Add **Environment Variables** in Vercel (`Production`, `Preview`, `Development`):
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `APP_ENCRYPTION_KEY`
   - `ALLOWED_ORIGINS`
   - `DECORBIZ_BREAKGLASS_TOKEN`
4. Click **Deploy**.

---

## 6. Post-Deployment Configuration Checklist

1. **Supabase Auth Redirect URLs**:
   - In **Supabase Dashboard → Authentication → URL Configuration**:
     - Set **Site URL** to `https://<your-domain>`
     - Add `https://<your-domain>/**` and `https://<your-domain>/ERP/**` to **Redirect URLs**.
2. **Verify API Health & Bundle Isolation**:
   - Visit `https://<your-domain>/api/health` → confirm `{"ok": true, "supabaseConfigured": true, "encryptionConfigured": true}`.
   - Visit `https://<your-domain>/robots.txt` → confirm `Disallow: /ERP` and `Disallow: /api/erp/`.
   - Visit `https://<your-domain>/` (Customer Storefront) and `https://<your-domain>/ERP` (Staff ERP Setup/Login).
3. **Complete First-Time Workspace Setup at `/ERP`**:
   - Enter Business Name, Owner Name, Email, Password, and GSTIN (if registered).
4. **Configure Integrations (Optional)**:
   - Open **`/ERP` → Settings → Integrations** to add Razorpay (`Key ID` + `Key Secret`) and toggle **Online Payment**, SMTP Email, WhatsApp gateway, or AI Assistant.
5. **Run Pre-Release Verification Locally**:
   ```bash
   npm run lint
   npm run build
   npm run security-audit
   npm run rehearse
   npm test
   ```
