import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import type { ProductLineKey } from '../../core/productLines';
import {
  ADHESIVE_SUITABLE_FOR,
  ADHESIVE_TYPES,
  FAUCET_BODY_MATERIALS,
  FAUCET_FINISHES,
  FAUCET_OPERATIONS,
  FAUCET_TYPES,
  SANITARYWARE_MOUNTINGS,
  SANITARYWARE_TRAPS,
  SANITARYWARE_TYPES,
  SERVICE_BILLING_BASES,
  SERVICE_CATEGORIES,
  SQFT_PER_SQM,
  TILE_EDGE_TYPES,
  TILE_FINISHES,
  TILE_MATERIALS,
  TILE_USE_AREAS,
  type AnySpecsMap,
  type ServiceSpecs,
} from '../../core/productSpecs';

interface ProductSpecFieldsProps {
  productLine: ProductLineKey;
  specs: AnySpecsMap;
  errors: Record<string, string>;
  onChange: (next: AnySpecsMap) => void;
}

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="mt-1 text-[11px] text-[var(--give)]">{msg}</p>;
}

const inputCls = (hasErr?: boolean) =>
  `w-full h-10 px-3 rounded-lg border bg-[var(--surface)] text-sm ${
    hasErr ? 'border-[var(--give)]' : 'border-[var(--border)]'
  }`;

