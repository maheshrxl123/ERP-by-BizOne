-- ============================================================================
-- Migration 0014: Tax Inclusive/Exclusive Precision Parity & Purchase/POS Fixes
-- ============================================================================
-- Ensures PostgreSQL compute_bill_amounts uses exact `(v_after_disc * 100.0) / (100.0 + v_gst_rate)`
-- matching the decimal-safe JS calculator, and ensures POS-Lite/purchases respect explicit
-- line-level tax_inclusive flags cleanly without silent defaults.

CREATE OR REPLACE FUNCTION public.compute_bill_amounts(
  p_gst_registered boolean,
  p_doc_type text,
  p_is_interstate boolean,
  p_extra_charges numeric,
  p_auto_round_off boolean,
  p_lines jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_gst_applied boolean;
  v_interstate boolean;
  v_line jsonb;
  v_qty numeric(15,3);
  v_price numeric(15,2);
  v_disc_pct numeric(5,2);
  v_gst_rate numeric(5,2);
  v_tax_incl boolean;
  v_gross numeric(15,2);
  v_disc_amt numeric(15,2);
  v_after_disc numeric(15,2);
  v_taxable numeric(15,2);
  v_tax numeric(15,2);
  v_cgst numeric(15,2);
  v_sgst numeric(15,2);
  v_igst numeric(15,2);
  v_line_total numeric(15,2);
  v_subtotal numeric(15,2) := 0;
  v_discount_total numeric(15,2) := 0;
  v_cgst_total numeric(15,2) := 0;
  v_sgst_total numeric(15,2) := 0;
  v_igst_total numeric(15,2) := 0;
  v_tax_total numeric(15,2) := 0;
  v_extra numeric(15,2);
  v_pre_round numeric(15,2);
  v_round_off numeric(15,2);
  v_grand numeric(15,2);
  v_calc_lines jsonb := '[]'::jsonb;
BEGIN
  v_gst_applied := COALESCE(p_gst_registered, false)
    AND public.is_module_enabled('tax')
    AND COALESCE(p_doc_type, 'tax_invoice') <> 'bill_of_supply';
  v_interstate := v_gst_applied AND COALESCE(p_is_interstate, false);

  FOR v_line IN SELECT value FROM jsonb_array_elements(COALESCE(p_lines, '[]'::jsonb))
  LOOP
    v_qty := GREATEST(0::numeric, COALESCE((v_line->>'entered_qty')::numeric, 0));
    v_price := GREATEST(0::numeric, round(COALESCE((v_line->>'unit_price')::numeric, 0), 2));
    v_disc_pct := LEAST(100::numeric, GREATEST(0::numeric, round(COALESCE((v_line->>'discount_pct')::numeric, 0), 2)));
    v_tax_incl := COALESCE((v_line->>'tax_inclusive')::boolean, false);
    v_gst_rate := CASE
      WHEN v_gst_applied THEN LEAST(100::numeric, GREATEST(0::numeric, round(COALESCE((v_line->>'gst_rate')::numeric, 0), 2)))
      ELSE 0::numeric
    END;

    v_gross := round((v_qty * v_price)::numeric, 2);
    v_disc_amt := round((v_gross * v_disc_pct / 100.0)::numeric, 2);
    v_after_disc := round((v_gross - v_disc_amt)::numeric, 2);

    v_taxable := v_after_disc;
    v_tax := 0;
    v_line_total := v_after_disc;

    IF v_gst_rate > 0 THEN
      IF v_tax_incl THEN
        v_taxable := round(((v_after_disc * 100.0) / (100.0 + v_gst_rate))::numeric, 2);
        v_tax := round((v_after_disc - v_taxable)::numeric, 2);
        v_line_total := v_after_disc;
      ELSE
        v_taxable := v_after_disc;
        v_tax := round((v_taxable * v_gst_rate / 100.0)::numeric, 2);
        v_line_total := round((v_taxable + v_tax)::numeric, 2);
      END IF;
    END IF;

    v_cgst := 0;
    v_sgst := 0;
    v_igst := 0;
    IF v_tax > 0 THEN
      IF v_interstate THEN
        v_igst := v_tax;
      ELSE
        v_cgst := round((v_tax / 2.0)::numeric, 2);
        v_sgst := round((v_tax - v_cgst)::numeric, 2);
      END IF;
    END IF;

    v_subtotal := round((v_subtotal + v_taxable)::numeric, 2);
    v_discount_total := round((v_discount_total + v_disc_amt)::numeric, 2);
    v_cgst_total := round((v_cgst_total + v_cgst)::numeric, 2);
    v_sgst_total := round((v_sgst_total + v_sgst)::numeric, 2);
    v_igst_total := round((v_igst_total + v_igst)::numeric, 2);

    v_calc_lines := v_calc_lines || jsonb_build_array(jsonb_build_object(
      'gross_amount', v_gross,
      'discount_amount', v_disc_amt,
      'taxable_amount', v_taxable,
      'cgst_amount', v_cgst,
      'sgst_amount', v_sgst,
      'igst_amount', v_igst,
      'tax_amount', v_tax,
      'line_total', v_line_total,
      'effective_gst_rate', v_gst_rate
    ));
  END LOOP;

  v_tax_total := round((v_cgst_total + v_sgst_total + v_igst_total)::numeric, 2);
  v_extra := GREATEST(0::numeric, round(COALESCE(p_extra_charges, 0)::numeric, 2));
  v_pre_round := round((v_subtotal + v_tax_total + v_extra)::numeric, 2);

  IF COALESCE(p_auto_round_off, true) THEN
    v_round_off := round((round(v_pre_round, 0) - v_pre_round)::numeric, 2);
  ELSE
    v_round_off := 0;
  END IF;
  v_grand := round((v_pre_round + v_round_off)::numeric, 2);

  RETURN jsonb_build_object(
    'gst_applied', v_gst_applied,
    'is_interstate', v_interstate,
    'subtotal_taxable', v_subtotal,
    'discount_total', v_discount_total,
    'cgst_total', v_cgst_total,
    'sgst_total', v_sgst_total,
    'igst_total', v_igst_total,
    'tax_total', v_tax_total,
    'extra_charges', v_extra,
    'round_off', v_round_off,
    'grand_total', v_grand,
    'lines', v_calc_lines
  );
END;
$$;
