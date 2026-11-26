import {
  IconArrowRight,
  IconFileText,
  IconLoader2,
  IconMessageChatbot,
  IconSend,
  IconShoppingBagPlus,
  IconSparkles,
  IconX,
} from '@tabler/icons-react';
import { useState } from 'react';
import type { PublishedStoreItemRecord } from '../../types/decorbiz';
import { formatInr, getProductImageSrc, type StoreCartItem } from './storeTypes';

interface SuggestedStoreItem {
  id: string;
  name: string;
  online_slug: string;
  product_line: PublishedStoreItemRecord['product_line'];
  item_type: string;
  effective_price: number;
  mrp: number | null;
  base_unit_code: string;
  sqft_per_box: number | null;
  available_qty: number;
  in_stock: boolean;
  primary_image_file_id: string | null;
}

interface SuggestedStorePage {
  slug: string;
  title: string;
}

interface ChatEntry {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  suggestedItems?: SuggestedStoreItem[];
  suggestedPages?: SuggestedStorePage[];
  boxEstimateNote?: string | null;
}

interface StoreAiAssistantProps {
  storeName: string;
  items: PublishedStoreItemRecord[];
  onOpenProductSlug: (slug: string) => void;
  onOpenPageSlug: (slug: string) => void;
  onAddToCart: (line: StoreCartItem) => void;
}

const STARTER_PROMPTS = [
  'Suggest floor tiles for a 12×15 ft living room',
  'Show bath fittings and faucets in stock',
  'How many tile boxes do I need for 250 sq.ft?',
  'Share active coupon codes and delivery zones',
];

