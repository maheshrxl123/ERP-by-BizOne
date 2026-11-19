-- ============================================================================
-- Migration 0015: Service Role & Phase-1 Authenticated Schema/Table Grants
-- ============================================================================
-- When migrations are applied via Supabase Management API (/database/query), SQL
-- executes under role `postgres`, whose Postgres 17 default ACLs do not grant
-- SELECT/INSERT/UPDATE/DELETE to `service_role` or `authenticated` automatically.
-- Restore required grants cleanly while preserving strict RLS & column-level locks.

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Backend admin (service_role) needs full privileges across all tables, views, sequences, and functions
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON FUNCTIONS TO service_role;

-- Restore RLS-gated grants for Phase 1 core tables (all protected by strict RLS policies)
GRANT SELECT, UPDATE ON public.business TO authenticated;
GRANT SELECT, UPDATE ON public.profiles TO authenticated;
GRANT SELECT, UPDATE ON public.modules_state TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.files TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.file_links TO authenticated;
GRANT SELECT ON public.audit_logs TO authenticated;
