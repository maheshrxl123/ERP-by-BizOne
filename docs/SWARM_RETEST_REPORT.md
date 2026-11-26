# DecorBiz ERP & Storefront — Verification-Only Retest Report

> **CRITICAL & HIGH ITEMS FAILED — DO NOT DEPLOY OR PUSH YET.**
>
> 1. **Local High-severity failures remain unresolved**: `PERF-03` (2.84 MB uncompressed showcase JPEGs), `CQ-02` (unused `src/core/taxEngine.ts`), and `FN-02` (`.env` `VITE_SUPABASE_URL` `demo-project-ref` mismatch blocking live E2E tests), plus `RT-05` (`npm install` fails without `--legacy-peer-deps`).
> 2. **Live deployment (`https://erpbybizone.vercel.app`) is still serving the pre-fix build**: Critical (`RT-01`, `DEV-01`, `PERF-01`) and High (`COM-01`, `DEV-02`, `UI-02`, `A11Y-01..03`, `PERF-02..04`) items all **FAIL** on the live site because local Phase A/C fixes have not been deployed, and `GET /api/erp/health` shows `encryptionConfigured: false` on live Vercel.

---

## 1. Live Routing & API Checks (`https://erpbybizone.vercel.app`)

| Target | Expected | Observed on Live | Verdict |
|---|---|---|---|
| `/` | Storefront (`200`) | `200 OK`, title `DecorBiz — Tiles, Sanitaryware & Bathware Showroom` | **PASS** |
| `/ERP` | ERP (`200` login or `403` IP block) | `200 OK`, `erp.html`, `X-Robots-Tag: noindex, nofollow`, title `DecorBiz ERP — Billing, Khata, Stock & GST` (`X-Vercel-Cache: HIT`, no IP allowlist check) | **PASS** (page); **NOT TESTED** (non-listed IP) |
| `/erp` | Redirect to `/ERP` | `200 OK` serving Storefront `index.html`, no `Location`, no `X-Robots-Tag` | **FAIL** (`RT-01` Critical) |
| `/Erp` | Redirect to `/ERP` | `200 OK` serving Storefront `index.html`, no `Location`, no `X-Robots-Tag` | **FAIL** (`RT-01` Critical) |
| `/ERP/login` | ERP (`200` or `403`) | `200 OK`, `erp.html`, `X-Robots-Tag: noindex, nofollow` | **PASS** |
| `/robots.txt` | Disallow `/ERP`, `/erp.html`, `/api/erp/` | `200 OK`, `User-agent: *\nDisallow: /ERP\nDisallow: /erp.html\nDisallow: /api/erp/` | **PASS** |
| `/api/store/health` | `200` Storefront health | `404 Not Found` (`{"error":"API route not found."}`) | **FAIL** (`RT-04` Low) |
| `/api/erp/health` | `200` ERP health + `noindex` | `200 OK`, `X-Robots-Tag: noindex, nofollow`, `{"ok":true,"supabaseConfigured":true,"encryptionConfigured":false}` | **PASS** (note: `encryptionConfigured: false`) |
| `/api/erp/*` token refusal | Refuse unauth / forged / customer tokens | Unauth & forged JWTs returned `401` on `/api/erp/store-admin/overview`, `/integrations`, `/auth/totp-status`, `/ai/providers`, `/admin/users`, `/backup/export-bundle`. Live customer JWT: **NOT TESTED** (no live customer credentials). | **PASS** (unauth/forged); **NOT TESTED** (customer JWT) |

---

## 2. Live 5-Viewport Comparison (`360x640`, `390x844`, `768x1024`, `1366x768`, `1920x1080`)

Tested via Playwright Chromium on `https://erpbybizone.vercel.app` and compared against `docs/SWARM_AUDIT_REPORT.md`:

