-- DecorBiz - Step 2 Item 2 Migration:
--   1. Add 5 typed specification tables (1:1 with public.items via item_id PK):
--        - item_specs_tiles_slabs
--        - item_specs_sanitaryware
--        - item_specs_faucets_cp
--        - item_specs_tile_adhesive
--        - item_specs_other_general
--   2. Enforce NOT NULL and domain CHECK constraints on every required field per line.
--   3. Update save_item to validate & persist typed specs atomically (when p_specs is provided).
--   4. Update item_catalog_view to expose typed specs jsonb per item.

-- ============================================================================
-- 1. Five Typed Specification Tables
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.item_specs_tiles_slabs (
  item_id uuid PRIMARY KEY REFERENCES public.items(id) ON DELETE CASCADE,
  size_length_mm numeric(10,2) NOT NULL CHECK (size_length_mm > 0),
  size_width_mm numeric(10,2) NOT NULL CHECK (size_width_mm > 0),
  thickness_mm numeric(8,2) NOT NULL CHECK (thickness_mm > 0),
  material text NOT NULL CHECK (material IN ('ceramic', 'vitrified', 'porcelain', 'marble', 'granite', 'quartz', 'other')),
  finish text NOT NULL CHECK (finish IN ('glossy', 'matte', 'satin', 'rustic', 'polished', 'carving')),
  use_area text NOT NULL CHECK (use_area IN ('floor', 'wall', 'outdoor', 'parking', 'bathroom', 'kitchen')),
  pieces_per_box integer NOT NULL CHECK (pieces_per_box > 0),
  sqft_per_box numeric(10,4) NOT NULL CHECK (sqft_per_box > 0),
  sqm_per_box numeric(10,4) NOT NULL CHECK (sqm_per_box > 0),
  weight_per_box_kg numeric(10,3) NOT NULL CHECK (weight_per_box_kg > 0),
  shade text NOT NULL CHECK (length(trim(shade)) >= 1),
  batch_lot text NOT NULL CHECK (length(trim(batch_lot)) >= 1),
  series text NOT NULL CHECK (length(trim(series)) >= 1),
  design_name text NOT NULL CHECK (length(trim(design_name)) >= 1),
  -- Optional fields
  pei_rating text,
  water_absorption_pct numeric(6,2) CHECK (water_absorption_pct IS NULL OR water_absorption_pct >= 0),
  slip_resistance text,
  edge_type text CHECK (edge_type IS NULL OR edge_type IN ('rectified', 'non-rectified')),
  faces_per_design integer CHECK (faces_per_design IS NULL OR faces_per_design > 0),
  anti_skid boolean NOT NULL DEFAULT false,
  anti_bacterial boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.item_specs_sanitaryware (
  item_id uuid PRIMARY KEY REFERENCES public.items(id) ON DELETE CASCADE,
  product_type text NOT NULL CHECK (product_type IN ('WC', 'wash basin', 'urinal', 'cistern', 'bathtub', 'pedestal', 'shower tray')),
  mounting text NOT NULL CHECK (mounting IN ('wall-hung', 'floor', 'counter', 'under-counter')),
  trap_type text NOT NULL CHECK (trap_type IN ('P', 'S', 'concealed')),
  colour text NOT NULL CHECK (length(trim(colour)) >= 1),
  material text NOT NULL CHECK (length(trim(material)) >= 1),
  flush_type_and_litres text NOT NULL CHECK (length(trim(flush_type_and_litres)) >= 1),
  seat_cover_included boolean NOT NULL DEFAULT false,
  set_contents text NOT NULL CHECK (length(trim(set_contents)) >= 1),
  dimensions text NOT NULL CHECK (length(trim(dimensions)) >= 1),
  warranty text NOT NULL CHECK (length(trim(warranty)) >= 1),
  -- Optional fields
  rough_in_distance text,
  water_saving_rating text,
  soft_close boolean NOT NULL DEFAULT false,
  series text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.item_specs_faucets_cp (
  item_id uuid PRIMARY KEY REFERENCES public.items(id) ON DELETE CASCADE,
  product_type text NOT NULL CHECK (product_type IN ('tap', 'mixer', 'shower', 'valve', 'health faucet', 'accessory')),
  finish text NOT NULL CHECK (finish IN ('chrome', 'black', 'gold', 'nickel', 'rose gold')),
  body_material text NOT NULL CHECK (body_material IN ('brass', 'SS', 'ABS')),
  size_and_connection text NOT NULL CHECK (length(trim(size_and_connection)) >= 1),
  operation text NOT NULL CHECK (operation IN ('single-lever', 'two-handle', 'sensor', 'pillar')),
  cartridge_type text NOT NULL CHECK (length(trim(cartridge_type)) >= 1),
  flow_rate text NOT NULL CHECK (length(trim(flow_rate)) >= 1),
  warranty text NOT NULL CHECK (length(trim(warranty)) >= 1),
  -- Optional fields
  pressure_range text,
  set_contents text,
  spout_length text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.item_specs_tile_adhesive (
  item_id uuid PRIMARY KEY REFERENCES public.items(id) ON DELETE CASCADE,
  adhesive_type text NOT NULL CHECK (adhesive_type IN ('cement-based', 'epoxy', 'grout', 'waterproofing')),
  grade text NOT NULL CHECK (length(trim(grade)) >= 1),
  pack_size_and_unit text NOT NULL CHECK (length(trim(pack_size_and_unit)) >= 1),
  coverage_per_pack text NOT NULL CHECK (length(trim(coverage_per_pack)) >= 1),
  pot_life text NOT NULL CHECK (length(trim(pot_life)) >= 1),
  shelf_life text NOT NULL CHECK (length(trim(shelf_life)) >= 1),
  colour text NOT NULL CHECK (length(trim(colour)) >= 1),
  suitable_for text NOT NULL CHECK (suitable_for IN ('floor', 'wall', 'outdoor', 'stone', 'large format')),
  -- Optional fields
  open_time text,
  curing_time text,
  mixing_ratio text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.item_specs_other_general (
  item_id uuid PRIMARY KEY REFERENCES public.items(id) ON DELETE CASCADE,
  item_label text NOT NULL CHECK (length(trim(item_label)) >= 1),
  unit_label text NOT NULL CHECK (length(trim(unit_label)) >= 1),
  size_or_description text NOT NULL CHECK (length(trim(size_or_description)) >= 1),
  colour text NOT NULL CHECK (length(trim(colour)) >= 1),
  material text NOT NULL CHECK (length(trim(material)) >= 1),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_specs_tiles_filter
  ON public.item_specs_tiles_slabs (material, finish, use_area, shade);
CREATE INDEX IF NOT EXISTS idx_specs_sanitaryware_filter
  ON public.item_specs_sanitaryware (product_type, mounting, trap_type);
CREATE INDEX IF NOT EXISTS idx_specs_faucets_filter
  ON public.item_specs_faucets_cp (product_type, finish, operation);
CREATE INDEX IF NOT EXISTS idx_specs_adhesive_filter
  ON public.item_specs_tile_adhesive (adhesive_type, suitable_for, grade);
CREATE INDEX IF NOT EXISTS idx_specs_other_filter
  ON public.item_specs_other_general (material, colour);

-- Updated_at helper & triggers
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_specs_tiles_slabs_updated_at ON public.item_specs_tiles_slabs;
CREATE TRIGGER trg_specs_tiles_slabs_updated_at
  BEFORE UPDATE ON public.item_specs_tiles_slabs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_specs_sanitaryware_updated_at ON public.item_specs_sanitaryware;
CREATE TRIGGER trg_specs_sanitaryware_updated_at
  BEFORE UPDATE ON public.item_specs_sanitaryware
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_specs_faucets_cp_updated_at ON public.item_specs_faucets_cp;
CREATE TRIGGER trg_specs_faucets_cp_updated_at
  BEFORE UPDATE ON public.item_specs_faucets_cp
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_specs_tile_adhesive_updated_at ON public.item_specs_tile_adhesive;
CREATE TRIGGER trg_specs_tile_adhesive_updated_at
  BEFORE UPDATE ON public.item_specs_tile_adhesive
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_specs_other_general_updated_at ON public.item_specs_other_general;
CREATE TRIGGER trg_specs_other_general_updated_at
  BEFORE UPDATE ON public.item_specs_other_general
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Enable RLS & policies (writes via save_item SECURITY DEFINER RPC)
ALTER TABLE public.item_specs_tiles_slabs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.item_specs_sanitaryware ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.item_specs_faucets_cp ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.item_specs_tile_adhesive ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.item_specs_other_general ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS item_specs_tiles_select ON public.item_specs_tiles_slabs;
CREATE POLICY item_specs_tiles_select ON public.item_specs_tiles_slabs
  FOR SELECT TO authenticated
  USING (
    public.is_module_enabled('inventory')
    AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant'])
  );

DROP POLICY IF EXISTS item_specs_sanitaryware_select ON public.item_specs_sanitaryware;
CREATE POLICY item_specs_sanitaryware_select ON public.item_specs_sanitaryware
  FOR SELECT TO authenticated
  USING (
    public.is_module_enabled('inventory')
    AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant'])
  );

DROP POLICY IF EXISTS item_specs_faucets_select ON public.item_specs_faucets_cp;
CREATE POLICY item_specs_faucets_select ON public.item_specs_faucets_cp
  FOR SELECT TO authenticated
  USING (
    public.is_module_enabled('inventory')
    AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant'])
  );

DROP POLICY IF EXISTS item_specs_adhesive_select ON public.item_specs_tile_adhesive;
CREATE POLICY item_specs_adhesive_select ON public.item_specs_tile_adhesive
  FOR SELECT TO authenticated
  USING (
    public.is_module_enabled('inventory')
    AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant'])
  );

DROP POLICY IF EXISTS item_specs_other_select ON public.item_specs_other_general;
CREATE POLICY item_specs_other_select ON public.item_specs_other_general
  FOR SELECT TO authenticated
  USING (
    public.is_module_enabled('inventory')
    AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant'])
  );

GRANT SELECT ON public.item_specs_tiles_slabs TO authenticated;
GRANT SELECT ON public.item_specs_sanitaryware TO authenticated;
GRANT SELECT ON public.item_specs_faucets_cp TO authenticated;
GRANT SELECT ON public.item_specs_tile_adhesive TO authenticated;
GRANT SELECT ON public.item_specs_other_general TO authenticated;

-- ============================================================================
-- 2. Helper RPC / Function to Validate & Persist Typed Specs
-- ============================================================================
CREATE OR REPLACE FUNCTION public._upsert_item_typed_specs(
  p_item_id uuid,
  p_product_line text,
  p_specs jsonb,
  p_fallback_name text DEFAULT NULL,
  p_fallback_unit text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_len numeric;
  v_wid numeric;
  v_thk numeric;
  v_pcs integer;
  v_sqft numeric;
  v_sqm numeric;
  v_wt numeric;
  v_mat text;
  v_fin text;
  v_area text;
  v_shade text;
  v_lot text;
  v_series text;
  v_design text;
  v_edge text;
  v_ptype text;
  v_mount text;
  v_trap text;
  v_colour text;
  v_flush text;
  v_seat boolean;
  v_set text;
  v_dim text;
  v_warr text;
  v_body text;
  v_conn text;
  v_op text;
  v_cart text;
  v_flow text;
  v_adh_type text;
  v_grade text;
  v_pack_sz text;
  v_cov text;
  v_pot text;
  v_shelf text;
  v_suit text;
  v_lbl text;
  v_ulbl text;
  v_desc text;
  v_attrs jsonb;
BEGIN
  IF p_specs IS NULL OR jsonb_typeof(p_specs) <> 'object' THEN
    RETURN;
  END IF;

  -- Remove stale specs from any other line
  IF p_product_line <> 'tiles_slabs' THEN
    DELETE FROM public.item_specs_tiles_slabs WHERE item_id = p_item_id;
  END IF;
  IF p_product_line <> 'sanitaryware' THEN
    DELETE FROM public.item_specs_sanitaryware WHERE item_id = p_item_id;
  END IF;
  IF p_product_line <> 'faucets_cp' THEN
    DELETE FROM public.item_specs_faucets_cp WHERE item_id = p_item_id;
  END IF;
  IF p_product_line <> 'tile_adhesive' THEN
    DELETE FROM public.item_specs_tile_adhesive WHERE item_id = p_item_id;
  END IF;
  IF p_product_line <> 'other_general' THEN
    DELETE FROM public.item_specs_other_general WHERE item_id = p_item_id;
  END IF;

  IF p_product_line = 'tiles_slabs' THEN
    v_len := NULLIF(trim(COALESCE(p_specs->>'size_length_mm', '')), '')::numeric;
    v_wid := NULLIF(trim(COALESCE(p_specs->>'size_width_mm', '')), '')::numeric;
    v_thk := NULLIF(trim(COALESCE(p_specs->>'thickness_mm', '')), '')::numeric;
    v_mat := lower(trim(COALESCE(p_specs->>'material', '')));
    v_fin := lower(trim(COALESCE(p_specs->>'finish', '')));
    v_area := lower(trim(COALESCE(p_specs->>'use_area', '')));
    v_pcs := NULLIF(trim(COALESCE(p_specs->>'pieces_per_box', '')), '')::integer;
    v_sqft := NULLIF(trim(COALESCE(p_specs->>'sqft_per_box', '')), '')::numeric;
    v_sqm := NULLIF(trim(COALESCE(p_specs->>'sqm_per_box', '')), '')::numeric;
    v_wt := NULLIF(trim(COALESCE(p_specs->>'weight_per_box_kg', '')), '')::numeric;
    v_shade := trim(COALESCE(p_specs->>'shade', ''));
    v_lot := trim(COALESCE(p_specs->>'batch_lot', ''));
    v_series := trim(COALESCE(p_specs->>'series', ''));
    v_design := trim(COALESCE(p_specs->>'design_name', ''));
    v_edge := NULLIF(lower(trim(COALESCE(p_specs->>'edge_type', ''))), '');

    IF v_len IS NULL OR v_len <= 0 THEN RAISE EXCEPTION 'Tiles spec required: size_length_mm must be > 0.'; END IF;
    IF v_wid IS NULL OR v_wid <= 0 THEN RAISE EXCEPTION 'Tiles spec required: size_width_mm must be > 0.'; END IF;
    IF v_thk IS NULL OR v_thk <= 0 THEN RAISE EXCEPTION 'Tiles spec required: thickness_mm must be > 0.'; END IF;
    IF v_mat NOT IN ('ceramic', 'vitrified', 'porcelain', 'marble', 'granite', 'quartz', 'other') THEN
      RAISE EXCEPTION 'Tiles spec required: valid material.';
    END IF;
    IF v_fin NOT IN ('glossy', 'matte', 'satin', 'rustic', 'polished', 'carving') THEN
      RAISE EXCEPTION 'Tiles spec required: valid finish.';
    END IF;
    IF v_area NOT IN ('floor', 'wall', 'outdoor', 'parking', 'bathroom', 'kitchen') THEN
      RAISE EXCEPTION 'Tiles spec required: valid use_area.';
    END IF;
    IF v_pcs IS NULL OR v_pcs <= 0 THEN RAISE EXCEPTION 'Tiles spec required: pieces_per_box must be > 0.'; END IF;
    IF v_sqft IS NULL OR v_sqft <= 0 THEN RAISE EXCEPTION 'Tiles spec required: sqft_per_box must be > 0.'; END IF;
    IF v_sqm IS NULL OR v_sqm <= 0 THEN RAISE EXCEPTION 'Tiles spec required: sqm_per_box must be > 0.'; END IF;
    IF v_wt IS NULL OR v_wt <= 0 THEN RAISE EXCEPTION 'Tiles spec required: weight_per_box_kg must be > 0.'; END IF;
    IF length(v_shade) < 1 THEN RAISE EXCEPTION 'Tiles spec required: shade cannot be empty.'; END IF;
    IF length(v_lot) < 1 THEN RAISE EXCEPTION 'Tiles spec required: batch_lot cannot be empty.'; END IF;
    IF length(v_series) < 1 THEN RAISE EXCEPTION 'Tiles spec required: series cannot be empty.'; END IF;
    IF length(v_design) < 1 THEN RAISE EXCEPTION 'Tiles spec required: design_name cannot be empty.'; END IF;

    INSERT INTO public.item_specs_tiles_slabs (
      item_id, size_length_mm, size_width_mm, thickness_mm, material, finish, use_area,
      pieces_per_box, sqft_per_box, sqm_per_box, weight_per_box_kg, shade, batch_lot, series, design_name,
      pei_rating, water_absorption_pct, slip_resistance, edge_type, faces_per_design, anti_skid, anti_bacterial
    )
    VALUES (
      p_item_id, v_len, v_wid, v_thk, v_mat, v_fin, v_area,
      v_pcs, v_sqft, v_sqm, v_wt, v_shade, v_lot, v_series, v_design,
      NULLIF(trim(COALESCE(p_specs->>'pei_rating', '')), ''),
      NULLIF(trim(COALESCE(p_specs->>'water_absorption_pct', '')), '')::numeric,
      NULLIF(trim(COALESCE(p_specs->>'slip_resistance', '')), ''),
      v_edge,
      NULLIF(trim(COALESCE(p_specs->>'faces_per_design', '')), '')::integer,
      COALESCE((p_specs->>'anti_skid')::boolean, false),
      COALESCE((p_specs->>'anti_bacterial')::boolean, false)
    )
    ON CONFLICT (item_id) DO UPDATE SET
      size_length_mm = EXCLUDED.size_length_mm,
      size_width_mm = EXCLUDED.size_width_mm,
      thickness_mm = EXCLUDED.thickness_mm,
      material = EXCLUDED.material,
      finish = EXCLUDED.finish,
      use_area = EXCLUDED.use_area,
      pieces_per_box = EXCLUDED.pieces_per_box,
      sqft_per_box = EXCLUDED.sqft_per_box,
      sqm_per_box = EXCLUDED.sqm_per_box,
      weight_per_box_kg = EXCLUDED.weight_per_box_kg,
      shade = EXCLUDED.shade,
      batch_lot = EXCLUDED.batch_lot,
      series = EXCLUDED.series,
      design_name = EXCLUDED.design_name,
      pei_rating = EXCLUDED.pei_rating,
      water_absorption_pct = EXCLUDED.water_absorption_pct,
      slip_resistance = EXCLUDED.slip_resistance,
      edge_type = EXCLUDED.edge_type,
      faces_per_design = EXCLUDED.faces_per_design,
      anti_skid = EXCLUDED.anti_skid,
      anti_bacterial = EXCLUDED.anti_bacterial;

  ELSIF p_product_line = 'sanitaryware' THEN
    v_ptype := trim(COALESCE(p_specs->>'product_type', ''));
    v_mount := lower(trim(COALESCE(p_specs->>'mounting', '')));
    v_trap := trim(COALESCE(p_specs->>'trap_type', ''));
    v_colour := trim(COALESCE(p_specs->>'colour', ''));
    v_mat := trim(COALESCE(p_specs->>'material', ''));
    v_flush := trim(COALESCE(p_specs->>'flush_type_and_litres', ''));
    IF NOT (p_specs ? 'seat_cover_included') OR p_specs->'seat_cover_included' IS NULL THEN
      RAISE EXCEPTION 'Sanitaryware spec required: seat_cover_included must be specified.';
    END IF;
    v_seat := (p_specs->>'seat_cover_included')::boolean;
    v_set := trim(COALESCE(p_specs->>'set_contents', ''));
    v_dim := trim(COALESCE(p_specs->>'dimensions', ''));
    v_warr := trim(COALESCE(p_specs->>'warranty', ''));

    IF v_ptype NOT IN ('WC', 'wash basin', 'urinal', 'cistern', 'bathtub', 'pedestal', 'shower tray') THEN
      RAISE EXCEPTION 'Sanitaryware spec required: valid product_type.';
    END IF;
    IF v_mount NOT IN ('wall-hung', 'floor', 'counter', 'under-counter') THEN
      RAISE EXCEPTION 'Sanitaryware spec required: valid mounting.';
    END IF;
    IF v_trap NOT IN ('P', 'S', 'concealed') THEN
      RAISE EXCEPTION 'Sanitaryware spec required: valid trap_type.';
    END IF;
    IF length(v_colour) < 1 THEN RAISE EXCEPTION 'Sanitaryware spec required: colour cannot be empty.'; END IF;
    IF length(v_mat) < 1 THEN RAISE EXCEPTION 'Sanitaryware spec required: material cannot be empty.'; END IF;
    IF length(v_flush) < 1 THEN RAISE EXCEPTION 'Sanitaryware spec required: flush_type_and_litres cannot be empty.'; END IF;
    IF length(v_set) < 1 THEN RAISE EXCEPTION 'Sanitaryware spec required: set_contents cannot be empty.'; END IF;
    IF length(v_dim) < 1 THEN RAISE EXCEPTION 'Sanitaryware spec required: dimensions cannot be empty.'; END IF;
    IF length(v_warr) < 1 THEN RAISE EXCEPTION 'Sanitaryware spec required: warranty cannot be empty.'; END IF;

    INSERT INTO public.item_specs_sanitaryware (
      item_id, product_type, mounting, trap_type, colour, material, flush_type_and_litres,
      seat_cover_included, set_contents, dimensions, warranty,
      rough_in_distance, water_saving_rating, soft_close, series
    )
    VALUES (
      p_item_id, v_ptype, v_mount, v_trap, v_colour, v_mat, v_flush,
      v_seat, v_set, v_dim, v_warr,
      NULLIF(trim(COALESCE(p_specs->>'rough_in_distance', '')), ''),
      NULLIF(trim(COALESCE(p_specs->>'water_saving_rating', '')), ''),
      COALESCE((p_specs->>'soft_close')::boolean, false),
      NULLIF(trim(COALESCE(p_specs->>'series', '')), '')
    )
    ON CONFLICT (item_id) DO UPDATE SET
      product_type = EXCLUDED.product_type,
      mounting = EXCLUDED.mounting,
      trap_type = EXCLUDED.trap_type,
      colour = EXCLUDED.colour,
      material = EXCLUDED.material,
      flush_type_and_litres = EXCLUDED.flush_type_and_litres,
      seat_cover_included = EXCLUDED.seat_cover_included,
      set_contents = EXCLUDED.set_contents,
      dimensions = EXCLUDED.dimensions,
      warranty = EXCLUDED.warranty,
      rough_in_distance = EXCLUDED.rough_in_distance,
      water_saving_rating = EXCLUDED.water_saving_rating,
      soft_close = EXCLUDED.soft_close,
      series = EXCLUDED.series;

  ELSIF p_product_line = 'faucets_cp' THEN
    v_ptype := lower(trim(COALESCE(p_specs->>'product_type', '')));
    v_fin := lower(trim(COALESCE(p_specs->>'finish', '')));
    v_body := trim(COALESCE(p_specs->>'body_material', ''));
    v_conn := trim(COALESCE(p_specs->>'size_and_connection', ''));
    v_op := lower(trim(COALESCE(p_specs->>'operation', '')));
    v_cart := trim(COALESCE(p_specs->>'cartridge_type', ''));
    v_flow := trim(COALESCE(p_specs->>'flow_rate', ''));
    v_warr := trim(COALESCE(p_specs->>'warranty', ''));

    IF v_ptype NOT IN ('tap', 'mixer', 'shower', 'valve', 'health faucet', 'accessory') THEN
      RAISE EXCEPTION 'Faucets spec required: valid product_type.';
    END IF;
    IF v_fin NOT IN ('chrome', 'black', 'gold', 'nickel', 'rose gold') THEN
      RAISE EXCEPTION 'Faucets spec required: valid finish.';
    END IF;
    IF v_body NOT IN ('brass', 'SS', 'ABS') THEN
      RAISE EXCEPTION 'Faucets spec required: valid body_material.';
    END IF;
    IF length(v_conn) < 1 THEN RAISE EXCEPTION 'Faucets spec required: size_and_connection cannot be empty.'; END IF;
    IF v_op NOT IN ('single-lever', 'two-handle', 'sensor', 'pillar') THEN
      RAISE EXCEPTION 'Faucets spec required: valid operation.';
    END IF;
    IF length(v_cart) < 1 THEN RAISE EXCEPTION 'Faucets spec required: cartridge_type cannot be empty.'; END IF;
    IF length(v_flow) < 1 THEN RAISE EXCEPTION 'Faucets spec required: flow_rate cannot be empty.'; END IF;
    IF length(v_warr) < 1 THEN RAISE EXCEPTION 'Faucets spec required: warranty cannot be empty.'; END IF;

    INSERT INTO public.item_specs_faucets_cp (
      item_id, product_type, finish, body_material, size_and_connection, operation,
      cartridge_type, flow_rate, warranty, pressure_range, set_contents, spout_length
    )
    VALUES (
      p_item_id, v_ptype, v_fin, v_body, v_conn, v_op,
      v_cart, v_flow, v_warr,
      NULLIF(trim(COALESCE(p_specs->>'pressure_range', '')), ''),
      NULLIF(trim(COALESCE(p_specs->>'set_contents', '')), ''),
      NULLIF(trim(COALESCE(p_specs->>'spout_length', '')), '')
    )
    ON CONFLICT (item_id) DO UPDATE SET
      product_type = EXCLUDED.product_type,
      finish = EXCLUDED.finish,
      body_material = EXCLUDED.body_material,
      size_and_connection = EXCLUDED.size_and_connection,
      operation = EXCLUDED.operation,
      cartridge_type = EXCLUDED.cartridge_type,
      flow_rate = EXCLUDED.flow_rate,
      warranty = EXCLUDED.warranty,
      pressure_range = EXCLUDED.pressure_range,
      set_contents = EXCLUDED.set_contents,
      spout_length = EXCLUDED.spout_length;

  ELSIF p_product_line = 'tile_adhesive' THEN
    v_adh_type := lower(trim(COALESCE(p_specs->>'adhesive_type', '')));
    v_grade := trim(COALESCE(p_specs->>'grade', ''));
    v_pack_sz := trim(COALESCE(p_specs->>'pack_size_and_unit', ''));
    v_cov := trim(COALESCE(p_specs->>'coverage_per_pack', ''));
    v_pot := trim(COALESCE(p_specs->>'pot_life', ''));
    v_shelf := trim(COALESCE(p_specs->>'shelf_life', ''));
    v_colour := trim(COALESCE(p_specs->>'colour', ''));
    v_suit := lower(trim(COALESCE(p_specs->>'suitable_for', '')));

    IF v_adh_type NOT IN ('cement-based', 'epoxy', 'grout', 'waterproofing') THEN
      RAISE EXCEPTION 'Adhesive spec required: valid adhesive_type.';
    END IF;
    IF length(v_grade) < 1 THEN RAISE EXCEPTION 'Adhesive spec required: grade cannot be empty.'; END IF;
    IF length(v_pack_sz) < 1 THEN RAISE EXCEPTION 'Adhesive spec required: pack_size_and_unit cannot be empty.'; END IF;
    IF length(v_cov) < 1 THEN RAISE EXCEPTION 'Adhesive spec required: coverage_per_pack cannot be empty.'; END IF;
    IF length(v_pot) < 1 THEN RAISE EXCEPTION 'Adhesive spec required: pot_life cannot be empty.'; END IF;
    IF length(v_shelf) < 1 THEN RAISE EXCEPTION 'Adhesive spec required: shelf_life cannot be empty.'; END IF;
    IF length(v_colour) < 1 THEN RAISE EXCEPTION 'Adhesive spec required: colour cannot be empty.'; END IF;
    IF v_suit NOT IN ('floor', 'wall', 'outdoor', 'stone', 'large format') THEN
      RAISE EXCEPTION 'Adhesive spec required: valid suitable_for.';
    END IF;

    INSERT INTO public.item_specs_tile_adhesive (
      item_id, adhesive_type, grade, pack_size_and_unit, coverage_per_pack,
      pot_life, shelf_life, colour, suitable_for,
      open_time, curing_time, mixing_ratio
    )
    VALUES (
      p_item_id, v_adh_type, v_grade, v_pack_sz, v_cov,
      v_pot, v_shelf, v_colour, v_suit,
      NULLIF(trim(COALESCE(p_specs->>'open_time', '')), ''),
      NULLIF(trim(COALESCE(p_specs->>'curing_time', '')), ''),
      NULLIF(trim(COALESCE(p_specs->>'mixing_ratio', '')), '')
    )
    ON CONFLICT (item_id) DO UPDATE SET
      adhesive_type = EXCLUDED.adhesive_type,
      grade = EXCLUDED.grade,
      pack_size_and_unit = EXCLUDED.pack_size_and_unit,
      coverage_per_pack = EXCLUDED.coverage_per_pack,
      pot_life = EXCLUDED.pot_life,
      shelf_life = EXCLUDED.shelf_life,
      colour = EXCLUDED.colour,
      suitable_for = EXCLUDED.suitable_for,
      open_time = EXCLUDED.open_time,
      curing_time = EXCLUDED.curing_time,
      mixing_ratio = EXCLUDED.mixing_ratio;

  ELSE
    -- other_general
    v_lbl := trim(COALESCE(NULLIF(p_specs->>'item_label', ''), COALESCE(p_fallback_name, '')));
    v_ulbl := trim(COALESCE(NULLIF(p_specs->>'unit_label', ''), COALESCE(p_fallback_unit, '')));
    v_desc := trim(COALESCE(p_specs->>'size_or_description', ''));
    v_colour := trim(COALESCE(p_specs->>'colour', ''));
    v_mat := trim(COALESCE(p_specs->>'material', ''));
    v_attrs := CASE
      WHEN jsonb_typeof(p_specs->'attributes') = 'object' THEN p_specs->'attributes'
      ELSE '{}'::jsonb
    END;

    IF length(v_lbl) < 1 THEN RAISE EXCEPTION 'General spec required: item_label cannot be empty.'; END IF;
    IF length(v_ulbl) < 1 THEN RAISE EXCEPTION 'General spec required: unit_label cannot be empty.'; END IF;
    IF length(v_desc) < 1 THEN RAISE EXCEPTION 'General spec required: size_or_description cannot be empty.'; END IF;
    IF length(v_colour) < 1 THEN RAISE EXCEPTION 'General spec required: colour cannot be empty.'; END IF;
    IF length(v_mat) < 1 THEN RAISE EXCEPTION 'General spec required: material cannot be empty.'; END IF;

    INSERT INTO public.item_specs_other_general (
      item_id, item_label, unit_label, size_or_description, colour, material, attributes
    )
    VALUES (p_item_id, v_lbl, v_ulbl, v_desc, v_colour, v_mat, v_attrs)
    ON CONFLICT (item_id) DO UPDATE SET
      item_label = EXCLUDED.item_label,
      unit_label = EXCLUDED.unit_label,
      size_or_description = EXCLUDED.size_or_description,
      colour = EXCLUDED.colour,
      material = EXCLUDED.material,
      attributes = EXCLUDED.attributes;
  END IF;
END;
$$;

-- ============================================================================
-- 3. Update item_catalog_view to append typed specs jsonb
-- ============================================================================
CREATE OR REPLACE VIEW public.item_catalog_view AS
SELECT
  i.id,
  i.name,
  i.sku,
  i.barcode,
  i.category_id,
  c.name AS category_name,
  i.brand_id,
  b.name AS brand_name,
  i.base_unit_id,
  u.code AS base_unit_code,
  u.name_en AS base_unit_name_en,
  u.name_hi AS base_unit_name_hi,
  u.allow_decimal AS base_unit_allow_decimal,
  i.selling_price,
  i.mrp,
  CASE
    WHEN public.has_any_role(ARRAY['owner', 'manager', 'accountant']) THEN i.purchase_price
    ELSE NULL
  END AS purchase_price,
  i.gst_rate,
  i.hsn_code,
  i.tax_inclusive,
  i.low_stock_alert,
  i.allow_negative_stock,
  i.primary_image_file_id,
  i.pack_metadata,
  i.notes,
  i.is_active,
  i.is_demo,
  i.version,
  i.created_at,
  i.updated_at,
  COALESCE(sb.qty_on_hand, 0)::numeric(15,3) AS qty_on_hand,
  sb.last_movement_at,
  (i.item_type = 'goods' AND i.is_active AND COALESCE(sb.qty_on_hand, 0) <= 0) AS is_out_of_stock,
  (i.item_type = 'goods' AND i.is_active AND i.low_stock_alert > 0 AND COALESCE(sb.qty_on_hand, 0) <= i.low_stock_alert) AS is_low_stock,
  CASE
    WHEN public.has_any_role(ARRAY['owner', 'manager', 'accountant']) AND i.item_type = 'goods'
      THEN round((COALESCE(sb.qty_on_hand, 0) * COALESCE(i.purchase_price, 0))::numeric, 2)
    WHEN public.has_any_role(ARRAY['owner', 'manager', 'accountant'])
      THEN 0::numeric(15,2)
    ELSE NULL
  END AS stock_value,
  (SELECT count(*)::integer FROM public.item_images ii WHERE ii.item_id = i.id) AS image_count,
  (SELECT count(*)::integer FROM public.unit_conversions uc WHERE uc.item_id = i.id) AS conversions_count,
  i.item_type,
  i.product_line,
  i.supplier_id,
  sp.name AS supplier_name,
  i.country_of_origin,
  i.warranty_months,
  i.video_url,
  i.description,
  CASE i.product_line
    WHEN 'tiles_slabs' THEN to_jsonb(st) - 'item_id' - 'created_at' - 'updated_at'
    WHEN 'sanitaryware' THEN to_jsonb(ss) - 'item_id' - 'created_at' - 'updated_at'
    WHEN 'faucets_cp' THEN to_jsonb(sf) - 'item_id' - 'created_at' - 'updated_at'
    WHEN 'tile_adhesive' THEN to_jsonb(sa) - 'item_id' - 'created_at' - 'updated_at'
    WHEN 'other_general' THEN to_jsonb(so) - 'item_id' - 'created_at' - 'updated_at'
    ELSE NULL
  END AS specs
FROM public.items i
LEFT JOIN public.item_categories c ON c.id = i.category_id
LEFT JOIN public.brands b ON b.id = i.brand_id
LEFT JOIN public.parties sp ON sp.id = i.supplier_id
JOIN public.item_units u ON u.id = i.base_unit_id
LEFT JOIN public.stock_balances sb ON sb.item_id = i.id
LEFT JOIN public.item_specs_tiles_slabs st ON st.item_id = i.id
LEFT JOIN public.item_specs_sanitaryware ss ON ss.item_id = i.id
LEFT JOIN public.item_specs_faucets_cp sf ON sf.item_id = i.id
LEFT JOIN public.item_specs_tile_adhesive sa ON sa.item_id = i.id
LEFT JOIN public.item_specs_other_general so ON so.item_id = i.id
WHERE public.is_module_enabled('inventory')
  AND public.has_any_role(ARRAY['owner', 'manager', 'storekeeper', 'cashier', 'accountant']);

ALTER VIEW public.item_catalog_view SET (security_invoker = false);
GRANT SELECT ON public.item_catalog_view TO authenticated;

-- ============================================================================
-- 4. Update save_item RPC to accept p_specs jsonb DEFAULT NULL
-- ============================================================================
DROP FUNCTION IF EXISTS public.save_item(
  uuid, text, text, text, uuid, uuid, uuid, numeric, numeric, numeric, numeric, text,
  boolean, numeric, boolean, numeric, uuid, jsonb, text, jsonb, jsonb, integer, text,
  text, uuid, text, integer, text, text
);

CREATE OR REPLACE FUNCTION public.save_item(
  p_id uuid DEFAULT NULL,
  p_name text DEFAULT '',
  p_sku text DEFAULT NULL,
  p_barcode text DEFAULT NULL,
  p_category_id uuid DEFAULT NULL,
  p_brand_id uuid DEFAULT NULL,
  p_base_unit_id uuid DEFAULT NULL,
  p_selling_price numeric DEFAULT 0,
  p_mrp numeric DEFAULT NULL,
  p_purchase_price numeric DEFAULT NULL,
  p_gst_rate numeric DEFAULT 0,
  p_hsn_code text DEFAULT NULL,
  p_tax_inclusive boolean DEFAULT false,
  p_low_stock_alert numeric DEFAULT 0,
  p_allow_negative_stock boolean DEFAULT false,
  p_opening_stock numeric DEFAULT 0,
  p_opening_unit_id uuid DEFAULT NULL,
  p_pack_metadata jsonb DEFAULT '{}'::jsonb,
  p_notes text DEFAULT NULL,
  p_conversions jsonb DEFAULT '[]'::jsonb,
  p_images jsonb DEFAULT NULL,
  p_expected_version integer DEFAULT NULL,
  p_item_type text DEFAULT 'goods',
  p_product_line text DEFAULT 'other_general',
  p_supplier_id uuid DEFAULT NULL,
  p_country_of_origin text DEFAULT NULL,
  p_warranty_months integer DEFAULT NULL,
  p_video_url text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_specs jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_can_edit_cost boolean;
  v_actor_email text;
  v_clean_name text;
  v_clean_sku text;
  v_clean_barcode text;
  v_clean_hsn text;
  v_item_type text;
  v_product_line text;
  v_base_unit_code text;
  v_item public.items;
  v_existing public.items;
  v_eff_purchase numeric(15,2);
  v_conv jsonb;
  v_alt_unit uuid;
  v_factor numeric(18,6);
  v_open_qty numeric(15,3);
  v_open_unit uuid;
  v_open_base numeric(15,3);
  v_open_factor numeric(18,6);
  v_img_res jsonb := '{}'::jsonb;
  v_removed_files jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.require_module('inventory');
  v_role := public.current_user_role();
  IF v_role NOT IN ('owner', 'manager', 'storekeeper') THEN
    RAISE EXCEPTION 'Only Owner, Manager, or Storekeeper can add or edit items.';
  END IF;

  v_can_edit_cost := v_role IN ('owner', 'manager', 'accountant');
  v_item_type := CASE WHEN COALESCE(p_item_type, 'goods') = 'service' THEN 'service' ELSE 'goods' END;
  v_product_line := lower(trim(COALESCE(NULLIF(p_product_line, ''), 'other_general')));
  IF v_product_line NOT IN ('tiles_slabs', 'sanitaryware', 'faucets_cp', 'tile_adhesive', 'other_general') THEN
    RAISE EXCEPTION 'Invalid product line "%". Must be one of tiles_slabs, sanitaryware, faucets_cp, tile_adhesive, other_general.', v_product_line;
  END IF;

  v_clean_name := trim(COALESCE(p_name, ''));
  IF length(v_clean_name) < 1 THEN
    RAISE EXCEPTION 'Item name is required.';
  END IF;

  IF p_base_unit_id IS NULL THEN
    RAISE EXCEPTION 'Base unit is required.';
  END IF;

  SELECT code INTO v_base_unit_code FROM public.item_units WHERE id = p_base_unit_id;

  IF COALESCE(p_selling_price, 0) < 0 THEN
    RAISE EXCEPTION 'Selling price cannot be negative.';
  END IF;
  IF p_mrp IS NOT NULL AND p_mrp < 0 THEN
    RAISE EXCEPTION 'MRP cannot be negative.';
  END IF;
  IF COALESCE(p_purchase_price, 0) < 0 THEN
    RAISE EXCEPTION 'Purchase price cannot be negative.';
  END IF;
  IF COALESCE(p_low_stock_alert, 0) < 0 THEN
    RAISE EXCEPTION 'Low stock alert cannot be negative.';
  END IF;
  IF p_warranty_months IS NOT NULL AND p_warranty_months < 0 THEN
    RAISE EXCEPTION 'Warranty months cannot be negative.';
  END IF;

  v_clean_sku := NULLIF(upper(trim(COALESCE(p_sku, ''))), '');
  v_clean_barcode := NULLIF(upper(trim(COALESCE(p_barcode, ''))), '');
  v_clean_hsn := NULLIF(trim(COALESCE(p_hsn_code, '')), '');

  IF p_id IS NULL THEN
    v_eff_purchase := CASE WHEN v_can_edit_cost THEN COALESCE(p_purchase_price, 0) ELSE 0 END;

    INSERT INTO public.items (
      name, sku, barcode, category_id, brand_id, base_unit_id,
      selling_price, mrp, purchase_price, gst_rate, hsn_code,
      tax_inclusive, low_stock_alert, allow_negative_stock,
      pack_metadata, notes, item_type, product_line,
      supplier_id, country_of_origin, warranty_months, video_url, description,
      created_by
    )
    VALUES (
      v_clean_name, v_clean_sku, v_clean_barcode, p_category_id, p_brand_id, p_base_unit_id,
      round(COALESCE(p_selling_price, 0)::numeric, 2),
      CASE WHEN p_mrp IS NOT NULL THEN round(p_mrp::numeric, 2) ELSE NULL END,
      round(v_eff_purchase::numeric, 2),
      COALESCE(p_gst_rate, 0),
      v_clean_hsn,
      COALESCE(p_tax_inclusive, false),
      CASE WHEN v_item_type = 'service' THEN 0 ELSE round(COALESCE(p_low_stock_alert, 0)::numeric, 3) END,
      CASE WHEN v_item_type = 'service' THEN true ELSE COALESCE(p_allow_negative_stock, false) END,
      COALESCE(p_pack_metadata, '{}'::jsonb),
      NULLIF(trim(COALESCE(p_notes, '')), ''),
      v_item_type,
      v_product_line,
      p_supplier_id,
      NULLIF(trim(COALESCE(p_country_of_origin, '')), ''),
      p_warranty_months,
      NULLIF(trim(COALESCE(p_video_url, '')), ''),
      NULLIF(trim(COALESCE(p_description, '')), ''),
      auth.uid()
    )
    RETURNING * INTO v_item;

    INSERT INTO public.stock_balances (item_id, qty_on_hand)
    VALUES (v_item.id, 0)
    ON CONFLICT (item_id) DO NOTHING;
  ELSE
    SELECT * INTO v_existing FROM public.items WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Item not found.';
    END IF;

    IF p_expected_version IS NOT NULL AND v_existing.version <> p_expected_version THEN
      RAISE EXCEPTION 'This item was modified by another user. Please refresh and try again.';
    END IF;

    v_eff_purchase := CASE
      WHEN v_can_edit_cost AND p_purchase_price IS NOT NULL THEN round(p_purchase_price::numeric, 2)
      ELSE v_existing.purchase_price
    END;

    UPDATE public.items
    SET
      name = v_clean_name,
      sku = v_clean_sku,
      barcode = v_clean_barcode,
      category_id = p_category_id,
      brand_id = p_brand_id,
      base_unit_id = p_base_unit_id,
      selling_price = round(COALESCE(p_selling_price, 0)::numeric, 2),
      mrp = CASE WHEN p_mrp IS NOT NULL THEN round(p_mrp::numeric, 2) ELSE NULL END,
      purchase_price = v_eff_purchase,
      gst_rate = COALESCE(p_gst_rate, 0),
      hsn_code = v_clean_hsn,
      tax_inclusive = COALESCE(p_tax_inclusive, false),
      low_stock_alert = CASE WHEN v_item_type = 'service' THEN 0 ELSE round(COALESCE(p_low_stock_alert, 0)::numeric, 3) END,
      allow_negative_stock = CASE WHEN v_item_type = 'service' THEN true ELSE COALESCE(p_allow_negative_stock, false) END,
      pack_metadata = COALESCE(p_pack_metadata, '{}'::jsonb),
      notes = NULLIF(trim(COALESCE(p_notes, '')), ''),
      item_type = v_item_type,
      product_line = v_product_line,
      supplier_id = p_supplier_id,
      country_of_origin = NULLIF(trim(COALESCE(p_country_of_origin, '')), ''),
      warranty_months = p_warranty_months,
      video_url = NULLIF(trim(COALESCE(p_video_url, '')), ''),
      description = NULLIF(trim(COALESCE(p_description, '')), ''),
      version = v_existing.version + 1
    WHERE id = p_id
    RETURNING * INTO v_item;
  END IF;

  -- Persist typed specification row if p_specs was supplied
  IF p_specs IS NOT NULL THEN
    PERFORM public._upsert_item_typed_specs(
      v_item.id,
      v_product_line,
      p_specs,
      v_clean_name,
      v_base_unit_code
    );
  END IF;

  DELETE FROM public.unit_conversions WHERE item_id = v_item.id;
  IF p_conversions IS NOT NULL AND jsonb_typeof(p_conversions) = 'array' THEN
    FOR v_conv IN SELECT value FROM jsonb_array_elements(p_conversions)
    LOOP
      v_alt_unit := NULLIF(trim(COALESCE(v_conv->>'alternate_unit_id', '')), '')::uuid;
      v_factor := COALESCE((v_conv->>'conversion_factor')::numeric, 0);
      IF v_alt_unit IS NOT NULL AND v_alt_unit <> p_base_unit_id AND v_factor > 0 THEN
        INSERT INTO public.unit_conversions (item_id, alternate_unit_id, conversion_factor)
        VALUES (v_item.id, v_alt_unit, v_factor)
        ON CONFLICT (item_id, alternate_unit_id) DO UPDATE SET conversion_factor = EXCLUDED.conversion_factor;
      END IF;
    END LOOP;
  END IF;

  IF p_id IS NULL AND v_item_type = 'goods' THEN
    v_open_qty := round(COALESCE(p_opening_stock, 0)::numeric, 3);
    IF v_open_qty > 0 THEN
      v_open_unit := COALESCE(p_opening_unit_id, p_base_unit_id);
      SELECT base_qty, conversion_factor INTO v_open_base, v_open_factor
      FROM public.convert_item_qty(v_item.id, v_open_qty, v_open_unit);

      INSERT INTO public.stock_ledger (
        item_id, movement_type, movement_date, entered_qty, entered_unit_id,
        conversion_factor, signed_base_qty, unit_cost, reason, reference_no,
        source_table, source_id, created_by
      )
      VALUES (
        v_item.id, 'opening_stock', CURRENT_DATE, v_open_qty, v_open_unit,
        v_open_factor, v_open_base, v_eff_purchase, 'Opening stock balance',
        NULL, 'items', v_item.id, auth.uid()
      );
    END IF;
  END IF;

  IF p_images IS NOT NULL AND jsonb_typeof(p_images) = 'array' THEN
    v_img_res := public.sync_item_images(v_item.id, p_images);
    v_removed_files := COALESCE(v_img_res->'removed_file_ids', '[]'::jsonb);
  END IF;

  SELECT email INTO v_actor_email FROM public.profiles WHERE id = auth.uid();
  INSERT INTO public.audit_logs (actor_id, actor_email, action, entity_type, entity_id, details)
  VALUES (
    auth.uid(), v_actor_email,
    CASE WHEN p_id IS NULL THEN 'item.created' ELSE 'item.updated' END,
    'item', v_item.id::text,
    jsonb_build_object(
      'name', v_item.name,
      'item_type', v_item.item_type,
      'product_line', v_item.product_line,
      'selling_price', v_item.selling_price
    )
  );

  SELECT * INTO v_item FROM public.items WHERE id = v_item.id;
  RETURN jsonb_build_object(
    'id', v_item.id,
    'version', v_item.version,
    'primary_image_file_id', v_item.primary_image_file_id,
    'item', to_jsonb(v_item),
    'removed_file_ids', v_removed_files
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_item(
  uuid, text, text, text, uuid, uuid, uuid, numeric, numeric, numeric, numeric, text,
  boolean, numeric, boolean, numeric, uuid, jsonb, text, jsonb, jsonb, integer, text,
  text, uuid, text, integer, text, text, jsonb
) TO authenticated;
