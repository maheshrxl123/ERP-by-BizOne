import {
  IconArrowLeft,
  IconCalculator,
  IconCheck,
  IconHeart,
  IconHeartFilled,
  IconPlayerPlay,
  IconShoppingBagPlus,
  IconStar,
  IconStarFilled,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { computeTileOrderQty, getItemSizeLabel } from '../../core/storeCatalog';
import type { ProductReviewRecord, PublishedStoreItemRecord } from '../../types/decorbiz';
import {
  formatInr,
  getProductImageSrc,
  STORE_PRODUCT_LINE_LABELS,
  type StoreCartItem,
  type StoreCustomerSession,
} from './storeTypes';

interface StoreProductDetailProps {
  slugOrId: string;
  initialItem?: PublishedStoreItemRecord | null;
  customerSession: StoreCustomerSession | null;
  wishlisted: boolean;
  onToggleWishlist: (itemId: string) => void;
  onAddToCart: (line: StoreCartItem) => void;
  onBack: () => void;
  onRequireAuth: () => void;
}

function resolveSafeVideoPlayer(rawUrl: string | null | undefined):
  | { kind: 'iframe'; embedUrl: string; externalUrl: string }
  | { kind: 'video'; src: string; externalUrl: string }
  | { kind: 'link'; externalUrl: string }
  | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    const host = parsed.hostname.toLowerCase();
    const externalUrl = parsed.toString();

    if (host === 'youtu.be') {
      const id = parsed.pathname.replace(/^\/+/, '').split('/')[0];
      if (/^[A-Za-z0-9_-]{6,20}$/.test(id)) {
        return { kind: 'iframe', embedUrl: `https://www.youtube-nocookie.com/embed/${id}`, externalUrl };
      }
    }
    if (host === 'www.youtube.com' || host === 'youtube.com' || host === 'm.youtube.com') {
      const v = parsed.searchParams.get('v');
      const shortsMatch = parsed.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{6,20})/);
      const embedMatch = parsed.pathname.match(/^\/embed\/([A-Za-z0-9_-]{6,20})/);
      const id = v || shortsMatch?.[1] || embedMatch?.[1] || '';
      if (/^[A-Za-z0-9_-]{6,20}$/.test(id)) {
        return { kind: 'iframe', embedUrl: `https://www.youtube-nocookie.com/embed/${id}`, externalUrl };
      }
    }
    if (host === 'vimeo.com' || host === 'www.vimeo.com' || host === 'player.vimeo.com') {
      const match = parsed.pathname.match(/\/(?:video\/)?(\d+)/);
      if (match?.[1]) {
        return { kind: 'iframe', embedUrl: `https://player.vimeo.com/video/${match[1]}`, externalUrl };
      }
    }
    if (/\.(mp4|webm|mov|m4v)(\?.*)?$/i.test(parsed.pathname)) {
      return { kind: 'video', src: externalUrl, externalUrl };
    }
    return { kind: 'link', externalUrl };
  } catch {
    return null;
  }
}

