# Security Summary

This audit reviewed backend Express route handlers, authentication and allowlist middleware, Supabase SQL migrations, build/bundle isolation scripts, and the DecorBiz ERP and Storefront clients. Confirmed bugs and security gaps were fixed at the root and verified with regression tests, type checking, linting, production dual-bundle builds, and automated secrets/dependency scanning.

## Confirmed Findings & Root Fixes

1. **OAuth Callback Script/HTML Escaping & Drive Backup Attachment Validation (`src/server/routes/googleDrive.ts`)**
   - **Root cause:** `sendPopupCloseHtml` only escaped `<` inside the `<p>` element and interpolated raw `JSON.stringify(message)` inside an inline `<script>` tag where `</script>` or Unicode line separators could break out of script context. Additionally, `/api/integrations/google-drive/restore` uploaded backup attachment buffers directly without sanitizing relative storage paths, enforcing `STORAGE_BUCKET`, restricting allowed MIME types, enforcing size bounds, or verifying file magic bytes (unlike `src/server/routes/backup.ts`).
   - **Fix:** Added full HTML entity escaping (`&`, `<`, `>`, `"`, `'`), escaped script-breaking characters (`<`, `>`, `&`, `\u2028`, `\u2029`) in serialized JSON payloads, pointed non-popup fallback redirects to `/ERP/`, and enforced `sanitizeStorageRelativePath`, `bucket === STORAGE_BUCKET`, MIME allowlist (`image/jpeg`, `image/png`, `image/webp`, `application/pdf`), `12 B–6 MB` bounds, and `verifyMagicBytes` on restored Drive attachments.

2. **Fail-Open IP Allowlist Error Paths (`src/server/ipAllowlist.ts`, `src/server/config.ts`, `src/modules/settings/SettingsScreen.tsx`)**
   - **Root cause:** `requireIpAllowlist` ignored database query errors (`{ data: biz }`) and called `next()` in `catch`, failing open if the `business` table query errored. Separately, `STORAGE_BUCKET` in `src/server/config.ts` ignored `process.env.SUPABASE_STORAGE_BUCKET`, and Settings > Security copy referenced an unsupported `?bg_token=` query parameter instead of header-only authentication.
   - **Fix:** `requireIpAllowlist` now fails closed with HTTP `503` when the `business.allowed_ips` query returns an error or throws (while loopback and break-glass recovery env/header checks continue to short-circuit beforehand). `STORAGE_BUCKET` now honors validated `SUPABASE_STORAGE_BUCKET` values, and Settings > Security documentation accurately specifies header-only `X-Break-Glass-Token` delivery.

3. **TOTP Middleware Path Normalization & Fail-Closed Client Verification (`src/server/middleware.ts`, `src/core/erpFetch.ts`, `src/app/AppProvider.tsx`, `src/App.tsx`)**
   - **Root cause:** `requireActiveStaff` matched TOTP challenge endpoints without trimming trailing slashes and ignored `staff_totp` lookup errors. On the client, `AppProvider.refreshTotpStatus()` cleared TOTP enforcement (`setTotpRequired(false); setTotpVerified(true);`) whenever `/api/erp/auth/totp-status` returned non-OK or threw, and HTTP `403` IP-block responses lacked a dedicated lockout screen.
   - **Fix:** Normalized trailing slashes on `reqPath`, returned HTTP `503` if `staff_totp` lookup fails, emitted `onIpBlocked` events from `erpFetch` on allowlist `403` responses, updated `AppProvider` to fail closed (`totpCheckError` / `ipBlockedError`) on non-OK or network errors, and added dedicated IP-blocked and security-check retry views in `src/App.tsx`.

4. **Storefront Checkout Coupon Timing, Post-Payment Stock Conflict Handling & Banner Routing (`src/server/routes/storefront.ts`, `src/core/storeCatalog.ts`, `src/StorefrontApp.tsx`)**
   - **Root cause:** Online orders using Razorpay incremented `store_coupons.used_count` at checkout creation before payment succeeded, `verify-razorpay` lacked idempotency and an audit/support trail if stock changed between payment and confirmation, and the hero banner CTA hardcoded `/catalogue` while ignoring `primaryBanner.cta_link` and `/catalogue?line=` filters.
   - **Fix:** Deferred Razorpay coupon usage increment until signature verification succeeds, added verify idempotency and `store.payment_stock_conflict` audit logging with HTTP `409` customer guidance on post-payment stock conflicts, added `resolveSafeStorePath()` to safely block external/protocol/ERP targets, and wired banner CTA links and query-parameter category filters in `StorefrontApp.tsx`.

5. **UI Heading Consistency, Built-In Store Integration Test & SQL Grants (`src/components/RequireGuards.tsx`, `src/App.tsx`, `src/server/routes/integrations.ts`, `supabase/migrations/0024_decorbiz_step2_modules_and_security.sql`)**
   - **Root cause:** `RequireModule`, `RequireRole`, and status headings in `App.tsx` lacked leading inline SVG icons; `POST /api/integrations/online_store/test` rejected built-in same-origin storefronts when no external webhook URL was set; and migration `0024` omitted explicit trailing `GRANT EXECUTE` statements for `save_purchase_draft` and `issue_purchase`.
   - **Fix:** Added leading Tabler `<IconLock>` / `<IconAlertCircle>` icons inside `<h1>` elements, updated the `online_store` integration check to validate built-in same-origin storefronts cleanly, and appended explicit `GRANT EXECUTE` statements for `save_purchase_draft` and `issue_purchase` to migration `0024`.

## PoC Verification

All checks below were executed after the final edit:

- **Type-check & Applet Build:** `compile_applet` succeeded and `lint_applet` (`tsc --noEmit`) passed with `0` errors.
- **Dual-Bundle Production Build & Isolation Check:** `npm run build` (`vite build && vite build --config vite.erp.config.ts && node scripts/check-bundle.mjs`) passed, producing isolated storefront (`dist/index.html`) and ERP (`dist/ERP/erp.html`) bundles.
- **Automated Test Suite (`tests/*.test.mjs`):** `npm test` ran `89` checks (`82` passed, `0` failed, `7` skipped where live Supabase env vars are absent in the sandbox), including new regression assertions in `tests/audit-fixes.test.mjs` covering `resolveSafeStorePath`, `isErpRequestPath`, `evaluateIpAccess` (`403` block vs `X-Break-Glass-Token` recovery), `SUPABASE_STORAGE_BUCKET` config handling, fail-closed `ipAllowlist` / `middleware` / `AppProvider` guards, and Drive OAuth escaping / attachment magic-byte checks.
- **Secrets Scan & Dependency Audit:** `npm run security-audit` scanned `172` files with `0` leaked secret findings and `0` critical or high dependency vulnerabilities (`moderate=2, low=0`).
- **Fresh-Install SQL Rehearsal:** `npm run rehearse` statically validated all `24` sequential migrations (`0001`–`0024`), `116` SQL functions, `90` tables, `13` views, `scripts/setup.mjs` coverage, and `vercel.json` headers/rewrites.
