/* js/shopping/shoppingCore.js
   Shopping state helpers, normalization, shopping actions, undo.
   Extracted from js/shopping.js (v0.6.10).
   Exposes: window.shoppingCore
*/
(() => {
  const uid = () => (window.utils?.uid ? window.utils.uid() : window.models.uid());
  const clone = (obj) => (window.utils?.clone ? window.utils.clone(obj) : JSON.parse(JSON.stringify(obj)));
  const cleanBarcode = (raw) => window.openFoodFacts.cleanBarcode(raw);

  // ---- undo (in-memory) ----
  let undoSnapshot = null;
  let undoTimer = null;
  let undoMessage = "";

  function setUndo(snapshot, message) {
    undoSnapshot = snapshot;
    undoMessage = message || "Rückgängig möglich.";

    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = setTimeout(() => {
      undoSnapshot = null;
      undoMessage = "";
      // UI wird bei nächstem Render aktualisiert
    }, 10_000);
  }

  function clearUndo() {
    undoSnapshot = null;
    undoMessage = "";
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = null;
  }

  // ---- state helpers ----
  function ensureState(state) {
    if (!Array.isArray(state.ingredients)) state.ingredients = [];
    if (!Array.isArray(state.shopping)) state.shopping = [];
    if (!Array.isArray(state.pantry)) state.pantry = [];
    if (!Array.isArray(state.purchaseLog)) state.purchaseLog = [];
    if (!Array.isArray(state.receipts)) state.receipts = [];
    if (!Array.isArray(state.recipes)) state.recipes = [];
    if (!Array.isArray(state.plannedRecipes)) state.plannedRecipes = [];

    if (!state.shoppingSession || typeof state.shoppingSession !== "object") {
      state.shoppingSession = { active: false, checked: {}, startedAt: null };
    }
    if (!state.shoppingSession.checked || typeof state.shoppingSession.checked !== "object") {
      state.shoppingSession.checked = {};
    }

    normalizeShopping(state);
  }

  function getIng(state, ingredientId) {
    return state.ingredients.find((i) => i.id === ingredientId) || null;
  }

  function findIngredientByBarcode(state, code) {
    const c = cleanBarcode(code);
    if (!c) return null;
    return (
      (state.ingredients || []).find((x) => cleanBarcode(x?.barcode) === c) || null
    );
  }

  function getRequiredPacks(state, ingredientId) {
    const it = (state.shopping || []).find((x) => String(x.ingredientId) === String(ingredientId));
    return it ? Math.max(1, Math.round(Number(it.packs) || 1)) : 0;
  }

  function getBoughtCount(state, ingredientId) {
    const v = state.shoppingSession?.checked?.[ingredientId];
    if (v === true) return Math.max(1, getRequiredPacks(state, ingredientId) || 1);
    if (v === false || v == null) return 0;
    const n = Math.floor(Number(v) || 0);
    return Math.max(0, n);
  }

  function setBoughtCount(state, ingredientId, next) {
    const max = getRequiredPacks(state, ingredientId) || 0;
    const n = Math.max(0, Math.floor(Number(next) || 0));
    const clamped = max ? Math.min(max, n) : n;
    if (!state.shoppingSession || typeof state.shoppingSession !== "object") {
      state.shoppingSession = { active: false, checked: {}, startedAt: null };
    }
    if (!state.shoppingSession.checked || typeof state.shoppingSession.checked !== "object") {
      state.shoppingSession.checked = {};
    }
    if (clamped <= 0) {
      delete state.shoppingSession.checked[ingredientId];
      return 0;
    }
    state.shoppingSession.checked[ingredientId] = clamped;
    return clamped;
  }

  function incBought(state, ingredientId, delta = 1) {
    const cur = getBoughtCount(state, ingredientId);
    return setBoughtCount(state, ingredientId, cur + delta);
  }

  function decBought(state, ingredientId, delta = 1) {
    const cur = getBoughtCount(state, ingredientId);
    return setBoughtCount(state, ingredientId, cur - delta);
  }

  function normalizeShopping(state) {
    // packs-only + duplicates mergen (planMin bleibt erhalten; max)
    const merged = new Map();

    // Text-Einträge (Generische Zutaten ohne konkretes Produkt) separat aufheben
    const _textItems = (state.shopping || []).filter(it => it?.type === "text");

    for (const it of state.shopping || []) {
      if (!it || typeof it !== "object") continue;
      if (!it.ingredientId) continue;

      const ing = getIng(state, it.ingredientId);

      let packs = Number(it.packs);
      if (!Number.isFinite(packs) || packs <= 0) {
        // legacy qty/count
        const q = Number(it.qty ?? it.count);
        if (Number.isFinite(q) && q > 0) packs = q;
      }
      if (!Number.isFinite(packs) || packs <= 0) {
        // legacy amount -> packs
        const amt = Number(it.amount);
        const packSize = Number(ing?.amount || 0);
        if (Number.isFinite(amt) && amt > 0 && Number.isFinite(packSize) && packSize > 0) {
          packs = Math.max(1, Math.ceil(amt / packSize));
        }
      }
      if (!Number.isFinite(packs) || packs <= 0) packs = 1;

      let planMin = Number(it.planMin);
      if (!Number.isFinite(planMin) || planMin < 0) planMin = undefined;
      else planMin = Math.round(planMin);

      const key = String(it.ingredientId);
      const cur = merged.get(key);
      if (!cur) {
        const row = { id: it.id || uid(), ingredientId: key, packs: Math.round(packs) };
        if (typeof planMin !== "undefined") row.planMin = planMin;
        merged.set(key, row);
      } else {
        cur.packs += Math.round(packs);
        if (typeof planMin !== "undefined") {
          cur.planMin = Math.max(Number(cur.planMin) || 0, planMin);
        }
      }
    }

    state.shopping = [...Array.from(merged.values()), ..._textItems];

    // Wenn etwas nicht mehr auf der Liste steht, aus checked entfernen
    const existingIds = new Set(
      state.shopping.filter(x => !x.type).map((x) => String(x.ingredientId))
    );
    for (const k of Object.keys(state.shoppingSession.checked || {})) {
      if (!existingIds.has(String(k))) {
        delete state.shoppingSession.checked[k];
        continue;
      }

      // checked kann legacy bool sein -> in Zahl wandeln
      const req = getRequiredPacks(state, String(k));
      const v = state.shoppingSession.checked[k];
      if (v === true) state.shoppingSession.checked[k] = req || 1;
      else if (v === false || v == null) delete state.shoppingSession.checked[k];
      else {
        const n = Math.max(0, Math.floor(Number(v) || 0));
        if (n <= 0) delete state.shoppingSession.checked[k];
        else state.shoppingSession.checked[k] = req ? Math.min(req, n) : n;
      }
    }

    // Wenn Packs reduziert wurden, gekauft-Zähler clampen
    for (const it of state.shopping) {
      const id = String(it.ingredientId);
      const req = Math.max(1, Math.round(Number(it.packs) || 1));
      const curBought = getBoughtCount(state, id);
      if (curBought > req) setBoughtCount(state, id, req);
    }
  }

  function groupShopping(state) {
    const groups = (state.shopping || [])
      .map((it) => ({
        ingredientId: String(it.ingredientId),
        packs: Math.max(1, Math.round(Number(it.packs) || 1)),
        planMin: Math.max(0, Math.round(Number(it.planMin) || 0))
      }))
      .sort((a, b) => {
        const ia = getIng(state, a.ingredientId)?.name || "";
        const ib = getIng(state, b.ingredientId)?.name || "";
        return ia.localeCompare(ib, "de");
      });

    return groups;
  }

  function calcExpiresAt(boughtAtISO, shelfLifeDays) {
    const days = Number(shelfLifeDays || 0);
    if (!Number.isFinite(days) || days <= 0) return null;
    const ms = new Date(boughtAtISO).getTime() + days * 24 * 60 * 60 * 1000;
    return new Date(ms).toISOString();
  }

  function startShopping(state) {
    state.shoppingSession.active = true;
    state.shoppingSession.startedAt = state.shoppingSession.startedAt || new Date().toISOString();
  }

  function cancelShopping(state) {
    state.shoppingSession.active = false;
    state.shoppingSession.checked = {};
    state.shoppingSession.startedAt = null;
  }

  function changePacks(state, ingredientId, delta) {
    const it = state.shopping.find((x) => x.ingredientId === ingredientId);

    if (!it) {
      if (delta > 0) state.shopping.push({ id: uid(), ingredientId, packs: 1 });
      return;
    }

    const before = Math.max(1, Math.round(Number(it.packs) || 1));
    const after = before + delta;

    if (after <= 0) {
      state.shopping = state.shopping.filter((x) => x.ingredientId !== ingredientId);
      delete state.shoppingSession.checked[ingredientId];
      return;
    }

    it.packs = after;

    // clamp bought count
    const curBought = getBoughtCount(state, ingredientId);
    if (curBought > after) setBoughtCount(state, ingredientId, after);
  }

  function removeAll(state, ingredientId) {
    state.shopping = state.shopping.filter((x) => x.ingredientId !== ingredientId);
    delete state.shoppingSession.checked[ingredientId];
  }

  function checkout(state) {
    const groups = groupShopping(state);
    const bought = groups
      .map((g) => ({
        ...g,
        boughtPacks: Math.min(g.packs, getBoughtCount(state, g.ingredientId))
      }))
      .filter((g) => g.boughtPacks > 0);

    if (!bought.length) return { ok: false, reason: "none_checked" };

    const snapshot = {
      shopping: clone(state.shopping),
      pantry: clone(state.pantry),
      purchaseLog: clone(state.purchaseLog),
      shoppingSession: clone(state.shoppingSession)
    };

    const nowISO = new Date().toISOString();

    for (const g of bought) {
      const ing = getIng(state, g.ingredientId);
      if (!ing) continue;

      const packs = g.boughtPacks;
      const buyAmount = (Number(ing.amount) || 0) * packs;
      const total = (Number(ing.price) || 0) * packs;

      state.purchaseLog.push({
        id: uid(),
        at: nowISO,
        total,
        ingredientId: ing.id,
        packs,
        buyAmount,
        unit: ing.unit
      });

      state.pantry.push({
        id: uid(),
        ingredientId: ing.id,
        amount: buyAmount,
        unit: ing.unit,
        boughtAt: nowISO,
        expiresAt: calcExpiresAt(nowISO, ing.shelfLifeDays),
        cost: total
      });

      // Shopping packs reduzieren (gekauft) – Rest bleibt
      const row = state.shopping.find((x) => String(x.ingredientId) === String(g.ingredientId));
      if (row) {
        row.packs = Math.max(1, Math.round(Number(row.packs) || 1)) - packs;
        if (row.packs <= 0) {
          state.shopping = state.shopping.filter((x) => String(x.ingredientId) !== String(g.ingredientId));
        } else if (typeof row.planMin !== "undefined") {
          row.planMin = Math.max(0, Math.round(Number(row.planMin) || 0) - packs);
        }
      }

      delete state.shoppingSession.checked[g.ingredientId];
    }

    // Wenn die Liste jetzt leer ist, Einkaufsmodus beenden
    state.shoppingSession.active = false;
    state.shoppingSession.startedAt = null;

    // Pantry hat sich geändert -> Plan ggf. neu anheben (niemals reduzieren)
    window.recipesLogic?.reconcileShoppingWithPlan?.(state, { mode: "raise" });

    return { ok: true, snapshot };
  }

  function undo(state, persist, container) {
    if (!undoSnapshot) return;
    state.shopping = undoSnapshot.shopping;
    state.pantry = undoSnapshot.pantry;
    state.purchaseLog = undoSnapshot.purchaseLog;
    state.shoppingSession = undoSnapshot.shoppingSession;
    clearUndo();
    persist();
    window.renderShoppingView?.(container, state, persist);
  }

  window.shoppingCore = {
    ensureState,
    getIng,
    findIngredientByBarcode,
    getRequiredPacks,
    getBoughtCount,
    setBoughtCount,
    incBought,
    decBought,
    normalizeShopping,
    groupShopping,
    calcExpiresAt,
    startShopping,
    cancelShopping,
    changePacks,
    removeAll,
    checkout,
    setUndo,
    clearUndo,
    undo,
    hasUndo: () => !!undoSnapshot,
    getUndoMessage: () => undoMessage
  };
})();
