# DecorBiz — Backup & Restore Guide

DecorBiz protects your showroom's GST bills, khata ledgers, inventory specs, customer orders, and product images with signed local backups, optional AES-256-GCM passphrase encryption, attachment bundle packaging, and optional Google Drive cloud backups.

---

## 1. What Backups Include (and Exclude)

### Included in `p7-v1` Database Backups
- Business profile, numbering series, and enabled module toggles (excluding `allowed_ips` lockout settings unless explicitly exported)
- Parties, customer addresses, khata ledgers, and payment allocations
- Product lines, categories, brands, unit conversions, items, typed specifications, item variants, and stock lots/ledgers
- Sales bills, quotations, purchase bills, expenses, vouchers, and bank accounts
- Storefront zones, coupons, pages, banners metadata, orders, and reviews

### Explicitly Excluded (Zero-Secret Guarantee)
- Server encryption master keys (`APP_ENCRYPTION_KEY`)
- Supabase credentials (`SUPABASE_SERVICE_ROLE_KEY`)
- Encrypted API keys / OAuth refresh tokens (`ai_provider_profiles`, `integration_settings`, `drive_connections`, `staff_totp`)

---

## 2. Creating a Local Encrypted Backup

1. Sign in to **`/ERP`** as **Owner** (or **Manager** / **Accountant** for exports).
2. Navigate to **Settings → Backup & Storage**.
3. **Recommended**: Enter a strong **Backup Passphrase**. DecorBiz encrypts the JSON snapshot in your browser using **PBKDF2-SHA256 (120,000 iterations) + AES-256-GCM** with a canonical **SHA-256 integrity checksum** before downloading.
4. Click **Download Local Backup (.json)** (`decorbiz-backup-YYYY-MM-DD.json`).
5. If your showroom uses item photos, business logos, or purchase bill PDFs, also click **Download Attachment Bundle (.json)** (`/api/erp/backup/export-bundle`).

---

## 3. Automated Google Drive Cloud Backups (Optional)

1. In **Google Cloud Console**, enable the **Google Drive API** and create an **OAuth Client ID (Web application)** with redirect URI:
   - `https://<your-domain>/api/erp/integrations/google-drive/callback`
2. Open **`/ERP` → Settings → Backup & Storage → Google Drive Cloud Backup**, save your Client ID & Client Secret, and click **Connect Google Drive**.
3. Click **Upload Encrypted Cloud Backup Now** anytime (or before schema upgrades). OAuth tokens are encrypted at rest with `APP_ENCRYPTION_KEY`.

---

## 4. Restoring from Backup (Owner Only)

> **Important**: Restoring replaces workspace business records cleanly inside a PostgreSQL transaction via `restore_workspace_backup()`. Always take a fresh pre-restore snapshot before overwriting live data.

### Step 1: Prepare Target Environment
- Ensure all SQL migrations (`0001` → `0024`) are applied on the target Supabase project (`npm run rehearse && npm run setup`).
- Ensure the `decorbiz-private` private bucket exists.

### Step 2: Restore Structured Data
1. Sign in as **Owner** at `/ERP` → **Settings → Backup & Storage**.
2. Select your `.json` backup file (supported schemas: `p5-v1`, `p6-v1`, and `p7-v1`).
3. If the file is encrypted, enter the exact passphrase used when exporting.
4. DecorBiz verifies the **SHA-256 payload checksum** before applying the restore RPC. Wait for the confirmation toast.

### Step 3: Restore Attachment Files (Optional)
1. Upload your Attachment Bundle `.json` in the **Attachment Bundle Restore** card (`/api/erp/backup/restore-bundle`).
2. The server validates every file path (`sanitizeStorageRelativePath`), bucket (`decorbiz-private`), MIME allowlist (`jpeg`, `png`, `webp`, `pdf`), max size (`6 MB`), and magic-byte header signature before restoring objects into Storage.

---

## 5. Recommended Backup Cadence

- **Daily**: Download a quick encrypted local `.json` snapshot at showroom closing.
- **Weekly**: Export both the database snapshot + Attachment Bundle and store a copy off-site (or upload to Google Drive).
- **Before Every Upgrade**: Always export both snapshots before running new database migrations.
