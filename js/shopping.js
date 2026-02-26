/* js/shopping.js
   Einkaufsliste (packs-only) + Einkaufen-Modus + Abschluss + Undo
   + Scan (Barcode) im Einkaufsmodus
   + Gekauft-Status als Zähler (packs) statt bool

   Passt zu app.js: window.renderShoppingView(container, state, persist)
*/
(() => {
  const esc = (s) => (window.utils?.esc ? window.utils.esc(s) : String(s ?? ""));
  const uid = () => (window.utils?.uid ? window.utils.uid() : window.models.uid());
  const euro = (n) => (window.utils?.euro ? window.utils.euro(Number(n) || 0) : window.models.euro(Number(n) || 0));
  const clone = (obj) => (window.utils?.clone ? window.utils.clone(obj) : JSON.parse(JSON.stringify(obj)));

  // ── OFF helpers (js/shopping/openFoodFacts.js) ──
  const fetchOffSuggestion = (s, p, b) => window.openFoodFacts.fetchOffSuggestion(s, p, b);
  const offDebugHtml = (s) => window.openFoodFacts.offDebugHtml(s);

  // ── Receipt parsing (js/shopping/receiptParsing.js) ──
  const fmtDate = (iso) => window.receiptParsing.fmtDate(iso);
  const guessReceiptMeta = (text) => window.receiptParsing.guessReceiptMeta(text);
  const parseReceiptItemsFromText = (text) => window.receiptParsing.parseReceiptItemsFromText(text);
  const extractTextFromPdfFile = (file) => window.receiptParsing.extractTextFromPdfFile(file);
  const prefillReceiptTextFromFile = (el, f) => window.receiptParsing.prefillReceiptTextFromFile(el, f);

  // ── Receipt ↔ state (js/shopping/receiptData.js) ──
  const receiptProgress = (r) => window.receiptData.receiptProgress(r);
  const deleteReceiptAndRelated = (s, id) => window.receiptData.deleteReceiptAndRelated(s, id);
  const upsertPurchaseLogFromReceiptItem = (s, r, it) => window.receiptData.upsertPurchaseLogFromReceiptItem(s, r, it);
  const upsertPantryFromReceiptItem = (s, r, it) => window.receiptData.upsertPantryFromReceiptItem(s, r, it);


  // ── Receipt modals (js/shopping/receiptModals.js) ──
  const openReceiptsHub = (...args) => window.receiptModals.openReceiptsHub(...args);

  // ── Shopping scanner (js/shopping/shoppingScanner.js) ──
  const openShoppingScannerModal = (...args) => window.shoppingScanner.openShoppingScannerModal(...args);

  // ── Shopping core (js/shopping/shoppingCore.js) ──
  const ensureState = (s) => window.shoppingCore.ensureState(s);
  const getIng = (s, id) => window.shoppingCore.getIng(s, id);
  const getBoughtCount = (s, id) => window.shoppingCore.getBoughtCount(s, id);
  const setBoughtCount = (s, id, n) => window.shoppingCore.setBoughtCount(s, id, n);
  const incBought = (s, id, d) => window.shoppingCore.incBought(s, id, d);
  const decBought = (s, id, d) => window.shoppingCore.decBought(s, id, d);
  const normalizeShopping = (s) => window.shoppingCore.normalizeShopping(s);
  const groupShopping = (s) => window.shoppingCore.groupShopping(s);
  const calcExpiresAt = (at, days) => window.shoppingCore.calcExpiresAt(at, days);
  const startShopping = (s) => window.shoppingCore.startShopping(s);
  const cancelShopping = (s) => window.shoppingCore.cancelShopping(s);
  const changePacks = (s, id, delta) => window.shoppingCore.changePacks(s, id, delta);
  const removeAll = (s, id) => window.shoppingCore.removeAll(s, id);
  const checkout = (s) => window.shoppingCore.checkout(s);
  const setUndo = (snapshot, msg) => window.shoppingCore.setUndo(snapshot, msg);
  const clearUndo = () => window.shoppingCore.clearUndo();
  const undo = (s, p, c) => window.shoppingCore.undo(s, p, c);

  // ---- render ----
  function renderShoppingView(container, state, persist) {
    ensureState(state);

    // bind once
    if (!container.__shoppingBound) {
      container.__shoppingBound = true;

      container.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-action]");
        if (!btn) return;

        const action = btn.getAttribute("data-action");
        const ingredientId = btn.getAttribute("data-ingredient-id");
        const recipeId = btn.getAttribute("data-recipe-id");

        // Snapshot for destructive actions (packs change that removes / removeAll)
        const takeSnapshot = () =>
          ({
            shopping: clone(state.shopping),
            pantry: clone(state.pantry),
            purchaseLog: clone(state.purchaseLog),
            shoppingSession: clone(state.shoppingSession)
          });

        if (action === "planRemove" && recipeId) {
          window.recipesLogic?.removePlannedRecipe?.(state, recipeId);
          window.recipesLogic?.reconcileShoppingWithPlan?.(state, { mode: "raise" }); // nicht reduzieren
          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "receipts") {
          openReceiptsHub(state, persist);
          return;
        }

        if (action === "planClean") {
          const ok = window.confirm(
            "Bereinigen reduziert Plan-Zutaten auf den Bedarf der geplanten Rezepte.\n\nManuelle Extras können dabei verschwinden.\n\nFortfahren?"
          );
          if (!ok) return;

          window.recipesLogic?.reconcileShoppingWithPlan?.(state, { mode: "exact" });
          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "start") {
          startShopping(state);
          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "cancel") {
          cancelShopping(state);
          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "scan") {
          openShoppingScannerModal(container, state, persist);
          return;
        }

        if (action === "buyInc" && ingredientId) {
          incBought(state, ingredientId, 1);
          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "buyDec" && ingredientId) {
          decBought(state, ingredientId, 1);
          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "inc" && ingredientId) {
          changePacks(state, ingredientId, +1);
          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "dec" && ingredientId) {
          const snap = takeSnapshot();
          const before = state.shopping.find((x) => x.ingredientId === ingredientId);
          const beforePacks = before ? Math.max(1, Math.round(Number(before.packs) || 1)) : 0;

          changePacks(state, ingredientId, -1);

          // Wenn der Eintrag dadurch komplett verschwunden ist -> Undo anbieten
          const stillThere = state.shopping.some((x) => x.ingredientId === ingredientId);
          if (!stillThere && beforePacks === 1) {
            setUndo(snap, "Eintrag entfernt.");
          }

          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "remove" && ingredientId) {
          const snap = takeSnapshot();
          removeAll(state, ingredientId);
          setUndo(snap, "Entfernt.");
          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "checkout") {
          const res = checkout(state);
          if (!res.ok) return;

          setUndo(res.snapshot, "Abgeschlossen. In den Vorrat übertragen.");
          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "undo") {
          undo(state, persist, container);
          return;
        }

        if (action === "toastClose") {
          clearUndo();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "textToggle") {
          const itemId = btn.getAttribute("data-item-id") || "";
          const it = (state.shopping || []).find(x => x.id === itemId);
          if (it) it.done = !it.done;
          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "textRemove") {
          const itemId = btn.getAttribute("data-item-id") || "";
          state.shopping = (state.shopping || []).filter(x => x.id !== itemId);
          persist();
          renderShoppingView(container, state, persist);
          return;
        }
      });
    }

    const groups = groupShopping(state);
    const active = !!state.shoppingSession.active;

    const boughtLines = groups.filter((g) => getBoughtCount(state, g.ingredientId) > 0).length;

    const boughtTotal = groups.reduce((sum, g) => {
      const bought = Math.min(g.packs, getBoughtCount(state, g.ingredientId));
      if (!bought) return sum;
      const ing = getIng(state, g.ingredientId);
      return sum + (Number(ing?.price) || 0) * bought;
    }, 0);

    const allTotal = groups.reduce((sum, g) => {
      const ing = getIng(state, g.ingredientId);
      return sum + (Number(ing?.price) || 0) * g.packs;
    }, 0);

    const rows = groups
      .map((g) => {
        const ing = getIng(state, g.ingredientId);
        const name = ing?.name || "(Unbekannte Zutat)";
        const packLabel = ing ? `${ing.amount ?? ""}${ing.unit ? " " + ing.unit : ""}`.trim() : "";

        const bought = Math.min(g.packs, getBoughtCount(state, g.ingredientId));
        const done = bought >= g.packs;

        return `
          <div style="display:flex; justify-content:space-between; gap:12px; align-items:center; padding:10px 0; border-top:1px solid var(--border);">
            <div style="min-width:0; flex:1;">
              <div style="font-weight:650; line-height:1.2;">${esc(name)}</div>
              <div class="small" style="margin-top:4px; opacity:0.9;">
                ${g.packs}× ${esc(packLabel)} · <b>${esc(euro((Number(ing?.price) || 0) * g.packs))}</b>
                ${g.planMin && g.planMin > 0 ? ` · <span class=\"small\" style=\"opacity:0.85;\">Plan: mind. <b>${g.planMin}×</b></span>` : ""}
              </div>
              ${
                active
                  ? `<div class="small" style="margin-top:6px;">Gekauft: <b>${bought}/${g.packs}</b> ${done ? "✓" : ""}</div>`
                  : ``
              }
            </div>

            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end;">
              ${
                active
                  ? `
                    <button data-action="buyDec" data-ingredient-id="${esc(g.ingredientId)}">−</button>
                    <button class="success" data-action="buyInc" data-ingredient-id="${esc(g.ingredientId)}">+</button>
                  `
                  : `
                    <button data-action="dec" data-ingredient-id="${esc(g.ingredientId)}">−</button>
                    <button data-action="inc" data-ingredient-id="${esc(g.ingredientId)}">+</button>
                    <button class="danger" data-action="remove" data-ingredient-id="${esc(g.ingredientId)}">Entfernen</button>
                  `
              }
            </div>
          </div>
        `;
      })
      .join("");

    const headerActions = active
      ? `
        <span class="small" style="border:1px solid var(--border); padding:4px 10px; border-radius:999px;">Im Einkauf</span>
        <button class="info" data-action="scan">Scannen</button>
        <button data-action="cancel">Abbrechen</button>
        <button class="success" data-action="checkout" ${boughtLines === 0 ? "disabled" : ""}>
          Abschließen / Bezahlt (${boughtLines}) · ${esc(euro(boughtTotal))}
        </button>
      `
      : `
        <button class="info" data-action="start" ${groups.length === 0 ? "disabled" : ""}>Einkaufen starten</button>
        <button class="info" data-action="receipts">Bon</button>
        <span class="small" style="opacity:0.9;">Gesamt: <b>${esc(euro(allTotal))}</b></span>
      `;

    const toast = window.shoppingCore.hasUndo?.()
      ? `
        <div class="toast-float" style="position:fixed; left:50%; bottom:18px; transform:translateX(-50%); z-index:9999;">
          <div class="toast-inner" style="display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--border); border-radius:14px; background:rgba(15,17,22,0.95); box-shadow:0 14px 40px rgba(0,0,0,0.55);">
            <div class="small" style="opacity:0.95;">${esc(window.shoppingCore.getUndoMessage?.() || "Aktion durchgeführt.")}</div>
            <button data-action="undo">Rückgängig</button>
            <button data-action="toastClose" title="Schließen" style="min-width:40px;">✕</button>
          </div>
        </div>
      `
      : "";

    const planned = Array.isArray(state.plannedRecipes) ? state.plannedRecipes : [];
    const recipes = Array.isArray(state.recipes) ? state.recipes : [];

    const planSummary = window.recipesLogic?.computePlanSummary?.(state) || { byIngredient: new Map() };
    const neededCount = Array.from(planSummary.byIngredient.values()).filter((x) => (Number(x.requiredPacks) || 0) > 0).length;

    const plannedChips = planned
      .slice()
      .sort((a, b) => String(a.addedAt || "").localeCompare(String(b.addedAt || "")))
      .map((p) => {
        const r = recipes.find((x) => String(x.id) === String(p.recipeId));
        const name = r?.name || "(Rezept gelöscht)";
        const portions = Math.max(1, Math.round(Number(p.portionsWanted) || 1));
        return `
          <span class="chip">
            <span style="font-weight:700; max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(name)}</span>
            <span class="muted2">${portions} Port.</span>
            <button class="danger chip-x" data-action="planRemove" data-recipe-id="${esc(String(p.recipeId))}" title="Entfernen">✕</button>
          </span>
        `;
      })
      .join("");

    const plannedSection = `
      <div style="margin-top:12px; padding:10px; border:1px dashed var(--border); border-radius:14px;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
          <div style="min-width:0; flex:1;">
            <div style="font-weight:750;">Geplante Rezepte</div>
            <div class="small" style="opacity:0.88; margin-top:4px;">
              ${planned.length ? `Plan beeinflusst <b>${neededCount}</b> Zutat(en).` : "Noch keine Rezepte geplant."}
            </div>
          </div>
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end;">
            <button class="warn" data-action="planClean" ${planned.length ? "" : "disabled"}>Bereinigen</button>
          </div>
        </div>

        <div class="chips" style="margin-top:10px;">
          ${planned.length ? plannedChips : ""}
        </div>
      </div>
    `;

    const textItems = (state.shopping || []).filter(it => it?.type === "text");
    const textRows = textItems.map(it => `
      <div style="display:flex; gap:10px; align-items:center; padding:8px 0; border-top:1px solid var(--border);">
        <button data-action="textToggle" data-item-id="${esc(it.id)}"
          style="min-width:36px; font-size:18px; line-height:1;"
          title="${it.done ? "Als nicht erledigt markieren" : "Abhaken"}">${it.done ? "✓" : "○"}</button>
        <span style="flex:1; ${it.done ? "text-decoration:line-through; opacity:0.55;" : ""}">${esc(it.label)}</span>
        <button class="danger" data-action="textRemove" data-item-id="${esc(it.id)}">Entfernen</button>
      </div>
    `).join("");

    container.innerHTML = `
      <div class="card">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
          <h2 style="margin:0;">Einkaufsliste</h2>
          <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; justify-content:flex-end;">
            ${headerActions}
          </div>
        </div>

        ${plannedSection}

        <div style="margin-top:10px;">
          ${groups.length ? rows : `<div class="small" style="padding:10px 0;">Noch nichts auf der Einkaufsliste.</div>`}
        </div>

        ${textItems.length ? `
          <div style="margin-top:12px;">
            <div class="small muted2" style="margin-bottom:4px;">Generische Zutaten (Rezept-Notizen)</div>
            ${textRows}
          </div>
        ` : ""}
      </div>
      ${toast}
    `;
  }

  window.renderShoppingView = renderShoppingView;
})();
