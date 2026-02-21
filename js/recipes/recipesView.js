(() => {
  const esc = (s) => (window.utils?.esc ? window.utils.esc(s) : String(s ?? ""));

  const L = () => window.recipesLogic;
  const M = () => window.recipesModals;
  const uid = () => (window.utils?.uid ? window.utils.uid() : window.models.uid());
  const toNum = (v) => (window.utils?.toNumber ? window.utils.toNumber(v) : window.models.toNumber(v));
  const euro = (n) => (window.utils?.euro ? window.utils.euro(n) : window.models.euro(n));

  const ui = {
    openRecipeMenus: new Set(),

    // 0.3.0 Filter
    filterCat: "all" // "all" | "none" | <categoryId>
  };

  function fmt(n) {
    const x = Number(n) || 0;
    return x.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  }

  function avgCookSeconds(recipe) {
    const arr = recipe.cookHistory || [];
    if (!arr.length) return null;
    const sum = arr.reduce((s, x) => s + (Number(x.seconds) || 0), 0);
    return sum > 0 ? sum / arr.length : null;
  }

  function fmtDuration(sec) {
    const s = Math.round(Number(sec) || 0);
    if (!s) return "—";
    const m = Math.floor(s / 60);
    const r = s % 60;
    if (m <= 0) return `${r}s`;
    if (r === 0) return `${m}m`;
    return `${m}m ${r}s`;
  }

  function ingredientsSorted(state) {
    return (state.ingredients || [])
      .slice()
      .sort((a, b) => (a.name || "").localeCompare(b.name || "", "de"));
  }

  function recipeItemsSummary(state, recipe) {
    const items = (recipe.items || []).filter((x) => x.ingredientId);
    if (!items.length) return "Keine Zutaten";

    const parts = items.slice(0, 3).map((it) => {
      const ing = L().getIng(state, it.ingredientId);
      const name = ing ? ing.name : "(Unbekannt)";
      const amt = Number(it.amount) || 0;
      const unit = ing ? ing.unit : (it.unit || "");
      return `${name} (${fmt(amt)} ${unit})`;
    });

    const rest = items.length - parts.length;
    return rest > 0 ? `${parts.join(" · ")} · +${rest}` : parts.join(" · ");
  }

  function cartIconSVG() {
    return `
      <svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 6h15l-1.5 9h-12z"></path>
        <path d="M6 6l-1-3H2"></path>
        <circle cx="9" cy="20" r="1"></circle>
        <circle cx="18" cy="20" r="1"></circle>
      </svg>
    `;
  }

  function cookIconSVG() {
    // Emoji statt SVG: klarer, wirkt weniger "komisch" im Stroke-Style
    return "🍳";
  }

  function recipeCardHTML(state, r) {
    const total = L().recipeCost(state, r);
    const perPortion = (Number(r.portions) || 0) > 0 ? total / Number(r.portions) : total;

    const avg = avgCookSeconds(r);
    const itemsText = recipeItemsSummary(state, r);

    const open = ui.openRecipeMenus.has(r.id) ? "open" : "";

    return `
      <div class="card" style="margin:10px 0;">
        <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
          <div style="min-width:0; flex:1;">
            <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
              <div style="font-weight:800; font-size:18px; line-height:1.1;">${esc(r.name || "(ohne Name)")}</div>
              <span class="small" style="border:1px solid var(--border); padding:4px 10px; border-radius:999px;">Portionen: <b>${esc(r.portions ?? 1)}</b></span>
            </div>

            <div class="small" style="margin-top:8px; opacity:0.9; display:flex; gap:10px; flex-wrap:wrap;">
              <span>Gesamt: <b>${esc(euro(total))}</b></span>
              <span>·</span>
              <span>pro Portion: <b>${esc(euro(perPortion))}</b></span>
              ${avg ? `<span>· Ø Kochzeit: <b>${esc(fmtDuration(avg))}</b></span>` : ``}
            </div>

            <div class="small muted2" style="margin-top:8px; line-height:1.35;">
              ${esc(itemsText)}
            </div>
          </div>

          <div class="recipe-actions-inline">
            <button class="btn-icon" data-action="addShop" data-recipe-id="${esc(r.id)}" title="Zur Einkaufsliste">
              ${cartIconSVG()}
            </button>

            <button class="primary btn-cook" data-action="cook" data-recipe-id="${esc(r.id)}" title="Kochen">Kochen</button>

            <details class="actions-menu recipe-actions" data-recipe="${esc(r.id)}" ${open}>
              <summary title="Aktionen">⋯</summary>
              <div class="actions-panel" style="min-width:220px;">
                <div class="actions-row" style="justify-content:space-between;">
                  <button class="info" data-action="edit" data-recipe-id="${esc(r.id)}">Bearbeiten</button>
                  <button class="danger" data-action="del" data-recipe-id="${esc(r.id)}">Löschen</button>
                </div>
              </div>
            </details>
          </div>
        </div>
      </div>
    `;
  }

  function ingredientOptionsHTML(state, selectedId) {
    return ingredientsSorted(state)
      .map((ing) => {
        const label = `${ing.name}${ing.unlisted ? " (ungelistet)" : ""}`;
        return `<option value="${esc(ing.id)}" ${ing.id === selectedId ? "selected" : ""}>${esc(label)}</option>`;
      })
      .join("");
  }

  // 0.3.0 Kategorien (Rezepte)
  function recipeCategoriesSorted(state) {
    const cats = Array.isArray(state.recipeCategories) ? state.recipeCategories : [];
    return cats.slice().sort((a, b) => (a.name || "").localeCompare(b.name || "", "de"));
  }

  function recipeCategorySelectOptionsHTML(state, selectedId) {
    const cats = recipeCategoriesSorted(state);
    const sel = String(selectedId || "");
    const opts = [`<option value="" ${sel ? "" : "selected"}>Ohne Kategorie</option>`];
    for (const c of cats) {
      opts.push(`<option value="${esc(c.id)}" ${String(c.id) === sel ? "selected" : ""}>${esc(c.name)}</option>`);
    }
    return opts.join("");
  }

  function openRecipeCategoriesModal(state, persist) {
    if (!Array.isArray(state.recipeCategories)) state.recipeCategories = [];

    const cats = recipeCategoriesSorted(state);
    const rows = cats
      .map(
        (c) => `
        <div class="row" style="margin:8px 0; align-items:center;">
          <div style="min-width:220px; flex:1;">
            <input data-role="catName" data-id="${esc(c.id)}" value="${esc(c.name)}" />
          </div>
          <div style="flex:0 0 auto;">
            <button type="button" class="danger" data-action="catDel" data-id="${esc(c.id)}">Löschen</button>
          </div>
        </div>
      `
      )
      .join("");

    const content = `
      <div class="small muted2">Kategorien für Rezepte. Beim Löschen wird die Kategorie bei betroffenen Rezepten entfernt.</div>
      <div style="margin-top:12px;">
        <label class="small">Neue Kategorie</label><br/>
        <div class="row" style="align-items:center;">
          <div style="flex:1; min-width:220px;"><input id="cat-new" placeholder="z. B. Meal Prep" /></div>
          <div style="flex:0 0 auto;"><button type="button" class="info" data-action="catAdd">Hinzufügen</button></div>
        </div>
      </div>
      <div style="margin-top:12px;">
        <h3 style="margin:0 0 8px 0;">Liste</h3>
        <div id="cat-list">${rows || `<div class="small">Noch keine Kategorien.</div>`}</div>
      </div>
      <div class="small" id="cat-msg" style="margin-top:10px; color: rgba(239,68,68,0.9);"></div>
    `;

    const { modal } = M().buildModal({
      title: "Rezept-Kategorien",
      contentHTML: content,
      okText: "Speichern",
      okClass: "success",
      onConfirm: (m, close) => {
        const msg = m.querySelector("#cat-msg");
        if (msg) msg.textContent = "";

        const inputs = Array.from(m.querySelectorAll("input[data-role=catName]"));
        const next = [];
        const used = new Set();

        for (const inp of inputs) {
          const id = String(inp.getAttribute("data-id") || "").trim();
          const name = String(inp.value || "").trim();
          if (!id) continue;
          if (!name) continue;
          const key = name.toLowerCase();
          if (used.has(key)) {
            if (msg) msg.textContent = `Doppelte Kategorie: „${name}“`;
            return;
          }
          used.add(key);
          next.push({ id, name });
        }

        next.sort((a, b) => (a.name || "").localeCompare(b.name || "", "de"));
        state.recipeCategories = next;

        // Referenzen bereinigen
        const valid = new Set(next.map((c) => String(c.id)));
        for (const r of state.recipes || []) {
          if (r?.categoryId && !valid.has(String(r.categoryId))) r.categoryId = null;
        }

        persist();
        close();
        window.app.navigate("recipes");
      }
    });

    function rebuildList() {
      const list = modal.querySelector("#cat-list");
      if (!list) return;
      const cats2 = recipeCategoriesSorted(state);
      list.innerHTML =
        cats2
          .map(
            (c) => `
            <div class="row" style="margin:8px 0; align-items:center;">
              <div style="min-width:220px; flex:1;">
                <input data-role="catName" data-id="${esc(c.id)}" value="${esc(c.name)}" />
              </div>
              <div style="flex:0 0 auto;">
                <button type="button" class="danger" data-action="catDel" data-id="${esc(c.id)}">Löschen</button>
              </div>
            </div>
          `
          )
          .join("") || `<div class="small">Noch keine Kategorien.</div>`;
    }

    modal.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const a = btn.getAttribute("data-action");
      const msg = modal.querySelector("#cat-msg");
      if (msg) msg.textContent = "";

      if (a === "catAdd") {
        const inp = modal.querySelector("#cat-new");
        const name = String(inp?.value || "").trim();
        if (!name) return;
        const dup = (state.recipeCategories || []).some((c) => String(c.name || "").trim().toLowerCase() === name.toLowerCase());
        if (dup) {
          if (msg) msg.textContent = "Kategorie existiert schon.";
          return;
        }
        state.recipeCategories.push({ id: uid(), name });
        if (inp) inp.value = "";
        rebuildList();
      }

      if (a === "catDel") {
        const id = btn.getAttribute("data-id") || "";
        state.recipeCategories = (state.recipeCategories || []).filter((c) => String(c.id) !== String(id));
        rebuildList();
      }
    });
  }

  function openRecipeEditorModal(state, persist, recipeOrNull) {
    if (!Array.isArray(state.recipes)) state.recipes = [];
    if (!Array.isArray(state.ingredients)) state.ingredients = [];

    const isEdit = !!recipeOrNull;

    const content = `
      <div class="row">
        <div>
          <label class="small">Name</label><br/>
          <input id="r-name" placeholder="z. B. Quinoa-Salat" value="${esc(recipeOrNull?.name || "")}" />
        </div>
        <div>
          <label class="small">Portionen</label><br/>
          <input id="r-portions" type="number" min="1" step="1" value="${esc(recipeOrNull?.portions ?? 1)}" />
        </div>
        <div>
          <label class="small">Zubereitungszeit (min)</label><br/>
          <input id="r-prep" type="number" min="0" step="1" value="${esc(recipeOrNull?.prepMinutes ?? "")}" />
        </div>
      </div>

      <div class="row" style="margin-top:10px;">
        <div>
          <label class="small">Kategorie</label><br/>
          <select id="r-cat" style="width:100%;">
            ${recipeCategorySelectOptionsHTML(state, recipeOrNull?.categoryId)}
          </select>
        </div>
      </div>

      <div style="margin-top:10px;">
        <label class="small">Kurzbeschreibung</label><br/>
        <textarea id="r-desc" rows="2" style="width:100%; resize:vertical;">${esc(recipeOrNull?.description || "")}</textarea>
      </div>

      <div style="margin-top:10px;">
        <label class="small">Schritte / Anleitung</label><br/>
        <textarea id="r-inst" rows="5" style="width:100%; resize:vertical;">${esc(recipeOrNull?.instructions || "")}</textarea>
      </div>

      <div style="margin-top:12px;" class="recipe-rows">
        <div class="recipe-rows-head">
          <div>Zutat</div>
          <div>Menge</div>
          <div>Einheit</div>
          <div></div>
        </div>
        <div id="r-rows"></div>

        <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-top:10px; flex-wrap:wrap;">
          <button type="button" class="info" data-action="addRow">+ Zutat</button>
          <div class="small" style="opacity:0.9;">Kosten-Vorschau: <b id="r-cost">—</b></div>
        </div>
      </div>

      <div class="small" id="r-msg" style="margin-top:10px; color: rgba(239,68,68,0.9);"></div>
    `;

    const { modal, close } = M().buildModal({
      title: isEdit ? "Rezept bearbeiten" : "Neues Rezept",
      contentHTML: content,
      okText: isEdit ? "Speichern" : "Hinzufügen",
      okClass: "success",
      onConfirm: (m, doClose) => {
        const msg = m.querySelector("#r-msg");
        if (msg) msg.textContent = "";

        const name = (m.querySelector("#r-name")?.value || "").trim();
        const portions = Math.max(1, Math.round(toNum(m.querySelector("#r-portions")?.value) || 1));
        const prep = Math.max(0, Math.round(toNum(m.querySelector("#r-prep")?.value) || 0));
        const description = (m.querySelector("#r-desc")?.value || "").trim();
        const instructions = (m.querySelector("#r-inst")?.value || "").trim();
        const categoryId = (m.querySelector("#r-cat")?.value || "").trim() || null;

        if (!name) return (msg.textContent = "Bitte einen Namen eingeben.");

        const rows = Array.from(m.querySelectorAll(".recipe-row"));
        const items = rows
          .map((row) => {
            const ingredientId = row.querySelector("select")?.value || "";
            const ing = L().getIng(state, ingredientId);
            const amount = toNum(row.querySelector("input[data-role=amt]")?.value);
            if (!ingredientId || !ing) return null;
            if (!Number.isFinite(amount) || amount <= 0) return null;
            return { ingredientId, amount: Number(amount.toFixed(4)), unit: ing.unit };
          })
          .filter(Boolean);

        if (!items.length) return (msg.textContent = "Bitte mindestens eine Zutat mit Menge hinzufügen.");

        if (isEdit) {
          const r = state.recipes.find((x) => x.id === recipeOrNull.id);
          if (!r) return (msg.textContent = "Rezept nicht gefunden.");

          r.name = name;
          r.portions = portions;
          r.prepMinutes = prep;
          r.description = description;
          r.instructions = instructions;
          r.items = items;
          r.categoryId = categoryId;

          // Wenn Rezept geplant ist: Einkaufsliste ggf. anheben (niemals reduzieren)
          window.recipesLogic?.reconcileShoppingWithPlan?.(state, { mode: "raise" });

          persist();
          doClose();
          window.app.navigate("recipes");
          return;
        }

        state.recipes.push({
          id: uid(),
          name,
          portions,
          prepMinutes: prep,
          description,
          instructions,
          items,
          categoryId,
          cookHistory: []
        });

        persist();
        doClose();
        window.app.navigate("recipes");
      }
    });

    const rowsWrap = modal.querySelector("#r-rows");
    const costEl = modal.querySelector("#r-cost");

    function recomputeCost() {
      const rows = Array.from(modal.querySelectorAll(".recipe-row"));
      const tmpItems = rows
        .map((row) => {
          const ingredientId = row.querySelector("select")?.value || "";
          const ing = L().getIng(state, ingredientId);
          const amount = toNum(row.querySelector("input[data-role=amt]")?.value);
          if (!ingredientId || !ing) return null;
          if (!Number.isFinite(amount) || amount <= 0) return null;
          return { ingredientId, amount: Number(amount.toFixed(4)), unit: ing.unit };
        })
        .filter(Boolean);

      if (!tmpItems.length) {
        costEl.textContent = "—";
        return;
      }

      const tmpRecipe = { items: tmpItems, portions: Math.max(1, Math.round(toNum(modal.querySelector("#r-portions")?.value) || 1)) };
      const total = L().recipeCost(state, tmpRecipe);
      const per = tmpRecipe.portions > 0 ? total / tmpRecipe.portions : total;
      costEl.textContent = `${euro(total)} (≈ ${euro(per)} / Portion)`;
    }

    function addRow(ingredientId = "", amount = "") {
      const row = document.createElement("div");
      row.className = "recipe-row";

      const options = `<option value="">– wählen –</option>${ingredientOptionsHTML(state, ingredientId)}`;

      row.innerHTML = `
        <select>${options}</select>
        <input data-role="amt" type="number" min="0" step="0.01" placeholder="0" value="${esc(amount)}" />
        <input data-role="unit" placeholder="" readonly />
        <button type="button" class="danger btn-mini" data-action="rowRemove">×</button>
      `;

      const sel = row.querySelector("select");
      const amtEl = row.querySelector("input[data-role=amt]");
      const unitEl = row.querySelector("input[data-role=unit]");

      function updateUnit() {
        const ing = L().getIng(state, sel.value);
        unitEl.value = ing ? ing.unit : "";
      }

      sel.addEventListener("change", () => {
        updateUnit();
        recomputeCost();
      });

      amtEl.addEventListener("input", () => {
        recomputeCost();
      });


      // remove handler
      row.querySelector("button[data-action=rowRemove]").addEventListener("click", () => {
        row.remove();
        recomputeCost();
      });

      rowsWrap.appendChild(row);
      updateUnit();
      recomputeCost();
      amtEl.focus();
    }

    // rows initial
    const initItems = (recipeOrNull?.items || []).slice();
    if (initItems.length) {
      for (const it of initItems) {
        addRow(it.ingredientId, it.amount);
      }
    } else {
      addRow();
    }

    modal.querySelector("button[data-action=addRow]").addEventListener("click", () => addRow());
    modal.querySelector("#r-portions").addEventListener("input", recomputeCost);

    setTimeout(() => modal.querySelector("#r-name")?.focus(), 0);

    // expose close? not needed
    return { close };
  }

  function openDeleteRecipeModal(state, persist, recipeId) {
    const r = (state.recipes || []).find((x) => x.id === recipeId);
    if (!r) return;

    M().buildModal({
      title: "Löschen bestätigen",
      contentHTML: `<div class="small">Rezept <b>${esc(r.name)}</b> löschen?</div><div class="small" style="margin-top:10px; opacity:0.85;">Das kann nicht rückgängig gemacht werden.</div>`,
      okText: "Löschen",
      okClass: "danger",
      onConfirm: (_m, close) => {
        if (window.actions?.deleteRecipeCascade) {
          window.actions.deleteRecipeCascade(recipeId);
        } else {
          state.recipes = (state.recipes || []).filter((x) => x.id !== recipeId);
          window.recipesLogic?.removePlannedRecipe?.(state, recipeId);
          window.recipesLogic?.reconcileShoppingWithPlan?.(state, { mode: "raise" });
          persist();
        }
        close();
        window.app.navigate("recipes");
      }
    });
  }

  window.renderRecipesView = function (container, state, persist) {
    if (!Array.isArray(state.recipes)) state.recipes = [];
    if (!Array.isArray(state.ingredients)) state.ingredients = [];

    // Menüs aufräumen, wenn Rezepte verschwinden
    for (const id of Array.from(ui.openRecipeMenus)) {
      if (!state.recipes.some((r) => r.id === id)) ui.openRecipeMenus.delete(id);
    }

    const cats = recipeCategoriesSorted(state);
    const validCatIds = new Set(cats.map((c) => String(c.id)));
    if (ui.filterCat !== "all" && ui.filterCat !== "none" && !validCatIds.has(String(ui.filterCat))) ui.filterCat = "all";

    let recipes = state.recipes.slice();
    if (ui.filterCat === "none") recipes = recipes.filter((r) => !r?.categoryId);
    else if (ui.filterCat !== "all") recipes = recipes.filter((r) => String(r?.categoryId || "") === String(ui.filterCat));
    recipes = recipes.sort((a, b) => (a.name || "").localeCompare(b.name || "", "de"));

    const chip = (label, catId, active) =>
      `<button type="button" class="chipbtn ${active ? "active" : ""}" data-action="filterCat" data-cat="${esc(catId)}">${esc(label)}</button>`;
    const chipsHTML = [
      chip("Alle", "all", ui.filterCat === "all"),
      chip("Ohne Kategorie", "none", ui.filterCat === "none"),
      ...cats.map((c) => chip(c.name, c.id, String(ui.filterCat) === String(c.id)))
    ].join("");

    container.innerHTML = `
      <div class="card">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
          <div>
            <h2 style="margin:0 0 6px 0;">Rezepte</h2>
            <p class="small" style="margin:0;">Einkaufsliste & Kochen sind direkt am Rezept. Bearbeiten/Löschen über „⋯“. Neues Rezept über „+“.</p>

            <div class="chipbar" style="margin-top:10px;">
              ${chipsHTML}
              <button type="button" class="chipbtn" data-action="manageCats">Kategorien…</button>
            </div>
          </div>
          <div class="small muted2" style="text-align:right;">${esc(recipes.length)} Rezept(e)</div>
        </div>
      </div>

      <div class="card">
        <h3 style="margin:0 0 10px 0;">Liste</h3>
        ${recipes.length ? recipes.map((r) => recipeCardHTML(state, r)).join("") : `<p class="small">Noch keine Rezepte. Tippe unten rechts auf „+“.</p>`}
      </div>

      <button class="fab" type="button" data-action="openAdd" title="Neues Rezept">+</button>
    `;

    // Toggle tracking
    if (!container.__recipeToggleBound) {
      container.__recipeToggleBound = true;
      container.addEventListener(
        "toggle",
        (e) => {
          const details = e.target;
          if (!(details instanceof HTMLDetailsElement)) return;
          if (!details.classList.contains("recipe-actions")) return;
          const id = details.getAttribute("data-recipe") || "";
          if (!id) return;
          if (details.open) ui.openRecipeMenus.add(id);
          else ui.openRecipeMenus.delete(id);
        },
        true
      );
    }

    container.onclick = (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;

      const action = btn.getAttribute("data-action");

      if (action === "filterCat") {
        ui.filterCat = btn.getAttribute("data-cat") || "all";
        window.app.navigate("recipes");
        return;
      }

      if (action === "manageCats") {
        openRecipeCategoriesModal(state, persist);
        return;
      }

      if (action === "openAdd") {
        openRecipeEditorModal(state, persist, null);
        return;
      }

      const recipeId = btn.getAttribute("data-recipe-id") || "";
      if (!recipeId) return;

      const r = state.recipes.find((x) => x.id === recipeId);
      if (!r) return;

      if (action === "addShop") {
        M().openAddToShoppingModal(state, persist, r);
        return;
      }

      if (action === "cook") {
        M().openCookModal(state, persist, r);
        return;
      }

      if (action === "edit") {
        openRecipeEditorModal(state, persist, r);
        return;
      }

      if (action === "del") {
        openDeleteRecipeModal(state, persist, recipeId);
      }
    };
  };
})();
