import type { ProductLineKey } from './productLines';

export const SQFT_PER_SQM = 10.7639104;

export const TILE_MATERIALS = [
  'ceramic',
  'vitrified',
  'porcelain',
  'marble',
  'granite',
  'quartz',
  'other',
] as const;

export const TILE_FINISHES = [
  'glossy',
  'matte',
  'satin',
  'rustic',
  'polished',
  'carving',
] as const;

export const TILE_USE_AREAS = [
  'floor',
  'wall',
  'outdoor',
  'parking',
  'bathroom',
  'kitchen',
] as const;

export const TILE_EDGE_TYPES = ['rectified', 'non-rectified'] as const;

export const SANITARYWARE_TYPES = [
  'WC',
  'wash basin',
  'urinal',
  'cistern',
  'bathtub',
  'pedestal',
  'shower tray',
] as const;

export const SANITARYWARE_MOUNTINGS = [
  'wall-hung',
  'floor',
  'counter',
  'under-counter',
] as const;

export const SANITARYWARE_TRAPS = ['P', 'S', 'concealed'] as const;

export const FAUCET_TYPES = [
  'tap',
  'mixer',
  'shower',
  'valve',
  'health faucet',
  'accessory',
] as const;

export const FAUCET_FINISHES = [
  'chrome',
  'black',
  'gold',
  'nickel',
  'rose gold',
] as const;

export const FAUCET_BODY_MATERIALS = ['brass', 'SS', 'ABS'] as const;

export const FAUCET_OPERATIONS = [
  'single-lever',
  'two-handle',
  'sensor',
  'pillar',
] as const;

export const ADHESIVE_TYPES = [
  'cement-based',
  'epoxy',
  'grout',
  'waterproofing',
] as const;

export const ADHESIVE_SUITABLE_FOR = [
  'floor',
  'wall',
  'outdoor',
  'stone',
  'large format',
] as const;

export interface TilesSlabsSpecs {
  size_length_mm: number | string;
  size_width_mm: number | string;
  thickness_mm: number | string;
  material: (typeof TILE_MATERIALS)[number] | string;
  finish: (typeof TILE_FINISHES)[number] | string;
  use_area: (typeof TILE_USE_AREAS)[number] | string;
  pieces_per_box: number | string;
  sqft_per_box: number | string;
  sqm_per_box: number | string;
  weight_per_box_kg: number | string;
  shade: string;
  batch_lot: string;
  series: string;
  design_name: string;
  // Optional
  pei_rating?: string;
  water_absorption_pct?: number | string | null;
  slip_resistance?: string;
  edge_type?: (typeof TILE_EDGE_TYPES)[number] | string;
  faces_per_design?: number | string | null;
  anti_skid?: boolean;
  anti_bacterial?: boolean;
}

export interface SanitarywareSpecs {
  product_type: (typeof SANITARYWARE_TYPES)[number] | string;
  mounting: (typeof SANITARYWARE_MOUNTINGS)[number] | string;
  trap_type: (typeof SANITARYWARE_TRAPS)[number] | string;
  colour: string;
  material: string;
  flush_type_and_litres: string;
  seat_cover_included: boolean;
  set_contents: string;
  dimensions: string;
  warranty: string;
  // Optional
  rough_in_distance?: string;
  water_saving_rating?: string;
  soft_close?: boolean;
  series?: string;
}

export interface FaucetsCpSpecs {
  product_type: (typeof FAUCET_TYPES)[number] | string;
  finish: (typeof FAUCET_FINISHES)[number] | string;
  body_material: (typeof FAUCET_BODY_MATERIALS)[number] | string;
  size_and_connection: string;
  operation: (typeof FAUCET_OPERATIONS)[number] | string;
  cartridge_type: string;
  flow_rate: string;
  warranty: string;
  // Optional
  pressure_range?: string;
  set_contents?: string;
  spout_length?: string;
}

export interface TileAdhesiveSpecs {
  adhesive_type: (typeof ADHESIVE_TYPES)[number] | string;
  grade: string;
  pack_size_and_unit: string;
  coverage_per_pack: string;
  pot_life: string;
  shelf_life: string;
  colour: string;
  suitable_for: (typeof ADHESIVE_SUITABLE_FOR)[number] | string;
  // Optional
  open_time?: string;
  curing_time?: string;
  mixing_ratio?: string;
}

export interface OtherGeneralSpecs {
  item_label: string;
  unit_label: string;
  size_or_description: string;
  colour: string;
  material: string;
  attributes: Record<string, string>;
}

