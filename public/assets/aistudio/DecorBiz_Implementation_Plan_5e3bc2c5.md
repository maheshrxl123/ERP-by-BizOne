# DecorBiz Implementation Plan

## Step 1: Cleanup, rebrand to DecorBiz, and the Settings backbone

Step 1 removes everything a tiles shop does not need, renames the software, and builds the on/off switch system every later step relies on.

**Work**

- Rename BizOne to DecorBiz in app config, UI strings, PWA manifest, `package.json`, `.env.example` and docs. Keep the Apache-2.0 LICENSE and NOTICE; read `TRADEMARKS.md` before release.
- Delete the Kirana, Medical, Clothing, Wholesale and Service packs: batch/expiry, Schedule H, prescriptions, IMEI/warranty-by-serial for other trades, job cards, salt substitutes, size-colour matrix, and `ModulePhasePlaceholder`. Replace the seven-pack selector with one fixed DecorBiz configuration.
- Drop the tables those features used in a new migration.
- Build Settings > Modules: one toggle per optional feature (godowns, accounting, GST returns, e-invoice and e-way bill, AI assistant, WhatsApp/SMS/email, Google Drive backup, Hindi, POS-lite, online payments, email notifications, online store). A switched-off feature disappears from menus and its API routes return 403.
- Build Settings > Integrations: credentials for each toggled feature, stored with the existing AES-256-GCM encryption.
- Split the 4,383-line `server.ts` into route files, replace the unmaintained `xlsx` package, and add helmet, CORS and a smaller JSON body limit than 50 MB.

**Acceptance checks**

- No remaining mention of BizOne or the removed trades in code, UI or docs.
- Type-check, build and the carried-over tests pass.
- Turning any toggle off hides its screens and blocks its API; turning it on restores both.

**Prompt to paste**

```markdown
You are working in the BizOne ERP software (React 19, Vite, Express server.ts, Supabase migrations). Do Step 1 of the DecorBiz plan only.
1. Rename BizOne to DecorBiz everywhere (config, strings, manifest, package.json, .env.example, docs). Keep LICENSE and NOTICE.
2. Remove the Kirana, Medical, Clothing, Wholesale and Service packs and all code, UI, types and tests that exist only for them. Remove the pack selector; keep one fixed configuration. Add a new migration that drops their tables.
3. Create Settings > Modules with one on/off toggle per optional feature: godowns, accounting, GST returns, e-invoice/e-way bill, AI assistant, messaging, Google Drive backup, Hindi, POS-lite, online payments, email notifications, online store. Disabled features must vanish from the UI and return 403 from the API.
4. Create Settings > Integrations for each feature's credentials, reusing the existing AES-256-GCM encrypted storage.
5. Split server.ts into route files, replace the xlsx package, add helmet, CORS and a 2 MB default JSON limit.
After each item run type-check, build and tests, fix failures, and list what changed. Do not start Step 2.
```

## Step 2: Tiles & Sanitaryware ERP core

Step 2 adds the five fixed product lines, each with its own required specification fields, plus the tile-specific features a showroom needs.

**Fields common to every item**

Name, SKU, barcode, product line (locked), category, brand, base unit, selling price, MRP, purchase price, GST rate, HSN code, tax inclusive flag, low-stock alert, images and video, supplier, country of origin, warranty months, description, active flag.

**Required specification fields per line**

