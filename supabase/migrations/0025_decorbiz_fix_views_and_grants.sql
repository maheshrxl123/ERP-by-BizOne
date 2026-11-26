-- DecorBiz Migration 0025:
-- 1. Restore public.khata_totals_summary view (dropped by CASCADE in 0016)
-- 2. Harden and grant SELECT on public.item_lot_balances for authenticated ERP staff
-- 3. Ensure explicit SELECT grants on item_variants_view and party_balances
-- 4. Reload PostgREST schema cache

CREATE OR REPLACE VIEW public.khata_totals_summary AS
SELECT
  COALESCE((SELECT SUM(pb.to_receive) FROM public.party_balances pb WHERE pb.is_active = true), 0)::numeric(15,2) AS total_to_receive,
  COALESCE((SELECT SUM(pb.to_give) FROM public.party_balances pb WHERE pb.is_active = true), 0)::numeric(15,2) AS total_to_give,
  COALESCE((SELECT COUNT(*) FROM public.party_balances pb WHERE pb.is_active = true), 0)::integer AS active_parties_count,
  COALESCE((SELECT COUNT(*) FROM public.party_balances pb WHERE pb.is_active = true AND pb.is_overdue = true), 0)::integer AS overdue_parties_count,
  COALESCE((SELECT SUM(py.amount) FROM public.payments py WHERE py.status = 'posted' AND py.direction = 'receive' AND py.payment_date = CURRENT_DATE), 0)::numeric(15,2) AS today_received,
  COALESCE((SELECT SUM(py.amount) FROM public.payments py WHERE py.status = 'posted' AND py.direction = 'give' AND py.payment_date = CURRENT_DATE), 0)::numeric(15,2) AS today_given;

ALTER VIEW public.khata_totals_summary SET (security_invoker = true);
REVOKE ALL ON public.khata_totals_summary FROM anon;
GRANT SELECT ON public.khata_totals_summary TO authenticated;

CREATE OR REPLACE VIEW public.item_lot_balances AS
SELECT
  sl.item_id,
  sl.variant_id,
  COALESCE(iv.variant_name, 'Standard') AS variant_name,
  COALESCE(NULLIF(trim(sl.shade), ''), 'Default') AS shade,
  COALESCE(NULLIF(trim(sl.batch_lot), ''), 'Default') AS batch_lot,
  round(sum(sl.signed_base_qty), 3) AS qty_on_hand,
  max(sl.movement_date) AS last_movement_at
FROM public.stock_ledger sl
LEFT JOIN public.item_variants iv ON iv.id = sl.variant_id
WHERE public.is_module_enabled('inventory')
  AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant'])
GROUP BY sl.item_id, sl.variant_id, iv.variant_name, COALESCE(NULLIF(trim(sl.shade), ''), 'Default'), COALESCE(NULLIF(trim(sl.batch_lot), ''), 'Default')
HAVING round(sum(sl.signed_base_qty), 3) <> 0;

ALTER VIEW public.item_lot_balances SET (security_invoker = false);
REVOKE ALL ON public.item_lot_balances FROM anon;
GRANT SELECT ON public.item_lot_balances TO authenticated;

GRANT SELECT ON public.item_variants_view TO authenticated;
GRANT SELECT ON public.party_balances TO authenticated;

NOTIFY pgrst, 'reload schema';
