# BizOne ERP (Phase 1)

Free, open-source, self-hosted, phone-first small-business software built with React, Vite, TypeScript, and Supabase.

## Phase 1 Scope
- **Single-Business Architecture**: One Supabase project and one frontend serve one business (`business`, `profiles`, `modules_state`, `files`, `file_links`, `audit_logs`, `integration_settings`).
- **Authentication & Recovery**: First-run Owner & Business setup, email/password sign-in, forgot password, and `PASSWORD_RECOVERY` completion flow.
- **Role-Based Access Control (RLS)**: Fixed roles (`owner`, `manager`, `cashier`, `storekeeper`, `accountant`, `viewer`), last-Owner protection, and no self-escalation.
- **User Profile (`UP1`)**: Personal display name, phone, profile photo upload, verified email change, and password update.
- **Settings (`S1–S6` & Optional Integrations)**: Business profile, logo & UPI QR upload, invoice prefix/tax mode, module dependency toggles, staff management, light/dark themes, English/Hindi languages, and AES-256-GCM encrypted optional integrations.
- **Universal File & Image Upload**: Client compression, server magic-byte validation, SHA-256 checksums, private Supabase Storage (`bizone-private`), and short-lived signed URLs.

## Quick Start
```bash
npm install
npm run check-env
npm run setup
npm run dev
```

## Testing & Verification
```bash
npm run lint
npm run build
npm test
```