| Line | Required fields | Optional fields |
| --- | --- | --- |
| Tiles & Slabs | Size (length x width, mm), thickness (mm), material (ceramic, vitrified, porcelain, marble, granite, quartz, other), finish (glossy, matte, satin, rustic, polished, carving), use area (floor, wall, outdoor, parking, bathroom, kitchen), pieces per box, sq.ft per box, sq.m per box, weight per box (kg), shade, batch lot, series and design name | PEI rating, water absorption %, slip resistance, edge type (rectified, non-rectified), faces per design, anti-skid, anti-bacterial |
| Sanitaryware | Type (WC, wash basin, urinal, cistern, bathtub, pedestal, shower tray), mounting (wall-hung, floor, counter, under-counter), trap type (P, S, concealed), colour, material, flush type and litres, seat cover included, set contents, dimensions (mm), warranty | Rough-in distance, water-saving rating, soft-close, series |
| Faucets & CP | Type (tap, mixer, shower, valve, health faucet, accessory), finish (chrome, black, gold, nickel, rose gold), body material (brass, SS, ABS), size and connection, operation (single-lever, two-handle, sensor, pillar), cartridge type, flow rate, warranty | Pressure range, set contents, spout length |
| Tile Adhesive | Type (cement-based, epoxy, grout, waterproofing), grade or class (C1, C2, S1), pack size and unit (kg), coverage per pack (sq.ft), pot life, shelf life (months), colour, suitable for (floor, wall, outdoor, stone, large format) | Open time, curing time, mixing ratio |
| Other/General | Name, unit, size or description, colour, material | Free key-value attributes |

**Behaviour**

- A database constraint and the UI both reject any value outside the five lines.
- Variants: the same product in several sizes, finishes or shades, each with its own SKU, price and stock.
- Tiles carry a shade and batch lot on every stock movement; a bill warns when one order mixes lots.
- Units are owner-created with conversions; tiles convert between box, piece, sq.ft and sq.m automatically.
- Godowns and stock transfers appear only when the godown toggle is on.
- Extra features, each behind its own toggle: area-to-boxes estimator with wastage %, breakage and damage returns, sample and display-piece tracking, contractor and architect rate cards, project quotations, delivery and transport tracking with own-vehicle trips, commission tracking, supplier price lists.

**Acceptance checks**

- One item in each of the five lines can be created with all required fields; a missing required field blocks saving.
- A tile sold in sq.ft reduces stock in boxes and pieces correctly.
- Mixing two shade lots on one bill shows a warning.

**Prompt to paste**

```markdown
Continue the DecorBiz software. Do Step 2 only; Step 1 is done.
1. Add a product_line column on items, constrained to: tiles_slabs, sanitaryware, faucets_cp, tile_adhesive, other_general. The owner cannot add, rename or delete lines; owners may add categories, brands and units inside a line.
2. For each line add a typed specification table with the required fields I list below, and build the item form, list filters and detail view per line. Required fields fail validation when empty.
   - tiles_slabs: size (length x width mm), thickness, material, finish, use area, pieces per box, sq.ft per box, sq.m per box, weight per box, shade, batch lot, series, design name.
   - sanitaryware: type, mounting, trap type, colour, material, flush type and litres, seat cover included, set contents, dimensions, warranty.
   - faucets_cp: type, finish, body material, size and connection, operation, cartridge type, flow rate, warranty.
   - tile_adhesive: type, grade, pack size and unit, coverage per pack, pot life, shelf life, colour, suitable for.
   - other_general: name, unit, size or description, colour, material, free key-value attributes.
3. Add item variants (size, finish, shade) with own SKU, price and stock, and shade/batch lot tracking on tile stock movements, with a warning on bills that mix lots.
4. Owner-created units with conversions; automatic box, piece, sq.ft and sq.m conversion for tiles.
5. Add optional toggled features: area-to-boxes estimator with wastage %, breakage returns, samples tracking, contractor rate cards, project quotations, delivery trips, commissions, supplier price lists. Godowns stay optional.
Write migrations, update types and tests. Run type-check, build and tests after each item. Do not start Step 3.
```

## Step 3: Routing split and ERP security

Step 3 separates the public site at `/` from the ERP at `/ERP` and locks the ERP behind an IP allowlist and two-factor login.

**Work**

