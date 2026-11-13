# BizOne ERP

## Product Requirements Document (PRD)

| | |
|---|---|
| **Version** | 6.0 (revises 5.2) |
| **Maintainer** | BizOne Technologies |
| **License** | Apache License 2.0, public GitHub repository |
| **Type** | Free, open-source, self-hosted, simple small-business app: billing, khata, inventory, purchases, payments, expenses, and reports; optional advanced modules and AI |
| **Model** | One install = one business. Each owner uses their own Supabase project and env variables |
| **Stack** | React 18 + Vite + TypeScript (PWA); Supabase (PostgreSQL, Auth, RLS, Storage, Edge Functions) |
| **Charts / Icons** | Chart.js or Recharts / Tabler Icons only, no emoji |
| **Languages** | English, Hindi |
| **Region default** | India (INR, GST, Indian number format) |
| **Reference style** | Simple and fast like Vyapar and KhataBook; BizOne uses its own design, names, and assets |

Figures marked **(verify)** depend on Supabase or third-party limits that change; check the provider's current documentation.

**v6.0 revision note:** This revision incorporates the confirmed product decisions on five-button mobile navigation, one desktop sidebar, user-managed profile details, multiple item images, optional integrations configured in Settings, a simple small-business product position, and seven independently usable vertical-slice phases with frontend/backend work in parallel.

---

## 1. Overview

BizOne is a free, open-source, simple small-business app inspired by the ease of use of products such as Khatabook and Vyapar. It gives a business fast billing, party khata (credit ledger), stock, purchases, payments, expenses, GST, and reports on a phone-first interface. The default experience must stay lightweight and approachable; it must not feel like a Tally-style or enterprise ERP system. Advanced accounting and operational features remain optional and are introduced only when enabled. Business-type **packs** add the fields and rules each trade needs: Kirana, Medical Store, Clothing, Hardware, General Retail, Wholesale, Service. An optional **AI Agent** works with the owner's own API key and model.

### 1.1 Goals

1. A new cashier can make a bill in under one minute without training.
2. The default product is simple, free, open-source small-business software; advanced ERP-style workflows are optional.
3. Every delivery phase is a complete vertical slice with working frontend, database, backend logic, permissions, and tests.
4. One codebase serves many trades through packs.
5. Owners deploy it themselves (own domain or local server) with their own Supabase.
6. Only developers customize structure, through code. Owners get simple on/off switches.
7. Billing, stock, and party balances are always correct and reconcile.
8. Data is safe: local backup for everyone, Google Drive backup optionally.
9. AI helps with questions, insights, and drafts, and never changes data without approval.

### 1.2 Out of Scope (v1)

Payment-gateway processing, bank feeds, automatic statutory filing, native apps (PWA only), multi-business in one install, SaaS plans and quotas.

### 1.3 Target Users

| User | Needs |
|---|---|
| Owner | Sales and dues at a glance, control of staff and settings, backup |
| Cashier | Fast billing, collect payment, print or share bill |
| Storekeeper | Stock in/out, adjustments, low-stock and expiry lists |
| Accountant | GST data, ledgers, reports, exports |
| Manager | Daily oversight, purchase, reports |
| Developer | Customize packs, modules, layouts; deploy and upgrade |

---

## 2. Product Model and Deployment

### 2.1 One Install, One Business

One Supabase project and one deployed frontend serve one business. The database holds a single `business` record; tables carry no `business_id`. Access is controlled by RLS using the user's role. Optional **locations** (shop, godown) exist inside the one business.

### 2.2 Deployment Modes

| Mode | Frontend | Backend | Use |
|---|---|---|---|
| A | Vercel, Netlify, or Cloudflare Pages on own domain | Supabase cloud | Easiest |
| B | VPS with Nginx or Docker on own domain | Supabase cloud | Own server |
| C | Shop computer on LAN | Supabase cloud | Local screen, internet needed |
| D | LAN or VPS | Self-hosted Supabase (Docker) | On-premises |

### 2.3 Environment Variables and Integration Credentials

`.env` / `.env.local` contains only the configuration required to connect and securely operate the BizOne backend. Optional provider credentials must not be required for installation and must be configured from the in-app Settings screens.

| Variable | Used by | In browser | Requirement |
|---|---|---|---|
| `VITE_SUPABASE_URL` | Frontend Supabase client | Yes | Required |
| `VITE_SUPABASE_ANON_KEY` (or current Supabase publishable key) | Frontend Supabase client; protected by RLS | Yes | Required |
| `VITE_APP_NAME` | Frontend branding | Yes | Optional |
| `SUPABASE_DB_URL` | Local setup and migration scripts | No | Required only for workflows that connect directly to the database |
| `SUPABASE_SERVICE_ROLE_KEY` | Trusted setup scripts / server functions only | No | Required only for trusted server-side operations that need it |
| `APP_ENCRYPTION_KEY` | Server-side encryption of integration credentials and tokens | No | Required before enabling storage of encrypted integration secrets |

Rules:
- Only `VITE_` variables are exposed to the browser. Supabase anon/publishable keys are public client identifiers, not privileged secrets; RLS is mandatory.
- Service-role keys, database passwords/URLs, and `APP_ENCRYPTION_KEY` are server-side secrets. They must never be exposed to browser code, committed, logged, or included in backups.
- Do not put optional AI provider keys, Google OAuth client credentials, SMTP credentials, WhatsApp/SMS provider credentials, or other integration secrets in `.env` as a prerequisite for installation.
- Optional integrations are configured by an authorized Owner in **Settings → Integrations**. Secrets are submitted over HTTPS, encrypted server-side using `APP_ENCRYPTION_KEY` (or a supported secrets vault), masked after saving, and never returned to the browser in plaintext.
- If an integration requires an OAuth redirect URI or provider-side application registration, show the required callback URL and setup instructions in its Settings screen. The user enters the provider credentials there.
- The app must clearly distinguish required infrastructure configuration from optional integrations. Installation and core billing must work when every optional integration is disabled.
- `check-env` validates only the variables required for the selected deployment and enabled server capabilities; it must not fail because an optional integration is not configured.

### 2.4 Setup Flow

1. Create a Supabase project; copy URL and keys into `.env`.
2. `npm install`, then `npm run setup`.
3. `check-env` validates variables, connectivity, and key roles.
4. Setup applies migrations, enables RLS, and verifies policies.
5. Setup asks: business name, owner name, email, password, **business type (pack)**, GST status, financial-year start, demo data yes/no.
6. Setup creates the Owner and business record, seeds the pack, and prints the login URL.
7. First login opens the onboarding checklist.

There is no web installer, so service keys never pass through a browser.

### 2.5 Upgrades

`npm run upgrade`: local backup, apply new migrations in order, run checks, show a summary. Semantic versioning, changelog, and migration notes per release. Pack migrations are versioned separately.

### 2.6 Free-Plan Notes

A Free Supabase project has limited database size, storage, and bandwidth, no managed backups, and pauses when idle **(verify)**. Documentation includes a keep-alive workflow, a weekly backup routine, and a scale-up guide.

---

## 3. Architecture

| Layer | Technology | Role |
|---|---|---|
| UI | React, Vite, TypeScript | PWA, routing, forms, charts |
| Server state | TanStack Query | Cache, pagination, retries |
| Forms | React Hook Form + Zod | Validation |
| Tables | TanStack Table (virtualized) | Large lists |
| Styling | CSS variables (design tokens) | Themes, density |
| Database | Supabase PostgreSQL | Data, constraints, views, RPC |
| Auth | Supabase Auth | Login, optional TOTP |
| Access | RLS + permission functions | Role-based access |
| Storage | Supabase Storage (private) | Logos, attachments, prescription images |
| Server logic | Postgres RPC + Edge Functions | Transactions, AI gateway, Drive, messaging |
| Secrets | Edge secrets, Vault | AI key, Drive token |
| Tests | Vitest, Playwright, pgTAP | Unit, end-to-end, database |
| CI | GitHub Actions | Lint, test, build, release |

### 3.1 Rules

1. The database decides totals, stock, and balances; browser values are previews only.
2. RLS is on for every table and tested.
3. Money and stock changes are single-transaction RPC calls.
4. Edge Functions only where a secret or external call is needed.
5. PDF and Excel files are built in the browser.
6. The service-role key never reaches frontend code.
7. Every module sits behind a module flag; a disabled module has no menu, route, or RPC access.
8. Per-business variation lives in config and pack folders, never in end-user builders.

### 3.2 Repository Structure

```text
bizone-erp/
├── README.md  LICENSE  NOTICE  CONTRIBUTING.md  CODE_OF_CONDUCT.md
├── SECURITY.md  CHANGELOG.md  TRADEMARKS.md  .env.example
├── Dockerfile  docker-compose.yml  package.json  vite.config.ts
├── config/        app.config.ts  modules.config.ts  theme.tokens.css
├── src/
│   ├── app/       routes, providers, guards (RequireAuth, RequireRole, RequireModule)
│   ├── core/      money, units, tax engine, format, permissions, module registry, hooks API
│   ├── modules/   billing, parties, khata, inventory, purchase, payments, expenses,
│   │              reports, dashboard, backup, settings, ai, accounting, tax
│   ├── packs/     kirana, medical, clothing, hardware, general-retail, wholesale, service, _template
│   ├── components/  design system
│   ├── i18n/      en.json, hi.json
│   └── types/     generated from Supabase schema
├── supabase/      migrations, seed, functions, tests
├── scripts/       setup.mjs, check-env.mjs, upgrade.mjs, create-owner.mjs
├── docs/          quick-start, deploy guides (A to D), customization-guide, create-a-pack,
│                  extension-points, backup-restore, google-drive-setup, ai-setup,
│                  upgrade-guide, user-manual (en, hi)
└── .github/       issue and PR templates, ci.yml, release.yml, keep-alive.yml
```

---

## 4. Customization (Developer-Only)

Owners cannot change the software's structure. A developer edits code and config, then redeploys.

**Not in the app:** custom field builder, form builder, report builder, workflow or automation builder, custom role builder, webhook UI, theme builder, print-template designer.

**Developer extension points:**