| Check / Screen | Live `https://erpbybizone.vercel.app` | Report (`docs/SWARM_AUDIT_REPORT.md` local) |
|---|---|---|
| **Horizontal overflow (`/ERP/`)** | **PASS** at all 5 viewports (`overflowX: false`) | PASS |
| **Horizontal overflow (`/`, `/catalogue`)** | **PASS** at `360x640`, `390x844`, `1366x768`, `1920x1080`; **FAIL** at `768x1024` (`scrollWidth: 787` vs `innerWidth: 768`, plus 1 broken image `/api/store/files/ec7987cc-e927-46aa-b361-536f37ad394d` on `/`) | PASS locally |
| **DEV-01 (Critical — ERP PWA & offline)** | **FAIL** (`manifestHref: null`, storefront SW scope `/`, offline reload fails) | PASS locally |
| **DEV-02 (High — Storefront touch targets < 44px)** | **FAIL** (7 targets `< 44px` at `360x640` & `390x844`; 12 targets `< 44px` at `768x1024`) | PASS locally |
| **DEV-03 (Medium — Floating AI button)** | **NOT TESTED** (`aiRect: null` on live storefront) | PASS locally |
| **DEV-04 (Medium — ERP auth touch targets)** | **FAIL** (3 targets `< 44px`: `हिन्दी`, `Toggle theme`, `Forgot password?`) | PASS locally |
| **DEV-05 / DEV-06 (High — Billing / POS mobile)** | **NOT TESTED** (no live ERP session) | PASS (code-verified) |
| **UI-01 / UI-04 (High/Medium — ERP admin UI)** | **NOT TESTED** (no live ERP session) | PASS locally |
| **UI-02 (High — Storefront error/retry UI)** | **FAIL** (pre-fix `/assets/main-Bd4pWk0c.js`) | PASS locally |
| **UI-03 (High — Hindi toggle)** | **PASS** on `/ERP/` login (`"डेकोरबिज़ में साइन इन करें"`); **NOT TESTED** on authenticated ERP screens | PASS locally |
| **UI-05 (Medium — Mobile nav drawer)** | **FAIL** (`hasMobileMenuBtn: false` at `360x640`, `390x844`) | PASS locally |
| **UI-06 (Medium — `/catalogue` `<h1>`)** | **FAIL** (`h1: null` on `/catalogue` at all 5 viewports) | PASS locally |
| **UI-07 (Medium — Checkout delivery validation)** | **NOT TESTED** (live catalogue has 0 items) | PASS locally |

---

## 3. Retest of FAIL, NOT TESTED, and Medium+ Items

