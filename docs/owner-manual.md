# DecorBiz — Business Owner Manual

Welcome to **DecorBiz**, your integrated showroom ERP (`/ERP`) and customer storefront (`/`). Only the **Owner** role has unrestricted access to Security, Integrations, Modules, Staff management, Store moderation, and Restores.

---

## 1. First-Time Workspace Setup (`/ERP`)

1. Open `https://<your-domain>/ERP`. On a fresh database, the setup wizard appears automatically.
2. Fill in **Business Name**, **Owner Full Name**, **Email**, **Password**, and **GSTIN** (if GST registered).
3. Click **Launch Business Workspace** to initialize your workspace and private storage bucket.

---

## 2. Five Locked Product Lines & Typed Specifications

DecorBiz enforces **5 fixed product lines** (cannot be added, renamed, or deleted). Inside each line you may freely add custom **Categories**, **Brands**, and **Units**.

| Product Line Key | Label | Required Typed Specification Highlights |
| :--- | :--- | :--- |
| `tiles_slabs` | Tiles & Slabs | Size (`length x width mm`), thickness, material, finish, use area, pieces/box, sq.ft/box, sq.m/box, weight/box, shade, batch lot, series, design name |
| `sanitaryware` | Sanitaryware | Type, mounting, trap type, colour, material, flush type & litres, seat cover included, set contents, dimensions, warranty |
| `faucets_cp` | Faucets & CP Fittings | Type, finish, body material, size & connection, operation, cartridge type, flow rate, warranty |
| `tile_adhesive` | Tile Adhesive & Grout | Type, grade, pack size & unit, coverage per pack, pot life, shelf life, colour, suitable for |
| `other_general` | Other / General Hardware | Name, unit, size/description, colour, material, plus custom key-value attributes |

Required fields are validated before saving items, and tailored list filters let staff filter cleanly by product line and specification attributes.

---

## 3. Variants, Shade / Batch Lots & Unit Conversions

- **Item Variants**: Define combinations of **Size**, **Finish**, and **Shade** inside the Item Form — each with its own SKU, selling price, purchase cost, and independent stock balance.
- **Lot / Shade Tracking**: Tile stock adjustments, sales bills, and supplier purchases track `shade` and `batch_lot`. If a GST bill mixes two different shades or batch lots for the same tile item, DecorBiz highlights a clear mixed-lot warning before issuing.
- **Automatic Tile Unit Conversions**: For `tiles_slabs` items, saving automatically builds/syncs **BOX**, **PCS**, **SQFT**, and **SQM** unit conversions from `pcs_per_box` and `sqft_per_box`. Billing and storefront cart automatically convert between **Boxes**, **Pieces**, **sq.ft**, and **sq.m**.

---

## 4. Optional Showroom Modules (`Settings → Modules & Features`)

Toggle features on or off without cluttering daily screens:
- **Area-to-Boxes Estimator** (`estimator`, with wastage % & direct tile calculator)
- **Breakage Returns** (`breakage_returns`), **Samples Tracking** (`samples`), **Contractor Rate Cards** (`contractor_rate_cards`), **Project Quotations**
- **Showroom Delivery Trips** (`delivery_trips`), **Commissions** (`commissions`), **Supplier Price Lists** (`supplier_price_lists`)
- **Multi-Location Godowns**, **POS-Lite**, **Double-Entry Accounting**, **Advanced GST / E-Invoice**
- **Online Storefront** & **Email Notifications**

---

## 5. Online Store Admin Console (`ERP → Store`)

When **Online Storefront** is enabled:
- **Catalogue Publishing**: Publish/unpublish items, override online price & rich description, generate SEO URL slugs, upload multiple product photos/videos.
- **Order Inbox & Stock Reservation**:
  - `confirmed` orders **reserve** stock from the shared ERP pool.
  - `delivered` or `picked_up` **deducts** physical stock and clears the reservation.
  - `cancelled` **releases** any reserved stock automatically.
- **Delivery Zones & Trips**: Define local pin codes/areas, delivery fee, minimum order threshold, estimated days, and assign showroom delivery trips.
- **Promotions, Content & Moderation**: Manage coupons (with edit/active toggles), homepage banners (image upload, CTA label/link, edit/active toggles), CMS info pages, and approve/reject customer reviews.

---

## 6. Payment Gateways & Integrations (`Settings → Integrations`)

- **Razorpay Online Payments**: Enter your **Razorpay Key ID** (`rzp_live_...` / `rzp_test_...`) and **Key Secret**, then toggle **Online Payment** ON. All Razorpay payment signatures are verified server-side (`HMAC-SHA256`) before confirming orders—browser responses alone are never trusted.
- **Cash on Delivery / Pay on Pickup**: Toggle independently inside Online Store settings.
- **DecorBiz AI / SMTP / WhatsApp**: All external credentials are encrypted at rest using `APP_ENCRYPTION_KEY`. Customer order confirmations & status emails dispatch via configured SMTP relay or webhook.

---

## 7. Security Controls (`Settings → Security & IP` & `Users & Roles`)

- **IP Allowlist (`Settings → Security & IP`)**: Restrict `/ERP` and `/api/erp/*` page and API access to trusted showroom/office IPs (with one-click **Add My Current IP**). Unlisted IPs receive HTTP `403`. Public storefront (`/`, `/api/store/*`) remains open to customers globally.
- **Two-Factor Authentication (2FA)**: Staff enroll via **My Profile → Two-Factor Authentication**. Once enabled, ERP login prompts for a 6-digit authenticator or recovery code and requires a signed `X-ERP-TOTP-Token` on `/api/erp/*` API requests. Recovery codes are hashed with SHA-256 at rest.
- **Owner Reset Staff 2FA**: In **Settings → Users & Roles**, the Owner can click **Reset 2FA** (`POST /api/erp/auth/totp-reset`) for any employee who loses their phone.
- **Emergency Recovery**: Read [Owner Break-Glass Recovery](owner-break-glass-recovery.md) before tightening your IP allowlist.
