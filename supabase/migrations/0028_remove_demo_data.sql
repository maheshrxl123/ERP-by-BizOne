-- Migration 0028: Remove sample demo data and drop demo seed/remove RPCs
-- Deletes any existing is_demo = true rows in FK-safe order without requiring
-- auth.uid() / current_user_role(), then drops seed_demo_data() and remove_demo_data().

DO $$
BEGIN
  PERFORM set_config('app.restore_context', txid_current()::text, true);

  IF to_regclass('public.store_order_lines') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.store_order_lines WHERE item_id IN (SELECT id FROM public.items WHERE is_demo = true)';
  END IF;
  IF to_regclass('public.breakage_returns') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.breakage_returns WHERE item_id IN (SELECT id FROM public.items WHERE is_demo = true)';
  END IF;
  IF to_regclass('public.sample_issues') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.sample_issues WHERE item_id IN (SELECT id FROM public.items WHERE is_demo = true)';
  END IF;
  IF to_regclass('public.contractor_rate_cards') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.contractor_rate_cards WHERE item_id IN (SELECT id FROM public.items WHERE is_demo = true) OR party_id IN (SELECT id FROM public.parties WHERE is_demo = true)';
  END IF;
  IF to_regclass('public.supplier_price_lists') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.supplier_price_lists WHERE item_id IN (SELECT id FROM public.items WHERE is_demo = true) OR party_id IN (SELECT id FROM public.parties WHERE is_demo = true)';
  END IF;

  DELETE FROM public.hardware_estimates WHERE is_demo = true;
  DELETE FROM public.bill_lines WHERE bill_id IN (SELECT id FROM public.bills WHERE is_demo = true);
  DELETE FROM public.purchase_lines WHERE purchase_id IN (SELECT id FROM public.purchase_bills WHERE is_demo = true);
  DELETE FROM public.payment_allocations WHERE payment_id IN (SELECT id FROM public.payments WHERE is_demo = true);
  DELETE FROM public.party_ledger_entries WHERE is_demo = true OR party_id IN (SELECT id FROM public.parties WHERE is_demo = true);
  DELETE FROM public.payments WHERE is_demo = true;
  DELETE FROM public.stock_ledger WHERE is_demo = true OR item_id IN (SELECT id FROM public.items WHERE is_demo = true);
  DELETE FROM public.bills WHERE is_demo = true;
  DELETE FROM public.purchase_bills WHERE is_demo = true;
  DELETE FROM public.expenses WHERE is_demo = true;
  DELETE FROM public.unit_conversions WHERE item_id IN (SELECT id FROM public.items WHERE is_demo = true);
  DELETE FROM public.item_images WHERE item_id IN (SELECT id FROM public.items WHERE is_demo = true);

  IF to_regclass('public.item_variants') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.item_variants WHERE item_id IN (SELECT id FROM public.items WHERE is_demo = true)';
  END IF;
  IF to_regclass('public.item_specs_tiles_slabs') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.item_specs_tiles_slabs WHERE item_id IN (SELECT id FROM public.items WHERE is_demo = true)';
  END IF;
  IF to_regclass('public.item_specs_sanitaryware') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.item_specs_sanitaryware WHERE item_id IN (SELECT id FROM public.items WHERE is_demo = true)';
  END IF;
  IF to_regclass('public.item_specs_faucets_cp') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.item_specs_faucets_cp WHERE item_id IN (SELECT id FROM public.items WHERE is_demo = true)';
  END IF;
  IF to_regclass('public.item_specs_tile_adhesive') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.item_specs_tile_adhesive WHERE item_id IN (SELECT id FROM public.items WHERE is_demo = true)';
  END IF;
  IF to_regclass('public.item_specs_other_general') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.item_specs_other_general WHERE item_id IN (SELECT id FROM public.items WHERE is_demo = true)';
  END IF;

  DELETE FROM public.stock_balances WHERE item_id IN (SELECT id FROM public.items WHERE is_demo = true);
  DELETE FROM public.items WHERE is_demo = true;
  DELETE FROM public.party_sites WHERE is_demo = true OR party_id IN (SELECT id FROM public.parties WHERE is_demo = true);
  DELETE FROM public.party_addresses WHERE party_id IN (SELECT id FROM public.parties WHERE is_demo = true);
  DELETE FROM public.parties WHERE is_demo = true;

  PERFORM set_config('app.restore_context', '', true);
END;
$$;

DROP FUNCTION IF EXISTS public.seed_demo_data();
DROP FUNCTION IF EXISTS public.remove_demo_data();

NOTIFY pgrst, 'reload schema';
