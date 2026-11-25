export interface LotCheckLine {
  item_id: string;
  item_name: string;
  product_line?: string | null;
  shade?: string | null;
  batch_lot?: string | null;
}

export interface MixedLotWarning {
  itemId: string;
  itemName: string;
  messageEn: string;
  messageHi: string;
}

export function detectMixedLotsOnBill(lines: LotCheckLine[]): MixedLotWarning[] {
  const itemMap = new Map<
    string,
    { itemName: string; shades: Set<string>; lots: Set<string> }
  >();

  for (const l of lines) {
    if (l.product_line !== 'tiles_slabs') continue;
    const shade = (l.shade || '').trim();
    const lot = (l.batch_lot || '').trim();
    if (!shade && !lot) continue;

    let entry = itemMap.get(l.item_id);
    if (!entry) {
      entry = { itemName: l.item_name, shades: new Set(), lots: new Set() };
      itemMap.set(l.item_id, entry);
    }
    if (shade) entry.shades.add(shade);
    if (lot) entry.lots.add(lot);
  }

  const warnings: MixedLotWarning[] = [];
  for (const [itemId, data] of itemMap.entries()) {
    const hasMultipleShades = data.shades.size > 1;
    const hasMultipleLots = data.lots.size > 1;

    if (hasMultipleShades || hasMultipleLots) {
      const parts: string[] = [];
      if (hasMultipleShades) parts.push(`shades [${Array.from(data.shades).join(', ')}]`);
      if (hasMultipleLots) parts.push(`batches [${Array.from(data.lots).join(', ')}]`);

      warnings.push({
        itemId,
        itemName: data.itemName,
        messageEn: `Warning: Tile "${data.itemName}" mixes different ${parts.join(' and ')} on this bill. Shade variation may occur upon laying.`,
        messageHi: `चेतावनी: टाइल "${data.itemName}" में इस बिल पर अलग-अलग ${parts.join(' और ')} मिलाए गए हैं। लगाने पर रंग/शेड में अंतर आ सकता है।`,
      });
    }
  }

  return warnings;
}