export type AnySpecsMap = Record<string, unknown>;

export interface SpecValidationResult {
  valid: boolean;
  errors: Record<string, string>;
  cleaned: AnySpecsMap;
}

export function createEmptySpecs(
  line: ProductLineKey,
  defaults?: { itemName?: string; unitCode?: string }
): AnySpecsMap {
  switch (line) {
    case 'tiles_slabs':
      return {
        size_length_mm: '',
        size_width_mm: '',
        thickness_mm: '',
        material: 'vitrified',
        finish: 'glossy',
        use_area: 'floor',
        pieces_per_box: '',
        sqft_per_box: '',
        sqm_per_box: '',
        weight_per_box_kg: '',
        shade: '',
        batch_lot: '',
        series: '',
        design_name: '',
        pei_rating: '',
        water_absorption_pct: '',
        slip_resistance: '',
        edge_type: '',
        faces_per_design: '',
        anti_skid: false,
        anti_bacterial: false,
      };
    case 'sanitaryware':
      return {
        product_type: 'WC',
        mounting: 'wall-hung',
        trap_type: 'P',
        colour: '',
        material: 'Ceramic Vitreous China',
        flush_type_and_litres: '',
        seat_cover_included: true,
        set_contents: '',
        dimensions: '',
        warranty: '',
        rough_in_distance: '',
        water_saving_rating: '',
        soft_close: false,
        series: '',
      };
    case 'faucets_cp':
      return {
        product_type: 'tap',
        finish: 'chrome',
        body_material: 'brass',
        size_and_connection: '',
        operation: 'single-lever',
        cartridge_type: '',
        flow_rate: '',
        warranty: '',
        pressure_range: '',
        set_contents: '',
        spout_length: '',
      };
    case 'tile_adhesive':
      return {
        adhesive_type: 'cement-based',
        grade: '',
        pack_size_and_unit: '',
        coverage_per_pack: '',
        pot_life: '',
        shelf_life: '',
        colour: '',
        suitable_for: 'floor',
        open_time: '',
        curing_time: '',
        mixing_ratio: '',
      };
    case 'other_general':
    default:
      return {
        item_label: defaults?.itemName?.trim() || '',
        unit_label: defaults?.unitCode?.trim() || 'PCS',
        size_or_description: '',
        colour: '',
        material: '',
        attributes: {} as Record<string, string>,
      };
  }
}

export function normalizeSpecsFromRecord(
  line: ProductLineKey,
  raw: Record<string, unknown> | null | undefined,
  defaults?: { itemName?: string; unitCode?: string }
): AnySpecsMap {
  const base = createEmptySpecs(line, defaults);
  if (!raw || typeof raw !== 'object') return base;
  const next: AnySpecsMap = { ...base };
  for (const key of Object.keys(base)) {
    if (key in raw && raw[key] !== null && raw[key] !== undefined) {
      if (key === 'attributes' && typeof raw[key] === 'object' && !Array.isArray(raw[key])) {
        const cleanAttrs: Record<string, string> = {};
        for (const [ak, av] of Object.entries(raw[key] as Record<string, unknown>)) {
          if (ak.trim()) cleanAttrs[ak] = String(av ?? '');
        }
        next.attributes = cleanAttrs;
      } else if (typeof base[key] === 'boolean') {
        next[key] = Boolean(raw[key]);
      } else {
        next[key] = String(raw[key]);
      }
    }
  }
  return next;
}

function reqStr(
  specs: AnySpecsMap,
  key: string,
  label: string,
  errors: Record<string, string>
): string {
  const val = String(specs[key] ?? '').trim();
  if (!val) {
    errors[key] = `${label} is required.`;
  }
  return val;
}

function reqPosNum(
  specs: AnySpecsMap,
  key: string,
  label: string,
  errors: Record<string, string>,
  integerOnly = false
): number {
  const raw = String(specs[key] ?? '').trim();
  if (!raw) {
    errors[key] = `${label} is required.`;
    return 0;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    errors[key] = `${label} must be greater than 0.`;
    return 0;
  }
  if (integerOnly && !Number.isInteger(n)) {
    errors[key] = `${label} must be a whole number.`;
    return 0;
  }
  return n;
}

