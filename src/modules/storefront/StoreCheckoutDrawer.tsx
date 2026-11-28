import {
  IconBuildingStore,
  IconCreditCard,
  IconMinus,
  IconPlus,
  IconTag,
  IconTrash,
  IconTruck,
  IconX,
} from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { computeStoreOrderTotals, matchDeliveryZone } from '../../core/storeCatalog';
import type { StoreOrderRecord } from '../../types/decorbiz';
import { StoreImage } from './StoreImage';
import {
  formatInr,
  getProductImageSrc,
  LINE_FALLBACK_IMAGES,
  type StoreCartItem,
  type StoreConfigPayload,
  type StoreCustomerSession,
} from './storeTypes';

function formatTaxAmount(val: number): string {
  return `₹${Number(val || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

function loadRazorpayCheckoutScript(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (window.Razorpay) return Promise.resolve(true);
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

interface StoreCheckoutDrawerProps {
  open: boolean;
  onClose: () => void;
  config: StoreConfigPayload;
  cart: StoreCartItem[];
  customerSession: StoreCustomerSession | null;
  onUpdateQty: (key: string, nextBaseQty: number) => void;
  onRemoveItem: (key: string) => void;
  onClearCart: () => void;
  onRequireAuth: () => void;
  onOrderComplete: (order: StoreOrderRecord) => void;
}

export function StoreCheckoutDrawer({
  open,
  onClose,
  config,
  cart,
  customerSession,
  onUpdateQty,
  onRemoveItem,
  onClearCart,
  onRequireAuth,
  onOrderComplete,
}: StoreCheckoutDrawerProps) {
  const [fulfillmentType, setFulfillmentType] = useState<'delivery' | 'pickup'>('delivery');
  const [paymentMethod, setPaymentMethod] = useState<'cod' | 'pay_on_pickup' | 'razorpay'>('cod');
  const [address, setAddress] = useState('');
  const [pincode, setPincode] = useState('');
  const [area, setArea] = useState('');
  const [couponInput, setCouponInput] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deliveryFieldErrors, setDeliveryFieldErrors] = useState<{
    pincode?: string;
    area?: string;
    address?: string;
  }>({});
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const drawerEl = drawerRef.current;
    const getFocusable = () =>
      drawerEl
        ? Array.from(
            drawerEl.querySelectorAll<HTMLElement>(
              'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
            )
          )
        : [];
    const focusables = getFocusable();
    if (focusables.length > 0) focusables[0].focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const list = getFocusable();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      prevFocus?.focus?.();
    };
  }, [open, onClose]);

  useEffect(() => {
    if (customerSession?.customer) {
      setAddress((prev) => prev || customerSession.customer.default_address || '');
      setPincode((prev) => prev || customerSession.customer.default_pincode || '');
    }
  }, [customerSession]);

  useEffect(() => {
    if (fulfillmentType === 'pickup') {
      if (paymentMethod === 'cod' || (paymentMethod === 'pay_on_pickup' && !config.pickupEnabled)) {
        setPaymentMethod(config.pickupEnabled ? 'pay_on_pickup' : 'razorpay');
      }
    } else if (fulfillmentType === 'delivery') {
      if (paymentMethod === 'pay_on_pickup' || (paymentMethod === 'cod' && !config.codEnabled)) {
        setPaymentMethod(config.codEnabled ? 'cod' : 'razorpay');
      }
    }
  }, [fulfillmentType, paymentMethod, config.codEnabled, config.pickupEnabled]);

  if (!open) return null;

  const matchedZone =
    fulfillmentType === 'delivery'
      ? matchDeliveryZone(config.zones || [], { pincode, area: area || address })
      : null;

  const hasEnteredDeliveryLocation = Boolean(pincode.trim() || area.trim());
  const matchedCoupon =
    couponInput.trim()
      ? (config.coupons || []).find((c) => c.code.toUpperCase() === couponInput.trim().toUpperCase()) || null
      : null;

  const pricing = computeStoreOrderTotals({
    lines: cart.map((c) => ({
      unitPrice: c.unitPrice,
      baseQty: c.baseQty,
      gstRate: Number(c.item.gst_rate ?? 0),
      taxInclusive: Boolean(c.item.tax_inclusive ?? true),
    })),
    fulfillmentType,
    zone: matchedZone,
    coupon: matchedCoupon,
    gstRegistered: config.gstRegistered,
  });

  const visiblePricingErrors = pricing.errors.filter((msg) => {
    if (
      fulfillmentType === 'delivery' &&
      !hasEnteredDeliveryLocation &&
      msg.toLowerCase().includes('delivery is not available')
    ) {
      return false;
    }
    return true;
  });

  const handlePlaceOrder = async () => {
    setError(null);
    if (!customerSession) {
      onRequireAuth();
      return;
    }
    if (cart.length === 0) return;

    if (fulfillmentType === 'delivery') {
      const nextFieldErrors: { pincode?: string; area?: string; address?: string } = {};
      if (!pincode.trim()) nextFieldErrors.pincode = 'Pincode is required.';
      if (!area.trim()) nextFieldErrors.area = 'Locality / Area is required.';
      if (!address.trim()) nextFieldErrors.address = 'Delivery address is required.';
      setDeliveryFieldErrors(nextFieldErrors);
      if (Object.keys(nextFieldErrors).length > 0) {
        setError('Please enter your delivery pincode, area, and full address.');
        return;
      }
    } else {
      setDeliveryFieldErrors({});
    }

    if (paymentMethod === 'razorpay' && (!config.razorpayEnabled || !config.razorpayKeyId)) {
      setError('Razorpay online payment is not currently configured.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/store/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${customerSession.access_token}`,
        },
        body: JSON.stringify({
          fulfillmentType,
          paymentMethod,
          deliveryAddress: fulfillmentType === 'delivery' ? address : undefined,
          deliveryPincode: fulfillmentType === 'delivery' ? pincode : undefined,
          deliveryArea: fulfillmentType === 'delivery' ? area : undefined,
          couponCode: couponInput.trim() || undefined,
          customerNotes: notes.trim() || undefined,
          lines: cart.map((c) => ({
            itemId: c.item.id,
            variantId: c.variantId,
            mode: c.mode,
            qty: c.qty,
            wastagePct: c.wastagePct,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Unable to place order.');

      if (paymentMethod === 'razorpay' && data.razorpay?.id) {
        const scriptOk = await loadRazorpayCheckoutScript();
        if (!scriptOk || !window.Razorpay) {
          throw new Error('Could not load Razorpay Checkout SDK.');
        }

        const rzp = new window.Razorpay({
          key: data.razorpay.keyId,
          amount: data.razorpay.amount,
          currency: data.razorpay.currency,
          name: config.storeName,
          description: `Order ${data.order.order_number}`,
          order_id: data.razorpay.id,
          prefill: {
            name: customerSession.customer.full_name,
            email: customerSession.customer.email,
            contact: customerSession.customer.phone || '',
          },
          handler: async (response: {
            razorpay_order_id: string;
            razorpay_payment_id: string;
            razorpay_signature: string;
          }) => {
            try {
              const verifyRes = await fetch(`/api/store/orders/${data.order.id}/verify-razorpay`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${customerSession.access_token}`,
                },
                body: JSON.stringify(response),
              });
              const verifyData = await verifyRes.json();
              if (!verifyRes.ok) {
                throw new Error(verifyData?.error || 'Payment signature verification failed.');
              }
              onClearCart();
              onOrderComplete(verifyData.order);
            } catch (verErr) {
              setError(
                verErr instanceof Error
                  ? verErr.message
                  : 'Razorpay payment signature verification failed.'
              );
            } finally {
              setSubmitting(false);
            }
          },
          modal: {
            ondismiss: () => {
              setSubmitting(false);
              setError('Payment window closed before completion. Check My Orders to retry or cancel.');
            },
          },
        });
        rzp.open();
        return;
      }

      onClearCart();
      onOrderComplete(data.order as StoreOrderRecord);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Checkout failed.');
    } finally {
      if (paymentMethod !== 'razorpay') {
        setSubmitting(false);
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-stone-950/50 backdrop-blur-xs">
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="store-checkout-title"
        className="w-full max-w-lg bg-white h-full flex flex-col shadow-2xl border-l border-stone-200"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-200">
          <div>
            <h2 id="store-checkout-title" className="text-lg font-bold text-stone-900">Your Shopping Bag</h2>
            <p className="text-xs text-stone-500">{cart.length} line item(s) ready for order</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close cart drawer"
            className="p-2 rounded-lg text-stone-500 hover:bg-stone-100"
          >
            <IconX size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {cart.length === 0 ? (
            <div className="text-center py-16 space-y-2">
              <p className="text-sm font-medium text-stone-700">Your bag is empty</p>
              <p className="text-xs text-stone-500">
                Add tiles by box or sq.ft, sanitaryware, or brass fittings from the showroom.
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-3">
                {cart.map((c) => (
                  <div
                    key={c.key}
                    className="flex gap-3 p-3 rounded-xl border border-stone-200 bg-stone-50/70"
                  >
                    <StoreImage
                      src={getProductImageSrc(c.item)}
                      fallbackSrc={LINE_FALLBACK_IMAGES[c.item.product_line] || LINE_FALLBACK_IMAGES.tiles_slabs}
                      alt={c.item.name}
                      width={64}
                      height={64}
                      wrapperClassName="relative w-16 h-16 rounded-lg overflow-hidden border border-stone-200 shrink-0"
                      className="w-full h-full object-cover"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs font-semibold text-stone-900 truncate">{c.item.name}</p>
                        <button
                          type="button"
                          onClick={() => onRemoveItem(c.key)}
                          className="text-stone-400 hover:text-red-600"
                          aria-label="Remove item"
                        >
                          <IconTrash size={14} />
                        </button>
                      </div>
                      {c.variantName && <p className="text-[11px] text-stone-500">{c.variantName}</p>}
                      <p className="text-[11px] text-stone-500 tabular-nums mt-0.5">
                        {formatInr(c.unitPrice)} / {c.item.base_unit_code}
                        {c.sqftCovered ? ` · ${c.sqftCovered} sq.ft covered` : ''}
                      </p>

                      <div className="flex items-center justify-between mt-2">
                        <div className="inline-flex items-center rounded-lg border border-stone-300 bg-white">
                          <button
                            type="button"
                            onClick={() => onUpdateQty(c.key, Math.max(1, c.baseQty - 1))}
                            aria-label={`Decrease quantity for ${c.item.name}`}
                            className="w-7 h-7 flex items-center justify-center text-stone-700"
                          >
                            <IconMinus size={12} />
                          </button>
                          <span className="px-2 text-xs font-semibold tabular-nums">
                            {c.baseQty} {c.item.base_unit_code}
                          </span>
                          <button
                            type="button"
                            onClick={() => onUpdateQty(c.key, c.baseQty + 1)}
                            aria-label={`Increase quantity for ${c.item.name}`}
                            className="w-7 h-7 flex items-center justify-center text-stone-700"
                          >
                            <IconPlus size={12} />
                          </button>
                        </div>
                        <span className="text-xs font-bold text-stone-900 tabular-nums">
                          {formatInr(c.unitPrice * c.baseQty)}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Fulfillment Selector */}
              <div className="space-y-3 pt-2 border-t border-stone-200">
                <p className="text-xs font-semibold uppercase tracking-wider text-stone-700">
                  Fulfillment Method
                </p>
                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => setFulfillmentType('delivery')}
                    className={`p-3 rounded-xl border text-left text-xs transition-all ${
                      fulfillmentType === 'delivery'
                        ? 'border-stone-900 bg-stone-900 text-white'
                        : 'border-stone-300 bg-white text-stone-800'
                    }`}
                  >
                    <IconTruck size={16} className="mb-1" />
                    <div className="font-semibold">Own-Fleet Delivery</div>
                    <div className={`text-[11px] ${fulfillmentType === 'delivery' ? 'text-stone-300' : 'text-stone-500'}`}>
                      Zone-based vehicle drop
                    </div>
                  </button>
                  {config.pickupEnabled && (
                    <button
                      type="button"
                      onClick={() => setFulfillmentType('pickup')}
                      className={`p-3 rounded-xl border text-left text-xs transition-all ${
                        fulfillmentType === 'pickup'
                          ? 'border-stone-900 bg-stone-900 text-white'
                          : 'border-stone-300 bg-white text-stone-800'
                      }`}
                    >
                      <IconBuildingStore size={16} className="mb-1" />
                      <div className="font-semibold">Shop Pickup</div>
                      <div className={`text-[11px] ${fulfillmentType === 'pickup' ? 'text-stone-300' : 'text-stone-500'}`}>
                        Free showroom collection
                      </div>
                    </button>
                  )}
                </div>

                {fulfillmentType === 'delivery' && (
                  <div className="space-y-2.5 rounded-xl border border-stone-200 bg-stone-50 p-3.5 text-xs">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div>
                        <input
                          type="text"
                          required
                          value={pincode}
                          onChange={(e) => {
                            setPincode(e.target.value);
                            if (deliveryFieldErrors.pincode) {
                              setDeliveryFieldErrors((prev) => ({ ...prev, pincode: undefined }));
                            }
                          }}
                          placeholder="Pincode (302001)"
                          aria-label="Delivery pincode"
                          aria-invalid={Boolean(deliveryFieldErrors.pincode)}
                          className="w-full h-9 px-3 rounded-lg border border-stone-300 bg-white focus:outline-none focus:ring-2 focus:ring-stone-900"
                        />
                        {deliveryFieldErrors.pincode && (
                          <p className="text-[11px] text-red-600 mt-1">{deliveryFieldErrors.pincode}</p>
                        )}
                      </div>
                      <div>
                        <input
                          type="text"
                          required
                          value={area}
                          onChange={(e) => {
                            setArea(e.target.value);
                            if (deliveryFieldErrors.area) {
                              setDeliveryFieldErrors((prev) => ({ ...prev, area: undefined }));
                            }
                          }}
                          placeholder="Locality / Area"
                          aria-label="Delivery locality or area"
                          aria-invalid={Boolean(deliveryFieldErrors.area)}
                          className="w-full h-9 px-3 rounded-lg border border-stone-300 bg-white focus:outline-none focus:ring-2 focus:ring-stone-900"
                        />
                        {deliveryFieldErrors.area && (
                          <p className="text-[11px] text-red-600 mt-1">{deliveryFieldErrors.area}</p>
                        )}
                      </div>
                    </div>
                    <div>
                      <textarea
                        rows={2}
                        required
                        value={address}
                        onChange={(e) => {
                          setAddress(e.target.value);
                          if (deliveryFieldErrors.address) {
                            setDeliveryFieldErrors((prev) => ({ ...prev, address: undefined }));
                          }
                        }}
                        placeholder="Full delivery address & landmark"
                        aria-label="Full delivery address"
                        aria-invalid={Boolean(deliveryFieldErrors.address)}
                        className="w-full p-2.5 rounded-lg border border-stone-300 bg-white focus:outline-none focus:ring-2 focus:ring-stone-900"
                      />
                      {deliveryFieldErrors.address && (
                        <p className="text-[11px] text-red-600 mt-1">{deliveryFieldErrors.address}</p>
                      )}
                    </div>
                    {matchedZone ? (
                      <p className="text-[11px] font-medium text-emerald-700">
                        Zone matched: {matchedZone.zone_name} · Delivery {formatInr(matchedZone.delivery_charge)} · Est.{' '}
                        {matchedZone.estimated_days} day(s)
                      </p>
                    ) : hasEnteredDeliveryLocation ? (
                      <p className="text-[11px] text-amber-700">
                        No matching local delivery zone for "{pincode.trim() || area.trim()}". Try another pincode/area or switch to Free Shop Pickup.
                      </p>
                    ) : (
                      <p className="text-[11px] text-stone-500">
                        Enter your delivery pincode &amp; locality to calculate delivery charges.
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Promo Coupon */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <IconTag size={14} className="absolute left-3 top-3 text-stone-400" />
                    <input
                      type="text"
                      value={couponInput}
                      onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
                      placeholder="Promo coupon code"
                      aria-label="Promo coupon code"
                      className="w-full h-10 pl-8 pr-3 rounded-xl border border-stone-300 text-xs font-mono uppercase"
                    />
                  </div>
                </div>
                {config.coupons && config.coupons.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 text-[11px]">
                    {config.coupons.map((cp) => (
                      <button
                        key={cp.id}
                        type="button"
                        onClick={() => setCouponInput(cp.code)}
                        className="px-2 py-1 rounded border border-stone-300 bg-stone-50 hover:bg-stone-100 font-mono text-stone-700"
                      >
                        {cp.code}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Payment Options */}
              <div className="space-y-2 pt-2 border-t border-stone-200">
                <p className="text-xs font-semibold uppercase tracking-wider text-stone-700">
                  Payment Method
                </p>
                <div className="space-y-2 text-xs">
                  {fulfillmentType === 'delivery' && config.codEnabled && (
                    <label className="flex items-center gap-2.5 p-3 rounded-xl border border-stone-200 cursor-pointer">
                      <input
                        type="radio"
                        name="store_pay"
                        checked={paymentMethod === 'cod'}
                        onChange={() => setPaymentMethod('cod')}
                        className="accent-stone-900"
                      />
                      <div>
                        <div className="font-semibold text-stone-900">Cash on Delivery (COD)</div>
                        <div className="text-[11px] text-stone-500">Pay cash or UPI on vehicle arrival</div>
                      </div>
                    </label>
                  )}

                  {fulfillmentType === 'pickup' && config.pickupEnabled && (
                    <label className="flex items-center gap-2.5 p-3 rounded-xl border border-stone-200 cursor-pointer">
                      <input
                        type="radio"
                        name="store_pay"
                        checked={paymentMethod === 'pay_on_pickup'}
                        onChange={() => setPaymentMethod('pay_on_pickup')}
                        className="accent-stone-900"
                      />
                      <div>
                        <div className="font-semibold text-stone-900">Pay on Showroom Pickup</div>
                        <div className="text-[11px] text-stone-500">Pay at counter when collecting materials</div>
                      </div>
                    </label>
                  )}

                  {config.razorpayEnabled && config.razorpayKeyId && (
                    <label className="flex items-center gap-2.5 p-3 rounded-xl border border-stone-200 cursor-pointer">
                      <input
                        type="radio"
                        name="store_pay"
                        checked={paymentMethod === 'razorpay'}
                        onChange={() => setPaymentMethod('razorpay')}
                        className="accent-stone-900"
                      />
                      <div className="flex-1">
                        <div className="font-semibold text-stone-900 inline-flex items-center gap-1.5">
                          <IconCreditCard size={14} className="text-sky-700" />
                          <span>Pay Online (Razorpay)</span>
                        </div>
                        <div className="text-[11px] text-stone-500">UPI, Cards & NetBanking · Instant reservation</div>
                      </div>
                    </label>
                  )}
                </div>
              </div>

              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Order note (gate timing, floor lift availability...)"
                aria-label="Order note"
                className="w-full h-10 px-3 rounded-xl border border-stone-300 text-xs"
              />
            </>
          )}
        </div>

        {cart.length > 0 && (
          <div className="p-6 border-t border-stone-200 bg-stone-50 space-y-3">
            {(error || visiblePricingErrors.length > 0) && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {error || visiblePricingErrors[0]}
              </div>
            )}
            <div className="space-y-1 text-xs">
              <div className="flex justify-between text-stone-600">
                <span>
                  {config.gstRegistered === false || pricing.taxAmount === 0
                    ? 'Subtotal'
                    : 'Subtotal (incl. GST)'}
                </span>
                <span className="tabular-nums">{formatInr(pricing.subtotal)}</span>
              </div>
              {pricing.discountAmount > 0 && (
                <div className="flex justify-between text-emerald-700 font-medium">
                  <span>Coupon ({pricing.couponApplied})</span>
                  <span className="tabular-nums">-{formatInr(pricing.discountAmount)}</span>
                </div>
              )}
              <div className="flex justify-between text-stone-600">
                <span>Delivery</span>
                <span className="tabular-nums">
                  {fulfillmentType === 'pickup' ? 'Free (Pickup)' : formatInr(pricing.deliveryCharge)}
                </span>
              </div>
              <div className="flex justify-between text-stone-600">
                <span>
                  {config.gstRegistered === false
                    ? 'Tax / GST (Non-GST)'
                    : 'Tax / GST (Included in price)'}
                </span>
                <span className="tabular-nums font-medium">{formatTaxAmount(pricing.taxAmount)}</span>
              </div>
              <div className="flex justify-between text-base font-bold text-stone-900 pt-1.5 border-t border-stone-200">
                <span>Total</span>
                <span className="tabular-nums">{formatInr(pricing.grandTotal)}</span>
              </div>
            </div>

            <button
              type="button"
              disabled={submitting || visiblePricingErrors.length > 0}
              onClick={() => void handlePlaceOrder()}
              className="w-full h-12 rounded-xl bg-stone-900 hover:bg-stone-800 text-white text-sm font-semibold disabled:opacity-50"
            >
              {!customerSession
                ? 'Sign In to Place Order'
                : submitting
                  ? 'Processing Order...'
                  : paymentMethod === 'razorpay'
                    ? `Pay ${formatInr(pricing.grandTotal)} Online`
                    : `Confirm Order · ${formatInr(pricing.grandTotal)}`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
