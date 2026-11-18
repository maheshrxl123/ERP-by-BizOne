# Changelog

## [1.0.0] — Release

### Added (Phase P7 & v1.0 Hardening)
- **Optional BizOne AI Agent (`ai`)**: Conversational chat (English/Hindi/Hinglish) over role-masked allowlisted tools, AI Analytics & anomaly detection, 7 configurable Playbooks, and Owner-only SHA-256 verified Approval cards. Multi-provider routing supports Gemini (`@google/genai`), OpenAI, Anthropic Claude, OpenRouter, xAI Grok, and custom HTTPS endpoints.
- **Tally-Style Double-Entry Accounting (`accounting`)**: Account Groups, Ledgers, balanced Dr=Cr Journal/Contra/Receipt/Payment vouchers enforced by a deferrable PostgreSQL constraint trigger, Guided Opening Balance Migration, Trial Balance, P&L, Balance Sheet, and Bank Reconciliation.
- **Advanced GST & E-Invoice (`tax`, `einvoice`)**: GSTR-1 (B2B/B2C/CDNR + CSV export), GSTR-3B & HSN summary, GSTR-2B ITC Reconciliation, E-Invoice / E-Way Bill GSP panel, and TDS/TCS registers.
- **POS-Lite & Idempotent Offline Queue**: Rapid counter item grid, parked/held bills, split tender notes, cash register open/close variance shifts, and offline billing queue synced via `sync_offline_bill_queue` (`idempotency_key` deduplication).
- **Multi-Location Stock, Operations & Messaging (`locations`, `messaging`)**: Inter-godown stock transfers, physical stock counts, Sales/Purchase orders, Delivery Challans, Leads, Cheque Register, Recurring Rules, WhatsApp/SMS/Email templates, and delivery logs.
- **v1.0 Hardening & Docs**: Security headers, SSRF URL validation, zero-secret `p7-v1` backups (compatible with `p5-v1` and `p6-v1` restore), `SECURITY.md`, `CONTRIBUTING.md`, `TRADEMARKS.md`, and `docs/deployment-and-upgrade.md`.

### Prior Phases
- **P1–P4**: Auth, RBAC, Business/Profile settings, Parties & Khata, Items & Stock, GST Billing/Quotations/Returns/UPI QR.
- **P5–P6**: Purchases, Expenses, Accounting Books & Standard Reports, Local Backup & Restore, 7 Business Packs, CSV/XLSX Import & Multi-sheet Export, Optional Google Drive Sync.
