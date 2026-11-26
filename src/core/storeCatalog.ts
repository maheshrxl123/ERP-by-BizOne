import type {
  PublishedStoreItemRecord,
  StoreCouponRecord,
  StoreDeliveryZoneRecord,
  StoreOrderStatus,
} from '../types/decorbiz';
import { roundHalfUp } from './money.ts';

export interface TileQtyInput {
  mode: 'boxes' | 'sqft' | 'base';
  inputQty: number;
  sqftPerBox?: number | null;
  wastagePct?: number;
}

export interface TileQtyResult {
  orderedUnit: 'box' | 'sqft' | 'base';
  orderedQty: number;
  baseQty: number;
  sqftCovered: number | null;
  suggestedBoxesWithWastage: number;
}

export function computeTileOrderQty(input: TileQtyInput): TileQtyResult {
  const qty = Number(input.inputQty);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error('Order quantity must be greater than zero.');
  }
  const sqftPerBox =
    typeof input.sqftPerBox === 'number' && Number.isFinite(input.sqftPerBox) && input.sqftPerBox > 0
      ? input.sqftPerBox
      : null;
  const wastagePct =
    typeof input.wastagePct === 'number' && Number.isFinite(input.wastagePct) && input.wastagePct >= 0
      ? Math.min(50, input.wastagePct)
      : 0;

  if (input.mode === 'sqft' && sqftPerBox) {
    const adjustedSqft = qty * (1 + wastagePct / 100);
    const boxes = Math.max(1, Math.ceil(adjustedSqft / sqftPerBox));
    return {
      orderedUnit: 'sqft',
      orderedQty: roundHalfUp(qty, 2),
      baseQty: boxes,
      sqftCovered: roundHalfUp(boxes * sqftPerBox, 2),
      suggestedBoxesWithWastage: Math.max(boxes, Math.ceil((qty * 1.1) / sqftPerBox)),
    };
  }

  if (input.mode === 'boxes') {
    const boxes = Math.max(1, Math.ceil(qty));
    return {
      orderedUnit: 'box',
      orderedQty: boxes,
      baseQty: boxes,
      sqftCovered: sqftPerBox ? roundHalfUp(boxes * sqftPerBox, 2) : null,
      suggestedBoxesWithWastage: Math.max(boxes, Math.ceil(boxes * 1.1)),
    };
  }

  return {
    orderedUnit: 'base',
    orderedQty: roundHalfUp(qty, 3),
    baseQty: roundHalfUp(qty, 3),
    sqftCovered: sqftPerBox ? roundHalfUp(qty * sqftPerBox, 2) : null,
    suggestedBoxesWithWastage: Math.max(1, Math.ceil(qty)),
  };
}

export function matchDeliveryZone(
  zones: StoreDeliveryZoneRecord[],
  location: { pincode?: string | null; area?: string | null }
): StoreDeliveryZoneRecord | null {
  const activeZones = zones.filter((z) => z.is_active);
  const cleanPin = (location.pincode || '').replace(/\s+/g, '').trim();
  if (cleanPin) {
    const pinHit = activeZones.find((z) =>
      (z.pincodes || []).some((p) => p.replace(/\s+/g, '').trim() === cleanPin)
    );
    if (pinHit) return pinHit;
  }

  const cleanArea = (location.area || '').trim().toLowerCase();
  if (cleanArea) {
    const areaHit = activeZones.find((z) =>
      (z.area_keywords || []).some((kw) => {
        const cleanKw = kw.trim().toLowerCase();
        return cleanKw.length > 0 && cleanArea.includes(cleanKw);
      })
    );
    if (areaHit) return areaHit;
  }

  return null;
}

export interface OrderPricingLineInput {
  unitPrice: number;
  baseQty: number;
}

export interface OrderPricingResult {
  subtotal: number;
  discountAmount: number;
  deliveryCharge: number;
  grandTotal: number;
  couponApplied: string | null;
  errors: string[];
}

