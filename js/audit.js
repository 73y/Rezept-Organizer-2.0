(() => {
  // js/audit.js
  // Referenzintegrität + kleine Reparaturen (in-memory). Logs bleiben bewusst erhalten.

  function isObj(x) {
    return x && typeof x === "object";
  }

  function repairReferences(state, { strictLogs = false } = {}) {
    const report = {
      removed: {
        shopping: 0,
        pantry: 0,
        plannedRecipes: 0,
        recipeItems: 0,
        shoppingCheckedKeys: 0
      },
      warnings: []
    };

    if (!isObj(state)) return report;

    const ingredients = Array.isArray(state.ingredients) ? state.ingredients : [];
    const recipes = Array.isArray(state.recipes) ? state.recipes : [];

    const ingIds = new Set(ingredients.map((x) => x?.id).filter(Boolean));
    const recipeIds = new Set(recipes.map((x) => x?.id).filter(Boolean));

    // shopping
    if (!Array.isArray(state.shopping)) state.shopping = [];
    const beforeShopping = state.shopping.length;
    state.shopping = state.shopping.filter((x) => x && x.ingredientId && ingIds.has(x.ingredientId));
    report.removed.shopping += beforeShopping - state.shopping.length;

    // pantry
    if (!Array.isArray(state.pantry)) state.pantry = [];
    const beforePantry = state.pantry.length;
    state.pantry = state.pantry.filter((p) => p && p.ingredientId && ingIds.has(p.ingredientId));
    report.removed.pantry += beforePantry - state.pantry.length;

    // recipes.items
    for (const r of recipes) {
      if (!isObj(r)) continue;
      if (!Array.isArray(r.items)) r.items = [];
      const b = r.items.length;
      r.items = r.items.filter((it) => it && it.ingredientId && ingIds.has(it.ingredientId));
      report.removed.recipeItems += b - r.items.length;
    }

    // plannedRecipes
    if (!Array.isArray(state.plannedRecipes)) state.plannedRecipes = [];
    const beforePlanned = state.plannedRecipes.length;
    state.plannedRecipes = state.plannedRecipes.filter((x) => x && x.recipeId && recipeIds.has(x.recipeId));
    report.removed.plannedRecipes += beforePlanned - state.plannedRecipes.length;

    // shoppingSession.checked (keys = ingredientId)
    if (!isObj(state.shoppingSession)) state.shoppingSession = { active: false, checked: {}, startedAt: null };
    if (!isObj(state.shoppingSession.checked)) state.shoppingSession.checked = {};
    const checked = state.shoppingSession.checked;

    const shoppingIngIds = new Set(state.shopping.map((x) => x?.ingredientId).filter(Boolean));
    for (const k of Object.keys(checked)) {
      if (!shoppingIngIds.has(k)) {
        delete checked[k];
        report.removed.shoppingCheckedKeys++;
      }
    }

    // Logs: optional strict cleanup (default: behalten)
    if (strictLogs) {
      if (Array.isArray(state.purchaseLog)) {
        const b = state.purchaseLog.length;
        state.purchaseLog = state.purchaseLog.filter((e) => e && e.ingredientId && ingIds.has(e.ingredientId));
        if (b !== state.purchaseLog.length) report.warnings.push(`purchaseLog: ${b - state.purchaseLog.length} verwaiste Einträge entfernt.`);
      }
      if (Array.isArray(state.wasteLog)) {
        const b = state.wasteLog.length;
        state.wasteLog = state.wasteLog.filter((e) => e && e.ingredientId && ingIds.has(e.ingredientId));
        if (b !== state.wasteLog.length) report.warnings.push(`wasteLog: ${b - state.wasteLog.length} verwaiste Einträge entfernt.`);
      }
    }

    // Warnungen, falls Logs Ingredient-IDs nutzen, die nicht mehr existieren
    if (Array.isArray(state.purchaseLog)) {
      const orphan = state.purchaseLog.filter((e) => e?.ingredientId && !ingIds.has(e.ingredientId)).length;
      if (orphan) report.warnings.push(`purchaseLog enthält ${orphan} Einträge zu gelöschten Zutaten (wird weiter gezählt).`);
    }
    if (Array.isArray(state.wasteLog)) {
      const orphan = state.wasteLog.filter((e) => e?.ingredientId && !ingIds.has(e.ingredientId)).length;
      if (orphan) report.warnings.push(`wasteLog enthält ${orphan} Einträge zu gelöschten Zutaten (wird weiter gezählt).`);
    }

    window.__auditReport = { at: new Date().toISOString(), ...report };
    return report;
  }

  function getLastAuditReport() {
    return window.__auditReport || null;
  }

  window.audit = { repairReferences, getLastAuditReport };
})();