function reqEnum<T extends readonly string[]>(
  specs: AnySpecsMap,
  key: string,
  label: string,
  allowed: T,
  errors: Record<string, string>,
  caseInsensitive = false
): string {
  const raw = String(specs[key] ?? '').trim();
  if (!raw) {
    errors[key] = `${label} is required.`;
    return '';
  }
  if (caseInsensitive) {
    const match = allowed.find((a) => a.toLowerCase() === raw.toLowerCase());
    if (!match) {
      errors[key] = `${label} must be one of: ${allowed.join(', ')}.`;
      return '';
    }
    return match;
  }
  if (!allowed.includes(raw)) {
    errors[key] = `${label} must be one of: ${allowed.join(', ')}.`;
    return '';
  }
  return raw;
}

export function validateProductSpecs(
  line: ProductLineKey,
  specs: AnySpecsMap
): SpecValidationResult {
  const errors: Record<string, string> = {};
  const cleaned: AnySpecsMap = {};

  if (line === 'tiles_slabs') {
    cleaned.size_length_mm = reqPosNum(specs, 'size_length_mm', 'Length (mm)', errors);
    cleaned.size_width_mm = reqPosNum(specs, 'size_width_mm', 'Width (mm)', errors);
    cleaned.thickness_mm = reqPosNum(specs, 'thickness_mm', 'Thickness (mm)', errors);
    cleaned.material = reqEnum(specs, 'material', 'Material', TILE_MATERIALS, errors, true);
    cleaned.finish = reqEnum(specs, 'finish', 'Finish', TILE_FINISHES, errors, true);
    cleaned.use_area = reqEnum(specs, 'use_area', 'Use Area', TILE_USE_AREAS, errors, true);
    cleaned.pieces_per_box = reqPosNum(specs, 'pieces_per_box', 'Pieces per Box', errors, true);
    cleaned.sqft_per_box = reqPosNum(specs, 'sqft_per_box', 'Sq.Ft per Box', errors);
    cleaned.sqm_per_box = reqPosNum(specs, 'sqm_per_box', 'Sq.M per Box', errors);
    cleaned.weight_per_box_kg = reqPosNum(specs, 'weight_per_box_kg', 'Weight per Box (kg)', errors);
    cleaned.shade = reqStr(specs, 'shade', 'Shade / Tone', errors);
    cleaned.batch_lot = reqStr(specs, 'batch_lot', 'Batch / Lot', errors);
    cleaned.series = reqStr(specs, 'series', 'Series', errors);
    cleaned.design_name = reqStr(specs, 'design_name', 'Design Name', errors);

    // Optional
    const pei = String(specs.pei_rating ?? '').trim();
    if (pei) cleaned.pei_rating = pei;
    const waRaw = String(specs.water_absorption_pct ?? '').trim();
    if (waRaw) {
      const wa = Number(waRaw);
      if (!Number.isFinite(wa) || wa < 0) {
        errors.water_absorption_pct = 'Water absorption % must be 0 or greater.';
      } else {
        cleaned.water_absorption_pct = wa;
      }
    }
    const slip = String(specs.slip_resistance ?? '').trim();
    if (slip) cleaned.slip_resistance = slip;
    const edge = String(specs.edge_type ?? '').trim();
    if (edge) {
      cleaned.edge_type = reqEnum(specs, 'edge_type', 'Edge Type', TILE_EDGE_TYPES, errors, true);
    }
    const facesRaw = String(specs.faces_per_design ?? '').trim();
    if (facesRaw) {
      const faces = Number(facesRaw);
      if (!Number.isInteger(faces) || faces <= 0) {
        errors.faces_per_design = 'Faces per design must be a positive whole number.';
      } else {
        cleaned.faces_per_design = faces;
      }
    }
    cleaned.anti_skid = Boolean(specs.anti_skid);
    cleaned.anti_bacterial = Boolean(specs.anti_bacterial);
  } else if (line === 'sanitaryware') {
    cleaned.product_type = reqEnum(specs, 'product_type', 'Sanitaryware Type', SANITARYWARE_TYPES, errors, true);
    cleaned.mounting = reqEnum(specs, 'mounting', 'Mounting', SANITARYWARE_MOUNTINGS, errors, true);
    cleaned.trap_type = reqEnum(specs, 'trap_type', 'Trap Type', SANITARYWARE_TRAPS, errors, true);
    cleaned.colour = reqStr(specs, 'colour', 'Colour', errors);
    cleaned.material = reqStr(specs, 'material', 'Material', errors);
    cleaned.flush_type_and_litres = reqStr(specs, 'flush_type_and_litres', 'Flush Type & Litres', errors);
    if (typeof specs.seat_cover_included !== 'boolean') {
      errors.seat_cover_included = 'Seat cover included must be specified.';
    } else {
      cleaned.seat_cover_included = specs.seat_cover_included;
    }
    cleaned.set_contents = reqStr(specs, 'set_contents', 'Set Contents', errors);
    cleaned.dimensions = reqStr(specs, 'dimensions', 'Dimensions', errors);
    cleaned.warranty = reqStr(specs, 'warranty', 'Warranty', errors);

    // Optional
    const rough = String(specs.rough_in_distance ?? '').trim();
    if (rough) cleaned.rough_in_distance = rough;
    const wsr = String(specs.water_saving_rating ?? '').trim();
    if (wsr) cleaned.water_saving_rating = wsr;
    cleaned.soft_close = Boolean(specs.soft_close);
    const series = String(specs.series ?? '').trim();
    if (series) cleaned.series = series;
  } else if (line === 'faucets_cp') {
    cleaned.product_type = reqEnum(specs, 'product_type', 'Faucet / CP Type', FAUCET_TYPES, errors, true);
    cleaned.finish = reqEnum(specs, 'finish', 'Finish', FAUCET_FINISHES, errors, true);
    cleaned.body_material = reqEnum(specs, 'body_material', 'Body Material', FAUCET_BODY_MATERIALS, errors, true);
    cleaned.size_and_connection = reqStr(specs, 'size_and_connection', 'Size & Connection', errors);
    cleaned.operation = reqEnum(specs, 'operation', 'Operation', FAUCET_OPERATIONS, errors, true);
    cleaned.cartridge_type = reqStr(specs, 'cartridge_type', 'Cartridge Type', errors);
    cleaned.flow_rate = reqStr(specs, 'flow_rate', 'Flow Rate', errors);
    cleaned.warranty = reqStr(specs, 'warranty', 'Warranty', errors);

    // Optional
    const pressure = String(specs.pressure_range ?? '').trim();
    if (pressure) cleaned.pressure_range = pressure;
    const setc = String(specs.set_contents ?? '').trim();
    if (setc) cleaned.set_contents = setc;
    const spout = String(specs.spout_length ?? '').trim();
    if (spout) cleaned.spout_length = spout;
  } else if (line === 'tile_adhesive') {
    cleaned.adhesive_type = reqEnum(specs, 'adhesive_type', 'Adhesive Type', ADHESIVE_TYPES, errors, true);
    cleaned.grade = reqStr(specs, 'grade', 'Grade', errors);
    cleaned.pack_size_and_unit = reqStr(specs, 'pack_size_and_unit', 'Pack Size & Unit', errors);
    cleaned.coverage_per_pack = reqStr(specs, 'coverage_per_pack', 'Coverage per Pack', errors);
    cleaned.pot_life = reqStr(specs, 'pot_life', 'Pot Life', errors);
    cleaned.shelf_life = reqStr(specs, 'shelf_life', 'Shelf Life', errors);
    cleaned.colour = reqStr(specs, 'colour', 'Colour', errors);
    cleaned.suitable_for = reqEnum(specs, 'suitable_for', 'Suitable For', ADHESIVE_SUITABLE_FOR, errors, true);

    // Optional
    const openTime = String(specs.open_time ?? '').trim();
    if (openTime) cleaned.open_time = openTime;
    const curing = String(specs.curing_time ?? '').trim();
    if (curing) cleaned.curing_time = curing;
    const mix = String(specs.mixing_ratio ?? '').trim();
    if (mix) cleaned.mixing_ratio = mix;
  } else {
    // other_general
    cleaned.item_label = reqStr(specs, 'item_label', 'Item Label / Name', errors);
    cleaned.unit_label = reqStr(specs, 'unit_label', 'Unit', errors);
    cleaned.size_or_description = reqStr(specs, 'size_or_description', 'Size or Description', errors);
    cleaned.colour = reqStr(specs, 'colour', 'Colour', errors);
    cleaned.material = reqStr(specs, 'material', 'Material', errors);

    const rawAttrs = specs.attributes;
    const cleanAttrs: Record<string, string> = {};
    if (rawAttrs && typeof rawAttrs === 'object' && !Array.isArray(rawAttrs)) {
      for (const [k, v] of Object.entries(rawAttrs as Record<string, unknown>)) {
        const ck = k.trim();
        const cv = String(v ?? '').trim();
        if (ck && cv) {
          cleanAttrs[ck] = cv;
        }
      }
    }
    cleaned.attributes = cleanAttrs;
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    cleaned,
  };
}

