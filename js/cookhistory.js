(() => {
  // UI-State (nicht in LocalStorage)
  const ui = {
    q: "",
    range: "all", // all | 7 | 30 | 365
    limit: 200
  };
  const esc = (s) => (window.utils?.esc ? window.utils.esc(s) : String(s ?? ""));
  const clone = (x) => (window.utils?.clone ? window.utils.clone(x) : JSON.parse(JSON.stringify(x)));

  function fmtDateTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("de-DE", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function fmtDuration(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function normalizeStr(s) {
    return String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .trim();
  }

  function withinRange(atIso, range) {
    if (range === "all") return true;
    const days = Number(range);
    if (!Number.isFinite(days) || days <= 0) return true;
    const t = new Date(atIso).getTime();
    if (!Number.isFinite(t)) return false;
    const now = Date.now();
    return t >= now - days * 24 * 60 * 60 * 1000;
  }

  function entryIdFor(recipeId, entry) {
    if (entry?.id) return String(entry.id);
    const at = entry?.at ? String(entry.at) : "";
    const sec = Math.max(0, Math.floor(Number(entry?.seconds) || 0));
    return `${recipeId || ""}|${at}|${sec}`;
  }

  // Undo
  let undoSnapshot = null;
  let undoMessage = "";
  let undoTimer = null;
  const UNDO_MS = 10_000;

  function setUndo(snapshot, message) {
    undoSnapshot = snapshot;
    undoMessage = message || "Aktion durchgeführt.";
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = setTimeout(() => {
      undoSnapshot = null;
      undoMessage = "";
      undoTimer = null;
    }, UNDO_MS);
  }

  function clearUndo() {
    undoSnapshot = null;
    undoMessage = "";
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = null;
  }

  window.renderCookHistoryView = function (container, state, persist) {
    if (!Array.isArray(state.recipes)) state.recipes = [];

    const rq = normalizeStr(ui.q);
    const cookEntries = [];

    for (const r of state.recipes || []) {
      const rName = r?.name || "(unbenannt)";
      if (rq && !normalizeStr(rName).includes(rq)) continue;

      const hist = Array.isArray(r?.cookHistory) ? r.cookHistory : [];
      for (const e of hist) {
        const at = e?.at ? String(e.at) : "";
        if (!at) continue;
        if (!withinRange(at, ui.range)) continue;
        const sec = Math.max(0, Math.floor(Number(e.seconds) || 0));
        cookEntries.push({
          recipeId: r?.id || "",
          recipeName: rName,
          entryId: entryIdFor(r?.id || "", e),
          at,
          seconds: sec
        });
      }
    }

    cookEntries.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    const totalCount = cookEntries.length;
    const shown = cookEntries.slice(0, ui.limit);
    const shownCount = shown.length;
    const shownSum = shown.reduce((sum, e) => sum + (Number(e.seconds) || 0), 0);

    // Gruppieren pro Rezept
    const groupsMap = new Map();
    for (const e of shown) {
      const key = e.recipeId || `__noid__${e.recipeName}`;
      if (!groupsMap.has(key)) {
        groupsMap.set(key, { recipeId: e.recipeId, recipeName: e.recipeName, entries: [], totalSeconds: 0, lastAt: e.at });
      }
      const g = groupsMap.get(key);
      g.entries.push(e);
      g.totalSeconds += Number(e.seconds) || 0;
      if (new Date(e.at).getTime() > new Date(g.lastAt).getTime()) g.lastAt = e.at;
    }

    const groups = Array.from(groupsMap.values()).sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime());

    const cookHtml = groups.length
      ? groups
          .map((g) => {
            const avg = g.entries.length ? Math.round(g.totalSeconds / g.entries.length) : 0;

            const groupActions = `
              <details class="actions-menu ch-actions" data-menu="recipe" data-recipe="${esc(g.recipeId)}">
                <summary title="Aktionen">⋯</summary>
                <div class="actions-panel" style="width:240px;">
                  <div class="actions-row" style="justify-content:flex-end;">
                    <button type="button" class="danger" data-action="chClearRecipe" data-recipe="${esc(g.recipeId)}">Historie löschen</button>
                  </div>
                </div>
              </details>
            `;

            const rows = g.entries
              .slice(0, 10)
              .map((e) => {
                const itemActions = `
                  <details class="actions-menu ch-actions" data-menu="entry" data-id="${esc(e.entryId)}" data-recipe="${esc(e.recipeId)}">
                    <summary title="Aktionen">⋯</summary>
                    <div class="actions-panel" style="width:220px;">
                      <div class="actions-row" style="justify-content:flex-end;">
                        <button type="button" class="danger" data-action="chDelEntry" data-recipe="${esc(e.recipeId)}" data-id="${esc(e.entryId)}">Löschen</button>
                      </div>
                    </div>
                  </details>
                `;

                return `
                  <div class="ch-item">
                    <div class="ch-item-left">
                      <div class="ch-date">${esc(fmtDateTime(e.at))}</div>
                    </div>
                    <div class="ch-item-right">
                      <div class="ch-dur">${esc(fmtDuration(e.seconds))}</div>
                      ${itemActions}
                    </div>
                  </div>
                `;
              })
              .join("");

            const moreNote = g.entries.length > 10 ? `<div class="small muted2" style="margin-top:8px;">Zeigt 10 von ${esc(g.entries.length)} Einträgen (Limit/Filter).</div>` : ``;

            return `
              <div class="card ch-group">
                <div class="ch-head">
                  <div class="ch-head-left">
                    <div class="ch-title">${esc(g.recipeName)}</div>
                    <div class="small muted2" style="margin-top:4px;">${esc(g.entries.length)}× gekocht · Ø ${esc(fmtDuration(avg))} · Summe ${esc(fmtDuration(g.totalSeconds))}</div>
                  </div>
                  <div class="ch-head-right">${groupActions}</div>
                </div>
                <div class="ch-items">${rows}</div>
                ${moreNote}
              </div>
            `;
          })
          .join("")
      : `<p class="small">Keine CookHistory-Einträge für diesen Filter.</p>`;

    const toast = undoSnapshot
      ? `
        <div class="toast-float" style="position:fixed; left:50%; bottom:18px; transform:translateX(-50%); z-index:9999;">
          <div class="toast-inner" style="display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--border); border-radius:14px; background: color-mix(in srgb, var(--panel) 92%, transparent); box-shadow:0 14px 40px rgba(0,0,0,0.55);">
            <div class="small" style="opacity:0.95;">${esc(undoMessage)}</div>
            <button type="button" data-action="chUndo">Rückgängig</button>
            <button type="button" data-action="chToastClose" title="Schließen" style="min-width:40px;">✕</button>
          </div>
        </div>
      `
      : "";

    container.innerHTML = `
      <div class="card">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
          <div>
            <h2 style="margin:0 0 6px 0;">CookHistory verwalten</h2>
            <p class="small" style="margin:0;">Hier kannst du Koch-Timer-Historie löschen (wirkt auf Kochzeit-Stats).</p>
          </div>
          <button type="button" class="info" data-action="back">← Einstellungen</button>
        </div>
      </div>

      <div class="card">
        <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
          <input id="ch-q" type="text" placeholder="Suchen (Rezeptname)" value="${esc(ui.q)}" style="min-width:220px;" />

          <select id="ch-range">
            <option value="all" ${ui.range === "all" ? "selected" : ""}>Alle</option>
            <option value="7" ${ui.range === "7" ? "selected" : ""}>Letzte 7 Tage</option>
            <option value="30" ${ui.range === "30" ? "selected" : ""}>Letzte 30 Tage</option>
            <option value="365" ${ui.range === "365" ? "selected" : ""}>Letzte 365 Tage</option>
          </select>

          <select id="ch-limit" title="Max. angezeigte Einträge">
            <option value="50" ${ui.limit === 50 ? "selected" : ""}>Zeige 50</option>
            <option value="200" ${ui.limit === 200 ? "selected" : ""}>Zeige 200</option>
            <option value="1000" ${ui.limit === 1000 ? "selected" : ""}>Zeige 1000</option>
          </select>

          <button class="danger" type="button" data-action="chClearAll">Alles löschen</button>
        </div>

        <div class="small muted2" style="margin-top:10px;">
          Treffer: <b>${esc(totalCount)}</b> · angezeigt: <b>${esc(shownCount)}</b> · Summe (angezeigt): <b>${esc(fmtDuration(shownSum))}</b>
        </div>

        <div class="small" style="margin-top:8px; opacity:0.8;">Hinweis: CookHistory kommt aus den Rezepten (Kochen → „Fertig“).</div>

        ${cookHtml}
      </div>

      ${toast}
    `;

    if (container.__chBound) return;
    container.__chBound = true;

    const rerender = () => window.renderCookHistoryView(container, state, persist);

    function findRecipe(id, nameFallback) {
      if (id) return (state.recipes || []).find((r) => String(r?.id || "") === String(id));
      // fallback per Name (soll selten sein)
      if (!nameFallback) return null;
      return (state.recipes || []).find((r) => String(r?.name || "") === String(nameFallback));
    }

    function removeEntryFromRecipe(recipeId, entryId) {
      const r = findRecipe(recipeId);
      if (!r) return false;
      const hist = Array.isArray(r.cookHistory) ? r.cookHistory : [];
      const beforeLen = hist.length;
      r.cookHistory = hist.filter((x) => entryIdFor(r.id || "", x) !== entryId);
      return r.cookHistory.length !== beforeLen;
    }

    container.addEventListener("change", (e) => {
      const el = e.target;
      if (el && el.id === "ch-range") {
        ui.range = el.value;
        rerender();
        return;
      }
      if (el && el.id === "ch-limit") {
        ui.limit = Number(el.value) || 200;
        rerender();
      }
    });

    container.addEventListener("input", (e) => {
      const el = e.target;
      if (el && el.id === "ch-q") {
        ui.q = el.value || "";
        rerender();
      }
    });

    container.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;

      const action = btn.getAttribute("data-action");

      if (action === "back") {
        window.app.navigate("settings");
        return;
      }

      if (action === "chUndo") {
        if (!undoSnapshot) return;
        if (undoSnapshot.recipes) state.recipes = undoSnapshot.recipes;
        clearUndo();
        persist();
        rerender();
        return;
      }

      if (action === "chToastClose") {
        clearUndo();
        rerender();
        return;
      }

      if (action === "chDelEntry") {
        const recipeId = btn.getAttribute("data-recipe") || "";
        const entryId = btn.getAttribute("data-id") || "";
        if (!entryId) return;

        const before = clone(state.recipes);
        const ok = removeEntryFromRecipe(recipeId, entryId);
        if (!ok) return;

        setUndo({ recipes: before }, "CookHistory-Eintrag gelöscht.");
        persist();
        rerender();
        return;
      }

      if (action === "chClearRecipe") {
        const recipeId = btn.getAttribute("data-recipe") || "";
        if (!recipeId) return;

        const before = clone(state.recipes);
        const r = findRecipe(recipeId);
        if (!r) return;

        r.cookHistory = [];
        setUndo({ recipes: before }, "CookHistory für Rezept gelöscht.");
        persist();
        rerender();
        return;
      }

      if (action === "chClearAll") {
        const before = clone(state.recipes);
        for (const r of state.recipes || []) r.cookHistory = [];
        setUndo({ recipes: before }, "CookHistory komplett gelöscht.");
        persist();
        rerender();
      }
    });
  };
})();
