# DecorBiz ERP & Storefront — Swarm Audit Report

## 1. Root Cause of `/erp` Showing Storefront

- **Root Cause**: **Letter case** in `vercel.json` (`rewrites` and `headers`).
  - `vercel.json` only matched uppercase `/ERP` and `/ERP/(.*)`, so requests to `/erp`, `/erp/*`, or `/Erp` fell through to the storefront SPA catch-all (`/(.*)` -> `/index.html`) and returned the storefront bundle instead of the ERP.
  - Additionally, `vite.config.ts` had a case-sensitive `navigateFallbackDenylist: [/^\/api\//, /^\/ERP/]` in the storefront PWA service worker, and `server.ts` did not canonically redirect `/erp` / `/Erp` to `/ERP`.
- **Fix Applied (Phase A)**:
  - `vercel.json`: Added permanent `redirects` (`/(?!ERP$)[Ee][Rr][Pp]` -> `/ERP`, `/(?!ERP/)[Ee][Rr][Pp]/(.*)` -> `/ERP/$1`) before `rewrites`, and routed `/ERP` + non-asset `/ERP/*` through `/api/index.ts` (Phase C `SEC-01`) with `X-Robots-Tag: noindex, nofollow`.
  - `server.ts`: Added Express 308 canonical redirect middleware for non-`/ERP` case variants (`/erp`, `/Erp`, etc.) -> `/ERP` / `/ERP/*` with `X-Robots-Tag: noindex, nofollow`.
  - `vite.config.ts`: Updated `navigateFallbackDenylist` to `[/^\/api\//, /^\/erp(?:\/|\.html|$)/i]`.
  - `src/server/routes/storefront.ts`: Added `GET /api/store/health` (`200`) separate from `/api/erp/health`.
  - `tests/step5-final-verification.test.mjs`: Added assertions for `/erp` & `/Erp/login?next=1` 308 redirects, `noindex`, `/api/store/health`, `vercel.json`, and `vite.config.ts`.

---

## 2. Findings Summary Table

