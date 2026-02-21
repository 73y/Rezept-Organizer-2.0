(() => {
  // js/actions.js
  // Zentrale, optionale Actions-Schicht. Views dürfen weiterhin direkt mutieren + persist()
  // (aber für Server/Sync ist diese Schicht später Gold wert).

  const clone = (x) => (window.utils?.clone ? window.utils.clone(x) : JSON.parse(JSON.stringify(x)));

  function update(mutator, { navigate = null, render = true } = {}) {
    const cur = window.app?.getState ? window.app.getState() : null;
    if (!cur) return null;

    const draft = clone(cur);
    mutator?.(draft);

    const next = window.app?.setState ? window.app.setState(draft, { render }) : draft;
    if (navigate) window.app?.navigate?.(navigate);
    return next;
  }

  function deleteIngredientCascade(ingredientId) {
    return update((state) => {
      const id = String(ingredientId || "");
      if (!id) return;

      // Zutaten
      state.ingredients = (state.ingredients || []).filter((x) => x?.id !== id);

      // aktive Daten (müssen clean sein)
      state.shopping = (state.shopping || []).filter((x) => x?.ingredientId !== id);
      state.pantry = (state.pantry || []).filter((x) => x?.ingredientId !== id);

      // Recipes: Items entfernen
      for (const r of state.recipes || []) {
        if (!r || typeof r !== "object") continue;
        r.items = Array.isArray(r.items) ? r.items.filter((it) => it?.ingredientId !== id) : [];
      }

      // shoppingSession.checked (keys = ingredientId)
      if (state.shoppingSession?.checked && typeof state.shoppingSession.checked === "object") {
        delete state.shoppingSession.checked[id];
      }

      // Logs bleiben absichtlich (Stats bleibt vollständig) – Anzeige fällt dann auf „Gelöscht“ zurück.
    });
  }

  function deleteRecipeCascade(recipeId) {
    return update((state) => {
      const id = String(recipeId || "");
      if (!id) return;

      state.recipes = (state.recipes || []).filter((r) => r?.id !== id);
      state.plannedRecipes = (state.plannedRecipes || []).filter((p) => p?.recipeId !== id);

      // Shopping-Anhebung wird im Save-Pipeline (storage.postLoadRepair) wieder sauber gemacht.
    });
  }

  function repairNow() {
    if (!window.dataTools?.repairState) return null;
    const cur = window.app?.getState ? window.app.getState() : null;
    if (!cur) return null;
    const next = window.dataTools.repairState(cur);
    window.app?.setState?.(next);
    return next;
  }

  window.actions = {
    update,
    deleteIngredientCascade,
    deleteRecipeCascade,
    repairNow
  };
})();