export function StoreAiAssistant({
  storeName,
  items,
  onOpenProductSlug,
  onOpenPageSlug,
  onAddToCart,
}: StoreAiAssistantProps) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [addedItemIds, setAddedItemIds] = useState<Record<string, boolean>>({});
  const [messages, setMessages] = useState<ChatEntry[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: `Hello! Ask me about tiles, room sq.ft to box estimates, sanitaryware, faucets, active offers, or delivery zones at ${storeName}.`,
    },
  ]);

  const sendMessage = async (textOverride?: string) => {
    const trimmed = (textOverride ?? input).trim();
    if (!trimmed || loading) return;

    const userMsg: ChatEntry = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: trimmed,
    };
    const nextHistory = [...messages, userMsg]
      .filter((m) => m.id !== 'welcome')
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [...prev, userMsg]);
    if (!textOverride) setInput('');
    setLoading(true);
    setErrorMsg(null);

    try {
      const res = await fetch('/api/store/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          history: nextHistory.slice(0, -1),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        reply?: string;
        suggestedItems?: SuggestedStoreItem[];
        suggestedPages?: SuggestedStorePage[];
        boxEstimateNote?: string | null;
      };
      if (!res.ok) {
        throw new Error(json.error || 'Assistant is unavailable right now.');
      }

      const replyEntry: ChatEntry = {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: json.reply || 'Here is what I found in our showroom catalogue.',
        suggestedItems: json.suggestedItems || [],
        suggestedPages: json.suggestedPages || [],
        boxEstimateNote: json.boxEstimateNote || null,
      };
      setMessages((prev) => [...prev, replyEntry]);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to send message.');
    } finally {
      setLoading(false);
    }
  };

  const handleQuickAdd = (suggested: SuggestedStoreItem) => {
    const fullItem = items.find((i) => i.id === suggested.id || i.online_slug === suggested.online_slug);
    if (!fullItem) {
      onOpenProductSlug(suggested.online_slug);
      return;
    }
    const specsObj =
      fullItem.specs && typeof fullItem.specs === 'object'
        ? (fullItem.specs as Record<string, unknown>)
        : null;
    const rawSqft = Number(specsObj?.sqft_per_box ?? suggested.sqft_per_box ?? 0);
    const sqftPerBox = Number.isFinite(rawSqft) && rawSqft > 0 ? rawSqft : null;
    onAddToCart({
      key: `${fullItem.id}:default:base`,
      item: fullItem,
      variantId: null,
      variantName: null,
      unitPrice: Number(fullItem.effective_price || 0),
      mode: 'base',
      qty: 1,
      baseQty: 1,
      wastagePct: 0,
      sqftCovered: sqftPerBox,
    });
    setAddedItemIds((prev) => ({ ...prev, [fullItem.id]: true }));
  };

  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col items-end">
      {open && (
        <section
          aria-label="Showroom Shopping Assistant"
          className="mb-3 w-[min(92vw,400px)] h-[540px] max-h-[78vh] rounded-2xl border border-stone-200 bg-white shadow-2xl flex flex-col overflow-hidden"
        >
          <div className="px-4 py-3 bg-stone-900 text-white flex items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center shrink-0">
                <IconSparkles size={16} />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold truncate">{storeName}</p>
                <p className="text-[11px] text-stone-300 truncate">Showroom Product &amp; Tile Assistant</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close assistant"
              className="p-1.5 rounded-lg text-stone-300 hover:text-white hover:bg-white/10"
            >
              <IconX size={16} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-3.5 space-y-3 bg-[#FAF9F6]">
            {messages.length <= 1 && (
              <div className="flex flex-wrap gap-1.5 pb-1">
                {STARTER_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => void sendMessage(prompt)}
                    className="text-left text-[11px] px-2.5 py-1.5 rounded-lg border border-stone-200 bg-white hover:border-stone-400 text-stone-700 transition-colors"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            )}

            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
              >
                <div
                  className={`max-w-[88%] rounded-xl px-3.5 py-2.5 text-xs leading-relaxed whitespace-pre-line ${
                    msg.role === 'user'
                      ? 'bg-stone-900 text-white'
                      : 'bg-white border border-stone-200 text-stone-800'
                  }`}
                >
                  {msg.content}
                </div>

                {msg.boxEstimateNote && (
                  <div className="mt-1.5 max-w-[92%] rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
                    {msg.boxEstimateNote}
                  </div>
                )}

                {msg.suggestedItems && msg.suggestedItems.length > 0 && (
                  <div className="mt-2 w-full space-y-2">
                    {msg.suggestedItems.map((it) => {
                      const imgSrc = getProductImageSrc(it);
                      const isAdded = Boolean(addedItemIds[it.id]);
                      return (
                        <div
                          key={it.id}
                          className="rounded-xl border border-stone-200 bg-white p-2.5 flex items-center gap-2.5"
                        >
                          <img
                            src={imgSrc}
                            alt={it.name}
                            referrerPolicy="no-referrer"
                            className="w-12 h-12 rounded-lg object-cover border border-stone-100 shrink-0"
                          />
                          <div className="min-w-0 flex-1">
                            <button
                              type="button"
                              onClick={() => {
                                onOpenProductSlug(it.online_slug);
                                setOpen(false);
                              }}
                              className="text-xs font-semibold text-stone-900 hover:underline text-left line-clamp-1"
                            >
                              {it.name}
                            </button>
                            <div className="text-[11px] text-stone-600 tabular-nums mt-0.5">
                              {formatInr(it.effective_price)} / {it.base_unit_code}
                              {it.sqft_per_box ? ` · ${it.sqft_per_box} sq.ft/box` : ''}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {it.in_stock && (
                              <button
                                type="button"
                                onClick={() => handleQuickAdd(it)}
                                title="Add to Bag"
                                className={`h-8 px-2.5 rounded-lg text-[11px] font-medium inline-flex items-center gap-1 ${
                                  isAdded
                                    ? 'bg-emerald-700 text-white'
                                    : 'bg-stone-900 hover:bg-stone-800 text-white'
                                }`}
                              >
                                <IconShoppingBagPlus size={13} />
                                <span>{isAdded ? 'Added' : 'Add'}</span>
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                onOpenProductSlug(it.online_slug);
                                setOpen(false);
                              }}
                              title="View Product"
                              className="h-8 w-8 rounded-lg border border-stone-200 hover:bg-stone-100 text-stone-700 flex items-center justify-center"
                            >
                              <IconArrowRight size={13} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {msg.suggestedPages && msg.suggestedPages.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {msg.suggestedPages.map((pg) => (
                      <button
                        key={pg.slug}
                        type="button"
                        onClick={() => {
                          onOpenPageSlug(pg.slug);
                          setOpen(false);
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-stone-200 bg-white hover:bg-stone-100 text-[11px] text-stone-700"
                      >
                        <IconFileText size={12} />
                        <span>{pg.title}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}

            {loading && (
              <div className="inline-flex items-center gap-2 rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs text-stone-600">
                <IconLoader2 size={14} className="animate-spin" />
                <span>Checking catalogue &amp; stock...</span>
              </div>
            )}

            {errorMsg && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700">
                {errorMsg}
              </div>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sendMessage();
            }}
            className="p-2.5 border-t border-stone-200 bg-white flex items-center gap-2 shrink-0"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about tiles, sizes, prices, delivery..."
              disabled={loading}
              className="flex-1 h-9 px-3 rounded-xl border border-stone-300 text-xs text-stone-900 focus:outline-none focus:ring-2 focus:ring-stone-800"
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              aria-label="Send message"
              className="h-9 w-9 rounded-xl bg-stone-900 hover:bg-stone-800 disabled:opacity-40 text-white flex items-center justify-center shrink-0"
            >
              <IconSend size={15} />
            </button>
          </form>
        </section>
      )}

      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="h-12 px-4 rounded-2xl bg-stone-900 hover:bg-stone-800 text-white shadow-lg border border-stone-800 inline-flex items-center gap-2 text-xs font-semibold transition-transform active:scale-95"
      >
        <IconMessageChatbot size={18} />
        <span>{open ? 'Hide Assistant' : 'Ask Showroom AI'}</span>
      </button>
    </div>
  );
}