| ID | Severity | Status | Summary | Files Changed |
|---|---|---|---|---|
| **RT-01** | Critical | **PASS** | Case-sensitive `vercel.json` rewrites served Storefront on `/erp` | `vercel.json`, `server.ts`, `tests/step5-final-verification.test.mjs` |
| **RT-02** | Medium | **PASS** | `X-Robots-Tag: noindex, nofollow` missed `/erp` case variants | `vercel.json`, `server.ts` |
| **RT-03** | Medium | **PASS** | `vite.config.ts` SW `navigateFallbackDenylist` was case-sensitive | `vite.config.ts` |
| **RT-04** | Low | **PASS** | `/api/store/health` returned 404 | `src/server/routes/storefront.ts`, `tests/step5-final-verification.test.mjs` |
| **RT-05** | Low | **OPEN** | `npm install` fails without `--legacy-peer-deps` (`esbuild@^0.25.0` vs `vite@8.4.0`) | `package.json` (not modified) |
| **SEC-01** | High | **PASS** (code/config; live Vercel **NOT TESTED**) | Vercel `/ERP` static rewrite bypassed `requireIpAllowlist` | `vercel.json`, `server.ts` |
| **SEC-02** | High | **PASS** | Unconditional `x-forwarded-for` trust allowed IP allowlist / rate-limit spoofing | `server.ts`, `src/server/rateLimit.ts`, `tests/step3-erp-security.test.mjs` |
| **SEC-03** | Medium | **OPEN** | Custom 2FA not enforced at Supabase PostgREST/RLS (`aal2`) layer | Architectural (`src/modules/auth/AuthScreens.tsx`, RLS) |
| **SEC-04** | Low | **PASS** (fail-closed secret; staff login rate limit **OPEN**) | `totpSecurity.ts` used ephemeral fallback secret in prod; staff login hits Supabase directly | `src/server/totpSecurity.ts`, `tests/step3-erp-security.test.mjs` |
| **SEC-05** | Medium | **Partial** (Secrets **PASS**; `npm audit` **NOT TESTED**) | `security-audit.mjs` failed on Windows path; `npm audit` blocked by `ENOLOCK` (no `package-lock.json` / `bun`) | `scripts/security-audit.mjs` |
| **FN-01** | Medium | **PASS** (SQL/setup verified; live DB **NOT TESTED**) | `seed_demo_data()` only seeded 2 items without all 5 product lines / `item_specs_*` | `supabase/migrations/0027_seed_all_product_lines.sql`, `scripts/setup.mjs` |
| **FN-02** | High | **OPEN (Env)** | `.env` `VITE_SUPABASE_URL` (`demo-project-ref`) mismatches `SUPABASE_SERVICE_ROLE_KEY`, failing `check-env.mjs` & E2E tests | `.env` (user-owned, not modified) |
| **FN-03** | Low | **PASS** | Stale test assertions failed after valid security/routing fixes | `tests/step1-server-security.test.mjs`, `tests/step3-erp-security.test.mjs`, `tests/p7-ai-advanced-v1.test.mjs` |
| **FN-04** | Low | **PASS** | `sqm_per_box` did not reverse-calculate `sqft_per_box` | `src/modules/items/ProductSpecFields.tsx` |
| **COM-01** | High | **PASS** | Cart `+/-` kept `mode: 'sqft'` with box count, shrinking checkout qty | `src/StorefrontApp.tsx` |
| **COM-02** | Medium | **PASS** | `/api/store/config` returned expired/exhausted coupons | `src/server/routes/storefront.ts`, `tests/step4-ecommerce-storefront.test.mjs` |
| **COM-03** | Medium | **PASS** | Checkout `paymentMethod` stayed `'cod'` when COD disabled on delivery | `src/modules/storefront/StoreCheckoutDrawer.tsx` |
| **COM-04** | Low | **PASS** | `verify-razorpay` coupon increment lacked atomic `usage_limit` guard | `src/server/routes/storefront.ts` |
| **COM-05** | Low | **PASS** | Wishlist toggle did not revert optimistic state or prompt login on 401/403 | `src/StorefrontApp.tsx` |
| **SET-01** | Medium | **PASS** | `/api/store/catalogue` returned 200 and `/api/store/files/:id` lacked `online_store` gate when off | `src/server/routes/storefront.ts`, `tests/step1-modules.test.mjs` |
| **SET-02** | Low | **PASS** | `store-admin/overview` queried `online_payments` without module gate | `src/server/routes/storeAdmin.ts` |
| **SET-03** | Low | **OPEN (Intentional)** | `Operations` nav stays visible when `locations` is off because other tabs share hub | `src/app/AppShell.tsx` (unchanged) |
| **UI-01** | High | **PASS** | `ImportExportPanel` used `text-white` on `--primary` (low contrast) | `src/modules/data/ImportExportPanel.tsx` |
| **UI-02** | High | **PASS** | Storefront lacked `loadError` / Retry UI and leaked ERP copy in empty state | `src/StorefrontApp.tsx` |
| **UI-03** | High | **PASS** | 7 ERP screens + auth/guard views lacked Hindi (`t()`) translations | `src/i18n/en.json`, `src/i18n/hi.json`, `src/App.tsx`, `AuthScreens.tsx`, `PosLiteScreen.tsx`, `AdvancedGstScreen.tsx`, `OperationsScreen.tsx`, `OnlineStoreAdminScreen.tsx`, `ProductSpecFields.tsx`, `PublicBillShareView.tsx` |
| **UI-04** | Medium | **PASS** | Picking/Delivery modal hardcoded `bg-white text-slate-900` in dark mode | `src/modules/store/OnlineStoreAdminScreen.tsx` |
| **UI-05** | Medium | **PASS** | Storefront mobile header had no nav/search drawer `< 640px` | `src/StorefrontApp.tsx` |
| **UI-06** | Medium | **PASS** | `/catalogue` view had no `<h1>` heading | `src/StorefrontApp.tsx` |
| **UI-07** | Medium | **PASS** | Checkout delivery `pincode`/`area`/`address` lacked inline validation | `src/modules/storefront/StoreCheckoutDrawer.tsx` |
| **UI-08** | Low | **PASS** | `focus:outline-none` without `focus-visible:ring` in search/bill/purchase | `src/components/GlobalSearchModal.tsx`, `NewBillScreen.tsx`, `NewPurchaseScreen.tsx` |
| **UI-09** | Low | **PASS** | Footer phone/email were plain `<span>` instead of `tel:`/`mailto:` links | `src/StorefrontApp.tsx` |
| **DEV-01** | Critical | **PASS** | ERP `/ERP/` lacked PWA manifest & offline SW support | `vite.erp.config.ts`, `erp.html` |
| **DEV-02** | High | **PASS** | Storefront mobile/tablet touch targets `< 44px` | `src/StorefrontApp.tsx` |
| **DEV-03** | Medium | **PASS** | Floating AI button overlapped storefront category cards on mobile | `src/modules/storefront/StoreAiAssistant.tsx`, `src/StorefrontApp.tsx` |
| **DEV-04** | Medium | **PASS** | ERP auth screen header buttons `< 44px` | `src/modules/auth/AuthScreens.tsx` |
| **DEV-05** | High | **PASS** | `NewBillScreen` 8-column line-item table unusable on mobile | `src/modules/bills/NewBillScreen.tsx` |
| **DEV-06** | High | **PASS** | `PosLiteScreen` cart/shift/sync controls `< 44px` on mobile | `src/modules/pos/PosLiteScreen.tsx` |
| **DEV-07** | Low | **PASS** | Minor `< 44px` close buttons & `10px` metadata text in `AppShell`/`NewBillScreen` | `src/app/AppShell.tsx`, `src/modules/bills/NewBillScreen.tsx` |
| **A11Y-01** | High | **PASS** | Low-contrast warning text, `--text-muted`, and `text-stone-400` | `config/theme.tokens.css`, `HomeScreen.tsx`, `StoreProductDetail.tsx` |
| **A11Y-02** | High | **PASS** | Missing `<label htmlFor>` / `aria-label` on storefront & billing inputs/selects | `src/StorefrontApp.tsx`, `StoreProductDetail.tsx`, `NewBillScreen.tsx` |
| **A11Y-03** | High | **PASS** | Missing `aria-label` on star-rating and bottom-sheet close buttons | `src/modules/storefront/StoreProductDetail.tsx`, `src/app/AppShell.tsx` |
| **A11Y-04** | Medium | **PASS** | Modals/drawers lacked focus trap & focus restoration | `src/app/AppShell.tsx`, `StoreAuthModal.tsx`, `StoreCheckoutDrawer.tsx` |
| **A11Y-05** | Medium | **PASS** | ERP `document.title` did not update on screen navigation | `src/app/AppShell.tsx` |
| **A11Y-06** | Low | **PASS** | Active nav items lacked `aria-current="page"` | `src/app/AppShell.tsx`, `src/StorefrontApp.tsx` |
| **PERF-01** | Critical | **PASS** | ERP initial JS bundle was 2.12 MB (reduced to ~622.7 KB via `React.lazy`) | `src/app/AppShell.tsx` |
| **PERF-02** | High | **PASS** | Unused `public/assets/aistudio/` (2.17 MB) was copied to both `dist/` & `dist/ERP/` | Moved to `docs/aistudio/` |
| **PERF-03** | High | **FAIL (OPEN)** | 4 storefront showcase JPEGs total 2.84 MB unoptimized | `src/modules/storefront/storeTypes.ts` / assets (not compressed) |
| **PERF-04** | High | **PASS** | `<img>` tags lacked `width`/`height` and `loading="lazy"` | `StorefrontApp.tsx`, `StoreProductDetail.tsx`, `StoreAccountViews.tsx`, `StoreAiAssistant.tsx`, `StoreCheckoutDrawer.tsx`, `AppShell.tsx` |
| **PERF-05** | Medium | **PASS** | No gzip compression, sequential AI check, no `Cache-Control`/`ETag` or catalogue pagination | `server.ts`, `src/server/routes/storefront.ts` |
| **CQ-01** | High | **PASS** | 31+ `async` Express routes/middleware lacked `try/catch` / `asyncHandler` + `unhandledRejection` | `server.ts`, `middleware.ts`, `storefront.ts`, `storeAdmin.ts`, `googleDrive.ts` |
| **CQ-02** | High | **FAIL (Deferred)** | `src/core/taxEngine.ts` unused in `src/` (only tested in `tests/`) | `src/core/taxEngine.ts` (kept for test compatibility) |
| **CQ-03** | Medium | **PASS** | Dead pack/calculator exports in `src/packs/registry.ts` | `src/packs/registry.ts`, `tests/p6-packs-import-backup-drive.test.mjs` |
| **CQ-04** | Medium | **PASS** | Leftover BizOne / removed-trade references in docs | `README.md`, `docs/deployment-and-upgrade.md` |
| **CQ-05** | Medium | **FAIL (Deferred)** | `cost_centres` table created in `0013` migration is unused in `src/` | `supabase/migrations/0013_phase7_ai_advanced_v1.sql` |
| **CQ-06** | Medium | **PASS** | Silent `.catch(() => undefined)` handlers swallowed errors | `StorefrontApp.tsx`, `ItemFormModal.tsx`, `FileUpload.tsx`, `ImageUpload.tsx` |
| **CQ-07** | Low | **PASS** | Leftover `'prescription'` purpose in `FileUpload.tsx` | `src/components/upload/FileUpload.tsx` |
| **CQ-08** | Low | **OPEN** | `npm run lint` only runs `tsc --noEmit` (no ESLint configured) | `package.json` |
| **CQ-09** | Low | **OPEN (Deferred)** | 21 `src/` files exceed 800 lines (e.g. `SettingsScreen.tsx` at 3,790L) | `src/modules/settings/SettingsScreen.tsx`, etc. |