export function computeStoreOrderTotals(params: {
  lines: OrderPricingLineInput[];
  fulfillmentType: 'delivery' | 'pickup';
  zone: StoreDeliveryZoneRecord | null;
  coupon: StoreCouponRecord | null;
  nowIso?: string;
}): OrderPricingResult {
  const errors: string[] = [];
  const subtotal = roundHalfUp(
    params.lines.reduce((sum, l) => sum + roundHalfUp(l.unitPrice * l.baseQty, 2), 0),
    2
  );

  let discountAmount = 0;
  let couponApplied: string | null = null;
  const todayStr = (params.nowIso || new Date().toISOString()).slice(0, 10);

  if (params.coupon) {
    const c = params.coupon;
    if (!c.is_active) {
      errors.push(`Coupon "${c.code}" is inactive.`);
    } else if (c.valid_until && c.valid_until < todayStr) {
      errors.push(`Coupon "${c.code}" has expired.`);
    } else if (c.usage_limit !== null && c.usage_limit !== undefined && c.used_count >= c.usage_limit) {
      errors.push(`Coupon "${c.code}" usage limit has been reached.`);
    } else if (subtotal < Number(c.min_order_amount || 0)) {
      errors.push(
        `Minimum order of Rs ${Number(c.min_order_amount).toFixed(2)} required for coupon "${c.code}".`
      );
    } else {
      const rawDiscount =
        c.discount_type === 'pct'
          ? roundHalfUp((subtotal * Number(c.discount_value)) / 100, 2)
          : roundHalfUp(Number(c.discount_value), 2);
      const capped =
        c.max_discount !== null && c.max_discount !== undefined
          ? Math.min(rawDiscount, Number(c.max_discount))
          : rawDiscount;
      discountAmount = Math.min(subtotal, Math.max(0, roundHalfUp(capped, 2)));
      couponApplied = c.code;
    }
  }

  let deliveryCharge = 0;
  if (params.fulfillmentType === 'delivery') {
    if (!params.zone) {
      errors.push('Delivery is not available for the entered pincode or area. Choose Shop Pickup or enter a serviceable area.');
    } else {
      const netAfterDiscount = Math.max(0, roundHalfUp(subtotal - discountAmount, 2));
      if (netAfterDiscount < Number(params.zone.min_order_amount || 0)) {
        errors.push(
          `Minimum order amount for ${params.zone.zone_name} delivery is Rs ${Number(params.zone.min_order_amount).toFixed(2)}.`
        );
      }
      deliveryCharge = roundHalfUp(Number(params.zone.delivery_charge || 0), 2);
    }
  }

  const grandTotal = Math.max(0, roundHalfUp(subtotal - discountAmount + deliveryCharge, 2));
  return {
    subtotal,
    discountAmount,
    deliveryCharge,
    grandTotal,
    couponApplied,
    errors,
  };
}

export interface StoreProductFilters {
  productLine?: string;
  size?: string;
  finish?: string;
  shade?: string;
  minPrice?: number | null;
  maxPrice?: number | null;
  inStockOnly?: boolean;
  query?: string;
  sort?: 'featured' | 'price_asc' | 'price_desc' | 'newest';
}

export function getItemSizeLabel(item: PublishedStoreItemRecord): string | null {
  const s = item.specs as Record<string, unknown> | null;
  if (!s) return null;
  if (s.size_length_mm && s.size_width_mm) {
    return `${String(s.size_length_mm)}x${String(s.size_width_mm)} mm`;
  }
  if (typeof s.dimensions === 'string' && s.dimensions.trim()) return s.dimensions.trim();
  if (typeof s.size_and_connection === 'string' && s.size_and_connection.trim()) {
    return s.size_and_connection.trim();
  }
  if (typeof s.pack_size_and_unit === 'string' && s.pack_size_and_unit.trim()) {
    return s.pack_size_and_unit.trim();
  }
  if (typeof s.size_or_description === 'string' && s.size_or_description.trim()) {
    return s.size_or_description.trim();
  }
  return null;
}

export function getItemFinishes(item: PublishedStoreItemRecord): string[] {
  const out = new Set<string>();
  const s = item.specs as Record<string, unknown> | null;
  if (s && typeof s.finish === 'string' && s.finish.trim()) out.add(s.finish.trim());
  for (const v of item.variants || []) {
    if (v.finish && v.finish.trim()) out.add(v.finish.trim());
  }
  return Array.from(out);
}

export function getItemShades(item: PublishedStoreItemRecord): string[] {
  const out = new Set<string>();
  const s = item.specs as Record<string, unknown> | null;
  if (s && typeof s.shade === 'string' && s.shade.trim()) out.add(s.shade.trim());
  if (s && typeof s.colour === 'string' && s.colour.trim()) out.add(s.colour.trim());
  for (const v of item.variants || []) {
    if (v.shade && v.shade.trim()) out.add(v.shade.trim());
  }
  return Array.from(out);
}

export function extractStoreFilterFacets(items: PublishedStoreItemRecord[]): {
  sizes: string[];
  finishes: string[];
  shades: string[];
} {
  const sizes = new Set<string>();
  const finishes = new Set<string>();
  const shades = new Set<string>();

  for (const item of items) {
    const size = getItemSizeLabel(item);
    if (size) sizes.add(size);
    for (const v of item.variants || []) {
      if (v.size_label && v.size_label.trim()) sizes.add(v.size_label.trim());
    }
    for (const f of getItemFinishes(item)) finishes.add(f);
    for (const sh of getItemShades(item)) shades.add(sh);
  }

  return {
    sizes: Array.from(sizes).sort(),
    finishes: Array.from(finishes).sort(),
    shades: Array.from(shades).sort(),
  };
}

