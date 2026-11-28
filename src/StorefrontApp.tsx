import {
  IconArrowRight,
  IconBuildingStore,
  IconFilter,
  IconHeart,
  IconHeartFilled,
  IconMail,
  IconMapPin,
  IconMenu2,
  IconPackage,
  IconPhone,
  IconSearch,
  IconShoppingBag,
  IconStarFilled,
  IconUser,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  extractStoreFilterFacets,
  filterStoreProducts,
  getItemSizeLabel,
  mergeStoreCartItems,
  resolveSafeStorePath,
  updateStoreCartItemQty,
} from './core/storeCatalog';
import { StoreOrdersView, StoreWishlistView } from './modules/storefront/StoreAccountViews';
import { StoreAiAssistant } from './modules/storefront/StoreAiAssistant';
import { StoreAuthModal } from './modules/storefront/StoreAuthModal';
import { StoreCheckoutDrawer } from './modules/storefront/StoreCheckoutDrawer';
import { StoreImage } from './modules/storefront/StoreImage';
import { StoreProductDetail } from './modules/storefront/StoreProductDetail';
import {
  formatInr,
  getProductImageSrc,
  LINE_FALLBACK_IMAGES,
  parseStorePath,
  STORE_HERO_DEFAULT_IMAGE,
  STORE_PRODUCT_LINE_LABELS,
  type StoreCartItem,
  type StoreConfigPayload,
  type StoreCustomerSession,
  type StoreRoute,
} from './modules/storefront/storeTypes';
import type { PublishedStoreItemRecord, StoreOrderRecord } from './types/decorbiz';

const CUSTOMER_STORAGE_KEY = 'decorbiz_store_customer_session';
const CART_STORAGE_KEY = 'decorbiz_store_cart_v1';
const STORE_BRANDING_CACHE_KEY = 'decorbiz_store_branding_v1';

const DEFAULT_CONFIG: StoreConfigPayload = {
  onlineStoreEnabled: true,
  aiAssistantEnabled: false,
  storeName: '',
  phone: null,
  email: null,
  address: null,
  logoUrl: null,
  gstRegistered: false,
  pickupEnabled: true,
  codEnabled: true,
  razorpayEnabled: false,
  razorpayKeyId: null,
  banners: [],
  pages: [],
  zones: [],
  coupons: [],
};

