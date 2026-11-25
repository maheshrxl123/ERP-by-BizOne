# Security Policy — DecorBiz

## Supported Versions
| Version | Supported |
| --- | --- |
| 1.0.x | Yes |

## Security Architecture
1. **Single-Tenant Isolation & RLS**: Every business table enables PostgreSQL Row Level Security (RLS) enforced at the database layer via `is_active_staff()`, `is_owner()`, and `has_any_role(...)`.
2. **Server-Side Encryption**: Optional credentials (Google Drive OAuth, AI provider API keys, SMTP, WhatsApp/SMS, E-Invoice GSP) are encrypted at rest with AES-256-GCM using `APP_ENCRYPTION_KEY` (64+ hex characters) in `server.ts`. Column-level `REVOKE ALL` / `GRANT SELECT` blocks browser clients from reading `encrypted_secret` or `encrypted_key`.
3. **SSRF & Secret Redaction**: External HTTPS integration URLs undergo strict validation blocking `http://`, `localhost`, `.local`/`.internal`, IPv4 loopback/private/link-local (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`), and IPv6 private/link-local addresses. Error responses redact `sk-*`, `AIza*`, `xai-*`, `Bearer *`, and `ghp_*` patterns.
4. **Zero-Secret Backups**: `export_workspace_backup` strictly exports business records only and excludes `integration_settings`, OAuth tokens, AI API keys, and approval tokens.
5. **AI Guardrails**: AI tools are statically allowlisted, filtered by enabled module and caller role (`view_profit` masks costs/margins for unauthorized roles), wrapped against prompt injection (`<UNTRUSTED_BUSINESS_DATA>`), and state-changing drafts require Owner-only SHA-256 verified approval (`ai_agent` cannot self-approve).

## Reporting a Vulnerability
Do not open public GitHub issues for security vulnerabilities. Report suspected vulnerabilities privately to the repository maintainers with reproduction steps and affected versions.