export interface LineFilterFieldDef {
  key: string;
  labelEn: string;
  labelHi: string;
  options?: readonly string[];
  placeholder?: string;
}

export function getLineFilterDefinitions(line: ProductLineKey | 'all'): LineFilterFieldDef[] {
  switch (line) {
    case 'tiles_slabs':
      return [
        { key: 'material', labelEn: 'Material', labelHi: 'सामग्री', options: TILE_MATERIALS },
        { key: 'finish', labelEn: 'Finish', labelHi: 'फिनिश', options: TILE_FINISHES },
        { key: 'use_area', labelEn: 'Use Area', labelHi: 'उपयोग क्षेत्र', options: TILE_USE_AREAS },
        { key: 'shade', labelEn: 'Shade', labelHi: 'शेड', placeholder: 'e.g. A1' },
      ];
    case 'sanitaryware':
      return [
        { key: 'product_type', labelEn: 'Type', labelHi: 'प्रकार', options: SANITARYWARE_TYPES },
        { key: 'mounting', labelEn: 'Mounting', labelHi: 'माउंटिंग', options: SANITARYWARE_MOUNTINGS },
        { key: 'trap_type', labelEn: 'Trap', labelHi: 'ट्रैप', options: SANITARYWARE_TRAPS },
      ];
    case 'faucets_cp':
      return [
        { key: 'product_type', labelEn: 'Type', labelHi: 'प्रकार', options: FAUCET_TYPES },
        { key: 'finish', labelEn: 'Finish', labelHi: 'फिनिश', options: FAUCET_FINISHES },
        { key: 'operation', labelEn: 'Operation', labelHi: 'संचालन', options: FAUCET_OPERATIONS },
      ];
    case 'tile_adhesive':
      return [
        { key: 'adhesive_type', labelEn: 'Type', labelHi: 'प्रकार', options: ADHESIVE_TYPES },
        { key: 'suitable_for', labelEn: 'Suitable For', labelHi: 'उपयुक्त', options: ADHESIVE_SUITABLE_FOR },
        { key: 'grade', labelEn: 'Grade', labelHi: 'ग्रेड', placeholder: 'e.g. C2TE' },
      ];
    case 'other_general':
      return [
        { key: 'material', labelEn: 'Material', labelHi: 'सामग्री', placeholder: 'Filter material' },
        { key: 'colour', labelEn: 'Colour', labelHi: 'रंग', placeholder: 'Filter colour' },
      ];
    case 'all':
    default:
      return [];
  }
}

