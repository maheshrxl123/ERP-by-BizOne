import {
  IconCheck,
  IconHeartFilled,
  IconLogout,
  IconPackage,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import type { PublishedStoreItemRecord, StoreOrderRecord, StoreOrderStatus } from '../../types/decorbiz';
import { formatInr, getProductImageSrc, type StoreCustomerSession } from './storeTypes';

const STATUS_LABELS: Record<StoreOrderStatus, string> = {
  pending: 'Order Placed',
  confirmed: 'Confirmed · Stock Reserved',
  packing: 'Packing in Showroom',
  out_for_delivery: 'Out for Delivery',
  ready_for_pickup: 'Ready for Pickup',
  delivered: 'Delivered',
  picked_up: 'Picked Up',
  cancelled: 'Cancelled',
};

interface StoreOrdersViewProps {
  customerSession: StoreCustomerSession | null;
  onRequireAuth: () => void;
  onSignOut: () => void;
  onSessionUpdate: (next: StoreCustomerSession) => void;
}

export function StoreOrdersView({
  customerSession,
  onRequireAuth,
  onSignOut,
  onSessionUpdate,
}: StoreOrdersViewProps) {
  const [orders, setOrders] = useState<StoreOrderRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [fullName, setFullName] = useState(customerSession?.customer.full_name || '');
  const [phone, setPhone] = useState(customerSession?.customer.phone || '');
  const [defaultAddress, setDefaultAddress] = useState(customerSession?.customer.default_address || '');
  const [defaultPincode, setDefaultPincode] = useState(customerSession?.customer.default_pincode || '');
  const [savingProfile, setSavingProfile] = useState(false);

  const loadOrders = async () => {
    if (!customerSession) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/store/orders', {
        headers: { Authorization: `Bearer ${customerSession.access_token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Could not load orders.');
      setOrders(data.orders || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to fetch order history.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (customerSession) {
      setFullName(customerSession.customer.full_name || '');
      setPhone(customerSession.customer.phone || '');
      setDefaultAddress(customerSession.customer.default_address || '');
      setDefaultPincode(customerSession.customer.default_pincode || '');
      void loadOrders();
    }
  }, [customerSession?.access_token]);

  const handleCancelOrder = async (orderId: string) => {
    if (!customerSession) return;
    setCancellingId(orderId);
    try {
      const res = await fetch(`/api/store/orders/${orderId}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${customerSession.access_token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Cancellation failed.');
      await loadOrders();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to cancel order.');
    } finally {
      setCancellingId(null);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerSession) return;
    setSavingProfile(true);
    try {
      const res = await fetch('/api/store/auth/me', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${customerSession.access_token}`,
        },
        body: JSON.stringify({
          full_name: fullName,
          phone,
          default_address: defaultAddress,
          default_pincode: defaultPincode,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Could not update profile.');
      onSessionUpdate({ ...customerSession, customer: data.customer });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Profile update failed.');
    } finally {
      setSavingProfile(false);
    }
  };

  if (!customerSession) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center space-y-4">
        <div className="w-12 h-12 rounded-2xl bg-stone-100 text-stone-700 flex items-center justify-center mx-auto">
          <IconPackage size={24} />
        </div>
        <h1 className="text-2xl font-bold text-stone-900">Your Orders & Account</h1>
        <p className="text-sm text-stone-600">
          Sign in to view your order status, delivery vehicle tracking, and saved addresses.
        </p>
        <button
          type="button"
          onClick={onRequireAuth}
          className="h-11 px-6 rounded-xl bg-stone-900 text-white text-sm font-semibold"
        >
          Customer Sign In / Register
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-stone-200 pb-5">
        <div>
          <h1 className="text-2xl font-bold text-stone-900">My Orders & Profile</h1>
          <p className="text-xs text-stone-500 mt-0.5">
            Signed in as {customerSession.customer.email}
            {customerSession.customer.email_verified ? ' (Verified)' : ' (Verification Pending)'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadOrders()}
            className="h-9 px-3.5 rounded-lg border border-stone-300 text-xs font-medium inline-flex items-center gap-1.5 hover:bg-stone-50"
          >
            <IconRefresh size={14} />
            <span>Refresh</span>
          </button>
          <button
            type="button"
            onClick={onSignOut}
            className="h-9 px-3.5 rounded-lg border border-stone-300 text-xs font-medium inline-flex items-center gap-1.5 text-red-700 hover:bg-red-50"
          >
            <IconLogout size={14} />
            <span>Sign Out</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-8 space-y-4">
          <h2 className="text-base font-semibold text-stone-900">Order History</h2>
          {loading ? (
            <p className="text-xs text-stone-500">Loading your orders...</p>
          ) : orders.length === 0 ? (
            <div className="rounded-2xl border border-stone-200 bg-white p-10 text-center text-sm text-stone-500">
              You have not placed any online orders yet.
            </div>
          ) : (
            orders.map((order) => (
              <div
                key={order.id}
                className="rounded-2xl border border-stone-200 bg-white p-5 space-y-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-100 pb-3">
                  <div>
                    <span className="font-mono text-sm font-bold text-stone-900">
                      {order.order_number}
                    </span>
                    <span className="text-xs text-stone-500 ml-3">
                      {new Date(order.created_at).toLocaleDateString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="font-semibold text-sky-800">
                      {STATUS_LABELS[order.status] || order.status}
                    </span>
                    <span className="text-stone-400">·</span>
                    <span className="font-medium uppercase text-stone-600">
                      {order.payment_method.replace(/_/g, ' ')} ({order.payment_status})
                    </span>
                  </div>
                </div>

                <div className="space-y-2 text-xs">
                  {(order.lines || []).map((line) => (
                    <div key={line.id} className="flex justify-between gap-2 text-stone-700">
                      <span>
                        {line.item_name}
                        {line.variant_name ? ` (${line.variant_name})` : ''} × {line.base_qty}{' '}
                        {line.ordered_unit === 'sqft' ? `(from ${line.ordered_qty} sq.ft)` : ''}
                      </span>
                      <span className="font-semibold tabular-nums">{formatInr(line.line_total)}</span>
                    </div>
                  ))}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-stone-100 text-xs">
                  <div className="text-stone-500">
                    {order.fulfillment_type === 'pickup'
                      ? 'Showroom Pickup Order'
                      : `Delivery: ${order.delivery_address || 'Local Zone'}${
                          order.delivery_pincode ? ` (${order.delivery_pincode})` : ''
                        }`}
                  </div>
                  <div className="flex items-center gap-3">
                    {['pending', 'confirmed'].includes(order.status) && (
                      <button
                        type="button"
                        disabled={cancellingId === order.id}
                        onClick={() => void handleCancelOrder(order.id)}
                        className="px-3 h-8 rounded-lg border border-red-200 text-red-700 hover:bg-red-50 font-medium"
                      >
                        {cancellingId === order.id ? 'Cancelling...' : 'Cancel Order'}
                      </button>
                    )}
                    <span className="text-sm font-bold text-stone-900 tabular-nums">
                      Total: {formatInr(order.grand_total)}
                    </span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="lg:col-span-4 space-y-4">
          <h2 className="text-base font-semibold text-stone-900">Saved Delivery Details</h2>
          <form onSubmit={handleSaveProfile} className="rounded-2xl border border-stone-200 bg-white p-5 space-y-3 text-xs">
            <div>
              <label className="block font-medium text-stone-700 mb-1">Full Name</label>
              <input
                type="text"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full h-9 px-3 rounded-lg border border-stone-300"
              />
            </div>
            <div>
              <label className="block font-medium text-stone-700 mb-1">Mobile Phone</label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full h-9 px-3 rounded-lg border border-stone-300"
              />
            </div>
            <div>
              <label className="block font-medium text-stone-700 mb-1">Default Pincode</label>
              <input
                type="text"
                value={defaultPincode}
                onChange={(e) => setDefaultPincode(e.target.value)}
                className="w-full h-9 px-3 rounded-lg border border-stone-300"
              />
            </div>
            <div>
              <label className="block font-medium text-stone-700 mb-1">Default Address</label>
              <textarea
                rows={3}
                value={defaultAddress}
                onChange={(e) => setDefaultAddress(e.target.value)}
                className="w-full p-2.5 rounded-lg border border-stone-300"
              />
            </div>
            <button
              type="submit"
              disabled={savingProfile}
              className="w-full h-10 rounded-xl bg-stone-900 text-white font-semibold inline-flex items-center justify-center gap-1.5"
            >
              <IconCheck size={14} />
              <span>{savingProfile ? 'Saving...' : 'Save Details'}</span>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

interface StoreWishlistViewProps {
  items: PublishedStoreItemRecord[];
  wishlistIds: string[];
  onRemove: (itemId: string) => void;
  onOpenProduct: (slug: string) => void;
}

export function StoreWishlistView({
  items,
  wishlistIds,
  onRemove,
  onOpenProduct,
}: StoreWishlistViewProps) {
  const savedItems = items.filter((it) => wishlistIds.includes(it.id));

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <div className="flex items-center gap-2.5 border-b border-stone-200 pb-4">
        <IconHeartFilled size={22} className="text-rose-600" />
        <div>
          <h1 className="text-2xl font-bold text-stone-900">Saved Wishlist</h1>
          <p className="text-xs text-stone-500">{savedItems.length} saved tile & bathware selection(s)</p>
        </div>
      </div>

      {savedItems.length === 0 ? (
        <div className="rounded-2xl border border-stone-200 bg-white p-12 text-center text-sm text-stone-500">
          Your wishlist is currently empty. Save designs while browsing to compare later.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {savedItems.map((item) => (
            <div
              key={item.id}
              className="rounded-2xl border border-stone-200 bg-white overflow-hidden flex flex-col"
            >
              <button
                type="button"
                onClick={() => onOpenProduct(item.online_slug)}
                className="aspect-[4/3] bg-stone-100 overflow-hidden"
              >
                <img
                  src={getProductImageSrc(item)}
                  alt={item.name}
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover hover:scale-105 transition-transform"
                />
              </button>
              <div className="p-4 flex-1 flex flex-col justify-between gap-3">
                <div>
                  <p className="text-[11px] text-stone-500 uppercase">{item.brand_name || 'Showroom'}</p>
                  <button
                    type="button"
                    onClick={() => onOpenProduct(item.online_slug)}
                    className="text-sm font-semibold text-stone-900 text-left hover:underline mt-0.5"
                  >
                    {item.name}
                  </button>
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-stone-100">
                  <span className="text-sm font-bold text-stone-900 tabular-nums">
                    {formatInr(item.effective_price)}
                  </span>
                  <button
                    type="button"
                    onClick={() => onRemove(item.id)}
                    className="text-xs text-stone-500 hover:text-red-600 inline-flex items-center gap-1"
                  >
                    <IconTrash size={14} />
                    <span>Remove</span>
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
