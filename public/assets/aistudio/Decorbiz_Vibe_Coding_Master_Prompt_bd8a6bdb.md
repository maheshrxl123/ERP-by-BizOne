# DecorBiz ERP & RV Tiles & Decor E-Commerce: QA-to-Implementation Vibe Coding Master Prompt

**Source Audit:** Live interactive QA audit of [https://erpbybizone.vercel.app/erp](https://erpbybizone.vercel.app/erp) and [https://erpbybizone.vercel.app/](https://erpbybizone.vercel.app/) (November 28, 2026)  
**Target Environment:** Google AI Studio / AI Coding Agent  
**Baseline Verdict:** Conditional No-Go (24/36 test cases passed, 9 failed, 3 safety-gated/partial; 4 Critical, 5 Major, 6 Minor defects)

---

## Deliverable 1: QA Report Analysis

### Actual Application State
The platform consists of two connected surfaces on `erpbybizone.vercel.app`:
1. **ERP Admin Panel (`/erp` -> `/ERP`):** Configured for **RV Tiles & Decor** (*DecorBiz Tiles & Sanitaryware ERP · Non-GST Billing*). Core master data (**Items & Inventory**, **Parties & Khata**), **Expenses**, and **Reports & Analytics** (Day Book, Profit Estimate, GST & HSN Summary, Stock Valuation, CSV export) work accurately and persist across page reloads. Stock valuation math (`₹61,720.00 -> ₹70,470.00 -> ₹72,220.00`) and expense-to-report synchronization (`EXP-2627-0002`, `₹100.00`) are mathematically sound.
2. **E-Commerce Storefront (`/`):** Branded **RV Tiles & Decor**. Product browsing, category/attribute filtering, sorting, the tile box/sq.ft area calculator (including +10% wastage rounding), shopping bag quantity math, and delivery zone pincode matching (`845302` -> `East Champaran`) function properly. ERP-created products (`QA Test Product 001`) sync to the storefront with updated price (`₹550`) and stock (`30 PCS`).

### Four-Category Breakdown

#### A. Existing Functionality That Needs Fixing (Broken / Unreliable)
- **P0 — `BUG-CRIT-01` (ERP Cold-Load Hang & False Offline Banner):** `/ERP` frequently stalls indefinitely on *"Loading DecorBiz workspace..."* with a non-dismissible yellow banner (*"You are offline. Changes that need server verification require internet."*) despite an active internet connection, requiring 1–2 manual reloads.
- **P0 — `BUG-CRIT-02` (Online Store Admin Catalogue Desync):** ERP **Online Store -> Online Catalogue** displays `Published Items: 0 / 0` and an empty `All Active Items` table even though 4 published items (`PGVT Statuario Marble Glossy`, 2 `ZZTEST-S3-Triage-Race` items, and `QA Test Product 001`) are live on the storefront.
- **P0 — `BUG-CRIT-03` (Active Coupons Rejected as Inactive):** `SPECIAL10` (10% off, Min ₹50) and `ZZTEST10` (10% off, Min ₹0) are marked `Active` in ERP **Online Store -> Coupons**, yet storefront checkout rejects both with `Coupon "..." is inactive.`
- **P0 — `BUG-CRIT-04` (DecorBiz AI Infinite Hang):** Submitting a read-only query (`"What is my total stock value?"`) leaves the button stuck on `"Thinking..."` indefinitely with no response or error, while the placeholder asks to configure an AI key even though **Settings -> Integrations** shows DecorBiz AI Provider as `configured`.
- **P1 — `BUG-MAJ-01` (Dead Row-Level `Adjust` Button):** In ERP **Items**, clicking `Adjust` directly on a table row does nothing; only opening the item detail page (`>`) and clicking `Adjust Stock` works.
- **P1 — `BUG-MAJ-02` (Global Search `⌘K` Ignores Items):** Placeholder promises *"Search bills, items, parties, modules, st..."*, yet searching `KAJARIA` returns `"No matching screens, modules, or staff found."`
- **P1 — `BUG-MAJ-04` (Production Test Data Leakage):** `ZZTEST-S3-Triage-Race` (x2) and `ZZTEST10` appear on the live storefront, and 13+ `ZZTEST-*` categories, brands, and delivery zones (`ZZTEST-Fort-Area`) pollute ERP masters.
- **P1 — `BUG-MAJ-05` (Stale `sq.ft covered` in Bag):** Adding boxes from a product page to an existing bag item updates quantity (`5 -> 10 BOX`) and price (`₹5,250 -> ₹10,500`), but leaves the `77.5 sq.ft covered` subtitle stale until `+` or `-` is clicked.
- **P2 — `BUG-MIN-01` (Drafts Drop `Paid Now`):** Saving a draft in **New Bill** with `Paid Now = 500` resets Balance Due to full `₹1,100.00`.
- **P2 — `BUG-MIN-02` (Missing Language Setting):** **Settings -> Appearance & Language** has only Light/Dark theme; the language toggle (`हिन्दी`) only exists on the pre-login screen.
- **P2 — `BUG-MIN-03` (Empty `Bathware` Nav Link):** Storefront `Bathware` filters to `Sanitaryware` (0 products).

#### B. Existing Functionality That Needs Improvement (UX, Validation, Mobile)
- **Mobile 375px Navbar Overlap & Bag CTA Collision:** At `375×812`, `RV Tiles & Decor` clips (`RV Tile...`) and overlaps Wishlist/Account/Bag icons; the floating `Ask Showroom AI` button overlaps `Sign In to Place Order` in the Bag drawer; `Pincode (e.g. 302...` truncates.
- **Hydration Flash & Image Placeholders:** Storefront briefly flashes `DecorBiz Architectural Showroom` before hydrating `RV Tiles & Decor`; category cards and detail thumbnails flash blank boxes.
- **Inconsistent Validation & Controls:** **New Purchase** silently disables `Post Purchase` on 0 items with no message (unlike **New Bill**); **Items** lacks column sorting; **Reports -> Stock Summary** truncates `Is Low...`; **Settings** tab bar overflows horizontally; **Bag** fulfillment toggle (`Shop Pickup` vs `Own-Fleet Delivery`) has low active-state contrast; Catalogue search retains empty category filters until manual `Reset`.

#### C. Missing Functionality (Identified in Audit)
- **Operations Sub-Modules:** Header advertises godown transfers, stock counts, orders, breakage returns, samples, contractor rates, commissions, supplier price lists, and delivery trips, but only **Physical Stock Count** exists.
- **Guest Order Tracking:** Storefront *Track Your Order* redirects to `/orders` login gate instead of offering an Order ID + Phone lookup.
- **Storefront Tax Breakdown & Online Payments:** Bag summary displays no GST/tax line item; payment is restricted to COD / Shop Pickup (no active online payment gateway).
- **Partially Tested / Safety-Gated Workflows Requiring Verification:** End-to-end `Issue Bill` -> Stock Deduction -> Khata Update -> Payment Recording -> Sales Return; `Post Purchase` -> Stock Increase -> Supplier Payable -> Purchase Return; Customer `Create Account` -> Wishlist Persistence -> Order Placement -> ERP Order Inbox Sync.

#### D. Structural & Architectural Improvements
- Unify storefront and ERP admin data queries (especially published catalogue items and coupon validation).
- Replace fragile client-side offline/hydration blocking with resilient network checks, explicit error states, and request timeouts.
- Enforce server-authoritative pricing, tax, coupon, and stock calculations inside atomic database transactions with idempotency keys.

---

## Deliverable 2: Root Cause and Impact Matrix

| Issue ID | Issue Summary | Likely Root Cause | Layer | Affected Modules | Impact / Blast Radius |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `BUG-CRIT-01` | `/ERP` hangs on loading + false offline banner | Hydration race condition in offline detector / service worker / auth-bootstrap fetch lacking timeout | Frontend / Auth Bootstrap | All ERP modules | Blocks entry to entire ERP on cold load |
| `BUG-CRIT-02` | Online Store Admin Catalogue shows `0/0` | Admin tab queries wrong table/filter/flag vs. storefront `/catalogue` API | Backend / Query | ERP Online Store, Storefront | Admins cannot see or manage published storefront items |
| `BUG-CRIT-03` | Active ERP coupons rejected as inactive | Schema/status mismatch (e.g., boolean vs. string, missing validity dates, or case sensitivity) between ERP write & storefront validate | Backend / Integration | Online Store Coupons, Bag Checkout | Zero promo codes work for customers |
| `BUG-CRIT-04` | DecorBiz AI stuck on `Thinking...` | Missing fetch timeout, unhandled 4xx/5xx error, or decoupled API key check between Settings and AI route | Backend / Frontend | DecorBiz AI, Settings | AI assistant completely unusable |
| `BUG-MAJ-01` | Items row `Adjust` button does nothing | Missing/unwired `onClick` handler or unmounted modal trigger in list row component | Frontend | Items & Inventory | Slows stock adjustments; looks broken |
| `BUG-MAJ-02` | `⌘K` Global Search skips Items/Parties | Command palette only indexes static nav routes + invoices | Frontend / Search API | Top Bar, Items, Parties | Misleading placeholder; poor operator speed |
| `BUG-MAJ-04` | `ZZTEST-*` records in live catalog & masters | QA/seed test records left in production database | Database / Data Hygiene | Storefront, Items, Zones, Coupons | Unprofessional storefront; pollutes analytics |
| `BUG-MAJ-05` | Stale `sq.ft covered` in Bag on Add-to-Bag | Cart merge reducer updates `qty` & `total` but forgets to recompute `sqftCovered` | Frontend State | Shopping Bag, Product Detail | Incorrect coverage shown to tile buyers |
| `BUG-MIN-01` | Bill Draft drops `Paid Now` | Draft serializer omits `paidNow` or resets payment fields on draft load | Frontend / Backend | Bills & Sales | Data loss when resuming drafts |
| `UI-MOB-01` | 375px Navbar & Bag CTA overlap | Unconstrained flex brand title; fixed bottom-right AI widget `z-index`/position collides with drawer footer | Frontend CSS | Storefront Header, Bag Drawer | Broken mobile UX and blocked checkout button |
| `MISS-01` | Operations has only 1 of 9+ listed tabs | Incomplete feature rollout; subtitle written ahead of UI/backend tabs | Frontend / Backend | Operations, Warehouses, HR | Missing multi-godown & delivery workflows |

---

## Deliverable 3: Prioritized Implementation Roadmap

| Phase | Title | Priority | Dependencies | Key Objectives | Exit / Acceptance Criteria |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Phase 0** | Codebase Audit & Technical Baseline | P0 | None | Map actual stack, DB schema, auth/RLS, API routes, and verify every QA bug against source code | Complete architecture map + verified file-to-bug mapping; zero code edits yet |
| **Phase 1** | Critical Stability, Load & AI/Search Fixes | P0–P1 | Phase 0 | Fix `/ERP` cold-load hang & offline banner (`BUG-CRIT-01`), DecorBiz AI hang (`BUG-CRIT-04`), Global Search (`BUG-MAJ-02`), and `ZZTEST-*` cleanup (`BUG-MAJ-04`) | `/ERP` loads < 3s on cold visit; AI returns answer or clear error < 15s; `⌘K` finds `KAJARIA`; zero `ZZTEST-*` in storefront |
| **Phase 2** | ERP Core Operations & Transactional Integrity | P1–P2 | Phase 1 | Fix row `Adjust` (`BUG-MAJ-01`), Draft `Paid Now` (`BUG-MIN-01`), Purchase empty validation, Items sorting, Settings Language tab (`BUG-MIN-02`), Reports headers, and verify atomic `Issue Bill` / `Post Purchase` / `Payments` / `Returns` | All ERP CRUD + full Sales & Procurement workflows persist and reconcile Stock & Khata atomically |
| **Phase 3** | E-Commerce Storefront Completion | P1–P2 | Phase 1 | Fix Bag `sq.ft` recalculation (`BUG-MAJ-05`), `Bathware` nav (`BUG-MIN-03`), Catalogue search reset (`BUG-MIN-04`), hydration flash, guest Order Tracking, and tax/checkout clarity | Clean 375px & desktop UX; Bag math & guest tracking work without hydration flicker |
| **Phase 4** | ERP–E-Commerce Integration & Sync | P0–P1 | Phases 2, 3 | Fix Online Store Admin `Online Catalogue` (`BUG-CRIT-02`) & Coupon validation (`BUG-CRIT-03`); verify full Storefront Order -> ERP Order Inbox -> Stock -> Fulfillment -> Return sync | Admin Catalogue matches live storefront 1:1; `SPECIAL10` applies 10% discount; orders sync end-to-end |
| **Phase 5** | UI/UX Polish, Mobile & Operations Alignment | P2–P3 | Phases 2, 3 | Fix 375px navbar & `Ask Showroom AI` overlap, Settings tab scroll, Delivery toggle contrast, and align **Operations** tabs with actual scope | Zero overlapping/clipped elements at 375px; all UI states (loading/empty/error) consistent |
| **Phase 6** | Security, RBAC, Regression & Go-Live Readiness | P0–P1 | Phases 1–5 | Enforce server-side RBAC, idempotency, RLS/API auth, and run full E2E regression across all 36 QA test cases | Typecheck + production build pass; all 36 QA checks verified PASS; Go-Live checklist signed off |

---

## Deliverable 4: Complete Vibe Coding Master Prompt

> **Instructions for User:** Copy the entire block below and paste it into Google AI Studio (or your AI coding agent) as your master system/project prompt.

```markdown
# MASTER IMPLEMENTATION PROMPT: DECORBIZ ERP & RV TILES & DECOR E-COMMERCE

## 1. PROJECT CONTEXT & GOAL
You are upgrading and repairing an existing, deployed ERP and E-Commerce platform:
- E-Commerce Storefront: `/` (RV Tiles & Decor)
- ERP Admin Panel: `/erp` -> `/ERP` (DecorBiz Tiles & Sanitaryware ERP)

A comprehensive hands-on QA audit was conducted on the live deployment. Your job is to inspect the existing codebase, verify each reported issue against the actual code, and execute a phased, production-grade repair and completion plan WITHOUT rebuilding from scratch or losing existing business data.

## 2. CRITICAL PRESERVATION RULES (NEVER VIOLATE)
1. **Work on the existing project.** Do NOT recreate the app, switch frameworks, or replace the database.
2. **Protect production data.** NEVER run destructive database resets, drop tables, or delete genuine business records. Only clean up clearly synthetic test records (`ZZTEST-*`, `QA Test ...`) via safe, reversible, logged migrations/scripts after confirming with the user or isolating them.
3. **Preserve working modules.** Keep existing working routes, layouts, Items/Parties/Expenses/Reports math, and the tile Box/Sq.ft calculator intact.
4. **No mock/fake backends.** Never replace broken features with hardcoded mock data.
5. **Verify before claiming.** Every phase is complete ONLY after running type checks, production build, and testing the exact reproduction steps.

## 3. PHASE 0: CODEBASE AUDIT & TECHNICAL BASELINE (DO THIS FIRST)
Before writing any fix:
1. Inspect the repository structure, `package.json`, framework/router setup, state management, and styling system.
2. Identify the database, ORM/client, authentication provider, and Row Level Security (RLS) / API authorization model.
3. Inspect all API routes, server actions, database queries, and service worker / offline-sync logic.
4. Map every QA defect below to exact file paths and root causes, and output a brief Technical Baseline Summary before starting Phase 1.

## 4. MANDATORY ENGINEERING STANDARDS
- **Architecture:** Keep business logic (pricing, tax, stock math, coupon validation, Khata balances) in server/domain services, never solely in UI components.
- **Data Integrity:** Use atomic database transactions for multi-step financial and inventory operations (e.g., `Issue Bill` must atomically create the invoice, deduct item stock, update party Khata balance, and record payment). Add idempotency protection to prevent duplicate submissions on double-click or retry.
- **Server Authority:** Backend must recompute and validate all totals, discounts, shipping charges, taxes, and stock availability; never trust client-submitted totals or permissions.
- **Security:** Enforce Role-Based Access Control (Owner, Manager, Cashier, Accountant, Storekeeper, View-only) on backend routes/queries, never expose secrets or service-role keys to the client, and respect RLS policies.
- **UI States:** Every screen and form must handle Loading, Empty, Success, Error, Validation, and Disabled states clearly.

## 5. PHASED IMPLEMENTATION SPECIFICATIONS

### PHASE 1: CRITICAL STABILITY, STARTUP & AI/SEARCH FIXES
- **P0 — Fix `/ERP` Cold-Load Hang & False Offline Banner (`BUG-CRIT-01`):**
  - *Root Cause Investigation:* Inspect `/ERP` bootstrap, auth session hydration, service worker, and offline-status listener (`navigator.onLine` or health ping).
  - *Requirements:* Ensure `/ERP` renders either the authenticated workspace or the Sign-In screen within 3 seconds on cold load. Add a timeout + retry mechanism for workspace initialization. Only show the offline banner when the browser is genuinely offline or a server health check fails, and provide a manual "Retry" / dismiss control.
- **P0 — Fix DecorBiz AI Infinite "Thinking..." Hang (`BUG-CRIT-04`):**
  - *Requirements:* Inspect **DecorBiz AI** chat/insights/drafts submission handler and **Settings -> Integrations** AI key storage. Unify the key-configured check so the input placeholder does not contradict Settings. Add a 20-second request timeout, surface real API/provider errors in the UI, and reset the loading state cleanly in `finally`.
- **P1 — Fix Global Search (`⌘K`) (`BUG-MAJ-02`):**
  - *Requirements:* Extend `⌘K` search to query **Items** (by name, SKU, brand, barcode) and **Parties** (by name, phone, GSTIN) in addition to Bills and Modules—so searching `"KAJARIA"` returns `PGVT Statuario Marble Glossy 600×1200mm`—or explicitly scope the search UI.
- **P1 — Clean Up Test Data Leakage (`BUG-MAJ-04`):**
  - *Requirements:* Provide a safe, non-destructive cleanup script/migration (excluding genuine RV Tiles & Decor records) to unpublish/archive `ZZTEST-S3-Triage-Race`, `ZZTEST10`, and `ZZTEST-*` categories/brands/zones after user confirmation.

### PHASE 2: ERP CORE OPERATIONS & TRANSACTIONAL INTEGRITY
- **P1 — Fix Items Row-Level `Adjust` Button (`BUG-MAJ-01`) & Add Sorting (`BUG-MIN-05`):**
  - *Requirements:* Wire the row-level `Adjust` button in the Items table to open the exact same Stock Adjustment modal as the item detail page, and refresh KPIs (`Stock Value`) immediately on save. Add column sorting or a sort dropdown (Name, Selling Price, Cost Price, Stock).
- **P1 — Verify & Harden End-to-End Transactional Workflows:**
  - **Sales Workflow:** `Customer -> Item -> Quotation -> Convert to Invoice -> Issue Bill -> Stock Deduction -> Khata Balance -> Receive Payment -> Sales Return (Credit Note)`. Fix `Save Draft` (`BUG-MIN-01`) so `Paid Now` and payment mode persist on drafts.
  - **Procurement Workflow:** `Supplier -> New Purchase -> Post Purchase -> Stock Increase -> Update Item Cost -> Khata Payable -> Give Payment -> Purchase Return`. Fix empty-form validation on `Post Purchase` (`BUG-MIN-06`) to show a clear inline error like `New Bill` instead of silently disabling.
  - **Expenses & Reports:** Ensure `Expenses` create/edit/void, `Day Book`, `Profit Estimate`, `GST & HSN Summary`, and `Stock & Valuation` remain 100% reconciled. Clean up truncated/raw table headers (`Is Low...` -> `Low Stock`) in Stock Summary.
- **P2 — Fix Settings Language Control (`BUG-MIN-02`):**
  - *Requirements:* Add a working Language selector (English / हिन्दी) inside **Settings -> Appearance & Language** synchronized with the pre-login language toggle.

### PHASE 3: E-COMMERCE STOREFRONT COMPLETION
- **P1 — Fix Bag `sq.ft covered` Stale State (`BUG-MAJ-05`):**
  - *Requirements:* When adding boxes to an existing SKU in the cart from a product page, recompute `sqftCovered = totalBoxes * sqftPerBox` in the same state update.
- **P1 — Fix Hydration Flash & Blank Image Placeholders:**
  - *Requirements:* Eliminate the initial flash of `DecorBiz Architectural Showroom` before `RV Tiles & Decor` renders (pass store config from server/SSR or show a clean skeleton). Add smooth image loading states on category cards and product thumbnails.
- **P2 — Fix Catalogue & Navigation UX (`BUG-MIN-03`, `BUG-MIN-04`):**
  - *Requirements:* Either populate `Sanitaryware` or map/hide empty `Bathware` nav links cleanly. When a user searches in the global/catalogue search bar while an empty category filter is active, either clear the category filter or show a 1-click *"Search across all collections"* prompt.
- **P2 — Guest Order Tracking & Checkout Clarity:**
  - *Requirements:* On `/orders`, add a guest lookup option (Order Number + Phone) alongside customer Sign In, or clearly label it as Account Order History. Display a clear Tax/GST line item (even if `₹0.00` for Non-GST) in the Bag summary.

### PHASE 4: ERP–E-COMMERCE INTEGRATION & SYNC
- **P0 — Fix Online Store Admin `Online Catalogue (0)` Desync (`BUG-CRIT-02`):**
  - *Requirements:* Align ERP **Online Store -> Online Catalogue** query with the same published-item flag/collection used by the storefront `/catalogue`. Published items (`PGVT Statuario Marble Glossy`, `QA Test Product 001`, etc.) must appear in `Online Catalogue` with accurate `Published Items` count, price, and stock, and edits must sync bidirectionally.
- **P0 — Fix Coupon Validation Sync (`BUG-CRIT-03`):**
  - *Requirements:* Ensure coupons marked `Active` in ERP **Online Store -> Coupons** (e.g., `SPECIAL10`) validate properly on storefront checkout (checking active status, min order amount, percentage/flat calculation, max cap, and expiry), and recompute the discount server-side on order placement.
- **P1 — Verify Full Order & Return Lifecycle:**
  - Verify `Storefront Order Placement -> ERP Online Store Order Inbox -> ERP Inventory Reservation/Deduction -> Delivery Trip -> Fulfillment / Cancellation / Return`.

### PHASE 5: UI/UX, MOBILE (375px) & OPERATIONS ALIGNMENT
- **P1 — Fix Mobile 375px Layout Collisions:**
  - *Requirements:* Prevent navbar brand text (`RV Tiles & Decor`) from clipping/overlapping Wishlist/Account/Bag icons at 375px. Reposition or hide the floating `Ask Showroom AI` button when the Shopping Bag drawer is open so it never overlaps `Sign In to Place Order`. Ensure `Pincode` input placeholder fits cleanly without truncation.
- **P2 — Fix Toggle Contrast & Overflow:**
  - *Requirements:* Give the active `Own-Fleet Delivery` / `Shop Pickup` button a high-contrast active state (AAA >= 7:1 or clear border/fill). Make the ERP Settings tab bar wrap or show clear scroll affordances.
- **P2 — Align Operations Module (`BUG-MAJ-03`):**
  - *Requirements:* Either implement the advertised tabs (Warehouses, Stock Transfers, Delivery Trips, Breakage Returns) or update the Operations header subtitle to accurately reflect `Physical Stock Count` and implemented workflows.

### PHASE 6: SECURITY, RBAC, TESTING & PRODUCTION READINESS
- Enforce server-side RBAC checks on all ERP endpoints for non-Owner roles (Manager, Cashier, Accountant, Storekeeper, View-only).
- Verify all forms reject invalid/negative inputs server-side.
- Run `npm run typecheck` / `tsc --noEmit` and `npm run build` (or project equivalents) with zero errors.
- Execute end-to-end verification of all 36 QA test cases and report exact pass/fail evidence.
```

---

## Deliverable 5: Phase-Wise Execution Prompts

Copy and run **one phase at a time** in Google AI Studio. Do not proceed to the next phase until the current phase's acceptance criteria pass.

### Phase 0 Prompt — Codebase Audit & Technical Baseline
```markdown
Inspect the existing DecorBiz ERP (`/erp` -> `/ERP`) and RV Tiles & Decor E-Commerce (`/`) codebase without modifying any files yet.
1. Identify the framework, router, database/ORM, authentication system, state management, and AI/payment integrations.
2. Locate the exact files responsible for:
   - `/ERP` workspace bootstrap, offline-status banner, and auth hydration (`BUG-CRIT-01`)
   - ERP `Online Store -> Online Catalogue` and `Coupons` vs. storefront `/catalogue` and Bag checkout (`BUG-CRIT-02`, `BUG-CRIT-03`)
   - `DecorBiz AI` query submission and `Settings -> Integrations` (`BUG-CRIT-04`)
   - `Items` list row `Adjust` button (`BUG-MAJ-01`) and `⌘K` Global Search (`BUG-MAJ-02`)
   - Storefront Shopping Bag `sq.ft covered` calculation (`BUG-MAJ-05`) and mobile 375px header/drawer (`UI-MOB-01`)
3. Output a concise Technical Baseline & File-to-Bug Map, and confirm how we will protect existing production data before starting Phase 1.
```

### Phase 1 Prompt — Critical Stability, Startup & AI/Search Fixes
```markdown
Execute Phase 1 on the existing codebase while preserving all working functionality and production data.
1. **Fix `BUG-CRIT-01` (`/ERP` Cold-Load Hang & False Offline Banner):** Inspect the workspace loader and offline detector. Fix the hydration/network race condition so `/ERP` loads the dashboard or Sign-In screen within 3 seconds. Show the offline banner only when genuinely offline/unreachable, and add a working Retry/Dismiss action.
2. **Fix `BUG-CRIT-04` (DecorBiz AI Infinite Hang):** Connect the AI provider configuration check in `Settings -> Integrations` to the `DecorBiz AI` input state. Add a 20-second timeout, proper error banner on failure, and `finally` cleanup so the button never stays stuck on `"Thinking..."`.
3. **Fix `BUG-MAJ-02` (Global Search `⌘K`):** Index and search **Items** (name, SKU, brand) and **Parties** (name, phone) alongside Bills and Modules so searching `"KAJARIA"` returns the matching product.
4. **Prepare `BUG-MAJ-04` Cleanup:** List all `ZZTEST-*` records in the database/seed files and provide a safe, non-destructive archive/cleanup script (do not delete genuine RV Tiles & Decor records).
5. Run typecheck and build, then test cold-loading `/ERP`, searching `KAJARIA` in `⌘K`, and submitting `"What is my total stock value?"` in DecorBiz AI.
```

### Phase 2 Prompt — ERP Core Operations & Transactional Integrity
```markdown
Execute Phase 2 on the ERP Admin Panel (`/ERP`) while preserving all existing data and working reports.
1. **Fix `BUG-MAJ-01` & `BUG-MIN-05` (Items):** Wire the row-level `Adjust` button in the Items table to open the Stock Adjustment modal and update KPIs immediately. Add sorting (Name, Selling Price, Cost Price, Stock) to the Items table.
2. **Fix `BUG-MIN-01` & `BUG-MIN-06` (Bills & Purchases):** Persist `Paid Now` and payment mode when saving a Bill Draft. On `New Purchase`, show a clear validation message when submitting with 0 items (matching `New Bill`).
3. **Harden Atomic Transactions:** Ensure `Issue Bill`, `Post Purchase`, `Record Payment`, `Sales Return`, and `Purchase Return` execute inside atomic server-side transactions (updating Stock, Khata balances, and Ledger together) with idempotency protection against double-clicks.
4. **Fix `BUG-MIN-02` & Reports UI:** Add a working Language selector to **Settings -> Appearance & Language**, and fix truncated/raw headers (`Is Low...`) in **Reports -> Stock Summary**.
5. Run typecheck, build, and test Items row-adjust, Bill Draft payment persistence, and full `Customer -> Quotation -> Invoice -> Payment -> Stock` verification.
```

### Phase 3 Prompt — E-Commerce Storefront Completion
```markdown
Execute Phase 3 on the E-Commerce Storefront (`/`) without breaking the existing Box/Sq.ft calculator or responsive grid.
1. **Fix `BUG-MAJ-05` (Bag `sq.ft covered`):** Ensure adding boxes to an existing cart item from any product page immediately recalculates `sqftCovered = totalBoxes * sqftPerBox`.
2. **Fix Hydration Flash & Blank Thumbnails:** Eliminate the initial flash of `"DecorBiz Architectural Showroom"` before `"RV Tiles & Decor"` loads, and add clean loading skeletons for category cards and product thumbnails.
3. **Fix `BUG-MIN-03` & `BUG-MIN-04` (Catalogue & Nav):** Populate or cleanly handle the empty `Bathware` (`Sanitaryware`) nav filter, and offer a 1-click *"Search all collections"* action when a search query returns 0 results under an active category filter.
4. **Checkout & Order Tracking Clarity:** Display a clear Tax/GST line item in the Bag summary (even when `₹0.00` for Non-GST), and add guest Order Tracking (Order ID + Phone) or clear account-login messaging on `/orders`.
5. Run typecheck, build, and verify add-to-bag `sq.ft` math, initial page load hydration, and search/filter behavior.
```

### Phase 4 Prompt — ERP–E-Commerce Integration & Sync
```markdown
Execute Phase 4 to repair ERP <-> E-Commerce synchronization.
1. **Fix `BUG-CRIT-02` (Online Store Admin `Online Catalogue`):** Inspect why ERP **Online Store -> Online Catalogue** shows `0 / 0` while `/` displays published items. Unify the query/flag so all published ERP items (`PGVT Statuario Marble Glossy`, etc.) appear in `Online Catalogue` with accurate stock, price, and publish toggles.
2. **Fix `BUG-CRIT-03` (Coupon Sync & Validation):** Inspect why `Active` coupons (`SPECIAL10`) in ERP Online Store fail with `"Coupon is inactive"` on storefront checkout. Fix the status/date/min-order validation and enforce server-side discount calculation at order placement.
3. **Verify End-to-End Order Sync:** Test `Storefront Order Placement -> ERP Online Store Order Inbox -> Stock Reservation/Deduction -> Order Status Update -> Cancellation/Return`.
4. Run typecheck, build, and verify Admin Catalogue count matches storefront count 1:1 and `SPECIAL10` applies 10% off in the Bag.
```

### Phase 5 Prompt — UI/UX, Mobile (375px) & Operations Alignment
```markdown
Execute Phase 5 for UI/UX polish, mobile responsiveness, and Operations module alignment.
1. **Fix Mobile 375px Layout:** At `375px` viewport width, prevent the storefront brand title (`RV Tiles & Decor`) from clipping or overlapping the Wishlist/Account/Bag icons. Hide or reposition the floating `Ask Showroom AI` button when the Bag drawer is open so it never overlaps `Sign In to Place Order`. Fix the truncated `Pincode` placeholder in the 2-column delivery row.
2. **Fix Contrast & Overflow:** Improve active-state contrast on the `Own-Fleet Delivery` / `Shop Pickup` toggle in the Bag drawer, and make the ERP **Settings** tab bar wrap cleanly or show clear scroll indicators.
3. **Fix `BUG-MAJ-03` (Operations Module):** Either implement the missing Operations tabs advertised in the header (Warehouses, Stock Transfers, Delivery Trips) or update the subtitle to accurately match the implemented `Physical Stock Count` workflow.
4. Run typecheck, build, and visually verify both `/` and `/ERP` at `375×812` and `1440×900`.
```

### Phase 6 Prompt — Security, RBAC, Regression & Go-Live Readiness
```markdown
Execute Phase 6 to validate security, permissions, and full production readiness.
1. **Server-Side RBAC & Validation:** Verify every ERP API route enforces role permissions (Owner, Manager, Cashier, Accountant, Storekeeper, View-only) and rejects invalid/negative quantities, prices, or unauthorized actions server-side.
2. **Audit Secrets & RLS:** Confirm no service-role keys or private credentials are exposed in client bundles, and verify RLS policies on customer/order/ERP tables.
3. **Full Regression & Build:** Run `typecheck` and production `build`, then execute an end-to-end regression pass covering all 36 QA test cases (Auth, Items, Parties, Bills, Purchases, Payments, Expenses, Reports, Operations, Online Store, AI, Storefront, Integration, Mobile).
4. Report exact pass/fail results for every test case and any remaining manual configuration steps (e.g., external payment gateway keys).
```

---

## Deliverable 6: Final Verification Checklist

- [ ] **Startup & Auth (`BUG-CRIT-01`):** `/erp` -> `/ERP` loads cleanly on cold visit in < 3 seconds without false offline banner.
- [ ] **Online Catalogue Sync (`BUG-CRIT-02`):** ERP **Online Store -> Online Catalogue** lists all published storefront items and matches live storefront count 1:1.
- [ ] **Coupon Sync (`BUG-CRIT-03`):** Active ERP coupons (`SPECIAL10`) apply accurate discounts on storefront checkout and validate server-side.
- [ ] **DecorBiz AI (`BUG-CRIT-04`):** AI Chat, Insights, and Smart Drafts return grounded responses or clear errors within timeout (never stuck on `Thinking...`).
- [ ] **Items Row Adjust & Sort (`BUG-MAJ-01`, `BUG-MIN-05`):** Row `Adjust` button opens modal and updates stock/valuation; table supports sorting.
- [ ] **Global Search (`BUG-MAJ-02`):** `⌘K` finds both invoices (`INV-*`) and items (`KAJARIA`) and parties.
- [ ] **Test Data Hygiene (`BUG-MAJ-04`):** Zero `ZZTEST-*` or `QA Test` records visible on live storefront or production masters.
- [ ] **Bag Sq.ft Math (`BUG-MAJ-05`):** Adding boxes to an existing cart item updates both box count and `sq.ft covered` immediately.
- [ ] **Drafts, Validation & Language (`BUG-MIN-01`, `BUG-MIN-02`, `BUG-MIN-06`):** Bill drafts retain `Paid Now`; `Post Purchase` shows clear empty-items error; Settings includes Language selector.
- [ ] **Mobile 375px & UI (`UI-MOB-01`):** Zero navbar icon overlap, zero `Ask Showroom AI` overlap on Bag CTA, zero hydration brand flash, clear delivery toggle contrast.
- [ ] **End-to-End Workflows:** `Issue Bill` -> Stock -> Khata -> Payment -> Return, `Post Purchase` -> Stock -> Payable -> Return, and `Storefront Order` -> `ERP Order Inbox` -> `Fulfillment` all verified end-to-end.
- [ ] **Build & Security:** Typecheck and production build pass with zero errors; server-side RBAC and validation verified.