| ID | Severity | Live Vercel Verdict | Local Verdict | Evidence / Reason |
|---|---|---|---|---|
| **RT-01** | Critical | **FAIL** | **PASS** | Live `/erp` & `/Erp` serve Storefront `index.html`; local `vercel.json` & `server.ts` fixed |
| **RT-02** | Medium | **FAIL** | **PASS** | Live `/erp` lacks `X-Robots-Tag: noindex, nofollow` |
| **RT-03** | Medium | **FAIL** | **PASS** | Live pre-fix SW deployed; local `vite.config.ts` uses `/^\/erp(?:\/\|\.html\|$)/i` |
| **RT-05** | Low | N/A | **FAIL** | Clean `npm install` fails with `ERESOLVE` (`esbuild@^0.25.0` vs `vite@8.4.0`); requires `--legacy-peer-deps` |
| **SEC-01** | High | **NOT TESTED** | **PASS** (config) | Live `/ERP` is `X-Vercel-Cache: HIT` pre-fix; non-listed external IP cannot be tested from this machine |
| **SEC-02** | High | **NOT TESTED** | **PASS** | Live `allowed_ips` did not block this IP, so spoofed `X-Forwarded-For: 127.0.0.1` cannot be distinguished |
| **SEC-03** | Medium | **NOT TESTED** | **OPEN** | No live staff session; architectural custom 2FA not enforced at Supabase RLS (`aal2`) |
| **SEC-05** | Medium | N/A | **NOT TESTED** (`npm audit`) | `npm audit` fails with `ENOLOCK` (no `package-lock.json`); `bun` CLI not installed |
| **FN-01** | Medium | **NOT TESTED** | **PASS** (SQL/setup) | `0027_seed_all_product_lines.sql` & `scripts/setup.mjs` verified; live DB execution blocked by `FN-02` |
| **FN-02** | High | N/A | **FAIL** | `.env` `VITE_SUPABASE_URL` (`demo-project-ref`) mismatches `SUPABASE_SERVICE_ROLE_KEY`, failing `check-env.mjs` & 5 E2E tests |
| **COM-01** | High | **FAIL** | **PASS** | Live `/assets/main-Bd4pWk0c.js` has pre-fix `baseQty:t,qty:t}` |
| **COM-02** | Medium | **NOT TESTED** | **PASS** | Live `coupons` is `[]` and live backend is pre-fix |
| **COM-03** | Medium | **NOT TESTED** | **PASS** | Live `codEnabled` is `true` and live bundle is pre-fix |
| **SET-01** | Medium | **NOT TESTED** | **PASS** | Live `onlineStoreEnabled: true` with no owner session to toggle OFF; ON state (`config`/`catalogue`/`files`) PASS |
| **A11Y-01..05** | High/Med | **FAIL** | **PASS** | Live `/assets/main-hcExkE24.css` (`--text-muted: #64748b`), `main-Bd4pWk0c.js`, and `main-CH9kni2x.js` are pre-fix |
| **PERF-01** | Critical | **FAIL** | **PASS** | Live `/ERP/assets/main-CH9kni2x.js` is `2,137,477` bytes (~2.14 MB) vs `622.7 KB` locally |
| **PERF-02** | High | **FAIL** | **PASS** | Live `HEAD /assets/aistudio/DecorBiz_Implementation_Plan_5e3bc2c5.md` returns `200` |
| **PERF-03** | High | **FAIL** | **FAIL** | 4 storefront showcase JPEGs remain unoptimized (`2.84 MB` total) both locally and on live |
| **PERF-04** | High | **FAIL** | **PASS** | Live bundles lack `loading="lazy"` on `<img>` tags |
| **PERF-05** | Medium | **FAIL** | **PASS** | Live `/api/store/config` took `3,690.9 ms` (`max-age=0`, no gzip); `/api/store/catalogue` took `1,595.8 ms` |
| **CQ-01** | High | N/A | **PASS** | 0 unguarded async routes in `src/server/routes/*.ts`; `unhandledRejection` handler present |
| **CQ-02** | High | N/A | **FAIL (Deferred)** | `src/core/taxEngine.ts` still exists and is unused in `src/` |
| **CQ-03 / CQ-04 / CQ-06** | Medium | N/A | **PASS** | Verified no regressions in `src/packs/registry.ts`, docs, or `.catch` handlers |
| **CQ-05** | Medium | N/A | **FAIL (Deferred)** | `cost_centres` table (`0013` migration) remains unused in `src/` |

---

## 4. Clean-Install Build & Test Results

Executed in a clean temporary copy (`$env:TEMP\decorbiz-clean-verify`, cleaned up afterwards; zero tracked files edited):

- **`npm install`**: **FAIL** (`ERESOLVE`: `esbuild@^0.25.0` vs `vite@8.4.0` peer dependency).
- **`npm install --legacy-peer-deps`**: **PASS** (`544` packages installed).
- **`npm run lint`** (`tsc --noEmit`): **PASS** (exit 0).
- **`npm run build`** (`vite build && vite build --config vite.erp.config.ts && node scripts/check-bundle.mjs`): **PASS** (exit 0; storefront clean, ERP isolated at `/ERP/`).
- **`npm test`**: **86 PASS / 8 FAIL** (out of 94 tests):
  - **7 expected environment failures (`FN-02`)**: `tests/p1-unit.test.mjs:62` & `tests/p7-ai-advanced-v1.test.mjs:432` (`check-env.mjs` fails on `demo-project-ref`), plus 5 live server E2E tests (`p1-e2e`, `p3-items-inventory`, `p4-billing-sales`, `p5-purchases-expenses-reports`, `p6-packs-import-backup-drive`) failing with `ECONNREFUSED 127.0.0.1:3000`.
  - **1 timing flake**: `tests/audit-fixes.test.mjs:194` (cold `node server.ts` boot in temp dir exceeded 8s `/api/health` timeout; passed in workspace).
- **Lighthouse CLI**: **NOT TESTED** (`lighthouse` CLI not installed).