export function matchesLineSpecFilters<T extends { product_line?: ProductLineKey; specs?: Record<string, unknown> | null }>(
  item: T,
  lineFilter: ProductLineKey | 'all',
  specFilters: Record<string, string>
): boolean {
  if (lineFilter === 'all') return true;
  if ((item.product_line || 'other_general') !== lineFilter) return false;
  const activeEntries = Object.entries(specFilters).filter(([, v]) => v.trim() !== '');
  if (activeEntries.length === 0) return true;
  const specs = item.specs;
  if (!specs || typeof specs !== 'object') return false;

  const defs = getLineFilterDefinitions(lineFilter);
  for (const [key, filterVal] of activeEntries) {
    const rawVal = specs[key];
    if (rawVal === null || rawVal === undefined) return false;
    const valStr = String(rawVal).trim().toLowerCase();
    const target = filterVal.trim().toLowerCase();
    const def = defs.find((d) => d.key === key);
    if (def?.options) {
      if (valStr !== target) return false;
    } else if (!valStr.includes(target)) {
      return false;
    }
  }
  return true;
}

export function formatItemSpecSummary(
  line: ProductLineKey | undefined,
  specs: Record<string, unknown> | null | undefined
): string {
  if (!specs || typeof specs !== 'object') return '';
  switch (line) {
    case 'tiles_slabs': {
      const l = specs.size_length_mm;
      const w = specs.size_width_mm;
      const size = l && w ? `${l}×${w} mm` : '';
      return [size, specs.finish, specs.use_area, specs.shade ? `Shade ${specs.shade}` : '']
        .filter(Boolean)
        .map(String)
        .join(' · ');
    }
    case 'sanitaryware':
      return [specs.mounting, specs.product_type, specs.trap_type ? `${specs.trap_type} trap` : '', specs.colour]
        .filter(Boolean)
        .map(String)
        .join(' · ');
    case 'faucets_cp':
      return [specs.product_type, specs.finish, specs.operation, specs.body_material]
        .filter(Boolean)
        .map(String)
        .join(' · ');
    case 'tile_adhesive':
      return [specs.adhesive_type, specs.grade, specs.pack_size_and_unit, specs.suitable_for]
        .filter(Boolean)
        .map(String)
        .join(' · ');
    case 'other_general':
      return [specs.size_or_description, specs.material, specs.colour]
        .filter(Boolean)
        .map(String)
        .join(' · ');
    default:
      return '';
  }
}