export function filterStoreProducts(
  items: PublishedStoreItemRecord[],
  filters: StoreProductFilters
): PublishedStoreItemRecord[] {
  const q = (filters.query || '').trim().toLowerCase();
  const minP =
    typeof filters.minPrice === 'number' && Number.isFinite(filters.minPrice)
      ? filters.minPrice
      : null;
  const maxP =
    typeof filters.maxPrice === 'number' && Number.isFinite(filters.maxPrice)
      ? filters.maxPrice
      : null;

  const filtered = items.filter((item) => {
    if (filters.productLine && filters.productLine !== 'all' && item.product_line !== filters.productLine) {
      return false;
    }
    if (filters.inStockOnly && !item.in_stock) {
      return false;
    }
    if (minP !== null && item.effective_price < minP) {
      return false;
    }
    if (maxP !== null && item.effective_price > maxP) {
      return false;
    }
    if (filters.size && filters.size !== 'all') {
      const itemSize = getItemSizeLabel(item);
      const varSizes = (item.variants || []).map((v) => v.size_label || '');
      if (itemSize !== filters.size && !varSizes.includes(filters.size)) {
        return false;
      }
    }
    if (filters.finish && filters.finish !== 'all') {
      const finishes = getItemFinishes(item).map((x) => x.toLowerCase());
      if (!finishes.includes(filters.finish.toLowerCase())) {
        return false;
      }
    }
    if (filters.shade && filters.shade !== 'all') {
      const shades = getItemShades(item).map((x) => x.toLowerCase());
      if (!shades.includes(filters.shade.toLowerCase())) {
        return false;
      }
    }
    if (q) {
      const specsStr = item.specs ? JSON.stringify(item.specs).toLowerCase() : '';
      const haystack = [
        item.name,
        item.sku || '',
        item.brand_name || '',
        item.category_name || '',
        item.online_description || '',
        item.description || '',
        specsStr,
      ]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  if (filters.sort === 'price_asc') {
    return [...filtered].sort((a, b) => a.effective_price - b.effective_price);
  }
  if (filters.sort === 'price_desc') {
    return [...filtered].sort((a, b) => b.effective_price - a.effective_price);
  }
  if (filters.sort === 'newest') {
    return [...filtered].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }
  return filtered;
}

export type StockState = 'none' | 'reserved' | 'deducted' | 'released';

export function computeStockPoolTransition(params: {
  qtyOnHand: number;
  reservedQty: number;
  orderBaseQty: number;
  allowNegativeStock: boolean;
  currentStockState: StockState;
  targetStatus: StoreOrderStatus;
}): {
  nextQtyOnHand: number;
  nextReservedQty: number;
  nextStockState: StockState;
} {
  let onHand = roundHalfUp(params.qtyOnHand, 3);
  let reserved = roundHalfUp(params.reservedQty, 3);
  const qty = roundHalfUp(params.orderBaseQty, 3);
  let stockState = params.currentStockState;

  if (['confirmed', 'packing', 'out_for_delivery', 'ready_for_pickup'].includes(params.targetStatus)) {
    if (stockState === 'none' || stockState === 'released') {
      const available = roundHalfUp(onHand - reserved, 3);
      if (!params.allowNegativeStock && available < qty) {
        throw new Error(`Insufficient available stock to reserve. Available: ${available}, Needed: ${qty}.`);
      }
      reserved = roundHalfUp(reserved + qty, 3);
      stockState = 'reserved';
    }
  } else if (['delivered', 'picked_up'].includes(params.targetStatus)) {
    if (stockState !== 'deducted') {
      if (stockState === 'none' || stockState === 'released') {
        const available = roundHalfUp(onHand - reserved, 3);
        if (!params.allowNegativeStock && available < qty) {
          throw new Error(`Insufficient unreserved stock to fulfill. Available: ${available}, Needed: ${qty}.`);
        }
      } else {
        reserved = Math.max(0, roundHalfUp(reserved - qty, 3));
      }
      const nextHand = roundHalfUp(onHand - qty, 3);
      if (!params.allowNegativeStock && nextHand < 0) {
        throw new Error(`Insufficient physical stock on hand. Available: ${onHand}, Needed: ${qty}.`);
      }
      onHand = nextHand;
      stockState = 'deducted';
    }
  } else if (params.targetStatus === 'cancelled') {
    if (stockState === 'reserved') {
      reserved = Math.max(0, roundHalfUp(reserved - qty, 3));
      stockState = 'released';
    } else if (stockState === 'deducted') {
      onHand = roundHalfUp(onHand + qty, 3);
      stockState = 'released';
    }
  }

  return {
    nextQtyOnHand: onHand,
    nextReservedQty: reserved,
    nextStockState: stockState,
  };
}

export function resolveSafeStorePath(rawPath?: string | null, fallback = '/catalogue'): string {
  const trimmed = String(rawPath || '').trim();
  if (!trimmed) return fallback;
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) {
    return fallback;
  }
  const lower = trimmed.toLowerCase();
  if (
    lower === '/erp' ||
    lower.startsWith('/erp/') ||
    lower === '/erp.html' ||
    lower.startsWith('/api/')
  ) {
    return fallback;
  }
  return trimmed;
}

