/* js/shopping/shoppingView.js
   Shopping list view + event handler (Einkaufsliste).
   Extracted from js/shopping.js (v0.6.11).
   Exposes: window.shoppingView = { renderShoppingView }
            window.renderShoppingView (compat alias used by app.js)
*/
(() => {
  const esc = (s) => (window.utils?.esc ? window.utils.esc(s) : String(s ?? ""));
  const euro = (n) => (window.utils?.euro ? window.utils.euro(Number(n) || 0) : window.models.euro(Number(n) || 0));
  const clone = (obj) => (window.utils?.clone ? window.utils.clone(obj) : JSON.parse(JSON.stringify(obj)));

  // ---- render ----
  function renderShoppingView(container, state, persist) {
    window.shoppingCore.ensureState(state);

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
          window.receiptModals.openReceiptsHub(state, persist);
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
          window.shoppingCore.startShopping(state);
          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "cancel") {
          window.shoppingCore.cancelShopping(state);
          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "scan") {
          window.shoppingScanner.openShoppingScannerModal(container, state, persist);
          return;
        }

        if (action === "buyInc" && ingredientId) {
          window.shoppingCore.incBought(state, ingredientId, 1);
          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "buyDec" && ingredientId) {
          window.shoppingCore.decBought(state, ingredientId, 1);
          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "inc" && ingredientId) {
          window.shoppingCore.changePacks(state, ingredientId, +1);
          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "dec" && ingredientId) {
          const snap = takeSnapshot();
          const before = state.shopping.find((x) => x.ingredientId === ingredientId);
          const beforePacks = before ? Math.max(1, Math.round(Number(before.packs) || 1)) : 0;

          window.shoppingCore.changePacks(state, ingredientId, -1);

          // Wenn der Eintrag dadurch komplett verschwunden ist -> Undo anbieten
          const stillThere = state.shopping.some((x) => x.ingredientId === ingredientId);
          if (!stillThere && beforePacks === 1) {
            window.shoppingCore.setUndo(snap, "Eintrag entfernt.");
          }

          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "remove" && ingredientId) {
          const snap = takeSnapshot();
          window.shoppingCore.removeAll(state, ingredientId);
          window.shoppingCore.setUndo(snap, "Entfernt.");
          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "checkout") {
          const res = window.shoppingCore.checkout(state);
          if (!res.ok) return;

          window.shoppingCore.setUndo(res.snapshot, "Abgeschlossen. In den Vorrat übertragen.");
          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "undo") {
          window.shoppingCore.undo(state, persist, container);
          return;
        }

        if (action === "toastClose") {
          window.shoppingCore.clearUndo();
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

    const groups = window.shoppingCore.groupShopping(state);
    const active = !!state.shoppingSession.active;

    const boughtLines = groups.filter((g) => window.shoppingCore.getBoughtCount(state, g.ingredientId) > 0).length;

    const boughtTotal = groups.reduce((sum, g) => {
      const bought = Math.min(g.packs, window.shoppingCore.getBoughtCount(state, g.ingredientId));
      if (!bought) return sum;
      const ing = window.shoppingCore.getIng(state, g.ingredientId);
      return sum + (Number(ing?.price) || 0) * bought;
    }, 0);

    const allTotal = groups.reduce((sum, g) => {
      const ing = window.shoppingCore.getIng(state, g.ingredientId);
      return sum + (Number(ing?.price) || 0) * g.packs;
    }, 0);

    const rows = groups
      .map((g) => {
        const ing = window.shoppingCore.getIng(state, g.ingredientId);
        const name = ing?.name || "(Unbekannte Zutat)";
        const packLabel = ing ? `${ing.amount ?? ""}${ing.unit ? " " + ing.unit : ""}`.trim() : "";

        const bought = Math.min(g.packs, window.shoppingCore.getBoughtCount(state, g.ingredientId));
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

  window.shoppingView = { renderShoppingView };
  window.renderShoppingView = renderShoppingView;
})();