| Point | What it changes |
|---|---|
| `config/app.config.ts` | App name, default pack, default modules, locale, currency, number format |
| `config/theme.tokens.css` | Colours, type, radius, density |
| `src/packs/<name>/` | Fields, units, rules, reports, seeds, demo data, translations, migrations |
| Module registry | Add a module: key, routes, menu, permissions, dependencies, migrations |
| Hooks API | `beforeBillSave`, `afterBillIssue`, `extendItemForm`, `extendBillLine`, `extendReports`, `extendDashboard`, `extendPrintTemplate` |
| Print templates | React/HTML components |
| `src/i18n/` | Add languages |
| `supabase/migrations/` | New tables with RLS and pgTAP tests |

**Owner-facing settings (simple):** business profile, invoice basics, module on/off switches, users and fixed roles, light or dark mode, language, AI provider, backup, activity log, help. Switching a module off hides it and keeps all data.

---

## 5. UI Design System

### 5.1 Design Principles

1. **Phone first.** Design at 360 px width; scale up to tablet and desktop.
2. **One main action per screen**, shown as a large primary button.
3. **Few fields by default.** Optional and pack fields sit in collapsible sections.
4. **Numbers first.** Amounts are large, right-aligned, and use tabular digits.
5. **Colour carries meaning**: green for money to receive, red for money to give.
6. **Fast data entry**: autofocus, numeric keypads, scan and search always on top, no extra confirmation dialogs for safe actions.
7. **Forgiving**: drafts auto-save, undo for deletes where safe, clear error messages with a fix.
8. **Flat and quiet**: borders instead of shadows, no gradients, no decorative graphics.

### 5.2 Colour Palette

**Light theme**

| Token | Hex | Use |
|---|---|---|
| `--primary` | `#0EA5E9` | Primary buttons, active tab, links on dark text |
| `--primary-dark` | `#075985` | Pressed state, links on white, headings accent |
| `--primary-soft` | `#E0F2FE` | Selected rows, chips, info background |
| `--on-primary` | `#0F172A` | Text on primary fill |
| `--bg` | `#F8FAFC` | Page background |
| `--surface` | `#FFFFFF` | Cards, sheets, app bar |
| `--text` | `#0F172A` | Main text |
| `--text-muted` | `#64748B` | Secondary text, labels |
| `--border` | `#E2E8F0` | Dividers, input borders |
| `--receive` | `#16A34A` (text `#15803D`) | To receive, paid, success |
| `--give` | `#DC2626` | To give, overdue, error, delete |
| `--warning` | `#EAB308` (text `#854D0E`) | Low stock, near expiry |
| `--info` | `#0EA5E9` | Hints |

**Dark theme**

| Token | Hex |
|---|---|
| `--bg` | `#0B1120` |
| `--surface` | `#111827` |
| `--text` | `#F1F5F9` |
| `--text-muted` | `#94A3B8` |
| `--border` | `#1F2937` |
| `--primary` | `#38BDF8` |
| `--primary-soft` | `#0C4A6E` |
| `--receive` | `#4ADE80` |
| `--give` | `#F87171` |
| `--warning` | `#FACC15` |

Rules: no gradients; text on the primary fill is dark (`--on-primary`) for AA contrast; coloured text on white uses the darker text variants above; status is never shown by colour alone (always an icon or label too). All tokens are CSS variables in `theme.tokens.css`.

### 5.3 Typography

| Item | Spec |
|---|---|
| Fonts | Inter (Latin), Noto Sans Devanagari (Hindi), system fallback |
| Sizes | 12, 14, 16 (base), 18, 20, 24, 32 px |
| Weights | 400 body, 500 labels, 600 headings and amounts |
| Numbers | Tabular lining digits; Indian grouping (₹1,23,456.00) |
| Line height | 1.4 body, 1.25 headings |
| Amount style | 24 px semibold on summary cards, 16 px in lists |

### 5.4 Layout, Spacing, Shape

- 4 px spacing grid; page padding 16 px mobile, 24 px desktop.
- Touch targets at least 48 × 48 px; list rows 56 px.
- Card radius 12 px, input and button radius 8 px, 1 px borders.
- Mobile: exactly five bottom-navigation controls: Home, Bills, central Quick Actions (+), Parties, More. The central control opens a quick-actions sheet and counts as one of the five controls.
- Tablet: collapsible primary side rail. Desktop: one 240 px primary sidebar (72 px collapsed), content up to 1280 px, billing in a two-pane layout. Never show a second or nested sidebar.
- Icons: Tabler, 24 px, 2 px stroke (20 px inside inputs).
- Motion: 150 to 200 ms fades and slides only; respects reduced-motion.

### 5.5 Components

| Component | Behaviour |
|---|---|
| Buttons | Primary (sky fill), Secondary (outline), Ghost, Danger (red outline); full-width on mobile forms |
| App bar | Back, title, up to 2 actions |
| Profile avatar | User image or initials fallback; opens profile/user menu |
| Image upload | Reusable upload control with preview, replace, remove, validation, compression, and upload progress; supports single image or multi-image gallery by field configuration |
| Bottom nav | Exactly five controls: Home, Bills, central Quick Actions (+), Parties, More. The central Quick Actions control opens a sheet and counts as one of the five controls. Items and less-frequent destinations are under More. |
| Quick actions sheet | New Bill, Receive Payment, Add Party, Add Item, Add Expense, New Purchase |
| Inputs | Label above, helper text below, inline error text, numeric keypad for amounts |
| Select / search select | Searchable bottom sheet on mobile, dropdown on desktop |
| Line-item row | Name, qty × rate, discount, amount, remove; tap to edit in sheet |
| Summary card | Label, big amount, optional trend chip |
| Party row | Avatar initials, name, phone, balance in green or red |
| Status chip | Paid, Partial, Due, Overdue, Draft, Void |
| Table (desktop) | Sticky header, sortable, column resize optional, row actions |
| Bottom sheet | Pickers, filters, item entry |
| Dialog | Only for destructive or irreversible actions |
| Toast | Success and undo messages, 4 s |
| Empty state | Icon, one line, one primary action |
| Loading | Skeleton rows; spinner only for button actions |
| Error state | Plain message, Retry button, and a "Details" expander for developers |
| Charts | Line (trend), bar (compare), donut (share, max 5 slices); always with a text summary |
| Approval card (AI) | Action, targets, before and after values, Approve and Reject |

### 5.6 States and Feedback

Every list and form defines: empty, loading, error, offline, and permission-denied states. Saving shows a button spinner then a toast. Destructive actions need a dialog with the item name. Offline banner appears at the top and queued actions show a pending badge.

### 5.7 Accessibility

Visible focus ring (2 px `--primary-dark`), labelled inputs, error text tied to fields, AA contrast, text scales to 200%, full keyboard use on desktop, screen-reader labels on icon-only buttons, chart text alternatives, reduced motion.

### 5.8 Print Specs

| Output | Spec |
|---|---|
| Invoice | A4 and A5 portrait; 58 mm and 80 mm thermal |
| Header | Logo, business name, address, GSTIN, phone, drug licence or other pack fields |
| Body | Item rows with HSN, qty and unit, rate, discount, tax, amount |
| Footer | Tax summary, amount in words, bank and UPI QR, terms, signature line, optional "Made with BizOne" |
| Barcode labels | 50 × 25 mm and 38 × 25 mm (configurable in code) |
| Method | Browser print and PDF; thermal printers through the system print dialog |

---

### 5.9 User Profile

A dedicated **User Profile** screen is available to every signed-in user.

- Users can view and edit their own display name and phone number, upload or change their profile photo, and change their own password.
- Email changes require verification of the new email address and any required re-authentication.
- Users can view their role and account status but cannot change their own role, permissions, or account activation status.
- Password changes use Supabase Auth's supported secure flow; the application never reads or stores plaintext passwords.
- The profile screen is separate from Business Profile and administrative User Management.
- Profile photo upload uses the shared image-upload service and follows the same validation, storage, and access rules as other images.

### 5.10 Universal File and Image Upload

Provide reusable upload infrastructure and UI components so all modules use one consistent upload experience.

- Supported use cases include user profile photos, business logo, item photos, party/customer attachments where enabled, expense attachments, prescription images, UPI QR images, and pack-specific images.
- Support **multiple images per item** with an ordered gallery, primary-image selection, preview, reorder, replace, and remove. Other fields declare whether they accept one image or multiple files.
- A shared `ImageUpload` component handles images; a shared `FileUpload` component handles permitted non-image attachments.
- Validate file type, size, and actual file content on the server; reject executable and unsupported formats. Apply configurable size limits.
- Compress and resize images on the client where practical; generate thumbnails and use WebP/modern formats when supported without losing the original where the business workflow requires it.
- Show upload progress, retry on failure, preview before save, and clear permission/error states.
- Store files in Supabase Storage using private buckets by default. Access is authorized through RLS-aware metadata and short-lived signed URLs; never expose unrestricted private object URLs.
- Store metadata in a common `files` table, including owner/creator, purpose, MIME type, size, storage path, checksum, timestamps, and optional linked record. Multiple item images use a relation table or ordered attachment relation rather than a single image column.
- Deleting or replacing a linked image must respect record permissions and avoid orphaned storage objects. Audit important upload, replace, and delete operations.
- Backups include attachments only when the user explicitly selects **Include files**, consistent with section 15.

## 6. Roles and Permissions

Fixed roles in code and database. Developers can adjust the mapping.

| Capability | Owner | Manager | Cashier | Storekeeper | Accountant | View-only |
|---|---|---|---|---|---|---|
| Create bills, quotations | Yes | Yes | Yes | No | Yes | No |
| Void bill, edit price or discount above limit | Yes | Yes | No | No | No | No |
| Receive and give payments | Yes | Yes | Yes | No | Yes | No |
| Add or edit parties | Yes | Yes | Yes | No | Yes | No |
| Add or edit items | Yes | Yes | No | Yes | No | No |
| See purchase price and profit | Yes | Yes | No | No | Yes | No |
| Stock adjustment | Yes | Yes | No | Yes | No | No |
| Purchases | Yes | Yes | No | Yes | Yes | No |
| Expenses | Yes | Yes | Yes (own) | No | Yes | No |
| Reports | Yes | Yes | Own sales | Stock only | Yes | Yes |
| Export data | Yes | Yes | No | No | Yes | No |
| Backup and restore | Yes | Backup only | No | No | Backup only | No |
| Users, modules, AI settings | Yes | No | No | No | No | No |
| AI chat | Yes | Yes | Optional | Optional | Yes | No |
| Approve AI proposals | Yes | No | No | No | No | No |

