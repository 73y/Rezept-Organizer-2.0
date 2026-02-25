// js/baseIngredients.js
// Generische Zutaten: Helpers + Picker-Modal
// Wird VOR ingredients.js geladen. Alle buildModal-Aufrufe erfolgen erst zur Laufzeit
// (wenn der User das Modal öffnet), zu dem Zeitpunkt ist window.buildModal bereits verfügbar.

(() => {
  const esc = (s) => (window.utils?.esc ? window.utils.esc(s) : String(s ?? ""));
  const uid = () => (window.utils?.uid ? window.utils.uid() : `id_${Date.now()}_${Math.random().toString(16).slice(2)}`);

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function nameById(state, id) {
    if (!id) return "";
    const list = Array.isArray(state.baseIngredients) ? state.baseIngredients : [];
    const found = list.find(x => String(x.id) === String(id));
    return found ? String(found.name || "") : "";
  }

  // Token-basierte Vorschläge: ein BaseIngredient wird vorgeschlagen, wenn
  // mindestens ein Token aus dem Zutaten-Namen im BI-Namen vorkommt (startsWith oder contains).
  function computeSuggestions(state, ingName) {
    const list = Array.isArray(state.baseIngredients) ? state.baseIngredients : [];
    if (!ingName) return [];
    const tokens = String(ingName).toLowerCase().split(/\s+/).filter(t => t.length >= 2);
    if (!tokens.length) return [];
    return list.filter(bi => {
      const n = String(bi.name).toLowerCase();
      return tokens.some(t => n.startsWith(t) || n.includes(t));
    });
  }

  // Alle baseIngredients nach Suchtext filtern, dabei bereits angezeigte IDs ausschließen.
  function filterList(state, search, excludeIds = []) {
    const list = Array.isArray(state.baseIngredients) ? state.baseIngredients : [];
    const excluded = new Set(excludeIds.map(String));
    const q = String(search || "").toLowerCase().trim();
    const filtered = q
      ? list.filter(bi => String(bi.name).toLowerCase().includes(q))
      : list.slice();
    return filtered.filter(bi => !excluded.has(String(bi.id)));
  }

  // ─── Picker-Modal ──────────────────────────────────────────────────────────

  function _renderSuggestionsHTML(suggestions) {
    if (!suggestions.length) return "";
    const rows = suggestions.map(bi =>
      `<div class="bi-row" data-base-id="${esc(bi.id)}" style="padding:8px 10px; border-radius:8px; cursor:pointer; border:1px solid var(--border); margin-bottom:6px;">${esc(bi.name)}</div>`
    ).join("");
    return `
      <div style="margin-bottom:12px;">
        <div class="small muted2" style="margin-bottom:6px;">Vorschläge</div>
        ${rows}
      </div>
    `;
  }

  function _renderListHTML(items, search) {
    if (!items.length) {
      const msg = search
        ? `Keine Treffer für „${esc(search)}".`
        : "Noch keine Generischen Zutaten vorhanden.";
      return `<div class="small muted2" style="padding:6px 0;">${msg}</div>`;
    }
    return items.map(bi =>
      `<div class="bi-row" data-base-id="${esc(bi.id)}" style="padding:8px 10px; border-radius:8px; cursor:pointer; border:1px solid var(--border); margin-bottom:6px;">${esc(bi.name)}</div>`
    ).join("");
  }

  function _renderPickerBody(state, ingName, search) {
    const suggestions = computeSuggestions(state, ingName);
    const suggestionIds = suggestions.map(bi => bi.id);
    const listItems = filterList(state, search, suggestionIds);
    const q = String(search || "").trim();

    const suggestionsHTML = !q ? _renderSuggestionsHTML(suggestions) : "";
    const listHTML = _renderListHTML(listItems, q);
    const createBtn = q
      ? `<button type="button" class="info" data-action="biCreate" style="margin-top:10px; width:100%;">+ Neu anlegen: „${esc(q)}"</button>`
      : "";

    return `
      <div>
        <input id="bi-search" placeholder="Suchen…" value="${esc(search)}" style="width:100%; margin-bottom:12px;" autocomplete="off" />
        ${suggestionsHTML}
        <div class="small muted2" style="margin-bottom:6px;">Generische Zutaten</div>
        <div id="bi-list">${listHTML}</div>
        ${createBtn ? `<div id="bi-create-wrap">${createBtn}</div>` : `<div id="bi-create-wrap"></div>`}
        <div id="bi-warn" class="small" style="display:none; margin-top:8px; color: rgba(234,179,8,0.9);"></div>
      </div>
    `;
  }

  function openPickerModal(state, persist, ingName, currentId, onSelect) {
    if (typeof window.buildModal !== "function") {
      alert("Generische Zutaten: Modal-System nicht bereit. Bitte Seite neu laden.");
      return;
    }

    const { modal, close } = window.buildModal({
      title: "Generische Zutat wählen",
      contentHTML: _renderPickerBody(state, ingName, ""),
      okText: "Schließen",
      cancelText: "Abbrechen",
      onConfirm: (_m, cl) => cl(),
      onCancel: (_m, cl) => cl()
    });

    // Hover-Effekt für Listenzeilen (via CSS-class toggle)
    modal.addEventListener("mouseover", (e) => {
      const row = e.target.closest(".bi-row");
      if (row) row.style.background = "var(--input)";
    });
    modal.addEventListener("mouseout", (e) => {
      const row = e.target.closest(".bi-row");
      if (row) row.style.background = "";
    });

    // Live-Suche: bei Eingabe Liste neu rendern
    modal.addEventListener("input", (e) => {
      if (e.target.id !== "bi-search") return;
      const q = e.target.value.trim();
      const listEl = modal.querySelector("#bi-list");
      const createWrap = modal.querySelector("#bi-create-wrap");

      const suggestions = computeSuggestions(state, ingName);
      const suggestionIds = q ? [] : suggestions.map(bi => bi.id); // Vorschläge nur ohne Suchtext
      const listItems = filterList(state, q, suggestionIds);

      if (listEl) listEl.innerHTML = _renderListHTML(listItems, q);

      if (createWrap) {
        createWrap.innerHTML = q
          ? `<button type="button" class="info" data-action="biCreate" style="margin-top:10px; width:100%;">+ Neu anlegen: „${esc(q)}"</button>`
          : "";
      }

      // Vorschläge-Sektion ausblenden wenn Suchtext vorhanden
      const sugSection = modal.querySelector("[data-bi-suggestions]");
      if (sugSection) sugSection.style.display = q ? "none" : "";
    });

    // Klick-Handler: Auswahl, Anlegen, Löschen
    modal.addEventListener("click", (e) => {
      // Auswahl eines vorhandenen BI
      const row = e.target.closest(".bi-row[data-base-id]");
      if (row) {
        const id = row.dataset.baseId;
        onSelect(id);
        close();
        return;
      }

      const btn = e.target.closest("button[data-action]");
      if (!btn) return;

      if (btn.dataset.action === "biCreate") {
        const searchEl = modal.querySelector("#bi-search");
        const q = String(searchEl?.value || "").trim();
        if (!q) return;

        // Duplikat-Prüfung (case-insensitive)
        const list = Array.isArray(state.baseIngredients) ? state.baseIngredients : [];
        const dup = list.find(bi => String(bi.name).toLowerCase() === q.toLowerCase());

        if (dup) {
          const warnEl = modal.querySelector("#bi-warn");
          if (warnEl) {
            warnEl.textContent = `„${esc(dup.name)}" existiert bereits und wurde ausgewählt.`;
            warnEl.style.display = "";
          }
          // Kurz anzeigen, dann schließen
          setTimeout(() => {
            onSelect(dup.id);
            close();
          }, 800);
          return;
        }

        // Neu anlegen
        if (!Array.isArray(state.baseIngredients)) state.baseIngredients = [];
        const newId = uid();
        state.baseIngredients.push({ id: newId, name: q });
        persist();
        onSelect(newId);
        close();
        return;
      }

      if (btn.dataset.action === "biClear") {
        onSelect(null);
        close();
      }
    });

    // Fokus auf Suche setzen
    setTimeout(() => modal.querySelector("#bi-search")?.focus(), 0);
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  window.baseIngredients = {
    nameById,
    computeSuggestions,
    filterList,
    openPickerModal
  };
})();