export const SERVICE_CATEGORIES = [
  'Tile / Marble Laying',
  'Plumbing & Sanitary Installation',
  'Bathroom Fitting & Waterproofing',
  'Grouting, Polishing & Sealing',
  'Site Measurement / Consultation',
  'Delivery / Unloading / Freight',
  'Other Service',
] as const;

export const SERVICE_BILLING_BASES = [
  'Per Sq.Ft',
  'Per Job / Visit',
  'Per Hour',
  'Per Day',
  'Per Point / Fixture',
  'Flat Fee',
] as const;

export interface ServiceSpecs {
  service_category: string;
  billing_basis: string;
  est_duration: string;
  service_area: string;
  scope_deliverables: string;
  sac_code: string;
  service_terms: string;
}

export function createEmptyServiceSpecs(defaults?: { sacCode?: string }): ServiceSpecs {
  return {
    service_category: '',
    billing_basis: 'Per Job / Visit',
    est_duration: '',
    service_area: '',
    scope_deliverables: '',
    sac_code: defaults?.sacCode || '',
    service_terms: '',
  };
}

export function normalizeServiceSpecsFromMetadata(
  packMetadata: Record<string, unknown> | null | undefined,
  fallbackSacCode?: string | null
): ServiceSpecs {
  const empty = createEmptyServiceSpecs({ sacCode: fallbackSacCode || '' });
  if (!packMetadata || typeof packMetadata !== 'object') return empty;
  const nested =
    packMetadata.service_specs && typeof packMetadata.service_specs === 'object' && !Array.isArray(packMetadata.service_specs)
      ? (packMetadata.service_specs as Record<string, unknown>)
      : null;

  const str = (v: unknown, fb = ''): string => (typeof v === 'string' ? v : v != null ? String(v) : fb);
  return {
    service_category: str(nested?.service_category ?? packMetadata.service_category, empty.service_category),
    billing_basis: str(nested?.billing_basis ?? packMetadata.billing_basis, empty.billing_basis),
    est_duration: str(
      nested?.est_duration ??
        packMetadata.est_duration ??
        (packMetadata.duration_mins ? `${packMetadata.duration_mins} mins` : ''),
      ''
    ),
    service_area: str(nested?.service_area ?? packMetadata.service_area, ''),
    scope_deliverables: str(nested?.scope_deliverables ?? packMetadata.scope_deliverables, ''),
    sac_code: str(nested?.sac_code ?? packMetadata.sac_code ?? fallbackSacCode, ''),
    service_terms: str(nested?.service_terms ?? packMetadata.service_terms, ''),
  };
}

export function validateServiceSpecs(specs: ServiceSpecs): {
  valid: boolean;
  errors: Record<string, string>;
  cleaned: ServiceSpecs;
} {
  const errors: Record<string, string> = {};
  const cleaned: ServiceSpecs = {
    service_category: String(specs.service_category || '').trim(),
    billing_basis: String(specs.billing_basis || '').trim(),
    est_duration: String(specs.est_duration || '').trim(),
    service_area: String(specs.service_area || '').trim(),
    scope_deliverables: String(specs.scope_deliverables || '').trim(),
    sac_code: String(specs.sac_code || '').trim(),
    service_terms: String(specs.service_terms || '').trim(),
  };

  if (!cleaned.service_category) {
    errors.service_category = 'Service category is required.';
  }
  if (!cleaned.billing_basis) {
    errors.billing_basis = 'Billing basis is required.';
  }
  return {
    valid: Object.keys(errors).length === 0,
    errors,
    cleaned,
  };
}

export function formatServiceSpecSummary(
  packMetadata: Record<string, unknown> | null | undefined
): string {
  const s = normalizeServiceSpecsFromMetadata(packMetadata);
  return [s.service_category, s.billing_basis, s.est_duration, s.service_area]
    .filter(Boolean)
    .join(' · ');
}