No self-signup: the Owner creates staff. The last Owner cannot be removed or demoted. Deactivating a user blocks access immediately.

---

## 7. Navigation

### 7.1 Mobile

The bottom navigation has **exactly five controls**:

1. Home
2. Bills
3. **Quick Actions (+)** — the central button; opens a bottom sheet
4. Parties
5. More

The Quick Actions sheet includes New Bill, Receive Payment, Add Party, Add Item, Add Expense, and New Purchase, subject to module availability and role permissions. Items, Purchases, Payments, Expenses, Reports, AI Assistant (if enabled), Backup, Settings, Profile, and Help are available from More or the relevant contextual entry. Do not add a sixth floating action button outside the five-control navigation.

### 7.2 Desktop

Use **one primary sidebar only**. It contains Home, Bills, Parties, Items, Purchases, Payments, Expenses, Reports, enabled pack entries, optional advanced modules, AI Assistant (if enabled), and Settings. Do not use a second sidebar, nested sidebar, or persistent sub-sidebar.

Within a destination such as Settings, use optional horizontal tabs or a compact horizontal sub-topbar for categories. These tabs belong inside the page content area and must not create another navigation rail. Use breadcrumbs where useful for deep screens.

The top bar may contain global search, quick-create, notifications, language/theme controls, and the user avatar/menu. The user menu links to the dedicated User Profile screen.

Menu items appear only for enabled modules and permitted roles. Profile remains available to every authenticated user.

## 8. Screen Inventory

Phase column refers to the roadmap (section 22). A screen is delivered in its listed phase as a working end-to-end feature against real backend data; mock-only screens do not count as phase completion.

| ID | Screen | Purpose | Roles | Phase |
|---|---|---|---|---|
| A1 | Login | Email and password | All | P1 |
| A2 | Forgot / reset password | Reset by email | All | P1 |
| A3 | Onboarding checklist | Logo, address, GSTIN, first item, first bill | Owner | P1 |
| UP1 | User Profile | View/edit own name and phone, profile photo, change password, verified email change, view role | All signed-in users | P1 |
| H1 | Home | Today numbers, dues, alerts, recent bills | All | P1 |
| B1 | Bills list | Search, filter by date, party, status | Sales roles | P4 |
| B2 | New / edit bill | Fast billing | Sales roles | P4 |
| B3 | Bill detail | View, print, share, return, void | Sales roles | P4 |
| B4 | Quotation list and form | Estimates, convert to bill | Sales roles | P4 |
| B5 | Sales return form | Return against a bill, credit note | Manager, Cashier | P4 |
| B6 | Share / print preview | Layout choice, share link, PDF | Sales roles | P4 |
| P1 | Parties list | You'll get / give totals, search | Sales roles | P2 |
| P2 | Party detail (khata) | Ledger, reminder, statement | Sales roles | P2 |
| P3 | Add / edit party | Details, opening balance | Sales roles | P2 |
| P4 | Receive / give payment | Amount, mode, allocate to bills | Sales roles | P2 |
| P5 | Statement preview | Date range, share, PDF | Sales roles | P2 |
| I1 | Items list | Search, filter, low stock tab | Stock roles | P3 |
| I2 | Item detail | Stock, ledger, price history | Stock roles | P3 |
| I3 | Add / edit item | Basic plus pack fields | Stock roles | P3 |
| I4 | Stock adjustment | Add or reduce with reason | Storekeeper, Manager | P3 |
| I5 | Barcode labels | Choose items, label size, print | Stock roles | P3 |
| I6 | Categories and brands | Manage lists | Stock roles | P3 |
| I7 | Stock transfer (advanced) | Between locations | Stock roles | P7 |
| I8 | Physical count (advanced) | Count sheet, variance | Stock roles | P7 |
| U1 | Purchases list | Supplier bills | Purchase roles | P5 |
| U2 | New purchase | Items, rates, freight, tax | Purchase roles | P5 |
| U3 | Purchase return | Return to supplier | Purchase roles | P5 |
| E1 | Expenses list and form | Category, amount, mode | Most roles | P5 |
| R1 | Reports hub | Grouped report list | Per role | P5 |
| R2 | Report view | Filters, table, chart, export | Per role | P5 |
| S1 | Settings home | Grouped settings | Owner | P1 |
| S2 | Business profile | Name, logo, address, GSTIN, UPI | Owner | P1 |
| S3 | Invoice settings | Prefix, series, terms, tax mode | Owner | P1 |
| S4 | Modules & Features | On/off switches | Owner | P1 |
| S5 | Users & roles | Add staff, assign role | Owner | P1 |
| S6 | Appearance and language | Light, dark, English, Hindi | All | P1 |
| S7 | Backup & restore | Local backup in P5; Google Drive backup in P6 | Owner | P5–P6 |
| S8 | Import | Excel/CSV templates, preview | Owner, Manager | P6 |
| S9 | Activity log | Who did what | Owner | P5 |
| S10 | Demo data and reset | Remove demo, reset | Owner | P6 |
| S11 | AI settings | Provider, key, model, test, playbooks | Owner | P7 |
| S12 | Storage usage | Database and file use | Owner | P5 |
| N1 | Notifications | Low stock, dues, expiry, backup | All | P5 |
| X1 | Global search | Parties, items, bills | All | P1 |
| AI1 | AI chat | Ask, tables, charts, proposals | Permitted | P7 |
| AI2 | AI approvals | Pending proposals | Owner | P7 |
| AI3 | AI reports | Saved insights | Owner, Manager | P7 |
| T1 | Help | Manual search, shortcuts | All | P1–P7 |
| K1 | Kirana quick bill | Item tiles, loose weight entry | Cashier | P6 |
| K2 | Daily rate update | Update loose-item rates | Manager | P6 |
| M1 | Prescription sheet | Doctor, patient, Rx image | Cashier | P6 |
| M2 | Schedule register | H, H1, narcotic entries | Pharmacist, Owner | P6 |
| M3 | Expiry report and returns | Near-expiry list, return to supplier | Storekeeper | P6 |
| M4 | Substitutes | Same-salt alternatives | Cashier | P6 |
| C1 | Variant matrix entry | Size × colour stock entry | Stock roles | P6 |
| C2 | Size-curve purchase | Quantities per size in one row | Purchase roles | P6 |
| C3 | Alteration jobs (advanced) | Tailoring job tracking | Cashier | P7 |
| HW1 | Estimate calculator | Area, wastage, material quantity | Sales roles | P6 |
| HW2 | Site / project ledger | Stage billing, running balance | Manager | P6 |
| HW3 | Warranty register | Warranty and claim tracking | Manager | P6 |
| HW4 | Rate list update | Import supplier rate list, apply discount % | Manager | P6 |
| HW5 | Breakage and claims | Damage record, supplier or transport claim | Storekeeper | P4 |
| HW6 | Referrer commission | Plumber, electrician, mason, architect | Manager | P4 |
| HW7 | Delivery challan | Vehicle, loading, delivery status | Sales roles | P7 |

Advanced module screens (accounting, HR, manufacturing, projects, assets, logistics) follow the same patterns and are specified when built (P7).

---

## 9. Key Screen Wireframes

Text wireframes at 360 px width. Real spacing and colours follow section 5.

### 9.1 Home (H1)

```text
+------------------------------------+
| Sharma Hardware       [search][bell]|
+------------------------------------+
| Today's Sales        Cash Received |
| Rs 24,580            Rs 18,200     |
+------------------------------------+
| You'll Get (green)   You'll Give (red)
| Rs 1,42,300          Rs 56,800     |
+------------------------------------+
| [ New Bill ] [ Receive ] [ Add Item ]
+------------------------------------+
| Alerts                             |
| (!) 6 items low on stock        >  |
| (!) 4 parties overdue           >  |
+------------------------------------+
| Sales, last 7 days                 |
|        /\      /\                  |
|   ____/  \____/  \__               |
+------------------------------------+
| Recent bills                       |
| INV-0142  Ramesh   Rs 3,200  Paid  |
| INV-0141  Walk-in  Rs   480  Paid  |
| INV-0140  Anil     Rs 9,750  Due   |
+------------------------------------+
| Home | Bills | Parties | Items | More
+------------------------------------+
```

### 9.2 New Bill (B2)

```text
+------------------------------------+
| <  New Bill  INV-0143     [Draft]  |
+------------------------------------+
| Party  [ Walk-in customer       v ] |
| Date   10 Nov 2026                 |
+------------------------------------+
| [scan] [ Search item or code...  ] |
+------------------------------------+
| PVC Pipe 1" ISI     3 Mtr x 85     |
|   Disc 5%                Rs 242.25 |
| Wall Tile 12x18     4 Box x 540    |
|   (56 sq ft)             Rs 2,160  |
| + Add item                         |
+------------------------------------+
| Subtotal               Rs 2,402.25 |
| GST                      Rs 432.41 |
| Round off                 + Rs 0.34|
| TOTAL                  Rs 2,835.00 |
+------------------------------------+
| (Cash) (UPI) (Card) (Credit)       |
| Received [ 2,835.00 ]  Balance 0.00|
+------------------------------------+
| [ Save Draft ]   [ Save & Share > ]|
+------------------------------------+
```

Behaviour: scanning or choosing an item adds a row and moves focus to quantity. Tapping a row opens an edit sheet (qty, unit, rate, discount, batch, notes). Choosing "Credit" leaves the balance on the party's khata. Totals update live as a preview; the server returns the authoritative totals on save.

### 9.3 Party Khata (P2)

```text
+------------------------------------+
| <  Ramesh Contractor    [call][...]|
+------------------------------------+
| You'll Get                         |
| Rs 38,450                          |
| [ Send Reminder ]  [ Statement ]   |
+------------------------------------+
| All | Bills | Payments             |
+------------------------------------+
| 08 Nov  Bill INV-0138    + 12,300  |
| 05 Nov  Payment (UPI)    -  5,000  |
| 28 Oct  Bill INV-0121    +  9,800  |
|                       Balance 38,450
+------------------------------------+
| [ Receive Payment ]   [ New Bill ] |
+------------------------------------+
```

### 9.4 Add Item (I3)