---

## 3. NOT TESTED Items (with Reasons)

1. **Live Vercel deployment (`https://erpbybizone.vercel.app`) post-fix**: Local changes have not been pushed/deployed to Vercel (per instruction: do not push to GitHub).
2. **Live E2E DB & Server Flows (7 failing tests in `npm test`, `FN-02`)**: `.env` has a placeholder `VITE_SUPABASE_URL` (`demo-project-ref`) that mismatches `SUPABASE_SERVICE_ROLE_KEY`, and no live server is running on port 3000. Blocked: `p1-e2e`, `p3-items-inventory`, `p4-billing-sales`, `p5-purchases-expenses-reports`, `p6-packs-import-backup-drive` live tests, `seed_demo_data()` SQL execution (`0027`), and `check-env.mjs`.
3. **Live Customer Auth / Email Verification / Cross-Customer RLS Isolation**: Could not create two live customer accounts or test real SMTP email verification against the mismatched/placeholder Supabase env.
4. **Live Razorpay Test-Mode Remote API & Real Payments**: `online_payments` has no test keys configured and real Razorpay payments cannot be executed in automated audit. (HMAC-SHA256 forged-signature rejection and disabled-toggle gating were unit-tested and passed.)
5. **Live External Integration Round-Trips**: `POST /api/integrations/:key/test` against Google Drive, Razorpay, SMTP, GSP, and WhatsApp were not executed to avoid mutating `integration_settings` or calling external APIs.
6. **Authenticated ERP Live Browser Viewport Rendering**: ERP login/theme/language were tested live in Playwright, but authenticated ERP screens (`NewBillScreen`, `PosLiteScreen`, `HomeScreen`, `SettingsScreen`) were audited via static TSX/CSS inspection because no live ERP session was available.
7. **Lighthouse CLI Audit**: `lighthouse` CLI is not installed in the workspace; replaced with `dist/` bundle analysis, asset audit, and live local server timing.
8. **Dependency Vulnerability Audit (`npm audit` / `bun audit`, `SEC-05`)**: `npm audit` fails with `ENOLOCK` (no `package-lock.json`) and `bun` CLI is not installed in this environment.
9. **IP Allowlist from External Non-Listed IPs on Vercel**: Cannot originate requests from external public IPs outside this machine against a deployed Vercel edge.

