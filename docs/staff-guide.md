# DecorBiz — Staff Operations Guide

This guide helps showroom managers, cashiers, storekeepers, accountants, and viewers work quickly and accurately inside `/ERP`.

---

## 1. Signing In & Role Permissions

Always open your showroom's private ERP URL (`https://<your-domain>/ERP`) from an approved showroom/office Wi-Fi IP address. Note: `/ERP` is strictly isolated from the customer website at `/` — customer emails cannot sign in to ERP, and staff accounts cannot place retail orders.

| Role | Typical Showroom Duties | Key Restrictions |
| :--- | :--- | :--- |
| **Manager** | Bills, purchases, stock, parties, online order fulfillment, delivery trips | Cannot change billing/security settings, reset 2FA, or delete workspace |
| **Cashier** | Counter GST billing, POS-Lite, customer receipts, breakup/sample logging | Purchase costs & profit reports are masked |
| **Storekeeper** | Receiving purchases, variant/lot stock counts, breakage, delivery dispatch | Cannot view profit reports or export backups |
| **Accountant** | GST reports (GSTR-1/3B/2B), purchase verification, khata statements, ledgers | Cannot modify system security settings |
| **Viewer** | Read-only review of bills, stock availability, and statements | Cannot create, edit, or delete records |

---

## 2. Setting Up Two-Factor Authentication (2FA)

1. Open **My Profile → Two-Factor Authentication**.
2. Click **Set Up 2FA** to display your QR code (`otpauth://...`), manual Base32 secret, and **8 one-time recovery codes** (stored hashed on the server).
3. Scan the QR code using Google Authenticator, Microsoft Authenticator, or Authy and enter the 6-digit verification code to activate 2FA.
4. **Save your 8 recovery codes offline** (printed or password manager). Each code works once during ERP sign-in if your phone is unavailable.
5. If you lose both your authenticator and recovery codes, ask the **Business Owner** to click **Reset 2FA** next to your name under **Settings → Users & Roles**.

---

## 3. Daily Billing & POS-Lite Workflow

1. **Choose Customer** (or walk-in cash customer). Toggle **Estimate / Quotation** when quoting a contractor before final billing.
2. **Select Item & Variant / Lot**:
   - For **Tiles & Slabs**, enter quantity in **Boxes**, **Pieces**, or **sq.ft** — DecorBiz converts automatically.
   - Use the **Area Estimator** button (when enabled) to convert room dimensions + wastage % directly into boxes.
   - Watch for the **Mixed Lot Warning** banner: if a customer needs 12 boxes and Box 1–8 are Lot A while Box 9–12 are Lot B, split or confirm shade tolerance before printing!
3. **Collect Payment & Print**:
   - Record Cash, UPI, Card, Bank Transfer, or Credit (Khata).
   - Print A4 GST Invoice or 80mm thermal receipt, or share a revocable invoice link.

---

## 4. Fulfilling Online Orders (`ERP → Store`)

Online customers order at `/` and share your showroom's live inventory pool:
1. Open **Store → Order Inbox**.
2. **Confirm (`confirmed`)**: Reserves ordered boxes/units immediately so counter staff don't oversell the same lot.
3. **Pack (`packing` → `ready_for_pickup` or `out_for_delivery`)**: Pick matching shade/batch lots and assign a delivery trip if using showroom transport.
4. **Complete (`delivered` / `picked_up`)**: Automatically deducts stock from inventory and clears the reservation.
5. **Cancel (`cancelled`)**: Releases reserved quantities straight back into available stock.

---

## 5. Parties, Khata & Expenses

- Always verify customer GSTIN (15 characters) for B2B invoices so GSTR-1 stays accurate.
- Record **Payments Received** against specific invoices (FIFO or manual bill allocation) to keep party ageing accurate.
- Upload supplier purchase bills (JPG/PNG/WebP/PDF up to 5 MB) directly on the purchase entry for audit trail completeness.