```text
+------------------------------------+
| <  Add Item                 [Save] |
+------------------------------------+
| Name*     [ PVC Pipe 1 inch ISI  ] |
| Category  [ Plumbing          v  ] |
| Code      [ 8901234 ]   [scan]     |
| Unit*     [ Metre  v ]             |
| Selling price*  [ 85 ]  GST [18% v]|
| Purchase price  [ 62 ]  HSN [3917] |
| Opening stock   [ 120 ]            |
| Low stock alert [ 20 ]             |
| v More units: 1 Coil = 100 Metre   |
| v Hardware details                 |
|     Material [ PVC v ] Size [ 1" ] |
|     Brand [ Supreme ]  Warranty [ ]|
| v Photo                            |
+------------------------------------+
```

### 9.5 Modules and Features (S4)

```text
+------------------------------------+
| <  Modules & Features              |
+------------------------------------+
| [ Search features...             ] |
| BASIC                              |
|  Billing and GST            [ ON ] |
|  Party khata                [ ON ] |
|  Stock and purchases        [ ON ] |
| ADVANCED                           |
|  Multiple locations         [ off ]|
|  Batch and expiry           [ off ]|
|  Tally-style accounting     [ off ]|
|    needs: Billing                  |
|  AI Agent                   [ off ]|
|    needs: API key                  |
+------------------------------------+
```

### 9.6 Hardware Estimate (HW1)

```text
+------------------------------------+
| <  Estimate - Site: Gupta Villa    |
+------------------------------------+
| Room: Bathroom 1                   |
| Floor area   6 x 8 ft = 48 sq ft   |
| Wall area    28 ft x 8 ft = 224    |
| Wastage      [ 10 % ]              |
+------------------------------------+
| Floor Tile 12x12   (14 sq ft / box)|
|   Need 53 sq ft  ->  4 boxes       |
| Wall Tile 12x18    (14 sq ft / box)|
|   Need 246 sq ft ->  18 boxes      |
+------------------------------------+
| [ + Add room ]  [ Add to Quotation ]
+------------------------------------+
```

### 9.7 Medical Bill Line (M1)

```text
+------------------------------------+
| Azithral 500 (strip of 5)          |
| Salt: Azithromycin 500 mg          |
| Batch [ B2301 v ]  Exp 08/2027     |
| MRP 118.00         Stock 24 strips |
| Qty [ 1 ] Strip   or  [ 3 ] Tabs   |
| (!) Schedule H: prescription needed|
| Doctor  [ Dr. Mehta ]  Reg [ ... ] |
| Patient [ Sunita ]     Age [ 34 ]  |
| [ Substitutes (3) ]       [ Add ]  |
+------------------------------------+
```

### 9.8 Clothing Variant Matrix (C1)

```text
+------------------------------------+
| Article: Cotton Kurta   KT-204     |
|          S    M    L    XL   XXL   |
| Blue   [ 2 ] [ 4 ] [ 4 ] [ 2 ] [ 0 ]|
| White  [ 0 ] [ 3 ] [ 3 ] [ 1 ] [ 0 ]|
| [ + Colour ]            [ + Size ] |
| Barcode per variant: [ Generate ]  |
+------------------------------------+
```

### 9.9 Kirana Quick Bill (K1)

```text
+------------------------------------+
| <  Quick Bill            Rs 612.50 |
+------------------------------------+
| [Sugar][Atta][Oil][Rice][Tea][Salt]|
| [Milk ][Soap][Dal ][ + more ...   ]|
+------------------------------------+
| Sugar     1.500 kg x 44    66.00   |
| Atta      5.000 kg x 38   190.00   |
| Oil 1L    1 x 156         156.00   |
+------------------------------------+
| [ 7 ][ 8 ][ 9 ]   Weight [ 1.500 ] |
| [ 4 ][ 5 ][ 6 ]                    |
| [ 1 ][ 2 ][ 3 ]  [ Cash ][ Udhaar ]|
| [ . ][ 0 ][ < ]  [   PAY  612.50 ] |
+------------------------------------+
```

### 9.10 AI Chat (AI1)

```text
+------------------------------------+
| <  BizOne AI               [ New ] |
+------------------------------------+
| You: Kitna udhaar baaki hai?       |
|                                    |
| AI: Total to receive Rs 1,42,300   |
|     from 18 parties. Top 3:        |
|     Ramesh   38,450                |
|     Anil     21,900                |
|     Gupta    17,200                |
|     [ View all ] [ Draft reminders ]
+------------------------------------+
| Proposal: 4 reminder drafts        |
| [ Reject ]              [ Approve ]|
+------------------------------------+
| [ Ask anything...          ] [send]|
+------------------------------------+
```

### 9.11 Desktop Billing (B2)

```text
+--------+-------------------------------------------+------------------+
| Home   | New Bill  INV-0143          [Draft]       | Party            |
| Bills  +-------------------------------------------+ Ramesh Contractor|
| Parties| [scan] [ Search item or code...         ] | Balance 38,450   |
| Items  | # Item          Qty  Unit  Rate  Disc  Amt|------------------|
| Purch. | 1 PVC Pipe 1"    3   Mtr    85    5%  242 | Payment          |
| Pay.   | 2 Wall Tile     4   Box   540    0  2160 | (Cash)(UPI)(Card)|
| Exp.   | + Add row (Enter)                         | (Credit)         |
| Reports|-------------------------------------------| Received [     ] |
| AI     |            Subtotal 2,402.25  GST 432.41  | Balance  [     ] |
| Settings|           TOTAL 2,835.00                 | [Save] [Print]   |
+--------+-------------------------------------------+------------------+
```

---

## 10. User Flows

1. **First setup:** run setup script → login → onboarding checklist (logo, address, GSTIN) → add first item → make first bill → share bill.
2. **Counter sale:** New Bill → scan or search items → enter payment mode → Save & Share (link, print, PDF).
3. **Udhaar sale and collection:** New Bill with Credit → party balance rises → later Parties → party → Receive Payment → allocate to bills → receipt shared.
4. **Purchase and stock:** New Purchase → supplier, items, freight → save → stock increases, supplier payable updates.
5. **Low stock to reorder:** Home alert → Items low-stock tab → select items → create purchase draft.
6. **Return:** Bill detail → Return → choose lines and quantities → credit note → stock and balance update.
7. **Backup:** Settings → Backup → Backup now → optional passphrase → file downloads; restore: choose file → checksum and preview → recovery backup → confirm → restore.
8. **Turn on a module:** Settings → Modules → toggle → dependency prompt → confirm → menu appears.
9. **Ask AI:** AI chat → question → table or chart → optional proposal → Owner approves.

---

## 11. Feature Catalogue

**B** = Basic (on by default). **A** = Advanced (off by default). Phase = first roadmap phase where it ships.

| Module | Feature | Level | Phase |
|---|---|---|---|
| Dashboard | Simple dashboard | B | P1 |
| | Advanced analytics and comparisons | A | P7 |
| Billing | Fast counter bill, GST and non-GST, discount, round-off, amount in words | B | P1 |
| | Quotation and convert to bill | B | P1 |
| | Share link, print, PDF | B | P1 |
| | Sales return and credit note | B | P3 |
| | Sales orders and delivery challans | A | P7 |
| | POS-lite: held bills, split payment, cash register, offline queue | A | P7 |
| | Recurring invoices | A | P7 |
| | E-invoice and e-way bill via GSP | A | P7 |
| Parties and Khata | Parties, ledger, to receive and to give | B | P1 |
| | Reminder text and statement share | B | P1 |
| | Credit limit and credit period, price tiers | A | P7 |
| | Leads and follow-ups | A | P7 |
| | Loyalty points | A | P7 |
| Inventory | Items, categories, units and conversions, stock, low-stock alert | B | P1 |
| | Opening stock and adjustments | B | P3 |
| | Barcode generate and scan, labels | B | P3 |
| | Multiple locations and transfers | A | P7 |
| | Batch and expiry | A (on in Medical) | P4 |
| | Variants | A (on in Clothing) | P4 |
| | Serial and IMEI | A | P7 |
| | Physical count, valuation, reorder suggestions | A | P7 |
| Purchases | Purchase bills and returns | B | P3 |
| | Purchase orders, goods receipt, landed cost | A | P7 |
| Payments | Receive and give, modes, partial, receipts | B | P1 |
| | Cheque and post-dated cheque register | A | P7 |
| | UPI QR on bill | A | P3 |
| Expenses | Expense entry and categories | B | P3 |
| | Recurring expenses | A | P7 |
| Accounting | Simple ledgers: cash book, bank book, day book, profit estimate | B | P3 |
| | Tally-style double entry, trial balance, P&L, balance sheet, reconciliation | A | P7 |
| Tax | GST rates, HSN, CGST/SGST/IGST, GST summary | B | P3 |
| | GSTR data, ITC reconciliation, TDS/TCS | A | P7 |
| Reports | Fixed standard reports | B | P3 |
| Team | Owner and fixed roles | B | P2 |
| | Audit log viewer | B | P3 |
| Messaging | Share by link and copy text | B | P1 |
| | WhatsApp, SMS, email from the system (owner sets provider) | A | P7 |
| Data | Excel/CSV import and export | B | P3 |
| Backup | Local backup and restore | B | P3 |
| | Google Drive backup and restore | A | P6 |
| AI | AI Agent: chat, analytics, playbooks | A | P6 |
| Other | Manufacturing basics, projects and service, HR and payroll, assets, logistics | A | P7 |
| Language | English and Hindi | B | P1 |

The module registry is data in `config/modules.config.ts`. Adding a module adds a registry entry and code, not hand-edited menus.

### 11.1 Module Switch Behaviour

- Off: menu, fields, report entries, and AI tools are hidden; RPC calls are rejected; data is kept.
- Dependencies are shown before switching (for example e-invoice needs GST).
- A module needed by another cannot be switched off until the other is off.
- Packs can mark modules as required (Medical requires batch and expiry).
- Only the Owner can switch modules; each change is audited.

---

## 12. Core Business Rules

### 12.1 Billing

- Bill types: GST invoice, bill of supply, quotation, sales return (credit note).
- Number series per financial year with a locked sequence function.
- Issued bills are immutable; corrections use void or credit note.
- Business and party details are snapshotted at issue.
- Totals, discount, tax, and round-off are computed in one RPC and stored. One rounding function exists in SQL and is mirrored in `core/money.ts`; tests prove they match.
- Header and lines save in one transaction. Idempotency keys stop duplicate submits.
- Share links use long random tokens, optional expiry, show a minimal view-only snapshot, can be revoked, and are rate limited.

