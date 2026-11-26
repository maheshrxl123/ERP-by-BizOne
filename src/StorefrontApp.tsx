import {
  IconArrowRight,
  IconBuildingStore,
  IconFilter,
  IconHeart,
  IconHeartFilled,
  IconMail,
  IconMapPin,
  IconPackage,
  IconPhone,
  IconSearch,
  IconShoppingBag,
  IconStarFilled,
  IconUser,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  extractStoreFilterFacets,
  filterStoreProducts,
  getItemSizeLabel,
  resolveSafeStorePath,
} from './core/storeCatalog';
import { StoreOrdersView, StoreWishlistView } from './modules/storefront/StoreAccountViews';
import { StoreAiAssistant } from './modules/storefront/StoreAiAssistant';
import { StoreAuthModal } from './modules/storefront/StoreAuthModal';
import { StoreCheckoutDrawer } from './modules/storefront/StoreCheckoutDrawer';
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

const DEFAULT_CONFIG: StoreConfigPayload = {
  onlineStoreEnabled: true,
  aiAssistantEnabled: false,
  storeName: 'DecorBiz Architectural Showroom',
  phone: null,
  email: null,
  address: null,
  logoUrl: null,
  pickupEnabled: true,
  codEnabled: true,
  razorpayEnabled: false,
  razorpayKeyId: null,
  banners: [],
  pages: [],
  zones: [],
  coupons: [],
};