- Today the app is one single-page bundle with no URL routing, and Vercel sends every path to `index.html`. Build two bundles: the storefront at `/` and the ERP at `/ERP`, so customers never download ERP code.
- Update the Vite base path, `vercel.json` rewrites and the Express fallback so `/ERP` and `/ERP/*` serve the ERP, and everything else serves the storefront.
- Split the API: `/api/erp/*` for staff, `/api/store/*` for customers. Each group uses its own auth middleware; a customer token is rejected on every ERP route.
- No link, menu entry or sitemap line from the storefront to the ERP. Add `noindex` headers and a `robots.txt` rule for `/ERP`.
- IP allowlist: the owner manages allowed addresses in Settings > Security. A request from any other address gets 403 before the login screen loads, on both page and API requests.
- Two-factor login for every staff account using an authenticator app (TOTP), with recovery codes. Owner can reset a staff member's second factor.
- Add a break-glass path for the owner, documented in the deployment guide, so a wrong allowlist entry cannot lock everyone out permanently.

**Acceptance checks**

- `/ERP` from a non-allowlisted address returns 403 for the page and the API.
- A staff password alone is not enough to reach the ERP; the second factor is required.
- The storefront bundle contains no ERP routes, strings or code (checked by a build script).
- A customer token cannot call any `/api/erp/*` route.

**Prompt to paste**

```markdown
Continue the DecorBiz software. Do Step 3 only; Steps 1 and 2 are done.
1. Split the front end into two Vite bundles: storefront served at / and ERP served at /ERP (base path /ERP/). Update vite config, vercel.json rewrites and the Express fallback.
2. Split the API into /api/erp/* (staff auth) and /api/store/* (customer auth, built in Step 4). Make a customer token fail on every /api/erp route.
3. Remove any link from the storefront to the ERP. Add noindex headers and a robots.txt rule for /ERP.
4. Add an IP allowlist managed in Settings > Security, enforced server-side for both page and API requests under /ERP and /api/erp, returning 403 otherwise.
5. Add TOTP two-factor login for all staff with recovery codes and an owner reset action. Add a documented owner break-glass recovery so an allowlist mistake cannot lock the owner out forever.
6. Add a build check that fails if ERP code appears in the storefront bundle.
Add tests for 403 on blocked IPs, second-factor enforcement and token separation. Run type-check, build and tests after each item. Do not start Step 4.
```

## Step 4: E-commerce storefront managed from the ERP

Step 4 builds the retail storefront at `/` with its own customer login, and a Store section inside the ERP that controls everything customers see.

**Customer side**

- Email and password registration and login, with email verification and password reset. Customers live in their own table with their own row-level security: they see only published products and their own orders.
- Catalogue with filters by product line, size, finish, shade, price and availability; search; product pages with multiple images and video; wishlist; reviews; coupons; SEO-friendly product URLs.
- Cart and checkout. Tile quantities can be entered in boxes or sq.ft, with the wastage suggestion from the estimator.
- Delivery: same city and nearby areas by own vehicles, configured as zones (pincode or area name) with a charge, minimum order and delivery days per zone; or pickup from the shop.
- Payment: cash on delivery and pay on pickup by default. Razorpay appears only when the Online Payment toggle is on and its keys are set in Settings > Integrations. Payment is verified server-side by Razorpay's signature, never trusted from the browser.
- Order history and live order status. Email notifications (placed, confirmed, out for delivery, ready for pickup) when that toggle is on.

**ERP side (Store menu)**

- Publish or unpublish each item, set online price, online description and images.
- Order inbox with status changes, delivery trip assignment, and printing of picking and delivery sheets.
- Manage delivery zones, coupons, banners, static pages and review moderation.
- Online stock is the ERP stock: a confirmed order reserves stock, delivery or pickup reduces it, and cancellation releases it.

**Acceptance checks**

- A customer can register, order on cash on delivery, and the order appears in the ERP with stock reserved.
- An unpublished item cannot be opened, carted or ordered, even by direct URL or API call.
- With the Online Payment toggle off, no Razorpay code or button is served; with it on, a failed signature never marks an order paid.
- A customer cannot read another customer's order.