### 12.2 Khata

- Party balance = opening balance + bills − payments − returns (for customers); reversed for suppliers.
- "You'll get" and "You'll give" totals come from database views.
- Payments allocate to bills (oldest first by default, or chosen); advances stay on account.
- Corrections use reversal entries, never silent deletion.
- Reminder text includes party name, amount, due bill list, and optional UPI link; it is shared through the phone's share sheet.

### 12.3 Inventory

- Stock ledger is insert-only; balances are cached by triggers.
- Items have a base unit and alternate units with conversion factors (box ↔ piece ↔ sq ft, coil ↔ metre, bag ↔ kg, strip ↔ tablet, carton ↔ packet). Entries use any unit; storage is in the base unit.
- Negative stock is blocked by default (developer-configurable).
- Adjustments need a reason and are audited.
- Purchase price and profit are hidden from roles without permission.

### 12.4 Payments and Expenses

Modes: cash, UPI, card, bank transfer, cheque, other. Partial payment, advance, and receipt sharing are supported. Expenses have category, amount, mode, date, note, and optional attachment.

### 12.5 Accounting

- **Basic:** party khata, cash book, bank book, day book, profit estimate (sales − purchase cost − expenses, labelled "estimate").
- **Advanced:** account groups and ledgers, vouchers (Sales, Purchase, Receipt, Payment, Journal, Contra, Debit Note, Credit Note), automatic posting from bills, purchases, payments, expenses, and adjustments, balanced vouchers enforced by a deferred constraint, trial balance, P&L, balance sheet, cash flow, bill-wise tracking, bank reconciliation, cost centres, budgets, year closing and lock dates. Enabling it on an existing business runs a guided opening-balance migration with preview and Owner confirmation.

### 12.6 GST and Tax

- **Basic:** GST rate per item, CGST/SGST/IGST by place of supply, HSN/SAC, inclusive or exclusive prices, composition and unregistered modes, GST summary by rate.
- **Advanced:** GSTR-1 and GSTR-3B data, HSN summary, GSTR-2A/2B import with ITC reconciliation, reverse charge, e-invoice and e-way bill through a GSP the owner configures, TDS/TCS registers. A `TaxEngine` interface lets developers add other regions.

---

## 13. Business Packs

Each pack sets default modules, extra fields and rules, seeds categories and tax defaults, and ships demo data and Hindi labels. Developers add packs from `_template`.

### 13.1 Kirana / Grocery

- Loose items by weight or volume with decimal quantity; carton-to-packet conversion.
- Quick-bill screen with item tiles and a numeric keypad; barcode first.
- Udhaar emphasis: credit sale in one tap, monthly statement, reminder shortcuts.
- MRP and selling price both stored; bill shows saving from MRP.
- Weighing-scale input through a developer adapter.
- Home-delivery flag with delivery charge.
- Daily rate update screen with price history.
- Reports: fast and slow movers, low margin items.

### 13.2 Medical Store

- Required modules: batch and expiry (always on).
- Item fields: brand, salt/composition, manufacturer, dosage form, pack size, schedule (OTC, H, H1, X, narcotic), storage note, MRP, GST rate, HSN.
- Units: strip, tablet, bottle, vial; loose-tablet sale.
- Batch and expiry: batch number, manufacturing and expiry date, batch-wise stock and MRP, first-expiry-first-out suggestion, expired stock cannot be sold, near-expiry alerts (days configurable), supplier return and credit note for expired or near-expiry stock.
- Substitutes: same-salt items with stock and price.
- Prescription and registers: doctor name and registration number, patient name, age, phone, optional prescription image; Schedule H/H1 and narcotic register entries created automatically on sale with configurable columns, printable and exportable.
- Bill extras: drug licence numbers, pharmacist name, batch and expiry per line; scheduled-drug sales require the mandatory fields before issue (rules configurable in code).
- Reports: batch-wise stock, expiry (30, 60, 90 days), schedule register, supplier-wise purchase, rate-wise GST, margin on MRP.

### 13.3 Clothing (Saree, Readymade, All Cloth Businesses)

- Article fields: design number, brand, category (saree, shirt, kurta, trouser, lehenga, kids, innerwear, fabric by metre), fabric, colour, pattern or work type, size, season, gender and age group, photo, wholesale and retail price, MRP.
- Variant matrix (size × colour) with one entry screen and barcode per variant.
- Unique-piece mode for designer sarees: one barcode per piece.
- Saree extras: blouse piece, fall and pico service and charge, length in metres.
- By-the-metre selling for fabric with remaining length per roll.
- Purchase with size curve (quantities per size in one row) and photo capture.
- Exchange and return rules with exchange credit note.
- Season schemes (buy X get Y, percentage by category) defined in code by a developer.
- Alteration and stitching jobs (advanced).
- Reports: size-wise and colour-wise sales, slow stock by season, design performance, stock ageing, margin by brand.

### 13.4 Hardware (replaces Tiles & Sanitaryware)

For hardware and building-material shops: tiles, sanitaryware, plumbing, electrical, paint, tools, fasteners, fittings, cement, steel, and similar.

**Category attribute templates.** Each category has its own detail fields (set by the pack, adjustable by a developer):

| Category | Typical details |
|---|---|
| Tiles | Size, finish, shade, design, application (floor, wall, outdoor), grade, pieces and sq ft per box |
| Sanitaryware and bath fittings | Type (WC, basin, tap, shower), colour, mounting, warranty |
| Plumbing (pipes and fittings) | Material (PVC, CPVC, UPVC, GI, HDPE), size (mm or inch), class or schedule, length, ISI mark |
| Electrical | Type (wire, switch, MCB, light, fan), rating, core and gauge, colour, brand, warranty |
| Paint and chemicals | Base, shade code, finish, pack size (litre or kg), batch |
| Tools and power tools | Brand, model, power rating, warranty, serial number |
| Fasteners and fittings | Type (nut, bolt, screw, hinge, lock), size, material, finish |
| Building material | Type (cement, steel, sand, aggregate, bricks, adhesive), grade, weight per bag or bundle |

**Units and conversions.** Box ↔ piece ↔ sq ft ↔ sq m (tiles); coil ↔ metre (wire, pipe); bag ↔ kg (cement); ton ↔ kg (steel); bundle ↔ piece; dozen ↔ piece; litre ↔ ml. Quantity and area (or length or weight) are both shown on the bill. Whole-box rounding is optional.

**Selling by cut length or loose weight.** Wire, pipe, and rope can be sold in cut lengths from a coil with the remaining length tracked. Fasteners can be sold by piece or by weight.

**Pricing.**
- List-price-with-discount: store brand list price and a discount percentage; bill price = list − discount.
- Price tiers: retail, contractor, plumber, electrician, mason, architect, dealer.
- Brand-wise rate lists with date and history.
- **Rate list import:** upload a supplier Excel rate list, preview changes, and apply (screen HW4). Hardware rates change often, so this is a core flow.
- Quantity slabs and brand schemes (code-configured).

**Estimate calculator (HW1).** Room dimensions or area plus wastage percentage gives boxes or pieces for tiles; paint coverage (area ÷ coverage per litre × coats) gives litres; wire or pipe length by run. Results add to a quotation, with room-wise grouping.

**Batch and shade (advanced, for tiles and paint).** Each lot has a batch and shade or caliber; billing suggests the same batch for an order and warns when batches are mixed in one room or project; a batch can be reserved for a project.

**Warranty register (HW3).** Items with warranty store the period at sale; the register lists active warranties by customer and serial number, and records claims and supplier follow-up.

**Breakage, damage, and claims (HW5).** Record at receipt, storage, or delivery with reason and who bears the cost (supplier, transporter, own); links to stock adjustment and supplier debit note.

**Referrer commission (HW6).** Attach a plumber, electrician, mason, contractor, or architect to a bill; commission by percentage or per unit; commission ledger and payout record.

**Project and site sales (HW2).** Quotation per site, stage-wise delivery and billing, advance and credit, running balance per site, consolidated site statement. Parties can have multiple sites.

**Delivery (advanced, HW7).** Challan with vehicle, driver, transporter, loading and unloading charges, delivery status, proof of delivery photo (compressed).

**Display and samples.** Track sample boxes and display pieces separately from saleable stock; sell-off of display pieces recorded.

**Combos and sets.** Bundles (for example a bathroom set) with bundle price.

**Reports.** Brand-wise and category-wise sales, rate change history, dead and slow stock, warranty due, commission due, site-wise balance, breakage loss.

### 13.5 General Retail

Barcode billing, brands and categories, optional variants, discounts, simple loyalty, returns and exchanges, daily cash summary.

### 13.6 Wholesale

Price tiers and quantity slabs, party-wise rates, orders and challans, credit limit and period, transport details, agent commission, dues ageing.

### 13.7 Service

Service items with SAC, quotations, recurring invoices, job and ticket tracking and AMC (advanced), expense tagging.

### 13.8 Adding a Pack

Copy `src/packs/_template`, follow `docs/create-a-pack.md`, add migrations and seeds, register the pack, and add tests and demo data. Community packs (for example mobile and electronics with IMEI, stationery, jewellery, restaurant) are accepted by pull request.

---

## 14. Dashboard and Reports

### 14.1 Basic Dashboard

Today's sales, month's sales, cash received, you'll get, you'll give, low-stock count, near-expiry count (Medical), warranty due (Hardware), recent bills, one 7-day sales chart, alerts list.

### 14.2 Advanced Analytics (A)

Date filters and period comparison; sales by item, category, brand, party, user, location; margin where cost data exists; stock value; dead and slow stock; dues ageing; collection trend; pack analytics; drill-down; CSV export.

### 14.3 Standard Reports (fixed, not user-built)

| Group | Reports |
|---|---|
| Sales | Sales register, item-wise, party-wise, user-wise, returns, quotation status |
| Purchase | Purchase register, supplier-wise |
| Stock | Stock summary, item ledger, low stock, stock value |
| Khata | Party-wise dues, ageing, party statement |
| Money | Day book, cash book, bank book, expenses, profit estimate |
| Tax | GST summary by rate, HSN summary |
| Pack | Kirana movers, Medical expiry and schedule register, Clothing size-colour, Hardware brand-wise and warranty |