function loadInitialStoreConfig(): StoreConfigPayload {
  if (typeof window === 'undefined') return DEFAULT_CONFIG;
  try {
    const raw = window.localStorage.getItem(STORE_BRANDING_CACHE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const cached = JSON.parse(raw) as Partial<StoreConfigPayload>;
    return {
      ...DEFAULT_CONFIG,
      storeName: typeof cached.storeName === 'string' ? cached.storeName : '',
      phone: typeof cached.phone === 'string' ? cached.phone : null,
      email: typeof cached.email === 'string' ? cached.email : null,
      address: typeof cached.address === 'string' ? cached.address : null,
      logoUrl: typeof cached.logoUrl === 'string' ? cached.logoUrl : null,
      gstRegistered: Boolean(cached.gstRegistered),
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export default function StorefrontApp() {
  const [route, setRoute] = useState<StoreRoute>(() =>
    typeof window !== 'undefined' ? parseStorePath(window.location.pathname) : { view: 'home' }
  );
  const [config, setConfig] = useState<StoreConfigPayload>(loadInitialStoreConfig);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [items, setItems] = useState<PublishedStoreItemRecord[]>([]);
  const [loadingCatalogue, setLoadingCatalogue] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Filters & search
  const [lineFilter, setLineFilter] = useState<string>('all');
  const [sizeFilter, setSizeFilter] = useState<string>('all');
  const [finishFilter, setFinishFilter] = useState<string>('all');
  const [shadeFilter, setShadeFilter] = useState<string>('all');
  const [minPrice, setMinPrice] = useState<string>('');
  const [maxPrice, setMaxPrice] = useState<string>('');
  const [inStockOnly, setInStockOnly] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sortBy, setSortBy] = useState<'featured' | 'price_asc' | 'price_desc' | 'newest'>('featured');
  const [showFiltersMobile, setShowFiltersMobile] = useState(false);

  // Customer session, wishlist, cart & modals
  const [customerSession, setCustomerSession] = useState<StoreCustomerSession | null>(() => {
    try {
      const raw = window.localStorage.getItem(CUSTOMER_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as StoreCustomerSession) : null;
    } catch {
      return null;
    }
  });
  const [wishlistIds, setWishlistIds] = useState<string[]>([]);
  const [cart, setCart] = useState<StoreCartItem[]>(() => {
    try {
      const raw = window.localStorage.getItem(CART_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as StoreCartItem[]) : [];
    } catch {
      return [];
    }
  });
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [recoveryToken, setRecoveryToken] = useState<string | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [bannerMessage, setBannerMessage] = useState<string | null>(null);

  const applyQueryFiltersFromLocation = useCallback((rawPathWithSearch: string) => {
    try {
      const url = new URL(rawPathWithSearch, 'https://decorbiz.local');
      if (url.pathname.replace(/\/+$/, '') === '/catalogue') {
        const qLine = url.searchParams.get('line');
        const qSearch = url.searchParams.get('q');
        if (qLine !== null) {
          setLineFilter(qLine || 'all');
        }
        if (qSearch !== null) {
          setSearchQuery(qSearch);
        }
      }
      setRoute(parseStorePath(url.pathname));
    } catch {
      setRoute(parseStorePath(rawPathWithSearch));
    }
  }, []);

  const navigate = useCallback(
    (path: string) => {
      setMobileMenuOpen(false);
      if (typeof window !== 'undefined') {
        window.history.pushState({}, '', path);
        applyQueryFiltersFromLocation(path);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    },
    [applyQueryFiltersFromLocation]
  );

  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.search) {
      applyQueryFiltersFromLocation(`${window.location.pathname}${window.location.search}`);
    }
    const onPop = () => {
      applyQueryFiltersFromLocation(`${window.location.pathname}${window.location.search}`);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [applyQueryFiltersFromLocation]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const checkRecovery = () => {
      const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const queryParams = new URLSearchParams(window.location.search);
      const token = hashParams.get('access_token') || queryParams.get('access_token');
      const linkType = hashParams.get('type') || queryParams.get('type');
      if (token && linkType === 'recovery') {
        setRecoveryToken(token);
        setAuthModalOpen(true);
      }
    };
    checkRecovery();
    window.addEventListener('hashchange', checkRecovery);
    return () => window.removeEventListener('hashchange', checkRecovery);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
    } catch {
      // ignore storage quota errors
    }
  }, [cart]);

  useEffect(() => {
    try {
      if (customerSession) {
        window.localStorage.setItem(CUSTOMER_STORAGE_KEY, JSON.stringify(customerSession));
      } else {
        window.localStorage.removeItem(CUSTOMER_STORAGE_KEY);
      }
    } catch {
      // ignore
    }
  }, [customerSession]);

  const loadStoreData = useCallback(async () => {
    setLoadingCatalogue(true);
    setLoadError(null);
    try {
      const [cfgRes, catRes] = await Promise.all([
        fetch('/api/store/config'),
        fetch('/api/store/catalogue'),
      ]);
      if (cfgRes.ok) {
        const cfgData = (await cfgRes.json()) as StoreConfigPayload;
        setConfig(cfgData);
        try {
          window.localStorage.setItem(
            STORE_BRANDING_CACHE_KEY,
            JSON.stringify({
              storeName: cfgData.storeName || '',
              phone: cfgData.phone || null,
              email: cfgData.email || null,
              address: cfgData.address || null,
              logoUrl: cfgData.logoUrl || null,
              gstRegistered: Boolean(cfgData.gstRegistered),
            })
          );
        } catch {
          // ignore storage quota errors
        }
        if (typeof document !== 'undefined' && cfgData.storeName) {
          document.title = `${cfgData.storeName} — Tiles, Sanitaryware & Bath Fittings`;
        }
      } else {
        setConfig((prev) => ({ ...prev, storeName: prev.storeName || 'RV Tiles & Decor' }));
      }
      if (!catRes.ok) {
        throw new Error(`Catalogue request failed (${catRes.status})`);
      }
      const catData = (await catRes.json()) as {
        enabled: boolean;
        items: PublishedStoreItemRecord[];
      };
      setItems(catData.items || []);
    } catch (err) {
      console.warn('Failed to load storefront data:', err);
      setConfig((prev) => ({ ...prev, storeName: prev.storeName || 'RV Tiles & Decor' }));
      setLoadError('Unable to load the showroom catalogue right now. Please try again.');
    } finally {
      setConfigLoaded(true);
      setLoadingCatalogue(false);
    }
  }, []);

  useEffect(() => {
    void loadStoreData();
  }, [loadStoreData]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (!configLoaded && !config.storeName) return;
    const baseName = config.storeName || 'RV Tiles & Decor';
    let pageTitle = `${baseName} — Tiles, Sanitaryware & Bath Fittings`;
    let pageDesc = `Shop curated architectural tiles, slabs, sanitaryware, and solid brass faucets from ${baseName}.`;

    if (route.view === 'catalogue') {
      pageTitle = `Catalogue — ${baseName}`;
    } else if (route.view === 'wishlist') {
      pageTitle = `Saved Wishlist — ${baseName}`;
    } else if (route.view === 'orders') {
      pageTitle = `My Orders — ${baseName}`;
    } else if (route.view === 'page') {
      const pg = (config.pages || []).find((p) => p.slug === route.slug);
      if (pg) {
        pageTitle = `${pg.title} — ${baseName}`;
        pageDesc = pg.content.slice(0, 160);
      }
    }
    if (route.view !== 'product') {
      document.title = pageTitle;
      const metaDesc = document.querySelector('meta[name="description"]');
      if (metaDesc) metaDesc.setAttribute('content', pageDesc);
    }
  }, [route, configLoaded, config.storeName, config.pages]);

  useEffect(() => {
    if (!customerSession?.access_token) {
      setWishlistIds([]);
      return;
    }
    fetch('/api/store/wishlist', {
      headers: { Authorization: `Bearer ${customerSession.access_token}` },
    })
      .then((res) => (res.ok ? res.json() : { wishlist: [] }))
      .then((data: { wishlist?: Array<{ item_id: string }> }) => {
        setWishlistIds((data.wishlist || []).map((w) => w.item_id));
      })
      .catch((err) => {
        console.warn('Failed to load wishlist:', err);
        setWishlistIds([]);
      });
  }, [customerSession?.access_token]);

  const facets = useMemo(() => extractStoreFilterFacets(items), [items]);
  const lineCounts = useMemo(() => {
    const counts: Record<string, number> = {
      all: items.length,
      tiles_slabs: 0,
      sanitaryware: 0,
      faucets_cp: 0,
      bathware: 0,
      adhesives_grout: 0,
      accessories_services: 0,
    };
    for (const item of items) {
      counts[item.product_line] = (counts[item.product_line] || 0) + 1;
      if (item.product_line === 'sanitaryware' || item.product_line === 'faucets_cp') {
        counts.bathware += 1;
      }
    }
    return counts;
  }, [items]);

  const filteredItems = useMemo(
    () =>
      filterStoreProducts(items, {
        productLine: lineFilter,
        size: sizeFilter,
        finish: finishFilter,
        shade: shadeFilter,
        minPrice: minPrice ? Number(minPrice) : null,
        maxPrice: maxPrice ? Number(maxPrice) : null,
        inStockOnly,
        query: searchQuery,
        sort: sortBy,
      }),
    [items, lineFilter, sizeFilter, finishFilter, shadeFilter, minPrice, maxPrice, inStockOnly, searchQuery, sortBy]
  );

  const allCollectionsSearchCount = useMemo(
    () => (searchQuery.trim() ? filterStoreProducts(items, { query: searchQuery }).length : items.length),
    [items, searchQuery]
  );

  const handleToggleWishlist = async (itemId: string) => {
    if (!customerSession) {
      setAuthModalOpen(true);
      return;
    }
    const exists = wishlistIds.includes(itemId);
    const revert = () =>
      setWishlistIds((prev) =>
        exists ? (prev.includes(itemId) ? prev : [...prev, itemId]) : prev.filter((id) => id !== itemId)
      );
    setWishlistIds((prev) => (exists ? prev.filter((id) => id !== itemId) : [...prev, itemId]));
    try {
      const res = exists
        ? await fetch(`/api/store/wishlist/${itemId}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${customerSession.access_token}` },
          })
        : await fetch('/api/store/wishlist', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${customerSession.access_token}`,
            },
            body: JSON.stringify({ itemId }),
          });
      if (res.status === 401 || res.status === 403) {
        revert();
        setCustomerSession(null);
        setAuthModalOpen(true);
        setBannerMessage('Please sign in again to update your wishlist.');
        return;
      }
      if (!res.ok) {
        revert();
        console.warn('Wishlist update failed:', res.status);
      }
    } catch (err) {
      revert();
      console.warn('Wishlist update failed:', err);
    }
  };

  const handleAddToCart = (line: StoreCartItem) => {
    setCart((prev) => mergeStoreCartItems(prev, line));
  };

  const handleOrderComplete = (order: StoreOrderRecord) => {
    setCartOpen(false);
    setBannerMessage(`Order ${order.order_number} confirmed! Track status updates below.`);
    navigate('/orders');
    void loadStoreData();
  };

  const primaryBanner = (config.banners || [])[0] || null;
  const heroImageUrl =
    primaryBanner?.image_file_id ? `/api/store/files/${primaryBanner.image_file_id}` : STORE_HERO_DEFAULT_IMAGE;

  const bagCount = cart.length;

  return (
    <div className="min-h-screen bg-[#FAF9F6] text-stone-900 flex flex-col">
      {/* 3-Zone Top Header Bar (Clean single-line navigation; zero ERP references) */}
      <header className="sticky top-0 z-40 border-b border-stone-200/80 bg-[#FAF9F6]/90 backdrop-blur-md">
        <div className="max-w-7xl mx-auto h-16 px-3 sm:px-6 lg:px-8 flex items-center justify-between gap-2 sm:gap-4">
          <div className="flex items-center gap-2 sm:gap-6 min-w-0 flex-1 md:flex-initial">
            <button
              type="button"
              onClick={() => setMobileMenuOpen((v) => !v)}
              aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
              aria-expanded={mobileMenuOpen}
              className="md:hidden h-10 w-10 rounded-lg border border-stone-200 bg-white text-stone-800 inline-flex items-center justify-center shrink-0"
            >
              {mobileMenuOpen ? <IconX size={18} /> : <IconMenu2 size={18} />}
            </button>

            <button
              type="button"
              onClick={() => navigate('/')}
              className="flex items-center gap-2 text-left min-w-0 min-h-10 py-1"
            >
              {config.logoUrl ? (
                <img
                  src={config.logoUrl}
                  alt={config.storeName || 'Showroom'}
                  width={32}
                  height={32}
                  decoding="async"
                  referrerPolicy="no-referrer"
                  className="h-8 w-8 rounded-lg object-cover border border-stone-200 shrink-0"
                />
              ) : !configLoaded && !config.storeName ? (
                <div className="w-8 h-8 rounded-lg bg-stone-200 animate-pulse shrink-0" aria-hidden="true" />
              ) : (
                <div className="w-8 h-8 rounded-lg bg-stone-900 text-white flex items-center justify-center shrink-0">
                  <IconBuildingStore size={18} />
                </div>
              )}
              {config.storeName ? (
                <span className="text-sm sm:text-base font-bold tracking-tight text-stone-900 truncate max-w-[125px] sm:max-w-[220px] md:max-w-none">
                  {config.storeName}
                </span>
              ) : !configLoaded ? (
                <span className="h-4 w-24 sm:w-32 rounded bg-stone-200 animate-pulse inline-block" aria-label="Loading showroom" />
              ) : (
                <span className="text-sm sm:text-base font-bold tracking-tight text-stone-900 truncate">
                  RV Tiles &amp; Decor
                </span>
              )}
            </button>

            <nav aria-label="Primary navigation" className="hidden md:flex items-center gap-4 text-xs font-medium text-stone-600">
              <button
                type="button"
                onClick={() => {
                  setLineFilter('all');
                  navigate('/catalogue');
                }}
                aria-current={route.view === 'catalogue' && lineFilter === 'all' ? 'page' : undefined}
                className={`min-h-11 lg:min-h-0 py-2.5 px-1 inline-flex items-center hover:text-stone-900 transition-colors ${
                  route.view === 'catalogue' && lineFilter === 'all' ? 'text-stone-900 font-semibold' : ''
                }`}
              >
                Catalogue
              </button>
              <button
                type="button"
                onClick={() => {
                  setLineFilter('tiles_slabs');
                  navigate('/catalogue');
                }}
                aria-current={route.view === 'catalogue' && lineFilter === 'tiles_slabs' ? 'page' : undefined}
                className={`min-h-11 lg:min-h-0 py-2.5 px-1 inline-flex items-center hover:text-stone-900 transition-colors ${
                  route.view === 'catalogue' && lineFilter === 'tiles_slabs' ? 'text-stone-900 font-semibold' : ''
                }`}
              >
                Tiles &amp; Slabs
              </button>
              <button
                type="button"
                onClick={() => {
                  setLineFilter('bathware');
                  navigate('/catalogue');
                }}
                aria-current={
                  route.view === 'catalogue' && (lineFilter === 'bathware' || lineFilter === 'sanitaryware')
                    ? 'page'
                    : undefined
                }
                className={`min-h-11 lg:min-h-0 py-2.5 px-1 inline-flex items-center hover:text-stone-900 transition-colors ${
                  route.view === 'catalogue' && (lineFilter === 'bathware' || lineFilter === 'sanitaryware')
                    ? 'text-stone-900 font-semibold'
                    : ''
                }`}
              >
                Bathware
              </button>
              <button
                type="button"
                onClick={() => navigate('/orders')}
                aria-current={route.view === 'orders' ? 'page' : undefined}
                className={`min-h-11 lg:min-h-0 py-2.5 px-1 inline-flex items-center hover:text-stone-900 transition-colors ${
                  route.view === 'orders' ? 'text-stone-900 font-semibold' : ''
                }`}
              >
                My Orders
              </button>
            </nav>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <div className="hidden sm:block relative w-44 lg:w-52">
              <IconSearch size={14} className="absolute left-3 top-3.5 lg:top-2.5 text-stone-400" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  if (route.view !== 'home' && route.view !== 'catalogue') navigate('/catalogue');
                }}
                placeholder="Search tiles, finishes..."
                aria-label="Search products"
                className="w-full h-11 lg:h-9 pl-8 pr-3 rounded-lg border border-stone-300 bg-white text-xs text-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-800"
              />
            </div>

            <button
              type="button"
              onClick={() => navigate('/wishlist')}
              aria-label="Wishlist"
              aria-current={route.view === 'wishlist' ? 'page' : undefined}
              className="h-10 w-10 sm:min-h-11 sm:min-w-11 lg:min-h-0 lg:min-w-0 lg:h-9 lg:w-auto lg:px-2.5 rounded-lg border border-stone-200 bg-white hover:bg-stone-100 text-stone-700 inline-flex items-center justify-center gap-1 text-xs font-medium shrink-0"
            >
              <IconHeart size={16} />
              <span className="hidden lg:inline">{wishlistIds.length}</span>
            </button>

            <button
              type="button"
              onClick={() => (customerSession ? navigate('/orders') : setAuthModalOpen(true))}
              aria-label={customerSession ? 'Customer account and orders' : 'Sign In'}
              className="h-10 w-10 sm:w-auto sm:min-h-11 sm:px-3 lg:min-h-0 lg:h-9 rounded-lg border border-stone-200 bg-white hover:bg-stone-100 text-stone-800 inline-flex items-center justify-center gap-1.5 text-xs font-medium shrink-0"
            >
              {customerSession ? <IconPackage size={15} /> : <IconUser size={15} />}
              <span className="hidden sm:inline">
                {customerSession ? customerSession.customer.full_name.split(' ')[0] : 'Sign In'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setCartOpen(true)}
              className="h-10 sm:min-h-11 lg:min-h-0 lg:h-9 px-2.5 sm:px-3.5 rounded-lg bg-stone-900 hover:bg-stone-800 text-white inline-flex items-center gap-1.5 sm:gap-2 text-xs font-semibold whitespace-nowrap shrink-0"
            >
              <IconShoppingBag size={15} />
              <span className="tabular-nums">Bag ({bagCount})</span>
            </button>
          </div>
        </div>

        {/* Mobile Navigation & Search Drawer (< md) */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-stone-200 bg-[#FAF9F6] px-4 py-3 space-y-3">
            <div className="sm:hidden relative">
              <IconSearch size={14} className="absolute left-3 top-3.5 text-stone-400" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  if (route.view !== 'home' && route.view !== 'catalogue') navigate('/catalogue');
                }}
                placeholder="Search tiles, finishes..."
                aria-label="Search products"
                className="w-full h-11 pl-8 pr-3 rounded-lg border border-stone-300 bg-white text-xs text-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-800"
              />
            </div>
            <nav aria-label="Mobile navigation" className="grid grid-cols-2 gap-2 text-xs font-medium text-stone-700">
              <button
                type="button"
                onClick={() => {
                  setLineFilter('all');
                  navigate('/catalogue');
                }}
                aria-current={route.view === 'catalogue' && lineFilter === 'all' ? 'page' : undefined}
                className={`min-h-11 px-3 rounded-lg border text-left ${
                  route.view === 'catalogue' && lineFilter === 'all'
                    ? 'border-stone-900 bg-stone-900 text-white font-semibold'
                    : 'border-stone-200 bg-white'
                }`}
              >
                Catalogue
              </button>
              <button
                type="button"
                onClick={() => {
                  setLineFilter('tiles_slabs');
                  navigate('/catalogue');
                }}
                className={`min-h-11 px-3 rounded-lg border text-left ${
                  route.view === 'catalogue' && lineFilter === 'tiles_slabs'
                    ? 'border-stone-900 bg-stone-900 text-white font-semibold'
                    : 'border-stone-200 bg-white'
                }`}
              >
                Tiles &amp; Slabs
              </button>
              <button
                type="button"
                onClick={() => {
                  setLineFilter('bathware');
                  navigate('/catalogue');
                }}
                className={`min-h-11 px-3 rounded-lg border text-left ${
                  route.view === 'catalogue' && (lineFilter === 'bathware' || lineFilter === 'sanitaryware')
                    ? 'border-stone-900 bg-stone-900 text-white font-semibold'
                    : 'border-stone-200 bg-white'
                }`}
              >
                Bathware
              </button>
              <button
                type="button"
                onClick={() => navigate('/orders')}
                aria-current={route.view === 'orders' ? 'page' : undefined}
                className={`min-h-11 px-3 rounded-lg border text-left ${
                  route.view === 'orders'
                    ? 'border-stone-900 bg-stone-900 text-white font-semibold'
                    : 'border-stone-200 bg-white'
                }`}
              >
                My Orders
              </button>
            </nav>
          </div>
        )}
      </header>

      {bannerMessage && (
        <div className="bg-emerald-900 text-emerald-50 text-xs py-2.5 px-4 text-center flex items-center justify-center gap-3">
          <span>{bannerMessage}</span>
          <button
            type="button"
            onClick={() => setBannerMessage(null)}
            className="underline text-emerald-200"
          >
            Dismiss
          </button>
        </div>
      )}

      {!config.onlineStoreEnabled ? (
        <main className="flex-1 max-w-2xl mx-auto px-4 py-24 text-center space-y-3">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500 tabular-nums">404</p>
          <h1 className="text-3xl font-bold text-stone-900">Page Not Found</h1>
          <p className="text-sm text-stone-600">
            The public storefront is currently disabled and not available at this address.
          </p>
        </main>
      ) : (
        <main className="flex-1">
          {route.view === 'product' ? (
            <StoreProductDetail
              slugOrId={route.slug}
              initialItem={items.find((i) => i.online_slug === route.slug || i.id === route.slug) || null}
              customerSession={customerSession}
              wishlisted={Boolean(
                items.find((i) => (i.online_slug === route.slug || i.id === route.slug) && wishlistIds.includes(i.id))
              )}
              onToggleWishlist={handleToggleWishlist}
              onAddToCart={handleAddToCart}
              onBack={() => navigate('/catalogue')}
              onRequireAuth={() => setAuthModalOpen(true)}
            />
          ) : route.view === 'wishlist' ? (
            <StoreWishlistView
              items={items}
              wishlistIds={wishlistIds}
              onRemove={(id) => void handleToggleWishlist(id)}
              onOpenProduct={(slug) => navigate(`/product/${encodeURIComponent(slug)}`)}
            />
          ) : route.view === 'orders' ? (
            <StoreOrdersView
              customerSession={customerSession}
              onRequireAuth={() => setAuthModalOpen(true)}
              onSignOut={() => setCustomerSession(null)}
              onSessionUpdate={(next) => setCustomerSession(next)}
            />
          ) : route.view === 'page' ? (
            (() => {
              const page = (config.pages || []).find((p) => p.slug === route.slug);
              return (
                <div className="max-w-3xl mx-auto px-4 py-12 space-y-4">
                  <h1 className="text-3xl font-bold text-stone-900">{page?.title || 'Showroom Information'}</h1>
                  <div className="prose prose-stone max-w-none text-sm leading-relaxed text-stone-700 whitespace-pre-line">
                    {page?.content || 'Information page not found.'}
                  </div>
                </div>
              );
            })()
          ) : (
            <>
              {/* Hero Editorial Showcase on Home View */}
              {route.view === 'home' && (
                <>
                  <section className="relative bg-stone-900 overflow-hidden">
                    <StoreImage
                      src={heroImageUrl}
                      fallbackSrc={STORE_HERO_DEFAULT_IMAGE}
                      alt={primaryBanner?.title || 'Architectural Tiles & Bathware Showroom'}
                      width={1600}
                      height={640}
                      eager
                      skeletonClassName="bg-stone-800"
                      className="w-full h-[380px] sm:h-[480px] object-cover opacity-75"
                    />
                    <div className="absolute inset-0 bg-gradient-to-r from-stone-950/80 via-stone-950/40 to-transparent flex items-center">
                      <div className="max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8">
                        <div className="max-w-xl space-y-4 text-white">
                          <p className="text-xs uppercase tracking-[0.2em] text-stone-300 font-medium">
                            Showroom Direct · Live Inventory
                          </p>
                          <h1 className="text-3xl sm:text-5xl font-bold tracking-tight leading-tight">
                            {primaryBanner?.title || 'Architectural Surfaces & Sculpted Bathware'}
                          </h1>
                          <p className="text-sm sm:text-base text-stone-200">
                            {primaryBanner?.subtitle ||
                              'Order vitrified floor slabs by box or exact sq.ft coverage, artisan basins, and solid brass faucets with own-fleet zone delivery or showroom pickup.'}
                          </p>
                          <div className="flex flex-wrap items-center gap-3 pt-2">
                            <button
                              type="button"
                              onClick={() => navigate(resolveSafeStorePath(primaryBanner?.cta_link, '/catalogue'))}
                              className="h-11 px-6 rounded-xl bg-white text-stone-900 text-sm font-semibold inline-flex items-center gap-2 hover:bg-stone-100"
                            >
                              <span>{primaryBanner?.cta_label || 'Explore Collection'}</span>
                              <IconArrowRight size={16} />
                            </button>
                            <button
                              type="button"
                              onClick={() => navigate('/orders')}
                              className="h-11 px-5 rounded-xl border border-white/40 text-white text-sm font-medium hover:bg-white/10"
                            >
                              Track Your Order
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </section>

                  {/* Category Bento Strip */}
                  <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
                    {!configLoaded && loadingCatalogue ? (
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5" aria-label="Loading collections">
                        {[1, 2, 3].map((n) => (
                          <div
                            key={n}
                            className="aspect-[4/3] rounded-2xl border border-stone-200 bg-stone-200 animate-pulse p-5 flex flex-col justify-end gap-2"
                          >
                            <div className="h-5 w-40 rounded bg-stone-300" />
                            <div className="h-3.5 w-52 rounded bg-stone-300" />
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
                        {(
                          [
                            {
                              key: 'tiles_slabs',
                              title: 'Tiles & Marble Slabs',
                              sub: 'Order by box or room area sq.ft',
                            },
                            {
                              key: 'sanitaryware',
                              title: 'Sanitaryware & Basins',
                              sub: 'Rimless wall-hung & counter pieces',
                            },
                            {
                              key: 'faucets_cp',
                              title: 'Solid Brass Faucets',
                              sub: 'PVD brushed gold, matte & chrome',
                            },
                          ] as const
                        ).map((cat) => {
                          const catCount = lineCounts[cat.key] || 0;
                          return (
                            <button
                              key={cat.key}
                              type="button"
                              onClick={() => {
                                setLineFilter(cat.key);
                                navigate('/catalogue');
                              }}
                              className="group relative aspect-[4/3] rounded-2xl overflow-hidden border border-stone-200 text-left bg-stone-100"
                            >
                              <StoreImage
                                src={LINE_FALLBACK_IMAGES[cat.key]}
                                fallbackSrc={LINE_FALLBACK_IMAGES.tiles_slabs}
                                alt={cat.title}
                                width={600}
                                height={450}
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                              />
                              <div className="absolute inset-0 bg-gradient-to-t from-stone-950/80 via-stone-950/20 to-transparent p-5 flex flex-col justify-end text-white">
                                <div className="flex items-center justify-between gap-2">
                                  <h2 className="text-lg font-bold">{cat.title}</h2>
                                  {items.length > 0 && (
                                    <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-white/15 text-white tabular-nums">
                                      {catCount} {catCount === 1 ? 'item' : 'items'}
                                    </span>
                                  )}
                                </div>
                                <p className="text-xs text-stone-200">{cat.sub}</p>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </section>
                </>
              )}

              {/* Catalogue + Filterable Grid */}
              <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-stone-200 pb-4">
                  <div>
                    {route.view === 'catalogue' ? (
                      <h1 className="text-2xl font-bold text-stone-900">
                        {STORE_PRODUCT_LINE_LABELS[lineFilter] || 'Showroom Catalogue'}
                      </h1>
                    ) : (
                      <h2 className="text-2xl font-bold text-stone-900">
                        {STORE_PRODUCT_LINE_LABELS[lineFilter] || 'Showroom Catalogue'}
                      </h2>
                    )}
                    <p className="text-xs text-stone-500 mt-0.5 tabular-nums">
                      {filteredItems.length} published product(s) available
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setShowFiltersMobile((v) => !v)}
                      className="lg:hidden min-h-11 min-w-11 px-3 rounded-lg border border-stone-300 bg-white text-xs font-medium inline-flex items-center gap-1.5"
                    >
                      <IconFilter size={14} />
                      <span>Filters</span>
                    </button>

                    <select
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                      aria-label="Sort products"
                      className="h-11 lg:h-9 px-3 rounded-lg border border-stone-300 bg-white text-xs font-medium text-stone-800"
                    >
                      <option value="featured">Featured Collection</option>
                      <option value="price_asc">Price: Low to High</option>
                      <option value="price_desc">Price: High to Low</option>
                      <option value="newest">Newest Arrivals</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
                  {/* Left Filter Rail */}
                  <aside
                    className={`lg:col-span-3 space-y-5 ${
                      showFiltersMobile ? 'block' : 'hidden lg:block'
                    }`}
                  >
                    <div className="rounded-2xl border border-stone-200 bg-white p-5 space-y-4 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold uppercase tracking-wider text-stone-800">
                          Filter Products
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setLineFilter('all');
                            setSizeFilter('all');
                            setFinishFilter('all');
                            setShadeFilter('all');
                            setMinPrice('');
                            setMaxPrice('');
                            setInStockOnly(false);
                            setSearchQuery('');
                          }}
                          className="text-sky-700 hover:underline font-medium"
                        >
                          Reset
                        </button>
                      </div>

                      <div>
                        <label htmlFor="filter-product-line" className="block font-medium text-stone-600 mb-1">Product Line</label>
                        <select
                          id="filter-product-line"
                          value={lineFilter}
                          onChange={(e) => setLineFilter(e.target.value)}
                          className="w-full h-11 lg:h-9 px-2.5 rounded-lg border border-stone-300 bg-white"
                        >
                          {Object.entries(STORE_PRODUCT_LINE_LABELS).map(([k, lbl]) => (
                            <option key={k} value={k}>
                              {items.length > 0 ? `${lbl} (${lineCounts[k] ?? 0})` : lbl}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label htmlFor="filter-size" className="block font-medium text-stone-600 mb-1">Size / Dimensions</label>
                        <select
                          id="filter-size"
                          value={sizeFilter}
                          onChange={(e) => setSizeFilter(e.target.value)}
                          className="w-full h-11 lg:h-9 px-2.5 rounded-lg border border-stone-300 bg-white"
                        >
                          <option value="all">All Sizes</option>
                          {facets.sizes.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label htmlFor="filter-finish" className="block font-medium text-stone-600 mb-1">Finish</label>
                        <select
                          id="filter-finish"
                          value={finishFilter}
                          onChange={(e) => setFinishFilter(e.target.value)}
                          className="w-full h-11 lg:h-9 px-2.5 rounded-lg border border-stone-300 bg-white"
                        >
                          <option value="all">All Finishes</option>
                          {facets.finishes.map((f) => (
                            <option key={f} value={f}>
                              {f}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label htmlFor="filter-shade" className="block font-medium text-stone-600 mb-1">Shade / Colour</label>
                        <select
                          id="filter-shade"
                          value={shadeFilter}
                          onChange={(e) => setShadeFilter(e.target.value)}
                          className="w-full h-11 lg:h-9 px-2.5 rounded-lg border border-stone-300 bg-white"
                        >
                          <option value="all">All Shades</option>
                          {facets.shades.map((sh) => (
                            <option key={sh} value={sh}>
                              {sh}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label htmlFor="filter-min-price" className="block font-medium text-stone-600 mb-1">Price Range (Rs)</label>
                        <div className="grid grid-cols-2 gap-2">
                          <input
                            id="filter-min-price"
                            type="number"
                            min={0}
                            value={minPrice}
                            onChange={(e) => setMinPrice(e.target.value)}
                            placeholder="Min"
                            aria-label="Minimum price"
                            className="h-11 lg:h-9 px-2.5 rounded-lg border border-stone-300 tabular-nums"
                          />
                          <input
                            id="filter-max-price"
                            type="number"
                            min={0}
                            value={maxPrice}
                            onChange={(e) => setMaxPrice(e.target.value)}
                            placeholder="Max"
                            aria-label="Maximum price"
                            className="h-11 lg:h-9 px-2.5 rounded-lg border border-stone-300 tabular-nums"
                          />
                        </div>
                      </div>

                      <label className="flex items-center gap-2 cursor-pointer pt-1">
                        <input
                          type="checkbox"
                          checked={inStockOnly}
                          onChange={(e) => setInStockOnly(e.target.checked)}
                          className="w-4 h-4 accent-stone-900"
                        />
                        <span className="font-medium text-stone-800">In Stock Only</span>
                      </label>
                    </div>
                  </aside>

                  {/* Product Card Grid */}
                  <div className="lg:col-span-9">
                    {loadingCatalogue ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6" aria-label="Loading products">
                        {[1, 2, 3, 4, 5, 6].map((n) => (
                          <div
                            key={n}
                            className="rounded-2xl border border-stone-200 bg-white overflow-hidden animate-pulse flex flex-col"
                          >
                            <div className="aspect-[4/3] bg-stone-200" />
                            <div className="p-4 space-y-3">
                              <div className="flex items-center justify-between gap-2">
                                <div className="h-3 w-20 rounded bg-stone-200" />
                                <div className="h-3 w-14 rounded bg-stone-200" />
                              </div>
                              <div className="h-4 w-4/5 rounded bg-stone-200" />
                              <div className="pt-2.5 border-t border-stone-100 flex items-center justify-between">
                                <div className="space-y-1.5">
                                  <div className="h-4 w-24 rounded bg-stone-200" />
                                  <div className="h-3 w-16 rounded bg-stone-200" />
                                </div>
                                <div className="h-9 w-16 rounded-xl bg-stone-200" />
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : loadError ? (
                      <div className="rounded-2xl border border-red-200 bg-white p-12 text-center space-y-3">
                        <p className="text-sm font-semibold text-stone-900">Unable to load catalogue</p>
                        <p className="text-xs text-stone-600">{loadError}</p>
                        <button
                          type="button"
                          onClick={() => void loadStoreData()}
                          className="min-h-11 px-5 rounded-xl bg-stone-900 hover:bg-stone-800 text-white text-xs font-semibold inline-flex items-center justify-center"
                        >
                          Retry
                        </button>
                      </div>
                    ) : filteredItems.length === 0 ? (
                      (() => {
                        const hasSubFilters =
                          lineFilter !== 'all' ||
                          sizeFilter !== 'all' ||
                          finishFilter !== 'all' ||
                          shadeFilter !== 'all' ||
                          Boolean(minPrice) ||
                          Boolean(maxPrice) ||
                          inStockOnly;
                        const activeLineLabel = STORE_PRODUCT_LINE_LABELS[lineFilter] || 'this collection';
                        return (
                          <div className="rounded-2xl border border-stone-200 bg-white p-10 sm:p-12 text-center space-y-3">
                            <p className="text-sm font-semibold text-stone-900">
                              {lineFilter !== 'all' && !searchQuery.trim()
                                ? `No ${activeLineLabel} published online right now`
                                : 'No matching products found'}
                            </p>
                            <p className="text-xs text-stone-600 max-w-md mx-auto">
                              {searchQuery.trim() && hasSubFilters
                                ? `No matches found for "${searchQuery.trim()}" within your active filters.`
                                : lineFilter !== 'all' && !searchQuery.trim()
                                  ? 'New arrivals for this collection are added regularly. Browse all available showroom items or contact us for catalogue requests.'
                                  : 'Try clearing your search query, size, finish, or price filters to view more showroom pieces.'}
                            </p>
                            <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
                              {searchQuery.trim() && hasSubFilters && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setLineFilter('all');
                                    setSizeFilter('all');
                                    setFinishFilter('all');
                                    setShadeFilter('all');
                                    setMinPrice('');
                                    setMaxPrice('');
                                    setInStockOnly(false);
                                  }}
                                  className="h-10 px-4 rounded-xl bg-stone-900 hover:bg-stone-800 text-white text-xs font-semibold"
                                >
                                  Search all collections{allCollectionsSearchCount > 0 ? ` (${allCollectionsSearchCount})` : ''}
                                </button>
                              )}
                              {(hasSubFilters || Boolean(searchQuery.trim())) && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setLineFilter('all');
                                    setSizeFilter('all');
                                    setFinishFilter('all');
                                    setShadeFilter('all');
                                    setMinPrice('');
                                    setMaxPrice('');
                                    setInStockOnly(false);
                                    setSearchQuery('');
                                  }}
                                  className="h-10 px-4 rounded-xl border border-stone-300 bg-white hover:bg-stone-50 text-stone-800 text-xs font-semibold"
                                >
                                  View All Published Products ({items.length})
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })()
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                        {filteredItems.map((item) => {
                          const sizeLabel = getItemSizeLabel(item);
                          const wished = wishlistIds.includes(item.id);
                          const fallbackSrc =
                            LINE_FALLBACK_IMAGES[item.product_line] || LINE_FALLBACK_IMAGES.tiles_slabs;
                          return (
                            <article
                              key={item.id}
                              className="group rounded-2xl border border-stone-200 bg-white overflow-hidden flex flex-col hover:border-stone-400 transition-colors"
                            >
                              <div className="relative aspect-[4/3] bg-stone-100 overflow-hidden">
                                <button
                                  type="button"
                                  onClick={() =>
                                    navigate(`/product/${encodeURIComponent(item.online_slug)}`)
                                  }
                                  className="w-full h-full block"
                                >
                                  <StoreImage
                                    src={getProductImageSrc(item)}
                                    fallbackSrc={fallbackSrc}
                                    alt={item.name}
                                    width={600}
                                    height={450}
                                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                                  />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleToggleWishlist(item.id)}
                                  aria-label="Save to wishlist"
                                  className="absolute top-3 right-3 min-w-11 min-h-11 lg:min-w-0 lg:min-h-0 lg:w-8 lg:h-8 rounded-full bg-white/90 border border-stone-200 flex items-center justify-center text-stone-700 hover:bg-white"
                                >
                                  {wished ? (
                                    <IconHeartFilled size={15} className="text-rose-600" />
                                  ) : (
                                    <IconHeart size={15} />
                                  )}
                                </button>
                              </div>

                              <div className="p-4 flex-1 flex flex-col justify-between gap-3">
                                <div className="space-y-1">
                                  <div className="flex items-center justify-between gap-2 text-[11px] text-stone-500 uppercase">
                                    <span>{item.brand_name || STORE_PRODUCT_LINE_LABELS[item.product_line]}</span>
                                    {sizeLabel && <span className="truncate">{sizeLabel}</span>}
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      navigate(`/product/${encodeURIComponent(item.online_slug)}`)
                                    }
                                    className="text-sm font-semibold text-stone-900 text-left hover:underline line-clamp-2"
                                  >
                                    {item.name}
                                  </button>
                                  {Number(item.review_count || 0) > 0 && (
                                    <div className="inline-flex items-center gap-1 text-[11px] text-amber-600 font-medium">
                                      <IconStarFilled size={12} />
                                      <span className="tabular-nums">
                                        {item.avg_rating} ({item.review_count})
                                      </span>
                                    </div>
                                  )}
                                </div>

                                <div className="flex items-center justify-between pt-2.5 border-t border-stone-100">
                                  <div>
                                    <div className="text-base font-bold text-stone-900 tabular-nums">
                                      {formatInr(item.effective_price)}
                                    </div>
                                    <div className="text-[11px] text-stone-500">
                                      per {item.base_unit_code} ·{' '}
                                      <span className={item.in_stock ? 'text-emerald-700' : 'text-red-600'}>
                                        {item.in_stock ? 'In Stock' : 'Out of Stock'}
                                      </span>
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      navigate(`/product/${encodeURIComponent(item.online_slug)}`)
                                    }
                                    className="h-9 px-3.5 rounded-xl bg-stone-900 hover:bg-stone-800 text-white text-xs font-semibold"
                                  >
                                    Select
                                  </button>
                                </div>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </section>
            </>
          )}
        </main>
      )}

      {/* Clean Customer-Facing Showroom Footer (ZERO links to ERP) */}
      <footer className="border-t border-stone-200 bg-white mt-12 pb-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 grid grid-cols-1 md:grid-cols-3 gap-8 text-xs text-stone-600">
          <div className="space-y-2">
            {config.storeName ? (
              <p className="text-sm font-bold text-stone-900">{config.storeName}</p>
            ) : !configLoaded ? (
              <span className="h-4 w-32 rounded bg-stone-200 animate-pulse inline-block" aria-hidden="true" />
            ) : (
              <p className="text-sm font-bold text-stone-900">RV Tiles &amp; Decor</p>
            )}
            {config.address && (
              <p className="inline-flex items-start gap-1.5">
                <IconMapPin size={14} className="shrink-0 mt-0.5 text-stone-400" />
                <span>{config.address}</span>
              </p>
            )}
            <div className="flex flex-wrap gap-4 pt-1">
              {config.phone && (
                <a
                  href={`tel:${config.phone}`}
                  className="inline-flex items-center gap-1 min-h-11 lg:min-h-0 py-2.5 lg:py-0 hover:text-stone-900 hover:underline"
                >
                  <IconPhone size={13} className="text-stone-400" />
                  <span>{config.phone}</span>
                </a>
              )}
              {config.email && (
                <a
                  href={`mailto:${config.email}`}
                  className="inline-flex items-center gap-1 min-h-11 lg:min-h-0 py-2.5 lg:py-0 hover:text-stone-900 hover:underline"
                >
                  <IconMail size={13} className="text-stone-400" />
                  <span>{config.email}</span>
                </a>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <p className="font-semibold text-stone-900">Information</p>
            <div className="flex flex-col gap-1.5">
              {(config.pages || []).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => navigate(`/page/${encodeURIComponent(p.slug)}`)}
                  className="text-left min-h-11 lg:min-h-0 py-2.5 lg:py-0.5 hover:text-stone-900 hover:underline"
                >
                  {p.title}
                </button>
              ))}
              <button
                type="button"
                onClick={() => navigate('/orders')}
                className="text-left min-h-11 lg:min-h-0 py-2.5 lg:py-0.5 hover:text-stone-900 hover:underline"
              >
                Order Status & History
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <p className="font-semibold text-stone-900">Delivery & Fulfillment</p>
            <p>
              Own-vehicle showroom dispatch across {config.zones.length} serviceable delivery zone(s).
              {config.pickupEnabled ? ' Free in-store pickup available.' : ''}
            </p>
          </div>
        </div>
      </footer>

      <StoreAuthModal
        open={authModalOpen}
        onClose={() => {
          setAuthModalOpen(false);
          if (recoveryToken && typeof window !== 'undefined' && window.location.hash) {
            window.history.replaceState({}, '', window.location.pathname + window.location.search);
            setRecoveryToken(null);
          }
        }}
        onAuthenticated={(sess) => setCustomerSession(sess)}
        recoveryToken={recoveryToken}
        onRecoveryComplete={() => {
          setRecoveryToken(null);
          if (typeof window !== 'undefined' && window.location.hash) {
            window.history.replaceState({}, '', window.location.pathname + window.location.search);
          }
          setBannerMessage('Password updated successfully. You can now sign in.');
        }}
      />

      <StoreCheckoutDrawer
        open={cartOpen}
        onClose={() => setCartOpen(false)}
        config={config}
        cart={cart}
        customerSession={customerSession}
        onUpdateQty={(key, nextBaseQty) =>
          setCart((prev) => updateStoreCartItemQty(prev, key, nextBaseQty))
        }
        onRemoveItem={(key) => setCart((prev) => prev.filter((c) => c.key !== key))}
        onClearCart={() => setCart([])}
        onRequireAuth={() => setAuthModalOpen(true)}
        onOrderComplete={handleOrderComplete}
      />

      {config.onlineStoreEnabled && config.aiAssistantEnabled && (
        <StoreAiAssistant
          storeName={config.storeName || 'RV Tiles & Decor'}
          items={items}
          hidden={cartOpen || authModalOpen || mobileMenuOpen}
          onOpenProductSlug={(slug) => navigate(`/product/${encodeURIComponent(slug)}`)}
          onOpenPageSlug={(slug) => navigate(`/page/${encodeURIComponent(slug)}`)}
          onAddToCart={handleAddToCart}
        />
      )}
    </div>
  );
}