export function StoreProductDetail({
  slugOrId,
  initialItem,
  customerSession,
  wishlisted,
  onToggleWishlist,
  onAddToCart,
  onBack,
  onRequireAuth,
}: StoreProductDetailProps) {
  const [item, setItem] = useState<PublishedStoreItemRecord | null>(initialItem || null);
  const [reviews, setReviews] = useState<ProductReviewRecord[]>([]);
  const [loading, setLoading] = useState(!initialItem);
  const [notFoundError, setNotFoundError] = useState<string | null>(null);
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null);
  const [activeImageIdx, setActiveImageIdx] = useState(0);
  const [qtyMode, setQtyMode] = useState<'boxes' | 'sqft' | 'base'>('base');
  const [qtyInput, setQtyInput] = useState<number>(1);
  const [addWastage, setAddWastage] = useState<boolean>(true);
  const [addedFeedback, setAddedFeedback] = useState(false);

  // Review state
  const [revRating, setRevRating] = useState(5);
  const [revTitle, setRevTitle] = useState('');
  const [revComment, setRevComment] = useState('');
  const [revSubmitting, setRevSubmitting] = useState(false);
  const [revMessage, setRevMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setNotFoundError(null);
    fetch(`/api/store/products/${encodeURIComponent(slugOrId)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || 'Product not found.');
        return data as { item: PublishedStoreItemRecord; reviews: ProductReviewRecord[] };
      })
      .then((data) => {
        if (!active) return;
        setItem(data.item);
        setReviews(data.reviews || []);
        setActiveImageIdx(0);
        const variants = data.item.variants || [];
        setSelectedVariantId(variants.length > 0 ? variants[0].id : null);
        if (data.item.product_line === 'tiles_slabs') {
          setQtyMode('boxes');
          setQtyInput(1);
        } else {
          setQtyMode('base');
          setQtyInput(1);
        }
      })
      .catch((err) => {
        if (!active) return;
        setNotFoundError(err instanceof Error ? err.message : 'Product unavailable.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [slugOrId]);

  useEffect(() => {
    if (!item || typeof document === 'undefined') return;
    document.title = `${item.name} — ${STORE_PRODUCT_LINE_LABELS[item.product_line] || 'Showroom'}`;
    const desc = (item.online_description || item.description || `${item.name} available at our showroom.`).slice(0, 160);
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) metaDesc.setAttribute('content', desc);
  }, [item]);

  if (loading && !item) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="animate-pulse grid grid-cols-1 lg:grid-cols-2 gap-10">
          <div className="aspect-[4/3] rounded-2xl bg-stone-200" />
          <div className="space-y-4">
            <div className="h-8 w-2/3 bg-stone-200 rounded" />
            <div className="h-6 w-1/3 bg-stone-200 rounded" />
            <div className="h-32 w-full bg-stone-100 rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  if (notFoundError || !item) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-16 text-center space-y-4">
        <h1 className="text-2xl font-bold text-stone-900">Product Unavailable</h1>
        <p className="text-sm text-stone-600">{notFoundError || 'This product is no longer published online.'}</p>
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 px-5 h-11 rounded-xl bg-stone-900 text-white text-sm font-medium"
        >
          <IconArrowLeft size={16} />
          <span>Back to Showroom Catalogue</span>
        </button>
      </div>
    );
  }

  const gallerySources = (() => {
    const ids = item.image_file_ids && item.image_file_ids.length > 0 ? item.image_file_ids : [];
    if (ids.length > 0) return ids.map((fid) => getProductImageSrc(item, fid));
    return [getProductImageSrc(item)];
  })();
  const videoPlayer = resolveSafeVideoPlayer(item.video_url);

  const selectedVariant = (item.variants || []).find((v) => v.id === selectedVariantId) || null;
  const activePrice = Number(selectedVariant ? selectedVariant.selling_price : item.effective_price);
  const activeMrp = selectedVariant?.mrp ?? item.mrp;
  const activeAvailable = selectedVariant ? Number(selectedVariant.available_qty) : Number(item.available_qty);
  const canOrder = item.item_type === 'service' || item.allow_negative_stock || activeAvailable > 0;
  const specsObj = (item.specs || {}) as Record<string, unknown>;
  const isTile = item.product_line === 'tiles_slabs';
  const sqftPerBox =
    typeof specsObj.sqft_per_box === 'number' && specsObj.sqft_per_box > 0
      ? specsObj.sqft_per_box
      : null;

  let calcSummary = {
    orderedUnit: qtyMode as 'boxes' | 'sqft' | 'base' | 'box',
    orderedQty: Math.max(1, qtyInput),
    baseQty: Math.max(1, qtyInput),
    sqftCovered: null as number | null,
    suggestedBoxesWithWastage: Math.max(1, qtyInput),
  };
  try {
    calcSummary = computeTileOrderQty({
      mode: isTile ? (qtyMode === 'sqft' ? 'sqft' : 'boxes') : 'base',
      inputQty: Math.max(0.01, qtyInput || 1),
      sqftPerBox,
      wastagePct: isTile && qtyMode === 'sqft' && addWastage ? 10 : 0,
    });
  } catch {
    // keep safe defaults on temporary invalid input
  }

  const lineTotal = calcSummary.baseQty * activePrice;
  const sizeLabel = getItemSizeLabel(item);

  const handleAdd = () => {
    onAddToCart({
      key: `${item.id}:${selectedVariant?.id || 'default'}:${calcSummary.orderedUnit}`,
      item,
      variantId: selectedVariant?.id || null,
      variantName: selectedVariant?.variant_name || null,
      unitPrice: activePrice,
      mode: isTile ? (qtyMode === 'sqft' ? 'sqft' : 'boxes') : 'base',
      qty: calcSummary.orderedQty,
      baseQty: calcSummary.baseQty,
      wastagePct: isTile && qtyMode === 'sqft' && addWastage ? 10 : 0,
      sqftCovered: calcSummary.sqftCovered,
    });
    setAddedFeedback(true);
    window.setTimeout(() => setAddedFeedback(false), 1800);
  };

  const handleReviewSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerSession) {
      onRequireAuth();
      return;
    }
    setRevSubmitting(true);
    setRevMessage(null);
    try {
      const res = await fetch(`/api/store/products/${item.id}/reviews`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${customerSession.access_token}`,
        },
        body: JSON.stringify({
          rating: revRating,
          title: revTitle,
          comment: revComment,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Could not submit review.');
      setRevTitle('');
      setRevComment('');
      setRevMessage(data.message || 'Review submitted for moderation.');
    } catch (err) {
      setRevMessage(err instanceof Error ? err.message : 'Unable to submit review.');
    } finally {
      setRevSubmitting(false);
    }
  };

  const specRows = Object.entries(specsObj).filter(
    ([k, v]) => v !== null && v !== undefined && v !== '' && k !== 'attributes'
  );

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-12">
      <div>
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-stone-600 hover:text-stone-900"
        >
          <IconArrowLeft size={15} />
          <span>Back to {STORE_PRODUCT_LINE_LABELS[item.product_line] || 'Catalogue'}</span>
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">
        {/* Left: Multi-Image Gallery & Video */}
        <div className="lg:col-span-6 space-y-4">
          <div className="aspect-[4/3] rounded-2xl overflow-hidden bg-stone-100 border border-stone-200 relative">
            <img
              src={gallerySources[activeImageIdx] || gallerySources[0]}
              alt={item.name}
              referrerPolicy="no-referrer"
              className="w-full h-full object-cover"
            />
          </div>

          {gallerySources.length > 1 && (
            <div className="grid grid-cols-5 gap-2.5">
              {gallerySources.map((src, idx) => (
                <button
                  key={`${src}-${idx}`}
                  type="button"
                  onClick={() => setActiveImageIdx(idx)}
                  className={`aspect-square rounded-xl overflow-hidden border-2 transition-all ${
                    idx === activeImageIdx
                      ? 'border-stone-900 ring-2 ring-stone-900/10'
                      : 'border-stone-200 opacity-75 hover:opacity-100'
                  }`}
                >
                  <img
                    src={src}
                    alt={`${item.name} view ${idx + 1}`}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                </button>
              ))}
            </div>
          )}

          {videoPlayer && (
            <div className="rounded-xl border border-stone-200 bg-white overflow-hidden">
              {videoPlayer.kind === 'iframe' && (
                <div className="aspect-video w-full bg-stone-950">
                  <iframe
                    src={videoPlayer.embedUrl}
                    title={`${item.name} product video`}
                    loading="lazy"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                    className="w-full h-full border-0"
                  />
                </div>
              )}
              {videoPlayer.kind === 'video' && (
                <video
                  src={videoPlayer.src}
                  controls
                  preload="metadata"
                  className="w-full aspect-video bg-stone-950 object-contain"
                />
              )}
              <div className="p-4 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-stone-900 text-white flex items-center justify-center shrink-0">
                    <IconPlayerPlay size={16} />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-stone-900">Product Installation & Finish Video</p>
                    <p className="text-[11px] text-stone-500">Preview showroom surface finish in motion</p>
                  </div>
                </div>
                <a
                  href={videoPlayer.externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3.5 h-8 rounded-lg border border-stone-300 text-xs font-medium text-stone-800 hover:bg-stone-50 inline-flex items-center shrink-0"
                >
                  Open Video
                </a>
              </div>
            </div>
          )}
        </div>

        {/* Right: Pricing, Variants, Tile Box/SqFt Calculator, Actions */}
        <div className="lg:col-span-6 space-y-6">
          <div className="space-y-2 border-b border-stone-200 pb-5">
            <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500 uppercase tracking-wider font-medium">
              <span>{item.brand_name || 'Showroom Curated'}</span>
              {item.category_name && (
                <>
                  <span>·</span>
                  <span>{item.category_name}</span>
                </>
              )}
              {sizeLabel && (
                <>
                  <span>·</span>
                  <span>{sizeLabel}</span>
                </>
              )}
            </div>

            <div className="flex items-start justify-between gap-4">
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-stone-900">
                {item.name}
              </h1>
              <button
                type="button"
                onClick={() => onToggleWishlist(item.id)}
                aria-label="Toggle wishlist"
                className="w-10 h-10 rounded-full border border-stone-300 flex items-center justify-center text-stone-700 hover:bg-stone-100 shrink-0"
              >
                {wishlisted ? (
                  <IconHeartFilled size={18} className="text-rose-600" />
                ) : (
                  <IconHeart size={18} />
                )}
              </button>
            </div>

            <div className="flex items-baseline gap-3 pt-1">
              <span className="text-2xl sm:text-3xl font-bold text-stone-900 tabular-nums">
                {formatInr(activePrice)}
              </span>
              <span className="text-xs text-stone-500">per {item.base_unit_name_en || item.base_unit_code}</span>
              {activeMrp && activeMrp > activePrice && (
                <span className="text-sm text-stone-400 line-through tabular-nums">
                  {formatInr(activeMrp)}
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3 text-xs pt-1">
              <span className={`font-semibold ${canOrder ? 'text-emerald-700' : 'text-red-600'}`}>
                {canOrder
                  ? `In Stock (${activeAvailable} ${item.base_unit_code} available)`
                  : 'Currently Out of Stock'}
              </span>
              {sqftPerBox && (
                <span className="text-stone-600 tabular-nums">
                  Coverage: {sqftPerBox} sq.ft / box ({formatInr(activePrice / sqftPerBox)} / sq.ft approx.)
                </span>
              )}
            </div>
          </div>

          {/* Variants */}
          {item.variants && item.variants.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-stone-700">
                Select Size / Finish / Shade
              </p>
              <div className="flex flex-wrap gap-2">
                {item.variants.map((v) => {
                  const active = v.id === selectedVariant?.id;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => setSelectedVariantId(v.id)}
                      className={`px-3.5 py-2 rounded-xl border text-left text-xs transition-all ${
                        active
                          ? 'border-stone-900 bg-stone-900 text-white'
                          : 'border-stone-300 bg-white text-stone-800 hover:border-stone-500'
                      }`}
                    >
                      <div className="font-semibold">{v.variant_name}</div>
                      <div className={`text-[11px] tabular-nums ${active ? 'text-stone-300' : 'text-stone-500'}`}>
                        {formatInr(v.selling_price)} · {v.available_qty} avail.
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Tile Box vs Sq.ft Order Calculator */}
          <div className="rounded-2xl border border-stone-200 bg-stone-50 p-4 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-stone-800">
                <IconCalculator size={16} className="text-sky-700" />
                <span>{isTile && sqftPerBox ? 'Order by Boxes or Room Area (sq.ft)' : 'Select Quantity'}</span>
              </div>
              {isTile && sqftPerBox && (
                <div className="inline-flex rounded-lg bg-stone-200 p-0.5 text-xs font-medium">
                  <button
                    type="button"
                    onClick={() => {
                      setQtyMode('boxes');
                      setQtyInput(1);
                    }}
                    className={`px-2.5 py-1 rounded-md ${
                      qtyMode !== 'sqft' ? 'bg-white text-stone-900 shadow-xs' : 'text-stone-600'
                    }`}
                  >
                    Boxes
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setQtyMode('sqft');
                      setQtyInput(Math.round(sqftPerBox * 4));
                    }}
                    className={`px-2.5 py-1 rounded-md ${
                      qtyMode === 'sqft' ? 'bg-white text-stone-900 shadow-xs' : 'text-stone-600'
                    }`}
                  >
                    Sq.ft Area
                  </button>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-center">
              <div>
                <label className="block text-[11px] font-medium text-stone-600 mb-1">
                  {qtyMode === 'sqft' ? 'Required Area (sq.ft)' : `Quantity (${item.base_unit_name_en})`}
                </label>
                <input
                  type="number"
                  min={qtyMode === 'sqft' ? 1 : 1}
                  step={qtyMode === 'sqft' ? 'any' : '1'}
                  value={qtyInput}
                  onChange={(e) => setQtyInput(Math.max(1, Number(e.target.value) || 1))}
                  className="w-full h-11 px-3 rounded-xl border border-stone-300 bg-white text-sm font-semibold text-stone-900 tabular-nums focus:outline-none focus:ring-2 focus:ring-sky-600"
                />
              </div>

              <div className="rounded-xl bg-white border border-stone-200 px-3.5 py-2.5 text-xs space-y-0.5">
                <div className="flex items-center justify-between text-stone-600">
                  <span>Dispatch Qty:</span>
                  <span className="font-semibold text-stone-900 tabular-nums">
                    {calcSummary.baseQty} {item.base_unit_code}
                  </span>
                </div>
                {calcSummary.sqftCovered && (
                  <div className="flex items-center justify-between text-stone-600">
                    <span>Total Coverage:</span>
                    <span className="font-semibold text-stone-900 tabular-nums">
                      {calcSummary.sqftCovered} sq.ft
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between text-stone-600 pt-0.5 border-t border-stone-100">
                  <span>Line Total:</span>
                  <span className="font-bold text-stone-900 tabular-nums">{formatInr(lineTotal)}</span>
                </div>
              </div>
            </div>

            {isTile && sqftPerBox && qtyMode === 'sqft' && (
              <label className="flex items-center gap-2 text-xs text-stone-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={addWastage}
                  onChange={(e) => setAddWastage(e.target.checked)}
                  className="w-4 h-4 accent-sky-700"
                />
                <span>Include +10% cutting & breakage wastage allowance</span>
              </label>
            )}

            <button
              type="button"
              disabled={!canOrder || (!item.allow_negative_stock && item.item_type === 'goods' && calcSummary.baseQty > activeAvailable)}
              onClick={handleAdd}
              className="w-full h-12 rounded-xl bg-stone-900 hover:bg-stone-800 text-white text-sm font-semibold inline-flex items-center justify-center gap-2 transition-colors disabled:opacity-45"
            >
              {addedFeedback ? (
                <>
                  <IconCheck size={18} />
                  <span>Added to Shopping Bag</span>
                </>
              ) : (
                <>
                  <IconShoppingBagPlus size={18} />
                  <span>
                    Add {calcSummary.baseQty} {item.base_unit_code} to Bag · {formatInr(lineTotal)}
                  </span>
                </>
              )}
            </button>
          </div>

          {/* Description & Typed Specifications */}
          {(item.online_description || item.description) && (
            <div className="space-y-2">
              <h2 className="text-sm font-semibold text-stone-900">Product Overview</h2>
              <p className="text-sm leading-relaxed text-stone-600 whitespace-pre-line">
                {item.online_description || item.description}
              </p>
            </div>
          )}

          {specRows.length > 0 && (
            <div className="space-y-2.5">
              <h2 className="text-sm font-semibold text-stone-900">Technical Specifications</h2>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 rounded-xl border border-stone-200 bg-white p-4 text-xs">
                {specRows.map(([k, v]) => (
                  <div key={k} className="border-b border-stone-100 pb-1.5">
                    <dt className="text-stone-500 capitalize">{k.replace(/_/g, ' ')}</dt>
                    <dd className="font-semibold text-stone-900 mt-0.5">
                      {typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v)}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>
      </div>

      {/* Customer Reviews Section */}
      <section className="pt-8 border-t border-stone-200 grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-5 space-y-4">
          <div>
            <h2 className="text-lg font-bold text-stone-900">Customer Reviews</h2>
            <p className="text-xs text-stone-500 mt-0.5">
              {reviews.length} verified showroom review(s)
            </p>
          </div>

          <form onSubmit={handleReviewSubmit} className="rounded-2xl border border-stone-200 bg-white p-5 space-y-3">
            <h3 className="text-sm font-semibold text-stone-900">Write a Review</h3>
            {revMessage && (
              <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                {revMessage}
              </p>
            )}
            <div className="flex items-center gap-1">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  type="button"
                  onClick={() => setRevRating(star)}
                  className="p-1 text-amber-500"
                >
                  {star <= revRating ? <IconStarFilled size={20} /> : <IconStar size={20} />}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={revTitle}
              onChange={(e) => setRevTitle(e.target.value)}
              placeholder="Headline (optional)"
              className="w-full h-10 px-3 rounded-lg border border-stone-300 text-xs"
            />
            <textarea
              required
              minLength={3}
              rows={3}
              value={revComment}
              onChange={(e) => setRevComment(e.target.value)}
              placeholder="Share finish quality, tile sizing consistency, or packaging feedback..."
              className="w-full p-3 rounded-lg border border-stone-300 text-xs"
            />
            <button
              type="submit"
              disabled={revSubmitting}
              className="h-10 px-4 rounded-xl bg-stone-900 text-white text-xs font-semibold disabled:opacity-50"
            >
              {revSubmitting ? 'Submitting...' : customerSession ? 'Submit Review' : 'Sign in to Review'}
            </button>
          </form>
        </div>

        <div className="lg:col-span-7 space-y-3">
          {reviews.length === 0 ? (
            <div className="rounded-2xl border border-stone-200 bg-white p-8 text-center text-sm text-stone-500">
              No published reviews yet for this product.
            </div>
          ) : (
            reviews.map((rev) => (
              <article key={rev.id} className="rounded-2xl border border-stone-200 bg-white p-5 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1 text-amber-500">
                    {Array.from({ length: rev.rating }).map((_, idx) => (
                      <IconStarFilled key={idx} size={14} />
                    ))}
                  </div>
                  <span className="text-[11px] text-stone-400">
                    {new Date(rev.created_at).toLocaleDateString('en-IN')}
                  </span>
                </div>
                {rev.title && <h4 className="text-sm font-semibold text-stone-900">{rev.title}</h4>}
                <p className="text-xs leading-relaxed text-stone-600">{rev.comment}</p>
                <p className="text-[11px] font-medium text-stone-500 pt-1">By {rev.customer_name}</p>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