Reports filter, sort, print, and export to PDF, Excel, and CSV, and follow role permissions.

### 14.4 Definitions

- **Sales:** issued, non-void bills minus credit notes.
- **Outstanding:** bill total minus allocated payments and credit notes.
- **Profit:** shown only where cost data exists; otherwise labelled estimate.
All values come from database views or RPC functions.

---

## 15. Backup, Restore, Import, Export

### 15.1 Backup Contents

Business data, settings, roles (not passwords), module configuration, schema version. Excluded: Supabase keys, AI keys, Drive tokens, provider credentials, auth secrets. Attachments only when "include files" is chosen and within size limits.

### 15.2 Local Backup and Restore (Basic)

- **Backup:** the app reads data through normal RLS queries, builds a compressed archive with a checksum in the browser, and downloads it. Optional passphrase encryption (AES-GCM; the passphrase never leaves the device and cannot be recovered).
- **Restore:** upload file → verify checksum and schema version → show preview (record counts, date range) → Owner re-authentication → automatic recovery backup → transactional restore through an RPC → relationship checks → audit entry → recovery guidance on failure.
- Restore replaces data after strong confirmation; merge restore is not supported in v1.
- Large data is processed in chunks with progress and cancel.
- `docs/backup-restore.md` also covers `pg_dump` and Supabase CLI for developers.

### 15.3 Google Drive Backup (Advanced, Phase 6)

- Each owner creates their own Google Cloud OAuth client (`docs/google-drive-setup.md`) and enters its client credentials in Settings → Integrations. The redirect/callback URL is shown in the app; credentials are encrypted server-side.
- Minimal `drive.file` scope: BizOne sees only files it creates.
- Refresh tokens are encrypted with `APP_ENCRYPTION_KEY`, stored server-side, revocable, and excluded from backups.
- Backup now, daily or weekly schedule (using `pg_cron` where available or the keep-alive workflow **(verify)**), keep last N, list backups, restore through the same flow as local, optional passphrase encryption, resumable chunked upload, failure notification.

### 15.4 Reminders

Home shows a reminder when no backup exists in the last 7 days (configurable). High-risk actions (restore, reset) require a fresh backup.

### 15.5 Import and Export

- Excel/CSV templates for parties, items, opening stock, opening balances, and rate lists.
- Import flow: choose template → upload → column mapping → preview with errors → duplicate check (by code, phone, or GSTIN) → confirm. Existing records are updated only when the user picks "update by code".
- Error report is downloadable.
- Export any list or report to CSV, Excel, or PDF; exports are role-checked and audited.
- Imports from other apps (Vyapar, Tally) are done through their Excel exports using the same templates.

---

## 16. AI Integration and the BizOne AI Agent

AI is an optional module, off until the owner adds an API key and model. It uses only fixed, permission-checked BizOne tools. The owner pays the provider directly.

### 16.1 Provider Settings (S11)

| Item | Spec |
|---|---|
| Providers | OpenAI (ChatGPT), Anthropic Claude, Google Gemini, OpenRouter, xAI Grok, Custom OpenAI-compatible (Groq, Mistral, DeepSeek, Together, local gateways, others) |
| Fields | Provider, base URL (auto-filled, editable for custom), API key, model ID (free text with suggestions), display name, timeouts, max output tokens, temperature (where supported), default toggle, **Test connection** |
| Routing | Separate model for chat, analytics, and automation, with default fallback |
| Capabilities | Stored flags per config (tool calling, structured output, vision, context size). Without tool calling the agent answers read-only questions and says so |
| Key protection | Encrypted server-side (Vault or `APP_ENCRYPTION_KEY`), masked in UI, never sent to browser code, prompts, logs, or backups; replace or remove anytime |
| Endpoint safety | HTTPS only; private, loopback, and link-local targets blocked (a developer may relax this in code for a local model, with a warning) |
| Limits | Per-user and monthly request and token limits; measured and estimated usage shown |
| Disclosure | The UI states that the needed context goes to the provider the owner chose, under that provider's own retention and training policy |

### 16.2 Agent Modes

**Chat (AI1).** Questions in English, Hindi, or Hinglish over authorized data: today's sales, who owes money, stock of an item, near-expiry medicines, slow-moving items, top brands, GST summary. Replies as text, tables, KPI cards, and charts. "Ask AI" on a record sends only that record's authorized fields. History with rename and delete.

**Analytics.** Sales trends and reasons, margin concerns, dead and slow stock with clearance ideas, reorder suggestions, collection-risk ranking, cash outlook, anomalies (duplicate bills, odd discounts, selling below cost, expired stock handling). Every number comes from backend report functions; the model explains and cites report, period, and definition.

**Automation.** Fixed built-in playbooks the owner can switch on or off (no builder): overdue reminder drafts, open-quotation follow-ups, reorder suggestions, near-expiry alerts and return ideas (Medical), warranty due notices (Hardware), daily closing summary, weekly summary. The agent prepares drafts and proposals; nothing is sent or changed without approval. Only internal reminders or tasks can optionally auto-approve; money, stock, price, deletion, permission, and customer-facing sends never auto-approve.

### 16.3 Tools (fixed allowlist)

Each tool has a name, input schema, permission requirement, module requirement, row and size limits, safe errors, and an audit rule. Tools run as the calling user (RLS applies); scheduled playbooks use a restricted least-privilege role.

- **Read:** `search_parties`, `get_party_statement`, `search_bills`, `get_sales_summary`, `get_purchase_summary`, `get_stock_levels`, `get_item_ledger`, `get_low_stock`, `get_slow_moving_items`, `get_party_dues_ageing`, `get_expense_summary`, `get_gst_summary`, `get_cash_position`, `get_profit_estimate`, `detect_anomalies`, `generate_chart_data`. Pack tools: `get_near_expiry`, `get_schedule_register` (Medical), `get_size_colour_sales` (Clothing), `estimate_material_required`, `get_warranty_due` (Hardware).
- **Proposal (never write directly):** `prepare_party_create`, `prepare_party_update`, `prepare_bill_draft`, `prepare_purchase_draft`, `prepare_expense_draft`, `prepare_stock_adjustment`, `prepare_reminder_message`, `request_record_deletion`.
- Tools of disabled modules or inactive packs are not exposed and are rejected server-side. The model gets no database credentials, writes no SQL, calls no arbitrary function, and cannot bypass RLS.

### 16.4 Request Flow

1. Edge Function authenticates the user's JWT.
2. Check AI module flag, permissions, and usage limits.
3. Load the system prompt and only the tools allowed for enabled modules and the user's role.
4. Decrypt the key inside the function.
5. Call the provider; validate each tool call and its arguments; re-check authorization.
6. Run read tools or store a proposal; return text, table, chart, or approval card.
7. Log usage and audit data.

### 16.5 Approvals (AI2)

Proposed changes need Owner approval. The card shows action, targets, current and proposed values, and consequences. Approval tokens are unguessable, time-limited, bound to the payload hash, and invalid if data or permissions change. The server revalidates before executing in one transaction. The AI cannot approve its own proposal. Bulk changes show a detailed preview. Financial records use void, reversal, or archive flows.

### 16.6 Prompt, Memory, Safety

A fixed default system prompt ships in code (developers can change it); owners may add short business notes such as preferred language and terms. The prompt is not a security boundary; RLS, tool validation, and approvals are. Record text (notes, descriptions, imports) is treated as untrusted data. Only needed fields are returned, role-restricted fields are masked, and no secrets or session tokens reach providers. History and simple preference memory can be switched off, viewed, and cleared. Provider errors, rate limits, bad outputs, and denied tools give safe messages and never cause partial changes.

---

## 17. Settings

Settings are grouped into clear categories. On desktop, categories may appear as horizontal tabs or a compact sub-topbar within the Settings page; they must not create a second sidebar.

1. Business profile
2. Invoice basics
3. Modules & Features
4. Users and roles
5. Appearance and language
6. Notifications
7. Integrations (optional providers and credentials)
8. Messaging (advanced)
9. AI and Agent
10. Backup and restore
11. Import and export
12. Security (sessions, optional TOTP)
13. Activity log
14. Demo data and reset
15. Storage usage
16. Help
17. About (name, version, license, maintainer)

### 17.1 Integrations Settings

- Optional integrations are configured inside BizOne, not as mandatory `.env` variables.
- Each integration has its own settings panel with enable/disable, credential fields, connection/test action, status, last-checked time, and remove/rotate credential action.
- Examples: AI providers, Google Drive, SMTP/email, WhatsApp/SMS gateways, and other supported providers.
- Credentials are encrypted server-side before persistence and are masked after save. Plaintext credentials are never fetched back to the browser.
- `APP_ENCRYPTION_KEY` (or a supported server-side vault) must be configured before an integration that stores secrets can be enabled.
- OAuth integrations show provider setup instructions and the exact redirect/callback URL.
- Missing optional credentials must never block setup, login, billing, khata, inventory, or local backup.
- No Settings page shows or edits Supabase service-role keys, database passwords, or server environment variables. The public Supabase URL and publishable/anon key are deployment configuration, not editable integration credentials.

### 17.2 User Profile versus User Administration

Every user manages their own display name, phone number, profile photo, and password from **Profile**. The Owner/authorized administrator manages invitations or staff creation, role assignment, permissions, and activation/deactivation from **Users and roles**. A user cannot grant themselves additional permissions.

## 18. Notifications

In-app only in the basic release (bell icon with list).

| Event | Audience | Rule |
|---|---|---|
| Low stock | Owner, Manager, Storekeeper | Stock at or below the alert level |
| Near expiry | Owner, Storekeeper | Within configured days (Medical) |
| Overdue dues | Owner, Manager | Past credit period, or older than set days |
| Warranty due | Owner, Manager | Within 30 days (Hardware) |
| Backup reminder | Owner | No backup in 7 days |
| Storage warning | Owner | 70% and 90% of Free-plan limit |
| AI proposal | Owner | New proposal waiting |

Messaging channels (WhatsApp, SMS, email) are an advanced feature the owner sets up with their own provider; templates use merge fields, and delivery logs are kept.

---

## 19. Demo Data, First Run, Reset

