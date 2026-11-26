import type {
  CustomerRecord,
  PublishedStoreItemRecord,
  StoreBannerRecord,
  StoreCouponRecord,
  StoreDeliveryZoneRecord,
  StorePageRecord,
} from '../../types/decorbiz';
import faucetsShowcaseImg from '../../assets/images/faucets_category_showcase_1795591930878.jpg';
import heroBannerImg from '../../assets/images/showroom_hero_banner_1795591930771.jpg';
import sanitarywareShowcaseImg from '../../assets/images/sanitaryware_category_showcase_1795591931474.jpg';
import tilesShowcaseImg from '../../assets/images/tiles_category_showcase_1795591929558.jpg';

export const STORE_HERO_DEFAULT_IMAGE = heroBannerImg;

export const LINE_FALLBACK_IMAGES: Record<string, string> = {
  tiles_slabs: tilesShowcaseImg,
  sanitaryware: sanitarywareShowcaseImg,
  faucets_cp: faucetsShowcaseImg,
  tile_adhesive: tilesShowcaseImg,
  other_general: heroBannerImg,
};

export const STORE_PRODUCT_LINE_LABELS: Record<string, string> = {
  all: 'All Collections',
  tiles_slabs: 'Tiles & Slabs',
  sanitaryware: 'Sanitaryware',
  faucets_cp: 'Faucets & CP',
  tile_adhesive: 'Tile Adhesives',
  other_general: 'Bath & Building Accents',
};

export interface StoreConfigPayload {
  onlineStoreEnabled: boolean;
  aiAssistantEnabled?: boolean;
  storeName: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  logoUrl: string | null;
  pickupEnabled: boolean;
  codEnabled: boolean;
  razorpayEnabled: boolean;
  razorpayKeyId: string | null;
  banners: StoreBannerRecord[];
  pages: StorePageRecord[];
  zones: StoreDeliveryZoneRecord[];
  coupons: StoreCouponRecord[];
}

export interface StoreCustomerSession {
  access_token: string;
  refresh_token?: string;
  customer: CustomerRecord;
}

export interface StoreCartItem {
  key: string;
  item: PublishedStoreItemRecord;
  variantId: string | null;
  variantName: string | null;
  unitPrice: number;
  mode: 'boxes' | 'sqft' | 'base';
  qty: number;
  baseQty: number;
  wastagePct: number;
  sqftCovered: number | null;
}

export type StoreRoute =
  | { view: 'home' }
  | { view: 'catalogue'; line?: string }
  | { view: 'product'; slug: string }
  | { view: 'page'; slug: string }
  | { view: 'wishlist' }
  | { view: 'orders' };

export function parseStorePath(pathname: string): StoreRoute {
  const clean = pathname.replace(/\/+$/, '') || '/';
  if (clean === '/' || clean === '') return { view: 'home' };
  if (clean === '/catalogue') return { view: 'catalogue' };
  if (clean === '/wishlist') return { view: 'wishlist' };
  if (clean === '/orders') return { view: 'orders' };
  if (clean.startsWith('/product/')) {
    return { view: 'product', slug: decodeURIComponent(clean.slice('/product/'.length)) };
  }
  if (clean.startsWith('/page/')) {
    return { view: 'page', slug: decodeURIComponent(clean.slice('/page/'.length)) };
  }
  return { view: 'home' };
}

export function getProductImageSrc(
  item: Pick<PublishedStoreItemRecord, 'primary_image_file_id' | 'product_line'>,
  fileIdOverride?: string | null
): string {
  const fid = fileIdOverride ?? item.primary_image_file_id;
  if (fid) return `/api/store/files/${fid}`;
  return LINE_FALLBACK_IMAGES[item.product_line] || STORE_HERO_DEFAULT_IMAGE;
}

export function formatInr(val: number): string {
  return `₹${Number(val || 0).toLocaleString('en-IN', {
    minimumFractionDigits: Number(val || 0) % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}