export default function StorefrontApp() {
  const [route, setRoute] = useState<StoreRoute>(() =>
    typeof window !== 'undefined' ? parseStorePath(window.location.pathname) : { view: 'home' }
  );
  const [config, setConfig] = useState<StoreConfigPayload>(DEFAULT_CONFIG);
  const [items, setItems] = useState<PublishedStoreItemRecord[]>([]);
  const [loadingCatalogue, setLoadingCatalogue] = useState(true);

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
    try {
      const [cfgRes, catRes] = await Promise.all([
        fetch('/api/store/config'),
        fetch('/api/store/catalogue'),
      ]);
      if (cfgRes.ok) {
        const cfgData = (await cfgRes.json()) as StoreConfigPayload;
        setConfig(cfgData);
        if (typeof document !== 'undefined' && cfgData.storeName) {
          document.title = `${cfgData.storeName} — Tiles, Sanitaryware & Bath Fittings`;
        }
      }
      if (catRes.ok) {
        const catData = (await catRes.json()) as {
          enabled: boolean;
          items: PublishedStoreItemRecord[];
        };
        setItems(catData.items || []);
      }
    } finally {
      setLoadingCatalogue(false);
    }
  }, []);

  useEffect(() => {
    void loadStoreData();
  }, [loadStoreData]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const baseName = config.storeName || 'DecorBiz Architectural Showroom';
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
  }, [route, config.storeName, config.pages]);

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
      .catch(() => {
        setWishlistIds([]);
      });
  }, [customerSession?.access_token]);

  const facets = useMemo(() => extractStoreFilterFacets(items), [items]);
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

  const handleToggleWishlist = async (itemId: string) => {
    if (!customerSession) {
      setAuthModalOpen(true);
      return;
    }
    const exists = wishlistIds.includes(itemId);
    setWishlistIds((prev) => (exists ? prev.filter((id) => id !== itemId) : [...prev, itemId]));
    try {
      if (exists) {
        await fetch(`/api/store/wishlist/${itemId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${customerSession.access_token}` },
        });
      } else {
        await fetch('/api/store/wishlist', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${customerSession.access_token}`,
          },
          body: JSON.stringify({ itemId }),
        });
      }
    } catch {
      // revert silently if offline
    }
  };

  const handleAddToCart = (line: StoreCartItem) => {
    setCart((prev) => {
      const idx = prev.findIndex((x) => x.key === line.key);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          baseQty: next[idx].baseQty + line.baseQty,
          qty: next[idx].qty + line.qty,
        };
        return next;
      }
      return [...prev, line];
    });
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
      <header className="sticky top-0 z-40 h-16 border-b border-stone-200/80 bg-[#FAF9F6]/90 backdrop-blur-md">
        <div className="max-w-7xl mx-auto h-full px-4 sm:px-6 lg:px-8 flex items-center justify-between gap-4">
          <div className="flex items-center gap-6">
            <button
              type="button"
              onClick={() => navigate('/')}
              className="flex items-center gap-2.5 text-left shrink-0"
            >
              {config.logoUrl ? (
                <img
                  src={config.logoUrl}
                  alt={config.storeName}
                  referrerPolicy="no-referrer"
                  className="h-8 w-8 rounded-lg object-cover border border-stone-200"
                />
              ) : (
                <div className="w-8 h-8 rounded-lg bg-stone-900 text-white flex items-center justify-center">
                  <IconBuildingStore size={18} />
                </div>
              )}
              <span className="text-sm sm:text-base font-bold tracking-tight text-stone-900">
                {config.storeName}
              </span>
            </button>

            <nav className="hidden md:flex items-center gap-5 text-xs font-medium text-stone-600">
              <button
                type="button"
                onClick={() => navigate('/catalogue')}
                className={`hover:text-stone-900 transition-colors ${
                  route.view === 'catalogue' ? 'text-stone-900 font-semibold' : ''
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
                className="hover:text-stone-900 transition-colors"
              >
                Tiles & Slabs
              </button>
              <button
                type="button"
                onClick={() => {
                  setLineFilter('sanitaryware');
                  navigate('/catalogue');
                }}
                className="hover:text-stone-900 transition-colors"
              >
                Bathware
              </button>
              <button
                type="button"
                onClick={() => navigate('/orders')}
                className={`hover:text-stone-900 transition-colors ${
                  route.view === 'orders' ? 'text-stone-900 font-semibold' : ''
                }`}
              >
                My Orders
              </button>
            </nav>
          </div>

          <div className="flex items-center gap-2">
            <div className="hidden sm:block relative w-52">
              <IconSearch size={14} className="absolute left-3 top-2.5 text-stone-400" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  if (route.view !== 'home' && route.view !== 'catalogue') navigate('/catalogue');
                }}
                placeholder="Search tiles, finishes..."
                className="w-full h-9 pl-8 pr-3 rounded-lg border border-stone-300 bg-white text-xs text-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-800"
              />
            </div>

            <button
              type="button"
              onClick={() => navigate('/wishlist')}
              aria-label="Wishlist"
              className="h-9 px-2.5 rounded-lg border border-stone-200 bg-white hover:bg-stone-100 text-stone-700 inline-flex items-center gap-1 text-xs font-medium"
            >
              <IconHeart size={16} />
              <span className="hidden lg:inline">{wishlistIds.length}</span>
            </button>

            <button
              type="button"
              onClick={() => (customerSession ? navigate('/orders') : setAuthModalOpen(true))}
              className="h-9 px-3 rounded-lg border border-stone-200 bg-white hover:bg-stone-100 text-stone-800 inline-flex items-center gap-1.5 text-xs font-medium"
            >
              {customerSession ? <IconPackage size={15} /> : <IconUser size={15} />}
              <span className="hidden sm:inline">
                {customerSession ? customerSession.customer.full_name.split(' ')[0] : 'Sign In'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setCartOpen(true)}
              className="h-9 px-3.5 rounded-lg bg-stone-900 hover:bg-stone-800 text-white inline-flex items-center gap-2 text-xs font-semibold"
            >
              <IconShoppingBag size={15} />
              <span className="tabular-nums">Bag ({bagCount})</span>
            </button>
          </div>
        </div>
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
                    <img
                      src={heroImageUrl}
                      alt={primaryBanner?.title || 'Architectural Tiles & Bathware Showroom'}
                      referrerPolicy="no-referrer"
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
                      ).map((cat) => (
                        <button
                          key={cat.key}
                          type="button"
                          onClick={() => {
                            setLineFilter(cat.key);
                            navigate('/catalogue');
                          }}
                          className="group relative aspect-[4/3] rounded-2xl overflow-hidden border border-stone-200 text-left"
                        >
                          <img
                            src={LINE_FALLBACK_IMAGES[cat.key]}
                            alt={cat.title}
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                          />
                          <div className="absolute inset-0 bg-gradient-to-t from-stone-950/80 via-stone-950/20 to-transparent p-5 flex flex-col justify-end text-white">
                            <h2 className="text-lg font-bold">{cat.title}</h2>
                            <p className="text-xs text-stone-200">{cat.sub}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  </section>
                </>
              )}

              {/* Catalogue + Filterable Grid */}
              <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-stone-200 pb-4">
                  <div>
                    <h2 className="text-2xl font-bold text-stone-900">
                      {STORE_PRODUCT_LINE_LABELS[lineFilter] || 'Showroom Catalogue'}
                    </h2>
                    <p className="text-xs text-stone-500 mt-0.5 tabular-nums">
                      {filteredItems.length} published product(s) available
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setShowFiltersMobile((v) => !v)}
                      className="lg:hidden h-9 px-3 rounded-lg border border-stone-300 bg-white text-xs font-medium inline-flex items-center gap-1.5"
                    >
                      <IconFilter size={14} />
                      <span>Filters</span>
                    </button>

                    <select
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                      className="h-9 px-3 rounded-lg border border-stone-300 bg-white text-xs font-medium text-stone-800"
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
                        <label className="block font-medium text-stone-600 mb-1">Product Line</label>
                        <select
                          value={lineFilter}
                          onChange={(e) => setLineFilter(e.target.value)}
                          className="w-full h-9 px-2.5 rounded-lg border border-stone-300 bg-white"
                        >
                          {Object.entries(STORE_PRODUCT_LINE_LABELS).map(([k, lbl]) => (
                            <option key={k} value={k}>
                              {lbl}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block font-medium text-stone-600 mb-1">Size / Dimensions</label>
                        <select
                          value={sizeFilter}
                          onChange={(e) => setSizeFilter(e.target.value)}
                          className="w-full h-9 px-2.5 rounded-lg border border-stone-300 bg-white"
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
                        <label className="block font-medium text-stone-600 mb-1">Finish</label>
                        <select
                          value={finishFilter}
                          onChange={(e) => setFinishFilter(e.target.value)}
                          className="w-full h-9 px-2.5 rounded-lg border border-stone-300 bg-white"
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
                        <label className="block font-medium text-stone-600 mb-1">Shade / Colour</label>
                        <select
                          value={shadeFilter}
                          onChange={(e) => setShadeFilter(e.target.value)}
                          className="w-full h-9 px-2.5 rounded-lg border border-stone-300 bg-white"
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
                        <label className="block font-medium text-stone-600 mb-1">Price Range (Rs)</label>
                        <div className="grid grid-cols-2 gap-2">
                          <input
                            type="number"
                            min={0}
                            value={minPrice}
                            onChange={(e) => setMinPrice(e.target.value)}
                            placeholder="Min"
                            className="h-9 px-2.5 rounded-lg border border-stone-300 tabular-nums"
                          />
                          <input
                            type="number"
                            min={0}
                            value={maxPrice}
                            onChange={(e) => setMaxPrice(e.target.value)}
                            placeholder="Max"
                            className="h-9 px-2.5 rounded-lg border border-stone-300 tabular-nums"
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
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                        {[1, 2, 3, 4, 5, 6].map((n) => (
                          <div
                            key={n}
                            className="h-80 rounded-2xl border border-stone-200 bg-white animate-pulse"
                          />
                        ))}
                      </div>
                    ) : filteredItems.length === 0 ? (
                      <div className="rounded-2xl border border-stone-200 bg-white p-12 text-center space-y-2">
                        <p className="text-sm font-semibold text-stone-800">No matching products found</p>
                        <p className="text-xs text-stone-500">
                          Try clearing your size, finish, or price filters or publish items from showroom administration.
                        </p>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                        {filteredItems.map((item) => {
                          const sizeLabel = getItemSizeLabel(item);
                          const wished = wishlistIds.includes(item.id);
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
                                  <img
                                    src={getProductImageSrc(item)}
                                    alt={item.name}
                                    referrerPolicy="no-referrer"
                                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                                  />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleToggleWishlist(item.id)}
                                  aria-label="Save to wishlist"
                                  className="absolute top-3 right-3 w-8 h-8 rounded-full bg-white/90 border border-stone-200 flex items-center justify-center text-stone-700 hover:bg-white"
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
      <footer className="border-t border-stone-200 bg-white mt-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 grid grid-cols-1 md:grid-cols-3 gap-8 text-xs text-stone-600">
          <div className="space-y-2">
            <p className="text-sm font-bold text-stone-900">{config.storeName}</p>
            {config.address && (
              <p className="inline-flex items-start gap-1.5">
                <IconMapPin size={14} className="shrink-0 mt-0.5 text-stone-400" />
                <span>{config.address}</span>
              </p>
            )}
            <div className="flex flex-wrap gap-4 pt-1">
              {config.phone && (
                <span className="inline-flex items-center gap-1">
                  <IconPhone size={13} className="text-stone-400" />
                  <span>{config.phone}</span>
                </span>
              )}
              {config.email && (
                <span className="inline-flex items-center gap-1">
                  <IconMail size={13} className="text-stone-400" />
                  <span>{config.email}</span>
                </span>
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
                  className="text-left hover:text-stone-900 hover:underline"
                >
                  {p.title}
                </button>
              ))}
              <button
                type="button"
                onClick={() => navigate('/orders')}
                className="text-left hover:text-stone-900 hover:underline"
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
          setCart((prev) =>
            prev.map((c) => (c.key === key ? { ...c, baseQty: nextBaseQty, qty: nextBaseQty } : c))
          )
        }
        onRemoveItem={(key) => setCart((prev) => prev.filter((c) => c.key !== key))}
        onClearCart={() => setCart([])}
        onRequireAuth={() => setAuthModalOpen(true)}
        onOrderComplete={handleOrderComplete}
      />

      {config.onlineStoreEnabled && config.aiAssistantEnabled && (
        <StoreAiAssistant
          storeName={config.storeName}
          items={items}
          onOpenProductSlug={(slug) => navigate(`/product/${encodeURIComponent(slug)}`)}
          onOpenPageSlug={(slug) => navigate(`/page/${encodeURIComponent(slug)}`)}
          onAddToCart={handleAddToCart}
        />
      )}
    </div>
  );
}