- Each pack ships consistent demo data (items, parties, purchases, bills, payments, expenses; Medical includes batches with expiry and scheduled-drug sales; Hardware includes tiles, plumbing, electrical, paint, and a site ledger). Demo rows carry an `is_demo` flag; names are never used for matching.
- **Remove demo data:** Owner re-authentication, preview, dependency check, deletes only flagged rows, audit event.
- **Reset:** demo only, selected operational data, or empty workspace. A full reset needs a fresh backup, typed confirmation, and a data-loss summary, and never removes the schema, security setup, or the Owner.

---

## 20. Database

### 20.1 Principles

Single-business schema; primary and foreign keys; check constraints; `created_at`, `updated_at`, `created_by`; `numeric(15,2)` money and `numeric(15,3)` quantity; soft delete or archive; unique document numbers per series and year; indexes for common paths; ordered migrations; version column for optimistic concurrency; compact types for Free-plan efficiency.

### 20.2 Table Groups

| Group | Tables |
|---|---|
| Core | `business`, `profiles` (including profile image reference), `roles`, `role_permissions`, `modules_state`, `settings`, `numbering_series`, `financial_years`, `files`, `file_links` / ordered attachment relations, `notifications`, `audit_logs`, `backup_records`, `share_links` |
| Parties | `parties`, `party_addresses`, `sites`, `price_tiers`, `leads`, `activities` |
| Items and stock | `items`, `item_categories`, `category_attributes`, `brands`, `item_units`, `unit_conversions`, `item_variants`, `locations`, `stock_ledger`, `stock_balances`, `batches`, `stock_transfers`, `stock_adjustments`, `breakage_records`, `serials`, `rate_lists`, `rate_list_items` |
| Sales and purchase | `quotations`, `sales_orders`, `challans`, `bills`, `bill_items`, `sales_returns`, `purchase_bills`, `purchase_items`, `purchase_orders`, `grns`, `purchase_returns` |
| Money | `payments`, `payment_allocations`, `cheques`, `expenses`, `expense_categories` |
| Pack tables | Medical: `prescriptions`, `schedule_register`, `drug_licences`. Clothing: `size_curves`, `alterations`. Hardware: `estimates`, `estimate_rooms`, `warranties`, `warranty_claims`, `commissions`, `referrers`, `site_stages`, `deliveries` |
| Accounting (adv.) | `account_groups`, `ledgers`, `vouchers`, `voucher_entries`, `bill_references`, `bank_accounts`, `bank_statement_lines`, `reconciliations`, `cost_centres`, `budgets` |
| Tax | `tax_rates`, `hsn_codes`, `einvoice_records`, `eway_bills`, `tds_entries` |
| AI | `ai_provider_configs`, `ai_routing`, `ai_conversations`, `ai_messages`, `ai_memory_entries`, `ai_playbooks`, `ai_agent_runs`, `ai_action_proposals`, `ai_approval_events`, `ai_usage_logs` |
| Integrations | `drive_connections`, `backup_schedules` |

### 20.3 Critical Rules

- RPC functions call `require_module('key')` before work.
- Issued bills and posted vouchers change only through void, credit-note, or alter RPCs that keep history.
- Stock ledger rows are insert-only; corrections are new rows; expired batches cannot be sold (Medical).
- Document numbers come from a locked sequence function.
- Voucher debit equals credit (deferred constraint) when accounting is on.
- Secrets are stored only as encrypted values or Vault references, never in ordinary columns.
- Image and file metadata is stored centrally; linked records use ordered attachment relations to support multiple item images and context-specific single/multiple uploads.
- Heavy aggregates use views or on-demand refreshed materialized views.

---

## 21. Security, Quality, and Performance

### 21.1 Security

RLS on every table with pgTAP tests; server-side validation and constraints; React output escaping; Content Security Policy and HTTPS guidance; private storage with short-lived signed URLs; upload type and size validation; rate limiting on login and share links; dependency scanning; safe errors with no stack traces or secrets; build-time guard against secrets in `VITE_` variables.

### 21.2 Audit Log

Append-only, written by triggers: logins and failures, bill issue and void, price changes, stock adjustments, payment create and reverse, user and role changes, module switches, backups and restores, AI key changes, AI proposals and approvals, exports, resets. Passwords, API keys, and tokens are never logged.

### 21.3 Performance Targets

| Target | Value |
|---|---|
| First load on mid-range phone, 4G | Under 3 s to interactive |
| Add item to bill after scan or tap | Under 100 ms |
| Item search | Under 200 ms for 50,000 items |
| Save bill | Under 1 s on normal network |
| Lists | Virtualized; 60 fps scrolling |
| Initial JS (core shell) | Under 250 KB gzipped; modules and packs load on demand |
| Data size | Three years of a small shop's data fits within Free-plan limits (to be measured and verified) |

### 21.4 Support Matrix

Latest two versions of Chrome, Edge, Firefox, Safari; Android 8+ (Chrome) and iOS 15+ (Safari) as installable PWA. Screen sizes from 360 px to large desktop.

### 21.5 Errors and Offline

Handle network loss, RLS denial, validation and constraint errors, concurrent edits, upload failure, backup and restore failure, Drive token expiry, Edge Function timeout, AI errors, and a paused Supabase project (clear message and steps). Money operations roll back fully on failure. App shell works offline; offline billing queue with reserved bill-number ranges and idempotent sync is an advanced feature.

---

## 22. Build Roadmap

The product is delivered in **seven feature-based phases**. Each phase is a vertical slice: frontend, database schema/migrations, backend logic (RPC/Edge Functions as needed), RLS/permissions, validation, error handling, and automated/manual tests are developed together. There is **no standalone backend phase** and no phase that delivers only disconnected mock screens.

The frontend and backend are developed in parallel throughout every phase. A phase is complete only when its features work end-to-end against a real Supabase project and pass the phase acceptance tests. Mock data may be used for isolated UI prototyping and automated tests, but it is not the phase deliverable.

CI, deployment readiness, migrations, security checks, documentation, accessibility, performance, and regression testing are continuous responsibilities in all phases—not a separate phase that postpones usable software.

### 22.1 Overview

| Phase | Name | Main feature scope | Usable result |
|---|---|---|---|
| P1 | Foundation, authentication, profile & business setup | App shell, Supabase foundation, auth, roles, business profile, user profile, uploads, onboarding | Owner and staff can sign in and manage the business/profile on real data |
| P2 | Parties, khata & payments | Parties, customer/supplier ledgers, opening balances, payments, allocations, statements | Business can maintain party accounts and record/track dues and payments |
| P3 | Items & inventory | Items, categories, brands, units, multiple item images, stock ledger and adjustments | Business can maintain a real item catalogue and accurate stock |
| P4 | Billing & sales | Bills, quotations, returns, tax calculation, print/PDF/share, UPI QR | Business can create and manage real sales end-to-end |
| P5 | Purchases, expenses, basic accounting & reports | Purchases, expenses, cash/bank/day books, GST summaries, dashboards, reports, notifications | Business can operate and review day-to-day financial activity |
| P6 | Business packs, import/export & data management | Trade packs, bulk data operations, local/Drive backup, attachments | Supported business types can use their tailored workflows and protect/migrate data |
| P7 | Optional AI, advanced modules & v1.0 hardening | AI, advanced accounting/GST, offline/POS-lite, advanced operations, final hardening | Optional advanced capabilities with a stable v1.0 release |

### 22.2 Phase Details

**P1: Foundation, authentication, profile & business setup**

- Frontend: repository/app shell, design tokens, light/dark themes, English/Hindi, responsive components, exact five-control mobile navigation, one desktop sidebar, horizontal in-page Settings tabs, PWA shell, login/forgot-password screens, onboarding, dedicated User Profile, Business Profile, basic Settings, user menu.
- Backend/data: Supabase client and deployment configuration, core migrations, `business`, `profiles`, fixed roles/permissions, Auth integration, profile update functions, secure password change flow, business setup, module state, common `files` metadata and storage policies.
- Uploads: reusable single-image and multiple-image upload foundation; profile photo and business logo are first supported use cases. Establish the same service for later item photos, UPI QR images, and attachments.
- Security: RLS on all P1 tables, role checks, server-side validation, private storage, signed URLs, secret handling, audit events for profile/business/security changes.
- Tests: fresh-project setup, owner creation/login/logout, staff login and permission checks, profile name/phone/photo update, password change, email verification flow, business logo upload, storage access denial tests, responsive navigation and accessibility.
- Done when: a fresh installation can create an Owner and business; Owner/staff can sign in, edit permitted profile details, upload a profile photo and business logo, and use the app shell against real Supabase data.

**P2: Parties, khata & payments**

- Frontend: party list/detail, add/edit party, customer/supplier views, opening balance, ledger, receive/give payment, payment allocation, statement preview/share, due reminders.
- Backend/data: party and address tables, ledger/balance views, payment and allocation tables, transactional RPCs for payment posting/reversal, numbering where needed, audit records.
- Security: role-based party visibility and editing, permission checks for payment operations, no silent mutation of posted entries.
- Tests: opening balance, customer/supplier balance direction, partial and advance payments, allocation/reversal, statement totals, concurrent payment/idempotency, role access, Hindi labels.
- Done when: the business can create parties, maintain khata, record payments, and reconcile balances using persisted data.

**P3: Items & inventory**

- Frontend: item list/detail/form, categories, brands, units and conversions, stock summary/ledger, low-stock view, stock adjustment, image gallery manager.
- Backend/data: items, categories, brands, units/conversions, stock ledger and balances, adjustment RPCs, file-to-item ordered attachment relation, primary-image metadata.
- Uploads: multiple images per item with preview, reorder, primary-image selection, replace/remove, compression, upload progress, and permission-aware access.
- Security: purchase-cost visibility, stock-adjustment permissions, immutable stock ledger, storage ownership and linked-record authorization.
- Tests: unit conversion edge cases, stock ledger versus cached balances, adjustment audit, negative-stock policy, multiple image upload/reorder/delete, orphan-file cleanup, role access and search performance.
- Done when: the business can maintain a real catalogue with multiple photos per item and stock quantities reconcile after adjustments.

**P4: Billing & sales**

