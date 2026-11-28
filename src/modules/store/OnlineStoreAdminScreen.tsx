import {
  IconBuildingStore,
  IconCheck,
  IconEdit,
  IconFileText,
  IconLoader2,
  IconMessageCheck,
  IconPackage,
  IconPhoto,
  IconPlus,
  IconPrinter,
  IconRefresh,
  IconSettings,
  IconSparkles,
  IconTag,
  IconTrash,
  IconTruck,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../../app/AppProvider';
import { ImageUpload, type UploadedImageItem } from '../../components/upload/ImageUpload';
import { erpFetch } from '../../core/erpFetch';
import { formatINR } from '../../core/format';
import { PRODUCT_LINES, type ProductLineKey } from '../../core/productLines';
import { SERVICE_BILLING_BASES, SERVICE_CATEGORIES } from '../../core/productSpecs';
import type {
  BrandRecord,
  ItemCatalogRecord,
  ItemCategoryRecord,
  ItemUnitRecord,
  ProductReviewRecord,
  StoreBannerRecord,
  StoreCouponRecord,
  StoreDeliveryTripRecord,
  StoreDeliveryZoneRecord,
  StoreOrderRecord,
  StoreOrderStatus,
  StorePageRecord,
} from '../../types/decorbiz';

type StoreAdminTab =
  | 'orders'
  | 'catalog'
  | 'trips'
  | 'zones'
  | 'coupons'
  | 'content'
  | 'reviews';

const ORDER_STATUS_OPTIONS: StoreOrderStatus[] = [
  'pending',
  'confirmed',
  'packing',
  'out_for_delivery',
  'ready_for_pickup',
  'delivered',
  'picked_up',
  'cancelled',
];

interface OnlineStoreAdminScreenProps {
  onOpenIntegrations?: () => void;
}

export function OnlineStoreAdminScreen({ onOpenIntegrations }: OnlineStoreAdminScreenProps) {
  const { session, profile, business, isModuleEnabled, showToast, t } = useApp();
  const isOwner = profile?.role === 'owner';
  const canManageCatalog = ['owner', 'manager', 'storekeeper'].includes(profile?.role || '');
  const aiEnabled = isModuleEnabled('ai');

  const [tab, setTab] = useState<StoreAdminTab>('orders');
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<ItemCatalogRecord[]>([]);
  const [categories, setCategories] = useState<ItemCategoryRecord[]>([]);
  const [brands, setBrands] = useState<BrandRecord[]>([]);
  const [units, setUnits] = useState<ItemUnitRecord[]>([]);
  const [orders, setOrders] = useState<StoreOrderRecord[]>([]);
  const [trips, setTrips] = useState<StoreDeliveryTripRecord[]>([]);
  const [zones, setZones] = useState<StoreDeliveryZoneRecord[]>([]);
  const [coupons, setCoupons] = useState<StoreCouponRecord[]>([]);
  const [banners, setBanners] = useState<StoreBannerRecord[]>([]);
  const [pages, setPages] = useState<StorePageRecord[]>([]);
  const [reviews, setReviews] = useState<ProductReviewRecord[]>([]);
  const [razorpayConfigured, setRazorpayConfigured] = useState(false);

  // Filters
  const [orderStatusFilter, setOrderStatusFilter] = useState<string>('all');
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogPubFilter, setCatalogPubFilter] = useState<'all' | 'published' | 'draft'>('all');

  // Item online edit modal/inline
  const [editingItem, setEditingItem] = useState<ItemCatalogRecord | null>(null);
  const [editPrice, setEditPrice] = useState('');
  const [editSlug, setEditSlug] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editPublished, setEditPublished] = useState(false);
  const [savingAction, setSavingAction] = useState(false);
  const [aiDraftingKind, setAiDraftingKind] = useState<string | null>(null);

  // Add Online Item modal (Publish existing ERP item OR Create new Goods/Service item)
  const [addOnlineOpen, setAddOnlineOpen] = useState(false);
  const [addMode, setAddMode] = useState<'existing' | 'new'>('existing');
  const [existingPickId, setExistingPickId] = useState('');
  const [existingOnlinePrice, setExistingOnlinePrice] = useState('');
  const [existingSlug, setExistingSlug] = useState('');
  const [existingDesc, setExistingDesc] = useState('');

  const [newName, setNewName] = useState('');
  const [newItemType, setNewItemType] = useState<'goods' | 'service'>('goods');
  const [newProductLine, setNewProductLine] = useState<ProductLineKey>('tiles_slabs');
  const [newCatId, setNewCatId] = useState('');
  const [newBrandId, setNewBrandId] = useState('');
  const [newUnitId, setNewUnitId] = useState('');
  const [newSku, setNewSku] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const [newMrp, setNewMrp] = useState('');
  const [newOnlinePrice, setNewOnlinePrice] = useState('');
  const [newGst, setNewGst] = useState('18');
  const [newHsn, setNewHsn] = useState('6907');
  const [newOpeningStock, setNewOpeningStock] = useState('0');
  const [newSqftPerBox, setNewSqftPerBox] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [newOnlineDesc, setNewOnlineDesc] = useState('');
  const [newPublishOnline, setNewPublishOnline] = useState(true);
  const [newImages, setNewImages] = useState<UploadedImageItem[]>([]);
  const [newSrvCat, setNewSrvCat] = useState<string>(SERVICE_CATEGORIES[0]);
  const [newSrvBasis, setNewSrvBasis] = useState<string>(SERVICE_BILLING_BASES[1]);
  const [newSrvDuration, setNewSrvDuration] = useState('');

  // Printable sheet
  const [printOrder, setPrintOrder] = useState<StoreOrderRecord | null>(null);

  // Quick creation states
  const [newTripDate, setNewTripDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [newDriverName, setNewDriverName] = useState('');
  const [newDriverPhone, setNewDriverPhone] = useState('');
  const [newVehicleNo, setNewVehicleNo] = useState('');

  const [editingZoneId, setEditingZoneId] = useState<string | null>(null);
  const [newZoneName, setNewZoneName] = useState('');
  const [newZonePincodes, setNewZonePincodes] = useState('');
  const [newZoneAreas, setNewZoneAreas] = useState('');
  const [newZoneCharge, setNewZoneCharge] = useState('0');
  const [newZoneMinOrder, setNewZoneMinOrder] = useState('0');
  const [newZoneDays, setNewZoneDays] = useState('2');

  const [editingCouponId, setEditingCouponId] = useState<string | null>(null);
  const [newCouponCode, setNewCouponCode] = useState('');
  const [newCouponType, setNewCouponType] = useState<'pct' | 'flat'>('pct');
  const [newCouponVal, setNewCouponVal] = useState('10');
  const [newCouponMin, setNewCouponMin] = useState('0');
  const [newCouponMax, setNewCouponMax] = useState('');

  const [editingBannerId, setEditingBannerId] = useState<string | null>(null);
  const [newBannerTitle, setNewBannerTitle] = useState('');
  const [newBannerSub, setNewBannerSub] = useState('');
  const [newBannerCtaLabel, setNewBannerCtaLabel] = useState('');
  const [newBannerCtaLink, setNewBannerCtaLink] = useState('/catalogue');
  const [newBannerSortOrder, setNewBannerSortOrder] = useState('0');
  const [newBannerImages, setNewBannerImages] = useState<UploadedImageItem[]>([]);

  const [newPageSlug, setNewPageSlug] = useState('');
  const [newPageTitle, setNewPageTitle] = useState('');
  const [newPageContent, setNewPageContent] = useState('');

  const loadOverview = useCallback(async () => {
    if (!session?.access_token) return;
    setLoading(true);
    try {
      const res = await erpFetch('/api/erp/store-admin/overview', session.access_token);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to load store data.');
      setItems(data.items || []);
      setCategories(data.categories || []);
      setBrands(data.brands || []);
      setUnits(data.units || []);
      setOrders(data.orders || []);
      setTrips(data.trips || []);
      setZones(data.zones || []);
      setCoupons(data.coupons || []);
      setBanners(data.banners || []);
      setPages(data.pages || []);
      setReviews(data.reviews || []);
      setRazorpayConfigured(Boolean(data.razorpayConfigured));
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to load Store inbox.', 'error');
    } finally {
      setLoading(false);
    }
  }, [session?.access_token, showToast]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const handleAiStoreAssist = async (
    kind: 'item_listing' | 'banner' | 'page',
    contextPayload: Record<string, unknown>,
    onApplied: (draft: Record<string, unknown>) => void
  ) => {
    if (!session?.access_token) return;
    setAiDraftingKind(kind);
    try {
      const res = await erpFetch('/api/erp/ai/store-assist', session.access_token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, ...contextPayload }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'AI assist failed.');
      onApplied(data.draft || {});
      showToast('AI draft populated.', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'AI assist failed.', 'error');
    } finally {
      setAiDraftingKind(null);
    }
  };

  const openAddOnlineItemModal = () => {
    const drafts = items.filter((i) => !i.is_published_online);
    const firstDraft = drafts[0] || items[0] || null;
    setAddMode(drafts.length > 0 ? 'existing' : 'new');
    setExistingPickId(firstDraft?.id || '');
    setExistingOnlinePrice(
      firstDraft?.online_price != null ? String(firstDraft.online_price) : ''
    );
    setExistingSlug(firstDraft?.online_slug || '');
    setExistingDesc(firstDraft?.online_description || firstDraft?.description || '');

    const defUnit =
      units.find((u) => u.code === 'BOX') || units.find((u) => u.code === 'PCS') || units[0];
    setNewName('');
    setNewItemType('goods');
    setNewProductLine('tiles_slabs');
    setNewCatId('');
    setNewBrandId('');
    setNewUnitId(defUnit?.id || '');
    setNewSku('');
    setNewPrice('');
    setNewMrp('');
    setNewOnlinePrice('');
    setNewGst('18');
    setNewHsn('6907');
    setNewOpeningStock('0');
    setNewSqftPerBox('');
    setNewSlug('');
    setNewOnlineDesc('');
    setNewPublishOnline(true);
    setNewImages([]);
    setAddOnlineOpen(true);
  };

  const handleSubmitAddOnlineItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session?.access_token) return;
    setSavingAction(true);
    try {
      if (addMode === 'existing') {
        if (!existingPickId) {
          showToast('Select an ERP item to publish.', 'error');
          setSavingAction(false);
          return;
        }
        const res = await erpFetch(`/api/erp/store-admin/items/${existingPickId}`, session.access_token, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            is_published_online: true,
            online_price: existingOnlinePrice.trim() ? Number(existingOnlinePrice) : null,
            online_slug: existingSlug.trim() || null,
            online_description: existingDesc.trim() || null,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || 'Could not publish item.');
        showToast('Item published to Online Store.', 'success');
      } else {
        if (!newName.trim() || !newUnitId) {
          showToast('Item name and unit are required.', 'error');
          setSavingAction(false);
          return;
        }
        const res = await erpFetch('/api/erp/store-admin/items', session.access_token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: newName.trim(),
            item_type: newItemType,
            product_line: newItemType === 'service' ? 'other_general' : newProductLine,
            category_id: newCatId || null,
            brand_id: newBrandId || null,
            base_unit_id: newUnitId,
            sku: newSku.trim() || null,
            selling_price: Math.max(0, Number(newPrice || 0)),
            mrp: newMrp.trim() ? Math.max(0, Number(newMrp)) : null,
            gst_rate: Number(newGst || 0),
            hsn_code: newHsn.trim() || null,
            opening_stock: newItemType === 'service' ? 0 : Math.max(0, Number(newOpeningStock || 0)),
            image_file_ids: newImages.map((img) => img.fileId),
            sqft_per_box: newItemType === 'goods' && newSqftPerBox.trim() ? Number(newSqftPerBox) : null,
            service_specs:
              newItemType === 'service'
                ? {
                    service_category: newSrvCat,
                    billing_basis: newSrvBasis,
                    est_duration: newSrvDuration.trim(),
                    sac_code: newHsn.trim(),
                  }
                : undefined,
            is_published_online: newPublishOnline,
            online_price: newOnlinePrice.trim() ? Math.max(0, Number(newOnlinePrice)) : null,
            online_slug: newSlug.trim() || null,
            online_description: newOnlineDesc.trim() || null,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || 'Could not create online store item.');
        showToast('Online Store item created.', 'success');
      }
      setAddOnlineOpen(false);
      await loadOverview();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Unable to save online item.', 'error');
    } finally {
      setSavingAction(false);
    }
  };

  const handleToggleItemPublish = async (item: ItemCatalogRecord, nextPub: boolean) => {
    if (!session?.access_token) return;
    setSavingAction(true);
    try {
      const res = await erpFetch(`/api/erp/store-admin/items/${item.id}`, session.access_token, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          is_published_online: nextPub,
          online_price: item.online_price ?? null,
          online_slug: item.online_slug ?? null,
          online_description: item.online_description ?? null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Could not update listing.');
      showToast(nextPub ? `"${item.name}" published online.` : `"${item.name}" unpublished.`, 'success');
      await loadOverview();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Update failed.', 'error');
    } finally {
      setSavingAction(false);
    }
  };

  const handleSaveItemDetails = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingItem || !session?.access_token) return;
    setSavingAction(true);
    try {
      const res = await erpFetch(`/api/erp/store-admin/items/${editingItem.id}`, session.access_token, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          is_published_online: editPublished,
          online_price: editPrice.trim() ? Number(editPrice) : null,
          online_slug: editSlug.trim() || null,
          online_description: editDesc.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Could not save online details.');
      setEditingItem(null);
      showToast('Online product details saved.', 'success');
      await loadOverview();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Save failed.', 'error');
    } finally {
      setSavingAction(false);
    }
  };

  const handleUpdateOrder = async (
    orderId: string,
    patch: { status?: StoreOrderStatus; delivery_trip_id?: string | null }
  ) => {
    if (!session?.access_token) return;
    setSavingAction(true);
    try {
      const res = await erpFetch(`/api/erp/store-admin/orders/${orderId}`, session.access_token, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Order update failed.');
      showToast('Store order updated.', 'success');
      await loadOverview();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Order update failed.', 'error');
    } finally {
      setSavingAction(false);
    }
  };

  const handleCreateTrip = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session?.access_token) return;
    setSavingAction(true);
    try {
      const res = await erpFetch('/api/erp/store-admin/trips', session.access_token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trip_date: newTripDate,
          driver_name: newDriverName,
          driver_phone: newDriverPhone || null,
          vehicle_no: newVehicleNo || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Could not create delivery trip.');
      setNewDriverName('');
      setNewDriverPhone('');
      setNewVehicleNo('');
      showToast(`Trip ${data.trip.trip_number} scheduled.`, 'success');
      await loadOverview();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Trip creation failed.', 'error');
    } finally {
      setSavingAction(false);
    }
  };

  const handleSaveZone = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session?.access_token) return;
    setSavingAction(true);
    try {
      const payload = {
        zone_name: newZoneName,
        pincodes: newZonePincodes
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        area_keywords: newZoneAreas
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        delivery_charge: Number(newZoneCharge || 0),
        min_order_amount: Number(newZoneMinOrder || 0),
        estimated_days: Number(newZoneDays || 2),
      };
      const res = await erpFetch(
        editingZoneId ? `/api/erp/store-admin/zones/${editingZoneId}` : '/api/erp/store-admin/zones',
        session.access_token,
        {
          method: editingZoneId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Could not save delivery zone.');
      setEditingZoneId(null);
      setNewZoneName('');
      setNewZonePincodes('');
      setNewZoneAreas('');
      setNewZoneCharge('0');
      setNewZoneMinOrder('0');
      setNewZoneDays('2');
      showToast(editingZoneId ? 'Delivery zone updated.' : 'Delivery zone added.', 'success');
      await loadOverview();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Zone save failed.', 'error');
    } finally {
      setSavingAction(false);
    }
  };

  const handleToggleZoneActive = async (z: StoreDeliveryZoneRecord) => {
    if (!session?.access_token) return;
    const res = await erpFetch(`/api/erp/store-admin/zones/${z.id}`, session.access_token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !z.is_active }),
    });
    if (res.ok) await loadOverview();
  };

  const handleSaveCoupon = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session?.access_token) return;
    setSavingAction(true);
    try {
      const payload = {
        code: newCouponCode,
        discount_type: newCouponType,
        discount_value: Number(newCouponVal),
        min_order_amount: Number(newCouponMin || 0),
        max_discount: newCouponMax.trim() ? Number(newCouponMax) : null,
      };
      const res = await erpFetch(
        editingCouponId
          ? `/api/erp/store-admin/coupons/${editingCouponId}`
          : '/api/erp/store-admin/coupons',
        session.access_token,
        {
          method: editingCouponId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Could not save coupon.');
      setEditingCouponId(null);
      setNewCouponCode('');
      setNewCouponMax('');
      showToast(
        editingCouponId ? `Coupon ${data.coupon.code} updated.` : `Coupon ${data.coupon.code} created.`,
        'success'
      );
      await loadOverview();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Coupon save failed.', 'error');
    } finally {
      setSavingAction(false);
    }
  };

  const handleToggleCouponActive = async (cp: StoreCouponRecord) => {
    if (!session?.access_token) return;
    const res = await erpFetch(`/api/erp/store-admin/coupons/${cp.id}`, session.access_token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !cp.is_active }),
    });
    if (res.ok) await loadOverview();
  };

  const handleSaveBanner = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session?.access_token) return;
    setSavingAction(true);
    try {
      const payload = {
        title: newBannerTitle,
        subtitle: newBannerSub.trim() || null,
        cta_label: newBannerCtaLabel.trim() || null,
        cta_link: newBannerCtaLink.trim() || null,
        sort_order: Math.max(0, Number(newBannerSortOrder || 0)),
        image_file_id: newBannerImages[0]?.fileId || null,
      };
      const res = await erpFetch(
        editingBannerId
          ? `/api/erp/store-admin/banners/${editingBannerId}`
          : '/api/erp/store-admin/banners',
        session.access_token,
        {
          method: editingBannerId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Banner save failed.');
      setEditingBannerId(null);
      setNewBannerTitle('');
      setNewBannerSub('');
      setNewBannerCtaLabel('');
      setNewBannerCtaLink('/catalogue');
      setNewBannerSortOrder('0');
      setNewBannerImages([]);
      showToast(editingBannerId ? 'Banner updated.' : 'Banner published.', 'success');
      await loadOverview();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to save banner.', 'error');
    } finally {
      setSavingAction(false);
    }
  };

  const handleToggleBannerActive = async (b: StoreBannerRecord) => {
    if (!session?.access_token) return;
    const res = await erpFetch(`/api/erp/store-admin/banners/${b.id}`, session.access_token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !b.is_active }),
    });
    if (res.ok) await loadOverview();
  };

  const handleSavePage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session?.access_token) return;
    setSavingAction(true);
    try {
      const res = await erpFetch('/api/erp/store-admin/pages', session.access_token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: newPageSlug,
          title: newPageTitle,
          content: newPageContent,
          is_published: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Could not save static page.');
      setNewPageSlug('');
      setNewPageTitle('');
      setNewPageContent('');
      showToast('Store page saved & published.', 'success');
      await loadOverview();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to save page.', 'error');
    } finally {
      setSavingAction(false);
    }
  };

  const handleModerateReview = async (reviewId: string, status: 'approved' | 'rejected') => {
    if (!session?.access_token) return;
    setSavingAction(true);
    try {
      const res = await erpFetch(`/api/erp/store-admin/reviews/${reviewId}`, session.access_token, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error('Moderation failed.');
      showToast(`Review marked ${status}.`, 'success');
      await loadOverview();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Review update failed.', 'error');
    } finally {
      setSavingAction(false);
    }
  };

  const filteredOrders = orders.filter((o) =>
    orderStatusFilter === 'all' ? true : o.status === orderStatusFilter
  );

  const filteredItems = items.filter((it) => {
    if (catalogPubFilter === 'published' && !it.is_published_online) return false;
    if (catalogPubFilter === 'draft' && it.is_published_online) return false;
    if (catalogSearch.trim()) {
      const q = catalogSearch.trim().toLowerCase();
      return (
        it.name.toLowerCase().includes(q) ||
        (it.sku || '').toLowerCase().includes(q) ||
        (it.category_name || '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  const publishedCount = items.filter((i) => i.is_published_online).length;
  const openOrdersCount = orders.filter((o) => !['delivered', 'picked_up', 'cancelled'].includes(o.status)).length;
  const pendingReviewsCount = reviews.filter((r) => r.status === 'pending').length;

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight inline-flex items-center gap-2">
            <IconBuildingStore size={24} stroke={2} className="text-[var(--primary-dark)]" />
            <span>Online Store</span>
          </h1>
          <p className="text-sm text-[var(--text-muted)] mt-0.5">
            Retail storefront catalogue, order inbox, delivery trips, zones, coupons & review moderation for {business?.name || 'DecorBiz'}.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canManageCatalog && (
            <button
              type="button"
              onClick={openAddOnlineItemModal}
              className="h-9 px-3.5 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center gap-1.5"
            >
              <IconPlus size={14} stroke={2.5} />
              <span>Add Online Item</span>
            </button>
          )}
          {isOwner && onOpenIntegrations && (
            <button
              type="button"
              onClick={onOpenIntegrations}
              className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-medium inline-flex items-center gap-1.5"
            >
              <IconSettings size={14} stroke={2} />
              <span>Payments & Store Credentials</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => void loadOverview()}
            disabled={loading}
            className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-medium inline-flex items-center gap-1"
          >
            <IconRefresh size={14} stroke={2} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs text-[var(--text-muted)]">Open Orders</p>
          <p className="text-xl font-bold mt-1 tabular-nums">{openOrdersCount}</p>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs text-[var(--text-muted)]">Published Items</p>
          <p className="text-xl font-bold mt-1 tabular-nums">{publishedCount} / {items.length}</p>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs text-[var(--text-muted)]">Online Payments</p>
          <p className={`text-sm font-semibold mt-1.5 ${razorpayConfigured ? 'text-[var(--receive-text)]' : 'text-[var(--text-muted)]'}`}>
            {razorpayConfigured ? 'Razorpay Active' : 'COD / Pickup Only'}
          </p>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs text-[var(--text-muted)]">Pending Reviews</p>
          <p className="text-xl font-bold mt-1 tabular-nums">{pendingReviewsCount}</p>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex flex-wrap gap-1.5 border-b border-[var(--border)] pb-3 text-xs font-medium">
        {(
          [
            { id: 'orders', label: `${t('storeAdmin.ordersTab')} (${orders.length})`, icon: IconPackage },
            { id: 'catalog', label: `${t('storeAdmin.catalogTab')} (${publishedCount})`, icon: IconBuildingStore },
            { id: 'trips', label: `${t('storeAdmin.tripsTab')} (${trips.length})`, icon: IconTruck },
            { id: 'zones', label: `${t('storeAdmin.zonesTab')} (${zones.length})`, icon: IconTruck },
            { id: 'coupons', label: `${t('storeAdmin.couponsTab')} (${coupons.length})`, icon: IconTag },
            { id: 'content', label: t('storeAdmin.contentTab'), icon: IconPhoto },
            { id: 'reviews', label: `${t('storeAdmin.reviewsTab')} (${pendingReviewsCount})`, icon: IconMessageCheck },
          ] as const
        ).map((tabItem) => {
          const Icon = tabItem.icon;
          const active = tab === tabItem.id;
          return (
            <button
              key={tabItem.id}
              type="button"
              onClick={() => setTab(tabItem.id)}
              className={`h-9 px-3.5 rounded-lg inline-flex items-center gap-1.5 transition-colors ${
                active
                  ? 'bg-[var(--primary)] text-[var(--on-primary)] font-semibold'
                  : 'border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-muted)]'
              }`}
            >
              <Icon size={14} />
              <span>{tabItem.label}</span>
            </button>
          );
        })}
      </div>

      {/* 1. Order Inbox & Stock Reservation Workflow */}
      {tab === 'orders' && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <select
              value={orderStatusFilter}
              onChange={(e) => setOrderStatusFilter(e.target.value)}
              className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-medium"
            >
              <option value="all">All Order Statuses</option>
              {ORDER_STATUS_OPTIONS.map((st) => (
                <option key={st} value={st}>
                  {st.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </div>

          {filteredOrders.length === 0 ? (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-8 text-center text-sm text-[var(--text-muted)]">
              No storefront orders found matching this status.
            </div>
          ) : (
            <div className="space-y-3">
              {filteredOrders.map((order) => (
                <div
                  key={order.id}
                  className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] pb-3">
                    <div>
                      <span className="font-mono font-bold text-sm">{order.order_number}</span>
                      <span className="ml-2.5 font-semibold">{order.customer_name}</span>
                      <span className="ml-2 text-[var(--text-muted)]">{order.customer_phone || order.customer_email}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono px-2 py-0.5 rounded bg-[var(--surface-muted)]">
                        Stock: {order.stock_state}
                      </span>
                      <span className="font-semibold uppercase">
                        {order.payment_method.replace(/_/g, ' ')} ({order.payment_status})
                      </span>
                      <span className="font-bold text-sm tabular-nums">{formatINR(order.grand_total)}</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      {(order.lines || []).map((l) => (
                        <div key={l.id} className="flex justify-between gap-2">
                          <span>
                            {l.item_name}
                            {l.variant_name ? ` (${l.variant_name})` : ''} × {l.base_qty}
                          </span>
                          <span className="tabular-nums font-medium">{formatINR(l.line_total)}</span>
                        </div>
                      ))}
                    </div>
                    <div className="text-[var(--text-muted)] space-y-1">
                      <p>
                        Fulfillment:{' '}
                        <strong className="text-[var(--text)]">
                          {order.fulfillment_type === 'pickup' ? 'Showroom Pickup' : 'Delivery Vehicle'}
                        </strong>
                      </p>
                      {order.delivery_address && <p>Address: {order.delivery_address} {order.delivery_pincode}</p>}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[var(--border)]">
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="text-[var(--text-muted)]">Status:</label>
                      <select
                        disabled={savingAction}
                        value={order.status}
                        onChange={(e) =>
                          void handleUpdateOrder(order.id, { status: e.target.value as StoreOrderStatus })
                        }
                        className="h-8 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] font-medium"
                      >
                        {ORDER_STATUS_OPTIONS.map((st) => (
                          <option key={st} value={st}>
                            {st.replace(/_/g, ' ')}
                          </option>
                        ))}
                      </select>

                      {order.fulfillment_type === 'delivery' && (
                        <>
                          <label className="text-[var(--text-muted)] ml-2">Delivery Trip:</label>
                          <select
                            disabled={savingAction}
                            value={order.delivery_trip_id || ''}
                            onChange={(e) =>
                              void handleUpdateOrder(order.id, {
                                delivery_trip_id: e.target.value || null,
                              })
                            }
                            className="h-8 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)]"
                          >
                            <option value="">Unassigned</option>
                            {trips.map((tr) => (
                              <option key={tr.id} value={tr.id}>
                                {tr.trip_number} · {tr.driver_name} ({tr.trip_date})
                              </option>
                            ))}
                          </select>
                        </>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => setPrintOrder(order)}
                      className="h-8 px-3 rounded-lg border border-[var(--border)] hover:bg-[var(--surface-muted)] inline-flex items-center gap-1 font-medium"
                    >
                      <IconPrinter size={14} />
                      <span>Picking / Delivery Sheet</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* 2. Catalog Publishing */}
      {tab === 'catalog' && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="search"
                value={catalogSearch}
                onChange={(e) => setCatalogSearch(e.target.value)}
                placeholder="Search items by name or SKU..."
                className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs w-64"
              />
              <select
                value={catalogPubFilter}
                onChange={(e) => setCatalogPubFilter(e.target.value as typeof catalogPubFilter)}
                className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs"
              >
                <option value="all">All Active Items</option>
                <option value="published">Published Online</option>
                <option value="draft">Unpublished</option>
              </select>
            </div>
            {canManageCatalog && (
              <button
                type="button"
                onClick={openAddOnlineItemModal}
                className="h-9 px-3.5 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center gap-1.5"
              >
                <IconPlus size={14} stroke={2.5} />
                <span>Add Online Item</span>
              </button>
            )}
          </div>

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[var(--border)] bg-[var(--surface-muted)] text-[var(--text-muted)]">
                <tr>
                  <th className="py-2.5 px-4 font-semibold">Item</th>
                  <th className="py-2.5 px-3 font-semibold">Pool (On Hand / Resv / Avail)</th>
                  <th className="py-2.5 px-3 font-semibold">MRP</th>
                  <th className="py-2.5 px-3 font-semibold">ERP Selling</th>
                  <th className="py-2.5 px-3 font-semibold">Storefront Price</th>
                  <th className="py-2.5 px-3 font-semibold">Published</th>
                  <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {filteredItems.map((it) => {
                  const hasChannelOverride =
                    it.online_price !== null &&
                    it.online_price !== undefined &&
                    Number(it.online_price) !== Number(it.selling_price);
                  const effectiveOnline =
                    it.online_price !== null && it.online_price !== undefined
                      ? Number(it.online_price)
                      : Number(it.selling_price);
                  return (
                  <tr key={it.id} className="hover:bg-[var(--surface-muted)]/40">
                    <td className="py-2.5 px-4">
                      <div className="font-semibold">{it.name}</div>
                      <div className="text-[11px] text-[var(--text-muted)]">
                        {it.sku || it.product_line} {it.online_slug ? `· /product/${it.online_slug}` : ''}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 tabular-nums">
                      {it.qty_on_hand} / {it.reserved_qty || 0} /{' '}
                      <strong className="text-[var(--receive-text)]">{it.available_qty ?? it.qty_on_hand}</strong>{' '}
                      {it.base_unit_code}
                    </td>
                    <td className="py-2.5 px-3 tabular-nums text-[var(--text-muted)]">
                      {it.mrp !== null && it.mrp !== undefined ? formatINR(it.mrp) : '—'}
                    </td>
                    <td className="py-2.5 px-3 tabular-nums">{formatINR(it.selling_price)}</td>
                    <td className="py-2.5 px-3 tabular-nums">
                      <div className="font-semibold">{formatINR(effectiveOnline)}</div>
                      {hasChannelOverride ? (
                        <span className="text-[10px] font-medium text-amber-700 dark:text-amber-300">
                          Online override
                        </span>
                      ) : (
                        <span className="text-[10px] text-[var(--text-muted)]">Synced with ERP</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3">
                      <button
                        type="button"
                        disabled={savingAction}
                        onClick={() => void handleToggleItemPublish(it, !it.is_published_online)}
                        className={`h-7 px-2.5 rounded-md font-semibold ${
                          it.is_published_online
                            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                            : 'bg-[var(--surface-muted)] text-[var(--text-muted)]'
                        }`}
                      >
                        {it.is_published_online ? 'Published' : 'Hidden'}
                      </button>
                    </td>
                    <td className="py-2.5 px-4 text-right">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingItem(it);
                          setEditPublished(Boolean(it.is_published_online));
                          setEditPrice(it.online_price !== null && it.online_price !== undefined ? String(it.online_price) : '');
                          setEditSlug(it.online_slug || '');
                          setEditDesc(it.online_description || it.description || '');
                        }}
                        className="text-[var(--primary-dark)] hover:underline font-medium"
                      >
                        Edit Online Info
                      </button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* 3. Delivery Trips */}
      {tab === 'trips' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 text-xs">
          <form onSubmit={handleCreateTrip} className="lg:col-span-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3 h-fit">
            <h3 className="text-sm font-semibold">Schedule Delivery Trip</h3>
            <input type="date" required value={newTripDate} onChange={(e) => setNewTripDate(e.target.value)} className="w-full h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)]" />
            <input type="text" required value={newDriverName} onChange={(e) => setNewDriverName(e.target.value)} placeholder="Driver Name" className="w-full h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)]" />
            <input type="text" value={newDriverPhone} onChange={(e) => setNewDriverPhone(e.target.value)} placeholder="Driver Phone" className="w-full h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)]" />
            <input type="text" value={newVehicleNo} onChange={(e) => setNewVehicleNo(e.target.value)} placeholder="Vehicle Number (e.g. RJ-14-XX-1234)" className="w-full h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)]" />
            <button type="submit" disabled={savingAction} className="w-full h-9 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] font-semibold inline-flex items-center justify-center gap-1">
              <IconPlus size={14} /><span>Create Trip</span>
            </button>
          </form>

          <div className="lg:col-span-8 space-y-2.5">
            {trips.map((tr) => (
              <div key={tr.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 flex items-center justify-between gap-3">
                <div>
                  <p className="font-mono font-bold text-sm">{tr.trip_number}</p>
                  <p className="text-[var(--text-muted)]">
                    {tr.trip_date} · Driver: {tr.driver_name} ({tr.driver_phone || 'No phone'}) · Vehicle: {tr.vehicle_no || 'Showroom Tempo'}
                  </p>
                </div>
                <select
                  value={tr.status}
                  onChange={async (e) => {
                    if (!session?.access_token) return;
                    await erpFetch(`/api/erp/store-admin/trips/${tr.id}`, session.access_token, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ status: e.target.value }),
                    });
                    await loadOverview();
                  }}
                  className="h-8 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] font-medium"
                >
                  <option value="planned">planned</option>
                  <option value="dispatched">dispatched</option>
                  <option value="completed">completed</option>
                  <option value="cancelled">cancelled</option>
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 4. Delivery Zones */}
      {tab === 'zones' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 text-xs">
          <form onSubmit={handleSaveZone} className="lg:col-span-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3 h-fit">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">{editingZoneId ? 'Edit Delivery Zone' : 'Add Delivery Zone'}</h3>
              {editingZoneId && (
                <button
                  type="button"
                  onClick={() => {
                    setEditingZoneId(null);
                    setNewZoneName('');
                    setNewZonePincodes('');
                    setNewZoneAreas('');
                    setNewZoneCharge('0');
                    setNewZoneMinOrder('0');
                    setNewZoneDays('2');
                  }}
                  className="text-[var(--text-muted)] underline"
                >
                  Cancel
                </button>
              )}
            </div>
            <input type="text" required value={newZoneName} onChange={(e) => setNewZoneName(e.target.value)} placeholder="Zone Name (e.g. City Center)" className="w-full h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)]" />
            <input type="text" value={newZonePincodes} onChange={(e) => setNewZonePincodes(e.target.value)} placeholder="Pincodes (comma separated: 302001, 302002)" className="w-full h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)]" />
            <input type="text" value={newZoneAreas} onChange={(e) => setNewZoneAreas(e.target.value)} placeholder="Area Keywords (Vaishali, Malviya Nagar)" className="w-full h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)]" />
            <div className="grid grid-cols-3 gap-2">
              <div><label className="text-[11px]">Charge (Rs)</label><input type="number" min={0} value={newZoneCharge} onChange={(e) => setNewZoneCharge(e.target.value)} className="w-full h-9 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)]" /></div>
              <div><label className="text-[11px]">Min Order</label><input type="number" min={0} value={newZoneMinOrder} onChange={(e) => setNewZoneMinOrder(e.target.value)} className="w-full h-9 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)]" /></div>
              <div><label className="text-[11px]">Days ETA</label><input type="number" min={0} value={newZoneDays} onChange={(e) => setNewZoneDays(e.target.value)} className="w-full h-9 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)]" /></div>
            </div>
            <button type="submit" disabled={savingAction} className="w-full h-9 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] font-semibold">
              {editingZoneId ? 'Update Delivery Zone' : 'Save Delivery Zone'}
            </button>
          </form>

          <div className="lg:col-span-8 space-y-2.5">
            {zones.map((z) => (
              <div key={z.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 flex items-center justify-between gap-3">
                <div>
                  <p className="font-semibold text-sm">{z.zone_name}</p>
                  <p className="text-[var(--text-muted)]">
                    Pincodes: {z.pincodes.join(', ') || 'None'} · Areas: {z.area_keywords.join(', ') || 'None'}
                  </p>
                  <p className="mt-1 tabular-nums">
                    Charge: {formatINR(z.delivery_charge)} · Min Order: {formatINR(z.min_order_amount)} · ETA: {z.estimated_days}d
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => void handleToggleZoneActive(z)}
                    className={`h-7 px-2.5 rounded-md font-semibold ${
                      z.is_active ? 'bg-emerald-100 text-emerald-800' : 'bg-[var(--surface-muted)] text-[var(--text-muted)]'
                    }`}
                  >
                    {z.is_active ? 'Active' : 'Paused'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingZoneId(z.id);
                      setNewZoneName(z.zone_name);
                      setNewZonePincodes(z.pincodes.join(', '));
                      setNewZoneAreas(z.area_keywords.join(', '));
                      setNewZoneCharge(String(z.delivery_charge));
                      setNewZoneMinOrder(String(z.min_order_amount));
                      setNewZoneDays(String(z.estimated_days));
                    }}
                    className="p-2 text-[var(--primary-dark)]"
                    aria-label="Edit zone"
                  >
                    <IconEdit size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!session?.access_token) return;
                      await erpFetch(`/api/erp/store-admin/zones/${z.id}`, session.access_token, { method: 'DELETE' });
                      await loadOverview();
                    }}
                    className="text-red-600 p-2"
                    aria-label="Delete zone"
                  >
                    <IconTrash size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 5. Coupons */}
      {tab === 'coupons' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 text-xs">
          <form onSubmit={handleSaveCoupon} className="lg:col-span-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3 h-fit">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">{editingCouponId ? 'Edit Promo Coupon' : 'Create Promo Coupon'}</h3>
              {editingCouponId && (
                <button
                  type="button"
                  onClick={() => {
                    setEditingCouponId(null);
                    setNewCouponCode('');
                    setNewCouponVal('10');
                    setNewCouponMin('0');
                    setNewCouponMax('');
                  }}
                  className="text-[var(--text-muted)] underline"
                >
                  Cancel
                </button>
              )}
            </div>
            <input type="text" required value={newCouponCode} onChange={(e) => setNewCouponCode(e.target.value.toUpperCase())} placeholder="Code (e.g. TILE10)" className="w-full h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] font-mono uppercase" />
            <div className="grid grid-cols-2 gap-2">
              <select value={newCouponType} onChange={(e) => setNewCouponType(e.target.value as 'pct' | 'flat')} className="h-9 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)]">
                <option value="pct">Percentage (%)</option>
                <option value="flat">Flat Amount (Rs)</option>
              </select>
              <input type="number" required min={1} value={newCouponVal} onChange={(e) => setNewCouponVal(e.target.value)} placeholder="Value" className="h-9 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)]" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input type="number" min={0} value={newCouponMin} onChange={(e) => setNewCouponMin(e.target.value)} placeholder="Min Order (Rs)" className="h-9 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)]" />
              <input type="number" min={0} value={newCouponMax} onChange={(e) => setNewCouponMax(e.target.value)} placeholder="Max Cap (optional)" className="h-9 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)]" />
            </div>
            <button type="submit" disabled={savingAction} className="w-full h-9 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] font-semibold">
              {editingCouponId ? 'Update Coupon' : 'Create Coupon'}
            </button>
          </form>

          <div className="lg:col-span-8 space-y-2.5">
            {coupons.map((cp) => (
              <div key={cp.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 flex items-center justify-between gap-3">
                <div>
                  <p className="font-mono font-bold text-sm">{cp.code}</p>
                  <p className="text-[var(--text-muted)]">
                    {cp.discount_type === 'pct' ? `${cp.discount_value}% off` : `${formatINR(cp.discount_value)} off`} · Min {formatINR(cp.min_order_amount)} · Used {cp.used_count}x
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => void handleToggleCouponActive(cp)}
                    className={`h-7 px-2.5 rounded-md font-semibold ${
                      cp.is_active ? 'bg-emerald-100 text-emerald-800' : 'bg-[var(--surface-muted)] text-[var(--text-muted)]'
                    }`}
                  >
                    {cp.is_active ? 'Active' : 'Disabled'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingCouponId(cp.id);
                      setNewCouponCode(cp.code);
                      setNewCouponType(cp.discount_type);
                      setNewCouponVal(String(cp.discount_value));
                      setNewCouponMin(String(cp.min_order_amount));
                      setNewCouponMax(cp.max_discount !== null && cp.max_discount !== undefined ? String(cp.max_discount) : '');
                    }}
                    className="p-2 text-[var(--primary-dark)]"
                    aria-label="Edit coupon"
                  >
                    <IconEdit size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!session?.access_token) return;
                      await erpFetch(`/api/erp/store-admin/coupons/${cp.id}`, session.access_token, { method: 'DELETE' });
                      await loadOverview();
                    }}
                    className="text-red-600 p-2"
                    aria-label="Delete coupon"
                  >
                    <IconTrash size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 6. Banners & Pages */}
      {tab === 'content' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 text-xs">
          <div className="space-y-4">
            <form onSubmit={handleSaveBanner} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{editingBannerId ? 'Edit Hero Banner' : 'Hero Banners'}</h3>
                <div className="flex items-center gap-2">
                  {aiEnabled && (
                    <button
                      type="button"
                      disabled={aiDraftingKind === 'banner'}
                      onClick={() =>
                        void handleAiStoreAssist(
                          'banner',
                          { prompt: newBannerTitle || 'Tiles and sanitaryware showroom seasonal showcase' },
                          (d) => {
                            if (d.title) setNewBannerTitle(String(d.title));
                            if (d.subtitle) setNewBannerSub(String(d.subtitle));
                            if (d.cta_label) setNewBannerCtaLabel(String(d.cta_label));
                            if (d.cta_link) setNewBannerCtaLink(String(d.cta_link));
                          }
                        )
                      }
                      className="text-[11px] font-semibold text-[var(--primary-dark)] inline-flex items-center gap-1 hover:underline"
                    >
                      {aiDraftingKind === 'banner' ? (
                        <IconLoader2 size={12} className="animate-spin" />
                      ) : (
                        <IconSparkles size={12} stroke={2} />
                      )}
                      <span>AI Draft Banner</span>
                    </button>
                  )}
                  {editingBannerId && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingBannerId(null);
                        setNewBannerTitle('');
                        setNewBannerSub('');
                        setNewBannerCtaLabel('');
                        setNewBannerCtaLink('/catalogue');
                        setNewBannerSortOrder('0');
                        setNewBannerImages([]);
                      }}
                      className="text-[var(--text-muted)] underline"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
              <input type="text" required value={newBannerTitle} onChange={(e) => setNewBannerTitle(e.target.value)} placeholder="Banner Headline" className="w-full h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)]" />
              <input type="text" value={newBannerSub} onChange={(e) => setNewBannerSub(e.target.value)} placeholder="Subtitle" className="w-full h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)]" />
              <div className="grid grid-cols-3 gap-2">
                <input type="text" value={newBannerCtaLabel} onChange={(e) => setNewBannerCtaLabel(e.target.value)} placeholder="CTA Label (Explore)" className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)]" />
                <input type="text" value={newBannerCtaLink} onChange={(e) => setNewBannerCtaLink(e.target.value)} placeholder="CTA Link (/catalogue)" className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)]" />
                <input type="number" min={0} value={newBannerSortOrder} onChange={(e) => setNewBannerSortOrder(e.target.value)} placeholder="Sort Order" className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] tabular-nums" />
              </div>
              <ImageUpload
                label="Banner Hero Image (optional)"
                purpose="store_banner"
                value={newBannerImages}
                onChange={setNewBannerImages}
                entityType="store_banner"
                deferDelete
                helperText="Displayed cleanly on the storefront hero showcase."
              />
              <button type="submit" disabled={savingAction} className="h-9 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] font-semibold">
                {editingBannerId ? 'Update Banner' : 'Add Banner'}
              </button>
            </form>
            {banners.map((b) => (
              <div key={b.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3.5 flex items-center justify-between gap-2">
                <div>
                  <p className="font-semibold">{b.title}</p>
                  <p className="text-[var(--text-muted)]">{b.subtitle}</p>
                  <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                    Order #{b.sort_order}{b.cta_label ? ` · ${b.cta_label} (${b.cta_link || '/catalogue'})` : ''}
                    {b.image_file_id ? ' · Image attached' : ''}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => void handleToggleBannerActive(b)}
                    className={`h-7 px-2.5 rounded-md font-semibold ${
                      b.is_active ? 'bg-emerald-100 text-emerald-800' : 'bg-[var(--surface-muted)] text-[var(--text-muted)]'
                    }`}
                  >
                    {b.is_active ? 'Active' : 'Hidden'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingBannerId(b.id);
                      setNewBannerTitle(b.title);
                      setNewBannerSub(b.subtitle || '');
                      setNewBannerCtaLabel(b.cta_label || '');
                      setNewBannerCtaLink(b.cta_link || '/catalogue');
                      setNewBannerSortOrder(String(b.sort_order ?? 0));
                      setNewBannerImages(
                        b.image_file_id
                          ? [{ fileId: b.image_file_id, url: '', fileName: 'Banner image', isPrimary: true }]
                          : []
                      );
                    }}
                    className="p-1.5 text-[var(--primary-dark)]"
                    aria-label="Edit banner"
                  >
                    <IconEdit size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!session?.access_token) return;
                      await erpFetch(`/api/erp/store-admin/banners/${b.id}`, session.access_token, { method: 'DELETE' });
                      await loadOverview();
                    }}
                    className="text-red-600 p-1.5"
                    aria-label="Delete banner"
                  >
                    <IconTrash size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-4">
            <form onSubmit={handleSavePage} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold inline-flex items-center gap-1.5"><IconFileText size={15} /><span>Storefront CMS Pages</span></h3>
                {aiEnabled && (
                  <button
                    type="button"
                    disabled={aiDraftingKind === 'page'}
                    onClick={() =>
                      void handleAiStoreAssist(
                        'page',
                        { prompt: newPageTitle || newPageSlug || 'Showroom About Us, Delivery & Return Policy' },
                        (d) => {
                          if (d.slug && !newPageSlug.trim()) setNewPageSlug(String(d.slug));
                          if (d.title) setNewPageTitle(String(d.title));
                          if (d.content) setNewPageContent(String(d.content));
                        }
                      )
                    }
                    className="text-[11px] font-semibold text-[var(--primary-dark)] inline-flex items-center gap-1 hover:underline"
                  >
                    {aiDraftingKind === 'page' ? (
                      <IconLoader2 size={12} className="animate-spin" />
                    ) : (
                      <IconSparkles size={12} stroke={2} />
                    )}
                    <span>AI Draft Page</span>
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input type="text" required value={newPageSlug} onChange={(e) => setNewPageSlug(e.target.value)} placeholder="Slug (about-us)" className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] font-mono" />
                <input type="text" required value={newPageTitle} onChange={(e) => setNewPageTitle(e.target.value)} placeholder="Page Title" className="h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)]" />
              </div>
              <textarea rows={3} required value={newPageContent} onChange={(e) => setNewPageContent(e.target.value)} placeholder="Page body content..." className="w-full p-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)]" />
              <button type="submit" disabled={savingAction} className="h-9 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] font-semibold">Publish / Update Page</button>
            </form>
            {pages.map((p) => (
              <div key={p.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3.5 flex items-center justify-between gap-2">
                <div><p className="font-semibold">{p.title}</p><p className="font-mono text-[11px] text-[var(--text-muted)]">/page/{p.slug}</p></div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setNewPageSlug(p.slug);
                      setNewPageTitle(p.title);
                      setNewPageContent(p.content);
                    }}
                    className="p-1.5 text-[var(--primary-dark)]"
                    aria-label="Edit page"
                  >
                    <IconEdit size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!session?.access_token) return;
                      await erpFetch(`/api/erp/store-admin/pages/${p.id}`, session.access_token, { method: 'DELETE' });
                      await loadOverview();
                    }}
                    className="text-red-600 p-1.5"
                    aria-label="Delete page"
                  >
                    <IconTrash size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 7. Review Moderation */}
      {tab === 'reviews' && (
        <div className="space-y-3 text-xs">
          {reviews.length === 0 ? (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-8 text-center text-[var(--text-muted)]">
              No customer product reviews submitted yet.
            </div>
          ) : (
            reviews.map((rev) => (
              <div key={rev.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="space-y-1">
                  <p className="font-semibold text-sm">
                    {rev.item_name || 'Product'} · {rev.rating}/5 ★ · <span className="uppercase text-[var(--text-muted)]">{rev.status}</span>
                  </p>
                  {rev.title && <p className="font-medium">{rev.title}</p>}
                  <p className="text-[var(--text-muted)]">{rev.comment}</p>
                  <p className="text-[11px] text-[var(--text-muted)]">By {rev.customer_name}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => void handleModerateReview(rev.id, 'approved')}
                    className="h-8 px-3 rounded-lg bg-emerald-600 text-white font-semibold inline-flex items-center gap-1"
                  >
                    <IconCheck size={14} /><span>Approve</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleModerateReview(rev.id, 'rejected')}
                    className="h-8 px-3 rounded-lg border border-red-300 text-red-700 font-semibold"
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Add Online Item Modal (Publish Existing OR Create New Goods/Service) */}
      {addOnlineOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4"
          onClick={() => setAddOnlineOpen(false)}
        >
          <form
            onSubmit={handleSubmitAddOnlineItem}
            onClick={(e) => e.stopPropagation()}
            className="w-full sm:max-w-2xl max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4 text-xs"
          >
            <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] pb-3">
              <h3 className="text-base font-semibold">Add Item to Online Store</h3>
              <button
                type="button"
                onClick={() => setAddOnlineOpen(false)}
                className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-muted)]"
              >
                <IconX size={18} />
              </button>
            </div>

            <div className="inline-flex rounded-lg border border-[var(--border)] overflow-hidden">
              <button
                type="button"
                onClick={() => setAddMode('existing')}
                className={`h-9 px-3.5 font-semibold ${
                  addMode === 'existing'
                    ? 'bg-[var(--primary)] text-[var(--on-primary)]'
                    : 'bg-[var(--surface)] text-[var(--text-muted)]'
                }`}
              >
                Publish Existing ERP Item
              </button>
              <button
                type="button"
                onClick={() => setAddMode('new')}
                className={`h-9 px-3.5 font-semibold ${
                  addMode === 'new'
                    ? 'bg-[var(--primary)] text-[var(--on-primary)]'
                    : 'bg-[var(--surface)] text-[var(--text-muted)]'
                }`}
              >
                Create New Online Item
              </button>
            </div>

            {addMode === 'existing' ? (
              <div className="space-y-3">
                <div>
                  <label className="block font-medium mb-1">Select ERP Item *</label>
                  <select
                    required
                    value={existingPickId}
                    onChange={(e) => {
                      const picked = items.find((i) => i.id === e.target.value);
                      setExistingPickId(e.target.value);
                      setExistingOnlinePrice(
                        picked?.online_price != null ? String(picked.online_price) : ''
                      );
                      setExistingSlug(picked?.online_slug || '');
                      setExistingDesc(picked?.online_description || picked?.description || '');
                    }}
                    className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)]"
                  >
                    <option value="">Choose item...</option>
                    {items.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.name} · {formatINR(it.selling_price)} {it.is_published_online ? '(Already Published)' : '(Unpublished)'}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block font-medium mb-1">Online Price (₹ optional override)</label>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={existingOnlinePrice}
                      onChange={(e) => setExistingOnlinePrice(e.target.value)}
                      placeholder="Same as ERP selling price"
                      className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] tabular-nums"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="font-medium">SEO URL Slug</label>
                      {aiEnabled && existingPickId && (
                        <button
                          type="button"
                          disabled={aiDraftingKind === 'item_listing'}
                          onClick={() => {
                            const picked = items.find((i) => i.id === existingPickId);
                            if (!picked) return;
                            void handleAiStoreAssist(
                              'item_listing',
                              {
                                itemName: picked.name,
                                categoryName: picked.category_name,
                                brandName: picked.brand_name,
                                itemType: picked.item_type,
                                productLine: picked.product_line,
                                sellingPrice: picked.selling_price,
                              },
                              (d) => {
                                if (d.online_slug) setExistingSlug(String(d.online_slug));
                                if (d.online_description) setExistingDesc(String(d.online_description));
                              }
                            );
                          }}
                          className="text-[11px] font-semibold text-[var(--primary-dark)] inline-flex items-center gap-1 hover:underline"
                        >
                          <IconSparkles size={12} />
                          <span>AI Draft Slug & Copy</span>
                        </button>
                      )}
                    </div>
                    <input
                      type="text"
                      value={existingSlug}
                      onChange={(e) => setExistingSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-'))}
                      placeholder="auto-generated-slug"
                      className="w-full h-10 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] font-mono"
                    />
                  </div>
                </div>

                <div>
                  <label className="block font-medium mb-1">Online Store Description</label>
                  <textarea
                    rows={3}
                    value={existingDesc}
                    onChange={(e) => setExistingDesc(e.target.value)}
                    placeholder="Customer-facing storefront highlights..."
                    className="w-full p-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)]"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="inline-flex rounded-lg border border-[var(--border)] overflow-hidden">
                    <button
                      type="button"
                      onClick={() => {
                        setNewItemType('goods');
                        setNewHsn('6907');
                      }}
                      className={`h-8 px-3 font-semibold ${
                        newItemType === 'goods'
                          ? 'bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                          : 'bg-[var(--surface)] text-[var(--text-muted)]'
                      }`}
                    >
                      Goods (Physical Product)
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setNewItemType('service');
                        setNewHsn('9954');
                      }}
                      className={`h-8 px-3 font-semibold ${
                        newItemType === 'service'
                          ? 'bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                          : 'bg-[var(--surface)] text-[var(--text-muted)]'
                      }`}
                    >
                      Service (Non-Stock)
                    </button>
                  </div>

                  <label className="inline-flex items-center gap-1.5 font-semibold">
                    <input
                      type="checkbox"
                      checked={newPublishOnline}
                      onChange={(e) => setNewPublishOnline(e.target.checked)}
                    />
                    <span>Publish immediately</span>
                  </label>
                </div>

                {newItemType === 'goods' ? (
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
                    {PRODUCT_LINES.map((pl) => (
                      <button
                        key={pl.key}
                        type="button"
                        onClick={() => {
                          setNewProductLine(pl.key);
                          setNewHsn(pl.defaultHsn);
                          setNewGst(String(pl.defaultGst));
                        }}
                        className={`px-2 py-1.5 rounded-lg border text-left font-medium ${
                          newProductLine === pl.key
                            ? 'border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--primary-dark)]'
                            : 'border-[var(--border)] text-[var(--text-muted)]'
                        }`}
                      >
                        {pl.shortLabelEn}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 p-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]/40">
                    <div>
                      <label className="block font-medium mb-1">Service Category *</label>
                      <select
                        value={newSrvCat}
                        onChange={(e) => setNewSrvCat(e.target.value)}
                        className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)]"
                      >
                        {SERVICE_CATEGORIES.map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block font-medium mb-1">Billing Basis *</label>
                      <select
                        value={newSrvBasis}
                        onChange={(e) => setNewSrvBasis(e.target.value)}
                        className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)]"
                      >
                        {SERVICE_BILLING_BASES.map((b) => (
                          <option key={b} value={b}>{b}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block font-medium mb-1">Est. Duration</label>
                      <input
                        type="text"
                        value={newSrvDuration}
                        onChange={(e) => setNewSrvDuration(e.target.value)}
                        placeholder="e.g., 2 hours"
                        className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)]"
                      />
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block font-medium mb-1">Name *</label>
                    <input
                      type="text"
                      required
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder={newItemType === 'service' ? 'e.g., Bathroom Tile Fitting Service' : 'e.g., Statuario Glossy GVT 600x1200mm'}
                      className="w-full h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)]"
                    />
                  </div>
                  <div>
                    <label className="block font-medium mb-1">SKU / Code</label>
                    <input
                      type="text"
                      value={newSku}
                      onChange={(e) => setNewSku(e.target.value.toUpperCase())}
                      placeholder="Optional"
                      className="w-full h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] font-mono uppercase"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  <div>
                    <label className="block font-medium mb-1">Category</label>
                    <select
                      value={newCatId}
                      onChange={(e) => setNewCatId(e.target.value)}
                      className="w-full h-9 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)]"
                    >
                      <option value="">Uncategorized</option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block font-medium mb-1">Brand</label>
                    <select
                      value={newBrandId}
                      onChange={(e) => setNewBrandId(e.target.value)}
                      className="w-full h-9 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)]"
                    >
                      <option value="">No Brand</option>
                      {brands.map((b) => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block font-medium mb-1">Unit *</label>
                    <select
                      required
                      value={newUnitId}
                      onChange={(e) => setNewUnitId(e.target.value)}
                      className="w-full h-9 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)]"
                    >
                      {units.map((u) => (
                        <option key={u.id} value={u.id}>{u.code}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block font-medium mb-1">{newItemType === 'service' ? 'SAC Code' : 'HSN Code'}</label>
                    <input
                      type="text"
                      value={newHsn}
                      onChange={(e) => setNewHsn(e.target.value)}
                      className="w-full h-9 px-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] font-mono"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  <div>
                    <label className="block font-medium mb-1">Selling Price (₹) *</label>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      required
                      value={newPrice}
                      onChange={(e) => setNewPrice(e.target.value)}
                      className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block font-medium mb-1">Online Price (₹)</label>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={newOnlinePrice}
                      onChange={(e) => setNewOnlinePrice(e.target.value)}
                      placeholder="Same as ERP"
                      className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block font-medium mb-1">MRP (₹)</label>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={newMrp}
                      onChange={(e) => setNewMrp(e.target.value)}
                      className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] tabular-nums"
                    />
                  </div>
                  {newItemType === 'goods' ? (
                    <div>
                      <label className="block font-medium mb-1">Opening Stock</label>
                      <input
                        type="number"
                        min={0}
                        step="any"
                        value={newOpeningStock}
                        onChange={(e) => setNewOpeningStock(e.target.value)}
                        className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] tabular-nums"
                      />
                    </div>
                  ) : (
                    <div>
                      <label className="block font-medium mb-1">GST %</label>
                      <input
                        type="number"
                        min={0}
                        max={28}
                        value={newGst}
                        onChange={(e) => setNewGst(e.target.value)}
                        className="w-full h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] tabular-nums"
                      />
                    </div>
                  )}
                </div>

                {newItemType === 'goods' && newProductLine === 'tiles_slabs' && (
                  <div>
                    <label className="block font-medium mb-1">Sq.Ft per Box (for customer tile calculator)</label>
                    <input
                      type="number"
                      min={0.1}
                      step="any"
                      value={newSqftPerBox}
                      onChange={(e) => setNewSqftPerBox(e.target.value)}
                      placeholder="e.g., 15.5"
                      className="w-48 h-9 px-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] tabular-nums"
                    />
                  </div>
                )}

                <ImageUpload
                  label="Product Photos"
                  purpose="item_image"
                  multiple
                  maxFiles={6}
                  deferDelete
                  value={newImages}
                  onChange={setNewImages}
                />

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="font-medium">SEO URL Slug</label>
                    {aiEnabled && (
                      <button
                        type="button"
                        disabled={aiDraftingKind === 'item_listing'}
                        onClick={() =>
                          void handleAiStoreAssist(
                            'item_listing',
                            {
                              itemName: newName || 'Showroom Item',
                              itemType: newItemType,
                              productLine: newProductLine,
                              sellingPrice: newPrice ? Number(newPrice) : undefined,
                            },
                            (d) => {
                              if (d.online_slug) setNewSlug(String(d.online_slug));
                              if (d.online_description) setNewOnlineDesc(String(d.online_description));
                            }
                          )
                        }
                        className="text-[11px] font-semibold text-[var(--primary-dark)] inline-flex items-center gap-1 hover:underline"
                      >
                        <IconSparkles size={12} />
                        <span>AI Draft Slug & Copy</span>
                      </button>
                    )}
                  </div>
                  <input
                    type="text"
                    value={newSlug}
                    onChange={(e) => setNewSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-'))}
                    placeholder="auto-generated-from-name"
                    className="w-full h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] font-mono"
                  />
                </div>

                <div>
                  <label className="block font-medium mb-1">Online Store Description</label>
                  <textarea
                    rows={2}
                    value={newOnlineDesc}
                    onChange={(e) => setNewOnlineDesc(e.target.value)}
                    placeholder="Customer-facing product/service highlights..."
                    className="w-full p-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)]"
                  />
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2 border-t border-[var(--border)]">
              <button
                type="button"
                onClick={() => setAddOnlineOpen(false)}
                className="h-9 px-4 rounded-lg border border-[var(--border)]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingAction}
                className="h-9 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] font-semibold"
              >
                {savingAction
                  ? 'Saving...'
                  : addMode === 'existing'
                    ? 'Publish Online'
                    : 'Create & Publish'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Edit Item Online Listing Modal */}
      {editingItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <form
            onSubmit={handleSaveItemDetails}
            className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4 text-xs"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-base font-semibold">Online Listing: {editingItem.name}</h3>
              {aiEnabled && (
                <button
                  type="button"
                  disabled={aiDraftingKind === 'item_listing'}
                  onClick={() =>
                    void handleAiStoreAssist(
                      'item_listing',
                      {
                        itemName: editingItem.name,
                        categoryName: editingItem.category_name,
                        brandName: editingItem.brand_name,
                        itemType: editingItem.item_type,
                        productLine: editingItem.product_line,
                        sellingPrice: editingItem.selling_price,
                      },
                      (d) => {
                        if (d.online_slug) setEditSlug(String(d.online_slug));
                        if (d.online_description) setEditDesc(String(d.online_description));
                      }
                    )
                  }
                  className="text-[11px] font-semibold text-[var(--primary-dark)] inline-flex items-center gap-1 hover:underline shrink-0"
                >
                  <IconSparkles size={12} />
                  <span>AI Draft Copy</span>
                </button>
              )}
            </div>
            <label className="flex items-center gap-2 cursor-pointer font-medium">
              <input
                type="checkbox"
                checked={editPublished}
                onChange={(e) => setEditPublished(e.target.checked)}
                className="w-4 h-4 accent-[var(--primary-dark)]"
              />
              <span>Publish item on retail storefront</span>
            </label>
            <div>
              <div className="flex items-center justify-between gap-2 mb-1">
                <label className="font-medium">
                  Online Price Override (ERP: {formatINR(editingItem.selling_price)}
                  {editingItem.mrp != null ? ` · MRP: ${formatINR(editingItem.mrp)}` : ''})
                </label>
                {editPrice.trim() !== '' && (
                  <button
                    type="button"
                    onClick={() => setEditPrice('')}
                    className="text-[11px] font-medium text-[var(--primary-dark)] hover:underline"
                  >
                    Sync with ERP Price
                  </button>
                )}
              </div>
              <input
                type="number"
                min={0}
                step="0.01"
                value={editPrice}
                onChange={(e) => setEditPrice(e.target.value)}
                placeholder={`Leave blank to use ERP ${formatINR(editingItem.selling_price)}`}
                className="w-full h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)]"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">SEO URL Slug</label>
              <input
                type="text"
                value={editSlug}
                onChange={(e) => setEditSlug(e.target.value)}
                placeholder="statuario-vitrified-600x1200"
                className="w-full h-9 px-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] font-mono"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">Online Storefront Description</label>
              <textarea
                rows={4}
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                className="w-full p-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface)]"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setEditingItem(null)} className="h-9 px-4 rounded-lg border border-[var(--border)]">
                Cancel
              </button>
              <button type="submit" disabled={savingAction} className="h-9 px-4 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] font-semibold">
                Save Listing
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Printable Picking / Delivery Sheet Modal */}
      {printOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-2xl rounded-xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] print-surface p-6 space-y-4">
            <div className="flex items-start justify-between border-b border-[var(--border)] pb-3">
              <div>
                <h3 className="text-lg font-bold">
                  {printOrder.fulfillment_type === 'pickup' ? t('storeAdmin.pickingSlip') : t('storeAdmin.dispatchSheet')}
                </h3>
                <p className="text-xs text-[var(--text-muted)]">
                  Order {printOrder.order_number} · {new Date(printOrder.created_at).toLocaleString('en-IN')}
                </p>
              </div>
              <div className="flex gap-2 print:hidden">
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="h-9 px-3 rounded-lg bg-[var(--primary)] text-[var(--on-primary)] text-xs font-semibold inline-flex items-center gap-1"
                >
                  <IconPrinter size={14} /><span>{t('storeAdmin.print')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPrintOrder(null)}
                  className="h-9 px-3 rounded-lg border border-[var(--border)] text-xs hover:bg-[var(--surface-muted)]"
                >
                  {t('storeAdmin.close')}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <p className="font-semibold">Customer</p>
                <p>{printOrder.customer_name}</p>
                <p>{printOrder.customer_phone || printOrder.customer_email}</p>
              </div>
              <div>
                <p className="font-semibold">Dispatch / Fulfillment</p>
                <p className="uppercase">{printOrder.fulfillment_type}</p>
                {printOrder.delivery_address && <p>{printOrder.delivery_address} ({printOrder.delivery_pincode})</p>}
                {printOrder.delivery_trip && (
                  <p className="mt-1 font-medium">
                    Trip: {printOrder.delivery_trip.trip_number} · {printOrder.delivery_trip.driver_name}
                  </p>
                )}
              </div>
            </div>

            <table className="w-full text-xs border border-[var(--border)]">
              <thead className="bg-[var(--surface-muted)]">
                <tr>
                  <th className="p-2 text-left">Item</th>
                  <th className="p-2 text-right">Dispatch Qty</th>
                  <th className="p-2 text-right">Ordered Mode</th>
                  <th className="p-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {(printOrder.lines || []).map((l) => (
                  <tr key={l.id} className="border-t border-[var(--border)]">
                    <td className="p-2">{l.item_name} {l.variant_name ? `(${l.variant_name})` : ''}</td>
                    <td className="p-2 text-right font-semibold tabular-nums">{l.base_qty}</td>
                    <td className="p-2 text-right tabular-nums">{l.ordered_qty} {l.ordered_unit}</td>
                    <td className="p-2 text-right tabular-nums">{formatINR(l.line_total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="flex justify-between items-center text-xs pt-2 border-t border-[var(--border)] font-semibold">
              <span>Payment: {printOrder.payment_method.toUpperCase()} ({printOrder.payment_status})</span>
              <span className="text-sm">Collectable / Total: {formatINR(printOrder.grand_total)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
