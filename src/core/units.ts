import type { UnitConversionRecord } from '../types/bizone';

export function roundQty(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

export function formatStockQty(qty: number, unitCode?: string | null): string {
  const rounded = roundQty(qty);
  const formatted = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  }).format(rounded);
  return unitCode ? `${formatted} ${unitCode}` : formatted;
}

export function convertToBaseQty(params: {
  qty: number;
  unitId: string;
  baseUnitId: string;
  baseAllowDecimal?: boolean;
  conversions: Array<Pick<UnitConversionRecord, 'alternate_unit_id' | 'conversion_factor'>>;
}): { baseQty: number; factor: number } {
  const { qty, unitId, baseUnitId, baseAllowDecimal = true, conversions } = params;
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error('Quantity must be greater than zero.');
  }

  let factor = 1;
  if (unitId && unitId !== baseUnitId) {
    const found = conversions.find((c) => c.alternate_unit_id === unitId);
    if (!found || Number(found.conversion_factor) <= 0) {
      throw new Error('Selected unit has no valid conversion for this item.');
    }
    factor = Number(found.conversion_factor);
  }

  const baseQty = roundQty(qty * factor);
  if (baseQty <= 0) {
    throw new Error('Converted base quantity is too small.');
  }

  if (!baseAllowDecimal && Math.abs(baseQty - Math.trunc(baseQty)) > 1e-6) {
    throw new Error(
      `Base unit does not allow fractional quantities (computed ${baseQty}).`
    );
  }

  return { baseQty, factor };
}