- Frontend: fast bill creation, bill list/detail, quotation list/form, sales return/credit note, print/share/PDF preview, invoice settings, UPI QR image management.
- Backend/data: bills and bill lines, numbering, server-calculated totals/taxes/rounding, issue/void/return RPCs, immutable issued documents, share links, payment integration points.
- Security: permission-checked price/discount overrides, server-side validation, idempotent submit, safe share-link access and revocation.
- Tests: SQL/client total parity, GST and non-GST calculations, inclusive/exclusive prices, rounding, issued-bill immutability, return and credit-note flows, duplicate-submit prevention, PDF/print layout, UPI QR image upload and rendering.
- Done when: the business can create, issue, print/share, return, and reconcile sales documents against real party and item records.

**P5: Purchases, expenses, basic accounting & reports**

- Frontend: purchase bills/returns, expense entry and attachments, cash/bank/day book, basic ledger summaries, dashboard, standard reports, notifications and activity log.
- Backend/data: purchase and purchase-item records, expense records/categories, payment links, report views/RPCs, notification rules, audit events, local backup/restore support.
- Security: transaction-safe purchase/expense posting, role-restricted reports and exports, audit coverage.
- Tests: purchase stock impact, supplier balance, expense totals, cash/bank/day-book reconciliation, GST summary against source documents, report permission filters, local backup/restore and recovery path.
- Done when: a small business can run and review a normal operating day including sales, purchases, payments, expenses, and reports.

**P6: Business packs, import/export & data management**

- Frontend: pack-specific fields and workflows, pack switch/setup, CSV/XLSX import mapping and preview, export, backup/restore screens, Google Drive settings and status, attachment inclusion options.
- Backend/data: pack migrations/seeds and module dependencies; import validation and batch processing; backup records; Drive connection/token storage and scheduled backup metadata.
- Integrations: Google OAuth client credentials are entered in Settings → Integrations and encrypted server-side. Local backup remains available without Drive credentials.
- Tests: end-to-end workflows for Kirana, Medical, Clothing, Hardware, General Retail, Wholesale, and Service; import duplicate/error handling; backup checksum/restore; Drive token encryption/revocation and restore; optional integration disabled path.
- Done when: each supported pack completes its key business workflow and a user can safely import/export and back up/restore business data.

**P7: Optional AI, advanced modules & v1.0 hardening**

- Frontend: optional AI chat/analytics/playbooks/approval screens, advanced accounting and GST screens, POS-lite/offline queue, advanced inventory and operational screens, integration status screens.
- Backend/data: AI provider gateway and allowlisted tools, encrypted provider credentials, proposals/approvals, advanced accounting vouchers, advanced GST data, offline idempotent sync, messaging and other enabled advanced modules.
- Integrations: AI, Google Drive, SMTP, WhatsApp/SMS, and other optional provider credentials remain configurable inside Settings; none is required for core installation.
- Tests: AI tool allowlist and role masking, prompt-injection and approval bypass tests, secrets absent from browser/logs/backups, accounting balance and reconciliation, offline duplicate prevention, GST data consistency, performance, security, accessibility, upgrade and full regression.
- Done when: all enabled modules pass acceptance criteria, optional features remain off until configured, documentation and deployment paths are verified, and **v1.0** is ready.

### 22.3 Continuous Delivery Requirements

These apply to every phase:
- Frontend and backend implementation proceed in parallel; migrations, RPCs/Edge Functions, RLS policies, and UI flows are reviewed as one feature.
- Every feature includes loading, empty, error, permission-denied, and (where applicable) offline states.
- Every phase includes unit, integration, database/RLS, and end-to-end tests relevant to its scope.
- Keep the previous phase's accepted functionality working; run regression tests before closing a phase.
- Maintain deployable builds, migration/rollback notes, changelog, security scanning, accessibility checks, and updated user/developer documentation.
- Do not mark a feature complete because a mock screen exists; completion requires a real end-to-end flow or a clearly documented external dependency.

### 22.4 Release Tags

Use release tags only for working, tested increments. Suggested milestones: P1 foundation preview, P3 core catalogue/khata milestone, P5 core-business beta, P6 pack/data-management beta, and P7 v1.0. A tag is not a substitute for phase acceptance tests.

## 23. Open-Source Project

- **License:** Apache-2.0 with `NOTICE`; free to use, modify, and redistribute, including commercially, under the license terms.
- **Trademarks:** `TRADEMARKS.md` states that the BizOne name and logo belong to BizOne Technologies, Apache-2.0 grants no trademark rights, and forks must rebrand (app name and logo are config values).
- **Repository:** README with screenshots and quick start, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY (private reporting), issue and PR templates, labels, CHANGELOG, semantic versioning, tagged releases, CI on every PR.
- **No secrets in the repo:** secret scanning in pre-commit and CI; `.env` is git-ignored.
- **Docs:** deployment guides, customization guide, pack guide, upgrade guide, security guide, Hindi quick start.
- **Community:** pack and translation contribution guidelines, roadmap file.

---

## 24. Acceptance Criteria

1. Public repository under Apache-2.0 with all project files in section 23.
2. A developer deploys in modes A to D using only the docs; `npm run setup` yields a working Owner login.
3. One install serves one business; no multi-tenant, quota, or super-admin code remains.
4. No secret reaches the browser; the env check and build guard catch misplaced secrets.
5. Developers can customize through config, packs, and hooks; the app has no end-user builders.
6. The Owner can switch modules on and off with dependency handling, protected pack-required modules, and preserved data.
7. Counter billing, returns, quotations, khata, reminders, share links, print, and PDF work; issued bills are immutable.
8. Payments, party balances, stock, and simple ledgers reconcile.
9. Each pack works as specified: Kirana, Medical, Clothing, Hardware.
10. Local backup and restore pass the checksum, preview, and recovery-backup tests; Drive backup works with the owner's own OAuth client.
11. AI works with OpenAI, Claude, Gemini, OpenRouter, Grok, and a custom OpenAI-compatible provider; keys never reach the browser, logs, or backups.
12. The AI Agent uses only allowlisted tools limited to enabled modules, the active pack, and the user's role; all proposals need approval; figures match reports.
13. Demo data reconciles; removal deletes only flagged records.
14. UI follows section 5: phone-first, accessible, Tabler Icons only, no emoji, simple default screens; mobile navigation has exactly five controls (Home, Bills, central Quick Actions, Parties, More), and desktop has one primary sidebar only.
15. Every signed-in user has a dedicated Profile screen to edit their own permitted name/phone, profile photo, and password; email changes require verification.
16. The reusable upload system supports single-image fields and multiple item images, including preview, reorder, primary selection, replace/remove, validation, compression, private storage, and permission checks.
17. Optional integration credentials (AI, Google Drive, SMTP, messaging, etc.) are configured in Settings and encrypted server-side; core setup and core business flows do not require them.
18. Every roadmap phase delivers an end-to-end usable increment with frontend, database, backend, RLS/permissions, and tests developed together; there is no standalone backend phase.
19. English and Hindi are available; user and developer documentation exist.
20. Security, integrity, deployment, upgrade, performance, and responsive tests pass.

---

## 25. Glossary (English and Hindi Labels)

| English | Hindi |
|---|---|
| Home | होम |
| Bill | बिल |
| Quotation | कोटेशन |
| Party | पार्टी |
| Khata | खाता |
| You'll get | लेना है |
| You'll give | देना है |
| Receive payment | पैसे लें |
| Item | सामान |
| Stock | स्टॉक |
| Low stock | कम स्टॉक |
| Unit | इकाई |
| Purchase | खरीद |
| Supplier | सप्लायर |
| Expense | खर्च |
| Report | रिपोर्ट |
| Discount | छूट |
| Balance | बाकी |
| Cash | नकद |
| Credit (udhaar) | उधार |
| Return | वापसी |
| Batch | बैच |
| Expiry | एक्सपायरी |
| Warranty | वारंटी |
| Estimate | अनुमान |
| Settings | सेटिंग्स |
| Backup | बैकअप |
| Restore | रीस्टोर |

---

## 26. Compliance and Responsibility Notice

BizOne ERP assists with billing, tax data, and records, including pharmacy registers. It does not guarantee legal or statutory compliance. Tax rates, register formats, and rules vary by state and change over time; the business owner and their adviser must verify them. The software is provided "as is" under Apache-2.0. Owners are responsible for their own backups, security updates, and regulatory compliance. Pharmacy registers and scheduled-drug rules must be checked with the licensing authority and a qualified pharmacist.

---

## 27. Risks and Open Questions

| Risk | Handling |
|---|---|
| Owners misconfigure Supabase or leak keys | Env check, clear guides, build-time guard |
| Free-plan limits, no managed backups, idle pause | Local and Drive backup, reminders, keep-alive, scale-up guide |
| Rules differ by state (pharmacy, GST) | Configurable rules, notice in section 26 |
| Forks drift from upstream | Stable extension points, versioning, upgrade guide |
| Support load on a free product | Strong docs, templates, community packs, optional paid customization by developers |
| Google OAuth friction | Local backup always works; owner-owned OAuth client with documented options |
| AI misuse, injection, cost | Allowlisted tools, RLS, approvals, owner-owned keys, limits |
| Pack quality varies | Template, required tests, demo data |

**Product decisions confirmed for v6.0:** five mobile controls with central Quick Actions; one install per business with multiple users; users can edit their own permitted profile details and password; multiple images per item; each phase must remain independently usable and preserve previous functionality; advanced Tally-style accounting stays optional.

**Remaining project-level questions:** GitHub organization and repository name; contribution sign-off style (DCO or CLA); whether to launch a documentation website; support channel (GitHub Discussions, Telegram, WhatsApp group); whether to publish ready-made Docker images.

---

## 28. Product Definition

BizOne is a free, open-source, phone-first small-business app inspired by the simplicity of Khatabook and Vyapar—not a Tally-style or enterprise-heavy ERP by default. Each owner deploys one business with multiple users on their own Supabase project and domain or local server. It starts with fast billing, party khata, items and stock, purchases, payments, expenses, GST basics, and reports. It grows through owner-switchable modules and business packs for Kirana, Medical, Clothing, Hardware, General Retail, Wholesale, and Service. Developers customize it through code; owners get a simple interface. Every phase is an independently usable end-to-end increment with frontend and backend developed together. Users have a dedicated profile screen; reusable uploads support business assets and multiple item images. Optional integrations are configured inside Settings, while only essential infrastructure secrets remain in environment configuration. Advanced accounting and the optional AI Agent remain off unless explicitly enabled and configured; local and optional Google Drive backups protect the data.
