(() => {
  const toNum = (v) => window.models.toNumber(v);
  const uid = () => window.models.uid();

  function getIng(state, id) {
    return (state.ingredients || []).find((x) => x.id === id) || null;
  }

  function unitPriceOf(ing) {
    const up = window.models.unitPrice(Number(ing.price), Number(ing.amount));
    return up === null ? 0 : up;
  }

  function isExpiredPantryItem(p) {
    if (!p?.expiresAt) return false;
    return new Date(p.expiresAt).getTime() < Date.now();
  }

  function pantryAvailable(state, ingredientId) {
    if (!Array.isArray(state.pantry)) return 0;
    return state.pantry
      .filter((p) => p.ingredientId === ingredientId && !isExpiredPantryItem(p))
      .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  }

  // Plan: Aus benötigter Menge -> Packs + Kaufmenge
  function purchasePlan(ing, neededAmount) {
    const packSize = Number(ing?.amount) || 0;
    const need = Number(neededAmount) || 0;

    if (!Number.isFinite(packSize) || packSize <= 0 || !Number.isFinite(need) || need <= 0) {
      return { packs: 0, buyAmount: 0, packSize };
    }

    const packs = Math.max(1, Math.ceil(need / packSize));
    return { packs, buyAmount: packs * packSize, packSize };
  }

  function epsilonForUnit(unit) {
    return unit === "Stück" ? 0.01 : 0.5;
  }

  // Verbraucht aus pantry (FEFO, skaliert cost proportional)
  function consumeFromPantry(state, ingredientId, amount, unit) {
    if (!Array.isArray(state.pantry)) state.pantry = [];
    let remaining = Number(amount) || 0;
    if (remaining <= 0) return 0;

    const items = state.pantry
      .filter((p) => p.ingredientId === ingredientId && !isExpiredPantryItem(p))
      .slice()
      .sort((a, b) => {
        const ae = a.expiresAt ? new Date(a.expiresAt).getTime() : Infinity;
        const be = b.expiresAt ? new Date(b.expiresAt).getTime() : Infinity;
        if (ae !== be) return ae - be;
        return new Date(a.boughtAt || 0).getTime() - new Date(b.boughtAt || 0).getTime();
      });

    const eps = epsilonForUnit(unit);

    for (const it of items) {
      if (remaining <= eps) break;

      const oldAmt = Number(it.amount) || 0;
      if (oldAmt <= eps) continue;

      const take = Math.min(oldAmt, remaining);
      const newAmt = oldAmt - take;

      // cost proportional anpassen
      const oldCost = Number(it.cost) || 0;
      const ratio = oldAmt > 0 ? newAmt / oldAmt : 0;
      it.cost = Math.max(0, oldCost * ratio);

      it.amount = Number(newAmt.toFixed(4));
      remaining -= take;

      if (it.amount <= eps) {
        state.pantry = state.pantry.filter((p) => p.id !== it.id);
      }
    }

    return remaining;
  }

  function recipeCost(state, recipe) {
    let total = 0;
    for (const it of recipe.items || []) {
      const ing = getIng(state, it.ingredientId);
      if (!ing) continue;
      total += unitPriceOf(ing) * (Number(it.amount) || 0);
    }
    return total;
  }

  // Packs-only Shopping:
  // - Wenn unit angegeben ist -> "value" ist benötigte Menge und wird in Packs umgerechnet.
  // - Wenn unit NICHT angegeben ist -> "value" wird als Packs interpretiert.
  function addNeededToShopping(state, ingredientId, value, unit = null) {
    if (!Array.isArray(state.shopping)) state.shopping = [];

    const ing = getIng(state, ingredientId);
    if (!ing) return null;

    let packs = 0;

    if (typeof unit === "string" && unit.trim()) {
      const plan = purchasePlan(ing, value);
      packs = plan.packs;
    } else {
      packs = Math.round(Number(value) || 0);
    }

    if (!Number.isFinite(packs) || packs <= 0) return null;

    const existing = state.shopping.find((s) => s?.ingredientId === ingredientId);
    if (existing) {
      existing.packs = Math.max(1, Math.round((Number(existing.packs) || 0) + packs));
      // planMin unverändert lassen (manuell addiert)
    } else {
      state.shopping.push({ id: uid(), ingredientId, packs });
    }

    return { packs };
  }

  // -----------------------------
  // plannedRecipes / globaler Plan
  // -----------------------------
  function ensurePlannedRecipes(state) {
    if (!Array.isArray(state.plannedRecipes)) state.plannedRecipes = [];
    state.plannedRecipes = state.plannedRecipes
      .filter((x) => x && typeof x === "object" && x.recipeId)
      .map((x) => ({
        recipeId: String(x.recipeId),
        portionsWanted: Math.max(1, Math.round(Number(x.portionsWanted) || 1)),
        addedAt: x.addedAt ? String(x.addedAt) : new Date().toISOString()
      }));
  }

  function basePortionsOf(recipe) {
    const p = Math.round(Number(recipe?.portions) || 1);
    return p > 0 ? p : 1;
  }

  function needsFromPlannedRecipes(state, plannedRecipes) {
    const plan = Array.isArray(plannedRecipes) ? plannedRecipes : [];
    const recipes = Array.isArray(state.recipes) ? state.recipes : [];

    const totals = new Map(); // ingredientId -> amount

    for (const pr of plan) {
      const recipeId = pr?.recipeId ? String(pr.recipeId) : "";
      if (!recipeId) continue;

      const r = recipes.find((x) => x.id === recipeId);
      if (!r) continue;

      const base = basePortionsOf(r);
      const desired = Math.max(1, Math.round(Number(pr.portionsWanted) || base));
      const mult = base > 0 ? desired / base : 1;

      for (const it of r.items || []) {
        const ingId = it?.ingredientId ? String(it.ingredientId) : "";
        if (!ingId) continue;
        const amt = (Number(it.amount) || 0) * mult;
        if (!Number.isFinite(amt) || amt <= 0) continue;
        totals.set(ingId, (totals.get(ingId) || 0) + amt);
      }
    }

    return totals;
  }

  /**
   * computePlanSummary
   * - berücksichtigt: plannedRecipes + pantry
   * - Ergebnis: Map ingredientId -> { need, have, missing, requiredPacks, packSize }
   */
  function computePlanSummary(state, plannedRecipesOverride = null) {
    const plan = plannedRecipesOverride ? plannedRecipesOverride : state.plannedRecipes;

    const totals = needsFromPlannedRecipes(state, plan);
    const byIngredient = new Map();

    for (const [ingredientId, need] of totals.entries()) {
      const ing = getIng(state, ingredientId);
      if (!ing) continue;

      const have = pantryAvailable(state, ingredientId);
      const missing = Math.max(0, (Number(need) || 0) - (Number(have) || 0));
      const pp = missing > 0 ? purchasePlan(ing, missing) : { packs: 0, buyAmount: 0, packSize: Number(ing.amount) || 0 };
      const requiredPacks = Math.max(0, Math.round(Number(pp.packs) || 0));

      byIngredient.set(ingredientId, {
        ingredientId,
        ing,
        need: Number(need) || 0,
        have,
        missing,
        requiredPacks,
        packSize: Number(pp.packSize) || Number(ing.amount) || 0
      });
    }

    return { byIngredient, totals };
  }

  /**
   * reconcileShoppingWithPlan
   * mode:
   *  - "raise" (default): shopping.packs wird nur auf mind. requiredPacks angehoben (niemals reduziert)
   *  - "exact": setzt Plan-Zutaten exakt auf requiredPacks + entfernt Plan-Zutaten, die nicht mehr benötigt werden
   *
   * Technisch: wir markieren Shopping-Einträge mit `planMin`.
   */
  function reconcileShoppingWithPlan(state, { mode = "raise" } = {}) {
    ensurePlannedRecipes(state);
    if (!Array.isArray(state.shopping)) state.shopping = [];

    const { byIngredient } = computePlanSummary(state);

    // required packs (nur >0)
    const required = new Map();
    for (const [ingredientId, row] of byIngredient.entries()) {
      const rp = Math.max(0, Math.round(Number(row.requiredPacks) || 0));
      if (rp > 0) required.set(ingredientId, rp);
    }

    // Index shopping
    const idx = new Map();
    for (const it of state.shopping) {
      if (!it || typeof it !== "object" || !it.ingredientId) continue;
      idx.set(String(it.ingredientId), it);
    }

    // 1) required -> in shopping setzen
    for (const [ingredientId, rp] of required.entries()) {
      const it = idx.get(ingredientId);
      if (!it) {
        const created = { id: uid(), ingredientId, packs: rp, planMin: rp };
        state.shopping.push(created);
        idx.set(ingredientId, created);
      } else {
        const cur = Math.max(1, Math.round(Number(it.packs) || 1));
        it.planMin = rp;
        it.packs = mode === "exact" ? rp : Math.max(cur, rp);
      }
    }

    // 2) alle bisherigen Plan-Zutaten, die nicht mehr required sind
    if (mode === "exact") {
      state.shopping = (state.shopping || []).filter((it) => {
        if (!it || typeof it !== "object" || !it.ingredientId) return false;
        const id = String(it.ingredientId);
        if (typeof it.planMin === "undefined") return true; // manuell
        const rp = required.get(id) || 0;
        if (rp <= 0) return false; // Plan-Zutat entfernen
        it.planMin = rp;
        it.packs = rp;
        return true;
      });
    } else {
      for (const it of state.shopping) {
        if (!it || typeof it !== "object" || !it.ingredientId) continue;
        const id = String(it.ingredientId);
        if (typeof it.planMin === "undefined") continue;
        if (!required.has(id)) it.planMin = 0; // bleibt stehen, aber ist nicht mehr erforderlich
      }
    }

    return { required };
  }

  function removePlannedRecipe(state, recipeId) {
    ensurePlannedRecipes(state);
    const id = String(recipeId || "");
    if (!id) return;
    state.plannedRecipes = (state.plannedRecipes || []).filter((x) => String(x.recipeId) !== id);
  }

  function upsertPlannedRecipe(state, recipeId, portionsWanted) {
    ensurePlannedRecipes(state);
    const id = String(recipeId || "");
    if (!id) return;
    const portions = Math.max(1, Math.round(Number(portionsWanted) || 1));
    const existing = (state.plannedRecipes || []).find((x) => String(x.recipeId) === id);
    if (existing) {
      existing.portionsWanted = portions;
      existing.addedAt = new Date().toISOString();
    } else {
      state.plannedRecipes.push({ recipeId: id, portionsWanted: portions, addedAt: new Date().toISOString() });
    }
  }

  window.recipesLogic = {
    toNum,
    getIng,
    unitPriceOf,
    isExpiredPantryItem,
    pantryAvailable,
    purchasePlan,
    epsilonForUnit,
    consumeFromPantry,
    recipeCost,
    addNeededToShopping,

    // plannedRecipes
    ensurePlannedRecipes,
    computePlanSummary,
    reconcileShoppingWithPlan,
    removePlannedRecipe,
    upsertPlannedRecipe
  };
})();