**Prompt to paste**

```markdown
Continue the DecorBiz software. Do Step 4 only; Steps 1 to 3 are done.
1. Build the storefront at / : customer table separate from staff, email and password login with verification and reset, RLS so customers see only published items and their own orders.
2. Catalogue with filters (product line, size, finish, shade, price, availability), search, product pages with multiple images and video, wishlist, reviews, coupons and SEO URLs.
3. Cart and checkout. Tile quantity in boxes or sq.ft. Delivery zones (pincode or area, charge, minimum order, days) for own-vehicle delivery, plus shop pickup.
4. Payments: cash on delivery and pay on pickup. Razorpay only when the Online Payment toggle is on and keys are set in Settings > Integrations; verify the Razorpay signature server-side and never trust the browser.
5. Order history and status for customers; optional email notifications behind a toggle.
6. In the ERP add a Store menu: publish/unpublish items, online price and description, order inbox, status updates, delivery trip assignment, zones, coupons, banners, pages, review moderation.
7. Stock: online and ERP share one pool. Confirmed order reserves, delivery or pickup deducts, cancellation releases.
Add tests for customer isolation, unpublished items, reservation logic and Razorpay signature failure. Run type-check, build and tests after each item. Do not start Step 5.
```

## Step 5: Hardening, testing and release

Step 5 proves the finished system is safe and repeatable, and documents how to run it.

**Work**

- Tests for customer and staff isolation, the five-line rules, the `/ERP` guard, IP allowlist, two-factor enforcement, order-to-stock flow and Razorpay signature handling. Keep the existing billing and GST suites passing.
- Security review: rate limits on login, registration and checkout; upload type and size checks; secrets scan; dependency audit.
- Deployment guide for Supabase and Vercel, backup and restore guide, owner manual, and a short staff guide for the ERP.
- Fresh-install rehearsal from an empty Supabase project to a working shop with demo data.

**Acceptance checks**

- All tests pass on a clean checkout.
- A fresh deploy works end to end: setup, first item in each line, a storefront order, and an ERP delivery.
- The dependency audit shows no unresolved high-severity issues.

**Prompt to paste**

```markdown
Finish the DecorBiz software. Do Step 5 only; Steps 1 to 4 are done.
1. Add or complete tests for: customer/staff isolation, five-product-line constraint, /ERP guard, IP allowlist, TOTP enforcement, order-to-stock flow, Razorpay signature failure. Keep the existing billing and GST tests green.
2. Add rate limits on login, registration and checkout, upload checks, a secrets scan and a dependency audit; fix high-severity findings.
3. Write docs: Supabase and Vercel deployment, backup and restore, owner manual, staff guide, owner break-glass recovery.
4. Run a fresh-install rehearsal from an empty Supabase project and report every failure with its fix.
Report results as a short checklist.
```

## Audit risks found in the BizOne code

| Risk | Where | Fixed in |
| --- | --- | --- |
| Unmaintained `xlsx@0.18.5` with known security advisories (from memory; verify) | `package.json` | Step 1 |
| One 4,383-line `server.ts` holding every route | `server.ts` | Step 1 |
| 50 MB JSON body limit, no helmet or CORS configuration | `server.ts` | Step 1 |
| No URL routing; one bundle serves everything | `src/App.tsx`, `vercel.json` | Step 3 |
| Staff-only auth; no customer identity | `server.ts`, migrations | Step 4 |
| Seven trade packs and about 20 tables DecorBiz does not need | `src/packs`, migrations | Step 1 |
| Free-form `pack_metadata` JSON instead of typed specifications | `items` table | Step 2 |

The tests could not be run during this audit because package installs were blocked. Run `npm test` first in your own environment and treat any failure as a baseline, not a regression.