export function ProductSpecFields({
  productLine,
  specs,
  errors,
  onChange,
}: ProductSpecFieldsProps) {
  const [newAttrKey, setNewAttrKey] = useState('');
  const [newAttrVal, setNewAttrVal] = useState('');

  const setField = (key: string, value: unknown) => {
    const next: AnySpecsMap = { ...specs, [key]: value };
    // Auto-calculate sqm_per_box <-> sqft_per_box cleanly when user enters sqft_per_box
    if (productLine === 'tiles_slabs' && key === 'sqft_per_box') {
      const sqft = Number(value);
      if (Number.isFinite(sqft) && sqft > 0) {
        next.sqm_per_box = (sqft / SQFT_PER_SQM).toFixed(4);
      }
    }
    onChange(next);
  };

  if (productLine === 'tiles_slabs') {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs font-medium mb-1">Length (mm) *</label>
            <input
              type="number"
              step="any"
              min="0.01"
              value={String(specs.size_length_mm ?? '')}
              onChange={(e) => setField('size_length_mm', e.target.value)}
              placeholder="e.g., 600"
              className={`${inputCls(Boolean(errors.size_length_mm))} tabular-nums`}
            />
            <FieldError msg={errors.size_length_mm} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Width (mm) *</label>
            <input
              type="number"
              step="any"
              min="0.01"
              value={String(specs.size_width_mm ?? '')}
              onChange={(e) => setField('size_width_mm', e.target.value)}
              placeholder="e.g., 1200"
              className={`${inputCls(Boolean(errors.size_width_mm))} tabular-nums`}
            />
            <FieldError msg={errors.size_width_mm} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Thickness (mm) *</label>
            <input
              type="number"
              step="any"
              min="0.01"
              value={String(specs.thickness_mm ?? '')}
              onChange={(e) => setField('thickness_mm', e.target.value)}
              placeholder="e.g., 9"
              className={`${inputCls(Boolean(errors.thickness_mm))} tabular-nums`}
            />
            <FieldError msg={errors.thickness_mm} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Material *</label>
            <select
              value={String(specs.material ?? '')}
              onChange={(e) => setField('material', e.target.value)}
              className={inputCls(Boolean(errors.material))}
            >
              <option value="">Select material</option>
              {TILE_MATERIALS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <FieldError msg={errors.material} />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Finish *</label>
            <select
              value={String(specs.finish ?? '')}
              onChange={(e) => setField('finish', e.target.value)}
              className={inputCls(Boolean(errors.finish))}
            >
              <option value="">Select finish</option>
              {TILE_FINISHES.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <FieldError msg={errors.finish} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Use Area *</label>
            <select
              value={String(specs.use_area ?? '')}
              onChange={(e) => setField('use_area', e.target.value)}
              className={inputCls(Boolean(errors.use_area))}
            >
              <option value="">Select use area</option>
              {TILE_USE_AREAS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <FieldError msg={errors.use_area} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Pieces / Box *</label>
            <input
              type="number"
              step="1"
              min="1"
              value={String(specs.pieces_per_box ?? '')}
              onChange={(e) => setField('pieces_per_box', e.target.value)}
              placeholder="e.g., 2"
              className={`${inputCls(Boolean(errors.pieces_per_box))} tabular-nums`}
            />
            <FieldError msg={errors.pieces_per_box} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Weight / Box (kg) *</label>
            <input
              type="number"
              step="any"
              min="0.01"
              value={String(specs.weight_per_box_kg ?? '')}
              onChange={(e) => setField('weight_per_box_kg', e.target.value)}
              placeholder="e.g., 28.5"
              className={`${inputCls(Boolean(errors.weight_per_box_kg))} tabular-nums`}
            />
            <FieldError msg={errors.weight_per_box_kg} />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Sq.Ft / Box *</label>
            <input
              type="number"
              step="any"
              min="0.0001"
              value={String(specs.sqft_per_box ?? '')}
              onChange={(e) => setField('sqft_per_box', e.target.value)}
              placeholder="e.g., 15.5"
              className={`${inputCls(Boolean(errors.sqft_per_box))} tabular-nums`}
            />
            <FieldError msg={errors.sqft_per_box} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Sq.M / Box *</label>
            <input
              type="number"
              step="any"
              min="0.0001"
              value={String(specs.sqm_per_box ?? '')}
              onChange={(e) => setField('sqm_per_box', e.target.value)}
              placeholder="e.g., 1.44"
              className={`${inputCls(Boolean(errors.sqm_per_box))} tabular-nums`}
            />
            <FieldError msg={errors.sqm_per_box} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Shade *</label>
            <input
              type="text"
              value={String(specs.shade ?? '')}
              onChange={(e) => setField('shade', e.target.value)}
              placeholder="e.g., A1 Ivory"
              className={inputCls(Boolean(errors.shade))}
            />
            <FieldError msg={errors.shade} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Batch Lot *</label>
            <input
              type="text"
              value={String(specs.batch_lot ?? '')}
              onChange={(e) => setField('batch_lot', e.target.value)}
              placeholder="e.g., LOT-24B"
              className={`${inputCls(Boolean(errors.batch_lot))} font-mono`}
            />
            <FieldError msg={errors.batch_lot} />
          </div>

          <div className="col-span-2">
            <label className="block text-xs font-medium mb-1">Series *</label>
            <input
              type="text"
              value={String(specs.series ?? '')}
              onChange={(e) => setField('series', e.target.value)}
              placeholder="e.g., Eternity Carving Series"
              className={inputCls(Boolean(errors.series))}
            />
            <FieldError msg={errors.series} />
          </div>
          <div className="col-span-2">
            <label className="block text-xs font-medium mb-1">Design Name *</label>
            <input
              type="text"
              value={String(specs.design_name ?? '')}
              onChange={(e) => setField('design_name', e.target.value)}
              placeholder="e.g., Statuario Gold Vein"
              className={inputCls(Boolean(errors.design_name))}
            />
            <FieldError msg={errors.design_name} />
          </div>
        </div>

        {/* Optional Tiles Specifications */}
        <div className="pt-3 border-t border-[var(--border)] space-y-3">
          <p className="text-xs font-medium text-[var(--text-muted)]">
            Optional Technical Ratings
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1">PEI Rating</label>
              <input
                type="text"
                value={String(specs.pei_rating ?? '')}
                onChange={(e) => setField('pei_rating', e.target.value)}
                placeholder="e.g., PEI IV"
                className={inputCls()}
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1">
                Water Absorption %
              </label>
              <input
                type="number"
                step="any"
                min="0"
                value={String(specs.water_absorption_pct ?? '')}
                onChange={(e) => setField('water_absorption_pct', e.target.value)}
                placeholder="e.g., 0.05"
                className={`${inputCls(Boolean(errors.water_absorption_pct))} tabular-nums`}
              />
              <FieldError msg={errors.water_absorption_pct} />
            </div>
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1">
                Slip Resistance
              </label>
              <input
                type="text"
                value={String(specs.slip_resistance ?? '')}
                onChange={(e) => setField('slip_resistance', e.target.value)}
                placeholder="e.g., R10"
                className={inputCls()}
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1">Edge Type</label>
              <select
                value={String(specs.edge_type ?? '')}
                onChange={(e) => setField('edge_type', e.target.value)}
                className={inputCls()}
              >
                <option value="">Unspecified</option>
                {TILE_EDGE_TYPES.map((edge) => (
                  <option key={edge} value={edge}>
                    {edge}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1">
                Faces / Design
              </label>
              <input
                type="number"
                step="1"
                min="1"
                value={String(specs.faces_per_design ?? '')}
                onChange={(e) => setField('faces_per_design', e.target.value)}
                placeholder="e.g., 6"
                className={`${inputCls(Boolean(errors.faces_per_design))} tabular-nums`}
              />
              <FieldError msg={errors.faces_per_design} />
            </div>
            <label className="inline-flex items-center gap-2 text-xs font-medium pt-5">
              <input
                type="checkbox"
                checked={Boolean(specs.anti_skid)}
                onChange={(e) => setField('anti_skid', e.target.checked)}
              />
              <span>Anti-skid</span>
            </label>
            <label className="inline-flex items-center gap-2 text-xs font-medium pt-5">
              <input
                type="checkbox"
                checked={Boolean(specs.anti_bacterial)}
                onChange={(e) => setField('anti_bacterial', e.target.checked)}
              />
              <span>Anti-bacterial</span>
            </label>
          </div>
        </div>
      </div>
    );
  }

  if (productLine === 'sanitaryware') {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium mb-1">Type *</label>
            <select
              value={String(specs.product_type ?? '')}
              onChange={(e) => setField('product_type', e.target.value)}
              className={inputCls(Boolean(errors.product_type))}
            >
              <option value="">Select type</option>
              {SANITARYWARE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <FieldError msg={errors.product_type} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Mounting *</label>
            <select
              value={String(specs.mounting ?? '')}
              onChange={(e) => setField('mounting', e.target.value)}
              className={inputCls(Boolean(errors.mounting))}
            >
              <option value="">Select mounting</option>
              {SANITARYWARE_MOUNTINGS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <FieldError msg={errors.mounting} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Trap Type *</label>
            <select
              value={String(specs.trap_type ?? '')}
              onChange={(e) => setField('trap_type', e.target.value)}
              className={inputCls(Boolean(errors.trap_type))}
            >
              <option value="">Select trap</option>
              {SANITARYWARE_TRAPS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <FieldError msg={errors.trap_type} />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Colour *</label>
            <input
              type="text"
              value={String(specs.colour ?? '')}
              onChange={(e) => setField('colour', e.target.value)}
              placeholder="e.g., Alpine White"
              className={inputCls(Boolean(errors.colour))}
            />
            <FieldError msg={errors.colour} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Material *</label>
            <input
              type="text"
              value={String(specs.material ?? '')}
              onChange={(e) => setField('material', e.target.value)}
              placeholder="e.g., Ceramic Vitreous China"
              className={inputCls(Boolean(errors.material))}
            />
            <FieldError msg={errors.material} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Flush Type & Litres *</label>
            <input
              type="text"
              value={String(specs.flush_type_and_litres ?? '')}
              onChange={(e) => setField('flush_type_and_litres', e.target.value)}
              placeholder="e.g., Dual Flush 3/6L Rimless"
              className={inputCls(Boolean(errors.flush_type_and_litres))}
            />
            <FieldError msg={errors.flush_type_and_litres} />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Dimensions *</label>
            <input
              type="text"
              value={String(specs.dimensions ?? '')}
              onChange={(e) => setField('dimensions', e.target.value)}
              placeholder="e.g., 540 x 365 x 390 mm"
              className={inputCls(Boolean(errors.dimensions))}
            />
            <FieldError msg={errors.dimensions} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Warranty *</label>
            <input
              type="text"
              value={String(specs.warranty ?? '')}
              onChange={(e) => setField('warranty', e.target.value)}
              placeholder="e.g., 10 Years Ceramic"
              className={inputCls(Boolean(errors.warranty))}
            />
            <FieldError msg={errors.warranty} />
          </div>
          <label className="inline-flex items-center gap-2 text-xs font-medium pt-6">
            <input
              type="checkbox"
              checked={Boolean(specs.seat_cover_included)}
              onChange={(e) => setField('seat_cover_included', e.target.checked)}
            />
            <span>Seat cover included *</span>
          </label>

          <div className="sm:col-span-3">
            <label className="block text-xs font-medium mb-1">Set Contents *</label>
            <input
              type="text"
              value={String(specs.set_contents ?? '')}
              onChange={(e) => setField('set_contents', e.target.value)}
              placeholder="e.g., Pan, Soft-Close Seat Cover, Fixing Rag Bolts"
              className={inputCls(Boolean(errors.set_contents))}
            />
            <FieldError msg={errors.set_contents} />
          </div>
        </div>

        <div className="pt-3 border-t border-[var(--border)] grid grid-cols-1 sm:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">
              Rough-in Distance
            </label>
            <input
              type="text"
              value={String(specs.rough_in_distance ?? '')}
              onChange={(e) => setField('rough_in_distance', e.target.value)}
              placeholder="e.g., 220 mm"
              className={inputCls()}
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">
              Water Saving Rating
            </label>
            <input
              type="text"
              value={String(specs.water_saving_rating ?? '')}
              onChange={(e) => setField('water_saving_rating', e.target.value)}
              placeholder="e.g., 5-Star WEP"
              className={inputCls()}
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">Series</label>
            <input
              type="text"
              value={String(specs.series ?? '')}
              onChange={(e) => setField('series', e.target.value)}
              placeholder="e.g., Opal Prime"
              className={inputCls()}
            />
          </div>
          <label className="inline-flex items-center gap-2 text-xs font-medium pt-5">
            <input
              type="checkbox"
              checked={Boolean(specs.soft_close)}
              onChange={(e) => setField('soft_close', e.target.checked)}
            />
            <span>Soft close seat</span>
          </label>
        </div>
      </div>
    );
  }

  if (productLine === 'faucets_cp') {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs font-medium mb-1">Type *</label>
            <select
              value={String(specs.product_type ?? '')}
              onChange={(e) => setField('product_type', e.target.value)}
              className={inputCls(Boolean(errors.product_type))}
            >
              <option value="">Select type</option>
              {FAUCET_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <FieldError msg={errors.product_type} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Finish *</label>
            <select
              value={String(specs.finish ?? '')}
              onChange={(e) => setField('finish', e.target.value)}
              className={inputCls(Boolean(errors.finish))}
            >
              <option value="">Select finish</option>
              {FAUCET_FINISHES.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <FieldError msg={errors.finish} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Body Material *</label>
            <select
              value={String(specs.body_material ?? '')}
              onChange={(e) => setField('body_material', e.target.value)}
              className={inputCls(Boolean(errors.body_material))}
            >
              <option value="">Select material</option>
              {FAUCET_BODY_MATERIALS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <FieldError msg={errors.body_material} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Operation *</label>
            <select
              value={String(specs.operation ?? '')}
              onChange={(e) => setField('operation', e.target.value)}
              className={inputCls(Boolean(errors.operation))}
            >
              <option value="">Select operation</option>
              {FAUCET_OPERATIONS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <FieldError msg={errors.operation} />
          </div>

          <div className="sm:col-span-2">
            <label className="block text-xs font-medium mb-1">Size & Connection *</label>
            <input
              type="text"
              value={String(specs.size_and_connection ?? '')}
              onChange={(e) => setField('size_and_connection', e.target.value)}
              placeholder="e.g., 1/2 inch BSP Wall Flange"
              className={inputCls(Boolean(errors.size_and_connection))}
            />
            <FieldError msg={errors.size_and_connection} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Cartridge Type *</label>
            <input
              type="text"
              value={String(specs.cartridge_type ?? '')}
              onChange={(e) => setField('cartridge_type', e.target.value)}
              placeholder="e.g., 35mm Ceramic Disc"
              className={inputCls(Boolean(errors.cartridge_type))}
            />
            <FieldError msg={errors.cartridge_type} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Flow Rate *</label>
            <input
              type="text"
              value={String(specs.flow_rate ?? '')}
              onChange={(e) => setField('flow_rate', e.target.value)}
              placeholder="e.g., 6.5 LPM @ 3 Bar"
              className={inputCls(Boolean(errors.flow_rate))}
            />
            <FieldError msg={errors.flow_rate} />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium mb-1">Warranty *</label>
            <input
              type="text"
              value={String(specs.warranty ?? '')}
              onChange={(e) => setField('warranty', e.target.value)}
              placeholder="e.g., 7 Years Brass & Finish"
              className={inputCls(Boolean(errors.warranty))}
            />
            <FieldError msg={errors.warranty} />
          </div>
        </div>

        <div className="pt-3 border-t border-[var(--border)] grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">
              Pressure Range
            </label>
            <input
              type="text"
              value={String(specs.pressure_range ?? '')}
              onChange={(e) => setField('pressure_range', e.target.value)}
              placeholder="e.g., 0.5 - 5.0 Bar"
              className={inputCls()}
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">
              Spout Length
            </label>
            <input
              type="text"
              value={String(specs.spout_length ?? '')}
              onChange={(e) => setField('spout_length', e.target.value)}
              placeholder="e.g., 165 mm"
              className={inputCls()}
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">
              Set Contents
            </label>
            <input
              type="text"
              value={String(specs.set_contents ?? '')}
              onChange={(e) => setField('set_contents', e.target.value)}
              placeholder="e.g., Mixer body, Aerator, Wall Escutcheon"
              className={inputCls()}
            />
          </div>
        </div>
      </div>
    );
  }

  if (productLine === 'tile_adhesive') {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs font-medium mb-1">Adhesive Type *</label>
            <select
              value={String(specs.adhesive_type ?? '')}
              onChange={(e) => setField('adhesive_type', e.target.value)}
              className={inputCls(Boolean(errors.adhesive_type))}
            >
              <option value="">Select type</option>
              {ADHESIVE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <FieldError msg={errors.adhesive_type} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Grade *</label>
            <input
              type="text"
              value={String(specs.grade ?? '')}
              onChange={(e) => setField('grade', e.target.value)}
              placeholder="e.g., C2TE S1"
              className={inputCls(Boolean(errors.grade))}
            />
            <FieldError msg={errors.grade} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Pack Size & Unit *</label>
            <input
              type="text"
              value={String(specs.pack_size_and_unit ?? '')}
              onChange={(e) => setField('pack_size_and_unit', e.target.value)}
              placeholder="e.g., 20 kg Bag"
              className={inputCls(Boolean(errors.pack_size_and_unit))}
            />
            <FieldError msg={errors.pack_size_and_unit} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Suitable For *</label>
            <select
              value={String(specs.suitable_for ?? '')}
              onChange={(e) => setField('suitable_for', e.target.value)}
              className={inputCls(Boolean(errors.suitable_for))}
            >
              <option value="">Select application</option>
              {ADHESIVE_SUITABLE_FOR.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <FieldError msg={errors.suitable_for} />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Coverage / Pack *</label>
            <input
              type="text"
              value={String(specs.coverage_per_pack ?? '')}
              onChange={(e) => setField('coverage_per_pack', e.target.value)}
              placeholder="e.g., 55-65 sq.ft @ 3mm"
              className={inputCls(Boolean(errors.coverage_per_pack))}
            />
            <FieldError msg={errors.coverage_per_pack} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Pot Life *</label>
            <input
              type="text"
              value={String(specs.pot_life ?? '')}
              onChange={(e) => setField('pot_life', e.target.value)}
              placeholder="e.g., 3 Hours"
              className={inputCls(Boolean(errors.pot_life))}
            />
            <FieldError msg={errors.pot_life} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Shelf Life *</label>
            <input
              type="text"
              value={String(specs.shelf_life ?? '')}
              onChange={(e) => setField('shelf_life', e.target.value)}
              placeholder="e.g., 12 Months"
              className={inputCls(Boolean(errors.shelf_life))}
            />
            <FieldError msg={errors.shelf_life} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Colour *</label>
            <input
              type="text"
              value={String(specs.colour ?? '')}
              onChange={(e) => setField('colour', e.target.value)}
              placeholder="e.g., Grey / White"
              className={inputCls(Boolean(errors.colour))}
            />
            <FieldError msg={errors.colour} />
          </div>
        </div>

        <div className="pt-3 border-t border-[var(--border)] grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">Open Time</label>
            <input
              type="text"
              value={String(specs.open_time ?? '')}
              onChange={(e) => setField('open_time', e.target.value)}
              placeholder="e.g., 25 Minutes"
              className={inputCls()}
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">Curing Time</label>
            <input
              type="text"
              value={String(specs.curing_time ?? '')}
              onChange={(e) => setField('curing_time', e.target.value)}
              placeholder="e.g., 24 Hours"
              className={inputCls()}
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">Mixing Ratio</label>
            <input
              type="text"
              value={String(specs.mixing_ratio ?? '')}
              onChange={(e) => setField('mixing_ratio', e.target.value)}
              placeholder="e.g., 20 kg : 5.2 L Water"
              className={inputCls()}
            />
          </div>
        </div>
      </div>
    );
  }

  // other_general
  const attrs =
    specs.attributes && typeof specs.attributes === 'object' && !Array.isArray(specs.attributes)
      ? (specs.attributes as Record<string, string>)
      : {};

  const handleAddAttr = () => {
    const k = newAttrKey.trim();
    const v = newAttrVal.trim();
    if (!k || !v) return;
    setField('attributes', { ...attrs, [k]: v });
    setNewAttrKey('');
    setNewAttrVal('');
  };

  const handleRemoveAttr = (keyToRemove: string) => {
    const nextAttrs = { ...attrs };
    delete nextAttrs[keyToRemove];
    setField('attributes', nextAttrs);
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium mb-1">Spec Label / Name *</label>
          <input
            type="text"
            value={String(specs.item_label ?? '')}
            onChange={(e) => setField('item_label', e.target.value)}
            placeholder="e.g., SS Floor Drain Trap 5x5"
            className={inputCls(Boolean(errors.item_label))}
          />
          <FieldError msg={errors.item_label} />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Spec Unit *</label>
          <input
            type="text"
            value={String(specs.unit_label ?? '')}
            onChange={(e) => setField('unit_label', e.target.value)}
            placeholder="e.g., PCS"
            className={inputCls(Boolean(errors.unit_label))}
          />
          <FieldError msg={errors.unit_label} />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs font-medium mb-1">Size or Description *</label>
          <input
            type="text"
            value={String(specs.size_or_description ?? '')}
            onChange={(e) => setField('size_or_description', e.target.value)}
            placeholder="e.g., 125x125 mm Heavy Cockroach Trap"
            className={inputCls(Boolean(errors.size_or_description))}
          />
          <FieldError msg={errors.size_or_description} />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Colour *</label>
          <input
            type="text"
            value={String(specs.colour ?? '')}
            onChange={(e) => setField('colour', e.target.value)}
            placeholder="e.g., Matte Steel"
            className={inputCls(Boolean(errors.colour))}
          />
          <FieldError msg={errors.colour} />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Material *</label>
          <input
            type="text"
            value={String(specs.material ?? '')}
            onChange={(e) => setField('material', e.target.value)}
            placeholder="e.g., AISI 304 Stainless Steel"
            className={inputCls(Boolean(errors.material))}
          />
          <FieldError msg={errors.material} />
        </div>
      </div>

      {/* Free Key-Value Attributes */}
      <div className="pt-3 border-t border-[var(--border)] space-y-2.5">
        <p className="text-xs font-medium text-[var(--text-muted)]">
          Custom Key-Value Attributes
        </p>
        {Object.entries(attrs).map(([k, v]) => (
          <div key={k} className="flex items-center gap-2 text-xs">
            <input
              type="text"
              value={k}
              readOnly
              className="w-40 h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] font-medium"
            />
            <input
              type="text"
              value={v}
              onChange={(e) =>
                setField('attributes', { ...attrs, [k]: e.target.value })
              }
              className="flex-1 h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)]"
            />
            <button
              type="button"
              onClick={() => handleRemoveAttr(k)}
              aria-label={`Remove ${k}`}
              className="p-1.5 rounded text-[var(--give)] hover:bg-[var(--give-soft)]"
            >
              <IconTrash size={14} stroke={2} />
            </button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={newAttrKey}
            onChange={(e) => setNewAttrKey(e.target.value)}
            placeholder="Attribute name (e.g., Grade)"
            className="w-40 h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
          />
          <input
            type="text"
            value={newAttrVal}
            onChange={(e) => setNewAttrVal(e.target.value)}
            placeholder="Value (e.g., SS-304)"
            className="flex-1 min-w-32 h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
          />
          <button
            type="button"
            onClick={handleAddAttr}
            className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)] text-xs font-medium inline-flex items-center gap-1"
          >
            <IconPlus size={13} stroke={2.5} />
            <span>Add Attribute</span>
          </button>
        </div>
      </div>
    </div>
  );
}

interface SpecDisplayRow {
  label: string;
  value: string;
  tabular?: boolean;
}

export function ProductSpecDetailGrid({
  productLine,
  specs,
}: {
  productLine: ProductLineKey | undefined;
  specs: Record<string, unknown> | null | undefined;
}) {
  if (!specs || typeof specs !== 'object') {
    return (
      <p className="text-xs text-[var(--text-muted)]">
        No line specifications saved yet. Click Edit to populate specifications.
      </p>
    );
  }

  const rows: SpecDisplayRow[] = [];
  const push = (label: string, val: unknown, tabular = false) => {
    if (val === null || val === undefined || val === '') return;
    if (typeof val === 'boolean') {
      rows.push({ label, value: val ? 'Yes' : 'No' });
    } else {
      rows.push({ label, value: String(val), tabular });
    }
  };

  if (productLine === 'tiles_slabs') {
    push(
      'Dimensions (mm)',
      specs.size_length_mm && specs.size_width_mm
        ? `${specs.size_length_mm} × ${specs.size_width_mm} × ${specs.thickness_mm || '?'} mm`
        : '',
      true
    );
    push('Material', specs.material);
    push('Finish', specs.finish);
    push('Use Area', specs.use_area);
    push('Pieces / Box', specs.pieces_per_box, true);
    push('Sq.Ft / Box', specs.sqft_per_box, true);
    push('Sq.M / Box', specs.sqm_per_box, true);
    push('Weight / Box (kg)', specs.weight_per_box_kg, true);
    push('Shade', specs.shade);
    push('Batch Lot', specs.batch_lot, true);
    push('Series', specs.series);
    push('Design Name', specs.design_name);
    push('PEI Rating', specs.pei_rating);
    push(
      'Water Absorption',
      specs.water_absorption_pct !== undefined && specs.water_absorption_pct !== null
        ? `${specs.water_absorption_pct}%`
        : ''
    );
    push('Slip Resistance', specs.slip_resistance);
    push('Edge Type', specs.edge_type);
    push('Faces / Design', specs.faces_per_design, true);
    if (specs.anti_skid) push('Anti-skid', true);
    if (specs.anti_bacterial) push('Anti-bacterial', true);
  } else if (productLine === 'sanitaryware') {
    push('Product Type', specs.product_type);
    push('Mounting', specs.mounting);
    push('Trap Type', specs.trap_type);
    push('Colour', specs.colour);
    push('Material', specs.material);
    push('Flush Type & Litres', specs.flush_type_and_litres);
    push('Seat Cover Included', Boolean(specs.seat_cover_included));
    push('Set Contents', specs.set_contents);
    push('Dimensions', specs.dimensions, true);
    push('Warranty', specs.warranty);
    push('Rough-in Distance', specs.rough_in_distance, true);
    push('Water Saving Rating', specs.water_saving_rating);
    if (specs.soft_close) push('Soft Close', true);
    push('Series', specs.series);
  } else if (productLine === 'faucets_cp') {
    push('Faucet / CP Type', specs.product_type);
    push('Finish', specs.finish);
    push('Body Material', specs.body_material);
    push('Size & Connection', specs.size_and_connection);
    push('Operation', specs.operation);
    push('Cartridge Type', specs.cartridge_type);
    push('Flow Rate', specs.flow_rate);
    push('Warranty', specs.warranty);
    push('Pressure Range', specs.pressure_range);
    push('Spout Length', specs.spout_length);
    push('Set Contents', specs.set_contents);
  } else if (productLine === 'tile_adhesive') {
    push('Adhesive Type', specs.adhesive_type);
    push('Grade', specs.grade);
    push('Pack Size & Unit', specs.pack_size_and_unit);
    push('Coverage / Pack', specs.coverage_per_pack);
    push('Pot Life', specs.pot_life);
    push('Shelf Life', specs.shelf_life);
    push('Colour', specs.colour);
    push('Suitable For', specs.suitable_for);
    push('Open Time', specs.open_time);
    push('Curing Time', specs.curing_time);
    push('Mixing Ratio', specs.mixing_ratio);
  } else {
    push('Spec Name', specs.item_label);
    push('Spec Unit', specs.unit_label);
    push('Size / Description', specs.size_or_description);
    push('Colour', specs.colour);
    push('Material', specs.material);
    const attrs =
      specs.attributes && typeof specs.attributes === 'object' && !Array.isArray(specs.attributes)
        ? (specs.attributes as Record<string, unknown>)
        : {};
    for (const [k, v] of Object.entries(attrs)) {
      push(k, v);
    }
  }

  return (
    <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 text-xs">
      {rows.map((r) => (
        <div key={r.label}>
          <dt className="text-[var(--text-muted)]">{r.label}</dt>
          <dd className={`font-medium mt-0.5 ${r.tabular ? 'tabular-nums' : ''}`}>
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ServiceSpecFields({
  specs,
  errors,
  onChange,
}: {
  specs: ServiceSpecs;
  errors: Record<string, string>;
  onChange: (next: ServiceSpecs) => void;
}) {
  const setField = <K extends keyof ServiceSpecs>(key: K, val: ServiceSpecs[K]) => {
    onChange({ ...specs, [key]: val });
  };

  return (
    <div className="space-y-3.5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium mb-1">Service Category *</label>
          <select
            value={specs.service_category}
            onChange={(e) => setField('service_category', e.target.value)}
            className={inputCls(Boolean(errors.service_category))}
          >
            <option value="">Select service category...</option>
            {SERVICE_CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>
          <FieldError msg={errors.service_category} />
        </div>

        <div>
          <label className="block text-xs font-medium mb-1">Billing Basis *</label>
          <select
            value={specs.billing_basis}
            onChange={(e) => setField('billing_basis', e.target.value)}
            className={inputCls(Boolean(errors.billing_basis))}
          >
            {SERVICE_BILLING_BASES.map((basis) => (
              <option key={basis} value={basis}>
                {basis}
              </option>
            ))}
          </select>
          <FieldError msg={errors.billing_basis} />
        </div>

        <div>
          <label className="block text-xs font-medium mb-1">Estimated Duration</label>
          <input
            type="text"
            value={specs.est_duration}
            onChange={(e) => setField('est_duration', e.target.value)}
            placeholder="e.g., 2 hours, 1–2 days"
            className={inputCls()}
          />
        </div>

        <div>
          <label className="block text-xs font-medium mb-1">Service Area / Location</label>
          <input
            type="text"
            value={specs.service_area}
            onChange={(e) => setField('service_area', e.target.value)}
            placeholder="e.g., City limits / Within 25 km"
            className={inputCls()}
          />
        </div>

        <div>
          <label className="block text-xs font-medium mb-1">SAC Code (GST Service)</label>
          <input
            type="text"
            value={specs.sac_code}
            onChange={(e) => setField('sac_code', e.target.value)}
            placeholder="e.g., 9954, 998714"
            className={`${inputCls()} font-mono`}
          />
        </div>

        <div>
          <label className="block text-xs font-medium mb-1">Warranty / Service Terms</label>
          <input
            type="text"
            value={specs.service_terms}
            onChange={(e) => setField('service_terms', e.target.value)}
            placeholder="e.g., 30-day workmanship warranty"
            className={inputCls()}
          />
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium mb-1">Scope & Deliverables</label>
        <textarea
          rows={2}
          value={specs.scope_deliverables}
          onChange={(e) => setField('scope_deliverables', e.target.value)}
          placeholder="What is included, tools/consumables excluded, site readiness requirements..."
          className="w-full p-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm"
        />
      </div>
    </div>
  );
}

export function ServiceSpecDetailGrid({ specs }: { specs: ServiceSpecs }) {
  const rows: SpecDisplayRow[] = [];
  const push = (label: string, val: string) => {
    if (!val.trim()) return;
    rows.push({ label, value: val });
  };
  push('Service Category', specs.service_category);
  push('Billing Basis', specs.billing_basis);
  push('Estimated Duration', specs.est_duration);
  push('Service Area', specs.service_area);
  push('SAC Code', specs.sac_code);
  push('Service Terms', specs.service_terms);
  push('Scope & Deliverables', specs.scope_deliverables);

  if (rows.length === 0) {
    return (
      <p className="text-xs text-[var(--text-muted)]">
        No service details recorded yet. Click Edit to add service category, billing basis, and deliverables.
      </p>
    );
  }

  return (
    <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 text-xs">
      {rows.map((r) => (
        <div key={r.label} className={r.label === 'Scope & Deliverables' ? 'col-span-2 sm:col-span-3 lg:col-span-4' : ''}>
          <dt className="text-[var(--text-muted)]">{r.label}</dt>
          <dd className="font-medium mt-0.5">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

