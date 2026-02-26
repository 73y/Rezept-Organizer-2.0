/* js/shopping/receiptData.js
   Receipt ↔ state integration: progress tracking, purchase log, pantry upsert.
   Extracted from js/shopping.js (v0.6.9).
   Exposes: window.receiptData
*/
(() => {
  const uid = () => (window.utils?.uid ? window.utils.uid() : window.models.uid());

  function receiptProgress(receipt) {
    const items = Array.isArray(receipt?.items) ? receipt.items : [];
    const main = items.filter((x) => x && x.kind === "item");
    const total = main.length;
    const matched = main.filter((x) => x && x.matchedIngredientId).length;
    const skipped = main.filter((x) => x && x.skippedAt).length;
    const done = matched + skipped;
    return { matched, skipped, done, total };
  }


  function deleteReceiptAndRelated(state, receiptId) {
    if (!receiptId) return;
    state.receipts = (state.receipts || []).filter((r) => r && r.id !== receiptId);
    // Remove any purchaseLog entries that came from this receipt (to avoid stats ghosts & duplicates after re-import)
    state.purchaseLog = (state.purchaseLog || []).filter((e) => !(e && e.source === "receipt" && e.receiptId === receiptId));
    // Remove any pantry lots that came from this receipt (to avoid duplicates after re-import)
    state.pantry = (state.pantry || []).filter((p) => !(p && p.source === "receipt" && p.receiptId === receiptId));
  }

  function findPurchaseLogEntryForReceiptItem(state, receiptId, receiptItemId) {
    return (state.purchaseLog || []).find((e) => e && e.source === "receipt" && e.receiptId === receiptId && e.receiptItemId === receiptItemId) || null;
  }

  function upsertPurchaseLogFromReceiptItem(state, receipt, item) {
    const at = receipt.at;
    const entry = findPurchaseLogEntryForReceiptItem(state, receipt.id, item.id);
    const qty = Math.max(1, Math.round(Number(item.qty) || 1));
    const total = Number(item.lineTotal) || 0;
    const unitPrice = Number(item.unitPrice) || (total / qty);

    if (!entry) {
      state.purchaseLog.push({
        id: uid(),
        at,
        total,
        ingredientId: item.matchedIngredientId || null,
        packs: qty,
        buyAmount: 0,
        unit: "",
        source: "receipt",
        receiptId: receipt.id,
        receiptItemId: item.id,
        rawName: item.rawName,
        qty,
        unitPrice,
        kind: item.kind
      });
      return;
    }

    entry.at = at;
    entry.total = total;
    entry.rawName = item.rawName;
    entry.qty = qty;
    entry.packs = qty;
    entry.unitPrice = unitPrice;
    entry.kind = item.kind;

    entry.ingredientId = item.matchedIngredientId || null;

    if (entry.ingredientId) {
      const ing = (state.ingredients || []).find((x) => x.id === entry.ingredientId) || null;
      if (ing) {
        entry.unit = ing.unit || "";
        const packAmt = Number(ing.amount) || 0;
        entry.buyAmount = packAmt > 0 ? packAmt * qty : 0;

        // Preis nur setzen, wenn bisher leer/0 (vorsichtig)
        const curPrice = Number(ing.price);
        if (!Number.isFinite(curPrice) || curPrice <= 0) {
          ing.price = Math.round(unitPrice * 100) / 100;
        }
      }
    } else {
      entry.unit = "";
      entry.buyAmount = 0;
    }
  }


  // --- Pantry aus Bon-Items (Receipt) ---
  function findPantryLotsForReceiptItem(state, receiptId, receiptItemId) {
    return (state.pantry || []).filter(
      (p) => p && p.source === "receipt" && p.receiptId === receiptId && p.receiptItemId === receiptItemId
    );
  }

  function calcExpiresAtISO(boughtAtISO, shelfLifeDays) {
    const days = Number(shelfLifeDays || 0);
    if (!Number.isFinite(days) || days <= 0) return null;
    const ms = new Date(boughtAtISO).getTime() + days * 24 * 60 * 60 * 1000;
    return new Date(ms).toISOString();
  }

  // Legt Pantry-Lots für einen Bon-Artikel an (idempotent).
  // Strategie: 1 Lot pro Packung (qty), damit Ablaufdaten sauber sind.
  function upsertPantryFromReceiptItem(state, receipt, item) {
    try {
      if (!receipt || !item || item.kind !== "item") return;
      const ingId = item.matchedIngredientId;
      if (!ingId) return;

      if (!Array.isArray(state.pantry)) state.pantry = [];

      // schon vorhanden? -> nichts tun
      const existingLots = findPantryLotsForReceiptItem(state, receipt.id, item.id);
      if (existingLots.length) return;

      const ing = (state.ingredients || []).find((x) => x && x.id === ingId) || null;
      if (!ing) return;

      const qty = Math.max(1, Math.round(Number(item.qty) || 1));
      const packAmt = Number(ing.amount) || 0;
      const unit = ing.unit || "";

      // Wenn Packungsmenge fehlt, lieber NICHT automatisch in Vorrat schreiben (sonst Müllwerte).
      if (!Number.isFinite(packAmt) || packAmt <= 0) return;

      const lineTotal = Number(item.lineTotal) || 0;
      const unitPrice = Number(item.unitPrice) || (lineTotal > 0 ? lineTotal / qty : Number(ing.price) || 0);

      const boughtAt = receipt.at || new Date().toISOString();
      const expiresAt = calcExpiresAtISO(boughtAt, ing.shelfLifeDays);

      for (let i = 0; i < qty; i++) {
        state.pantry.push({
          id: uid(),
          ingredientId: ing.id,
          amount: packAmt,
          unit,
          boughtAt,
          expiresAt,
          cost: Math.round((Number(unitPrice) || 0) * 100) / 100,
          source: "receipt",
          receiptId: receipt.id,
          receiptItemId: item.id,
          rawName: item.rawName,
          packIndex: i + 1,
          packs: qty
        });
      }
    } catch {
      // ignore
    }
  }

  window.receiptData = { receiptProgress, deleteReceiptAndRelated, upsertPurchaseLogFromReceiptItem, upsertPantryFromReceiptItem, calcExpiresAtISO };
})();