---

## 4. Commands You Must Run Yourself

1. **Fix `.env` and verify environment**:
   - Update `VITE_SUPABASE_URL` in `.env` to match your real Supabase project ref.
   - Run: `node scripts/check-env.mjs`
2. **Apply the new migration (`0027_seed_all_product_lines.sql`) to Supabase**:
   - Run via Supabase CLI or SQL Editor: `supabase db push` (or execute `supabase/migrations/0027_seed_all_product_lines.sql`).
3. **Run dependency vulnerability audit & generate lockfile (optional if using npm)**:
   - With Bun: `bun audit`
   - Or with npm: `npm install --package-lock-only --legacy-peer-deps && npm audit`
4. **Build, verify, and run full tests locally (with local server running for E2E)**:
   ```powershell
   npm run lint
   npm run build
   npm run security-audit
   npm run rehearse
   # In terminal 1:
   npm run start
   # In terminal 2:
   npm test
   ```
5. **Deploy to Vercel** (when ready after reviewing `git diff`):
   ```powershell
   git status
   git diff
   # Commit and push / deploy via Vercel CLI
   ```

---

## 5. Remaining Risks

1. **PERF-03 (High)**: The 4 storefront showcase JPEGs (`2.84 MB` total) remain uncompressed; mobile users on slow connections will experience slow LCP until converted to WebP/AVIF (<120 KB each).
2. **SEC-03 (Medium)**: Staff 2FA is enforced on Express `/api/erp/*` and in the React UI, but not in Supabase RLS (`aal2`). A stolen staff password JWT could query Supabase PostgREST/RPCs directly without TOTP until migrated to Supabase MFA (`aal2`).
3. **SEC-04 (Low)**: ERP staff password login (`supabase.auth.signInWithPassword`) goes directly to Supabase Auth without an Express rate limiter (relies on Supabase Auth's built-in rate limits).
4. **SEC-05 (Medium)**: Dependency vulnerabilities have not been audited here because `bun` is not installed and `package-lock.json` is absent.
5. **CQ-02 / CQ-05 / CQ-09**: `src/core/taxEngine.ts` and `cost_centres` remain unused in `src/`, and 21 large `src/` files (>800 lines) remain unsplit.
