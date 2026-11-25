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
import { useEffect, useState } from 'react';
import { computeStoreOrderTotals, matchDeliveryZone } from '../../core/storeCatalog';
import type { StoreOrderRecord } from '../../types/decorbiz';
import {
  formatInr,
  getProductImageSrc,
  type StoreCartItem,
  type StoreConfigPayload,
  type StoreCustomerSession,
} from './storeTypes';

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

  useEffect(() => {
    if (customerSession?.customer) {
      setAddress((prev) => prev || customerSession.customer.default_address || '');
      setPincode((prev) => prev || customerSession.customer.default_pincode || '');
    }
  }, [customerSession]);

  useEffect(() => {
    if (fulfillmentType === 'pickup' && paymentMethod === 'cod') {
      setPaymentMethod(config.pickupEnabled ? 'pay_on_pickup' : 'razorpay');
    } else if (fulfillmentType === 'delivery' && paymentMethod === 'pay_on_pickup') {
      setPaymentMethod(config.codEnabled ? 'cod' : 'razorpay');
    }
  }, [fulfillmentType, paymentMethod, config.codEnabled, config.pickupEnabled]);

  if (!open) return null;

  const matchedZone =
    fulfillmentType === 'delivery'
      ? matchDeliveryZone(config.zones || [], { pincode, area: area || address })
      : null;

  const matchedCoupon =
    couponInput.trim()
      ? (config.coupons || []).find((c) => c.code.toUpperCase() === couponInput.trim().toUpperCase()) || null
      : null;

  const pricing = computeStoreOrderTotals({
    lines: cart.map((c) => ({ unitPrice: c.unitPrice, baseQty: c.baseQty })),
    fulfillmentType,
    zone: matchedZone,
    coupon: matchedCoupon,
  });

  const handlePlaceOrder = async () => {
    setError(null);
    if (!customerSession) {
      onRequireAuth();
      return;
    }
    if (cart.length === 0) return;

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
      <div className="w-full max-w-lg bg-white h-full flex flex-col shadow-2xl border-l border-stone-200">
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-200">
          <div>
            <h2 className="text-lg font-bold text-stone-900">Your Shopping Bag</h2>
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
                    <img
                      src={getProductImageSrc(c.item)}
                      alt={c.item.name}
                      referrerPolicy="no-referrer"
                      className="w-16 h-16 rounded-lg object-cover border border-stone-200 shrink-0"
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
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="text"
                        value={pincode}
                        onChange={(e) => setPincode(e.target.value)}
                        placeholder="Pincode (e.g. 302001)"
                        className="h-9 px-3 rounded-lg border border-stone-300 bg-white"
                      />
                      <input
                        type="text"
                        value={area}
                        onChange={(e) => setArea(e.target.value)}
                        placeholder="Locality / Area"
                        className="h-9 px-3 rounded-lg border border-stone-300 bg-white"
                      />
                    </div>
                    <textarea
                      rows={2}
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                      placeholder="Full delivery address & landmark"
                      className="w-full p-2.5 rounded-lg border border-stone-300 bg-white"
                    />
                    {matchedZone ? (
                      <p className="text-[11px] font-medium text-emerald-700">
                        Zone matched: {matchedZone.zone_name} · Delivery {formatInr(matchedZone.delivery_charge)} · Est.{' '}
                        {matchedZone.estimated_days} day(s)
                      </p>
                    ) : (
                      <p className="text-[11px] text-amber-700">
                        Enter a serviceable pincode or locality, or switch to Free Shop Pickup.
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
                className="w-full h-10 px-3 rounded-xl border border-stone-300 text-xs"
              />
            </>
          )}
        </div>

        {cart.length > 0 && (
          <div className="p-6 border-t border-stone-200 bg-stone-50 space-y-3">
            {(error || pricing.errors.length > 0) && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {error || pricing.errors[0]}
              </div>
            )}
            <div className="space-y-1 text-xs">
              <div className="flex justify-between text-stone-600">
                <span>Subtotal</span>
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
              <div className="flex justify-between text-base font-bold text-stone-900 pt-1.5 border-t border-stone-200">
                <span>Total</span>
                <span className="tabular-nums">{formatInr(pricing.grandTotal)}</span>
              </div>
            </div>

            <button
              type="button"
              disabled={submitting || pricing.errors.length > 0}
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
