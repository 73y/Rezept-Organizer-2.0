(() => {
  // UI-State (nicht in LocalStorage)
  const ui = {
    q: "",
    range: "all", // all | 7 | 30 | 365
    limit: 200
  };
  const esc = (s) => (window.utils?.esc ? window.utils.esc(s) : String(s ?? ""));

  const euro = (n) => (window.models?.euro ? window.models.euro(Number(n) || 0) : `${(Number(n) || 0).toFixed(2)} €`);
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

  function groupByAt(entries) {
    const map = new Map();
    for (const e of entries) {
      const at = e?.at || "";
      if (!at) continue;
      if (!map.has(at)) map.set(at, []);
      map.get(at).push(e);
    }
    const sessions = Array.from(map.entries()).map(([at, items]) => {
      const total = items.reduce((sum, x) => sum + (Number(x.total) || 0), 0);
      return { at, items, total };
    });
    sessions.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    return sessions;
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

  function buildModal({ title, contentHTML, okText = "Speichern", cancelText = "Abbrechen", okClass = "primary", onConfirm }) {
    const overlay = document.createElement("div");
    overlay.style.cssText = `
      position:fixed; inset:0; z-index:9999;
      background: rgba(0,0,0,0.65); backdrop-filter: blur(2px);
      display:flex; align-items:center; justify-content:center;
      padding:16px;
    `;

    const modal = document.createElement("div");
    modal.style.cssText = `
      width:100%;
      max-width:640px;
      max-height:78vh;
      overflow:auto;
      background: var(--panel); color: var(--text);
      border:1px solid var(--border);
      border-radius:14px;
      padding:14px;
      box-shadow:0 14px 40px rgba(0,0,0,0.55);
    `;

    modal.innerHTML = `
      <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
        <div style="font-weight:700; font-size:16px; line-height:1.2;">${esc(title)}</div>
        <button data-action="close" title="Schließen" style="min-width:40px;">✕</button>
      </div>
      <div style="margin-top:12px;">${contentHTML}</div>
      <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:14px; flex-wrap:wrap;">
        <button data-action="cancel">${esc(cancelText)}</button>
        <button data-action="ok" class="${esc(okClass)}">${esc(okText)}</button>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function close() {
      overlay.remove();
    }

    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) close();
    });

    modal.addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-action]");
      if (!b) return;
      const a = b.getAttribute("data-action");
      if (a === "close" || a === "cancel") return close();
      if (a === "ok") return onConfirm?.(modal, close);
    });

    return { overlay, modal, close };
  }

  window.renderPurchaseLogView = function (container, state, persist) {
    if (!Array.isArray(state.purchaseLog)) state.purchaseLog = [];

    const ingMap = new Map((state.ingredients || []).map((i) => [i.id, i]));
    const q = normalizeStr(ui.q);

    const filtered = (state.purchaseLog || [])
      .filter((e) => (e?.at ? withinRange(e.at, ui.range) : false))
      .filter((e) => {
        if (!q) return true;
        const ingName = ingMap.get(e.ingredientId)?.name || "";
        return normalizeStr(ingName).includes(q);
      })
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    const limited = filtered.slice(0, ui.limit);
    const sessions = groupByAt(limited);

    const totalCount = filtered.length;
    const shownCount = limited.length;
    const shownSum = limited.reduce((sum, e) => sum + (Number(e.total) || 0), 0);

    const listHtml = sessions.length
      ? sessions
          .map((s) => {
            const showItemPrices = s.items.length > 1;

            const sessionActions = `
              <details class="actions-menu pl-actions" data-menu="session" data-at="${esc(s.at)}">
                <summary title="Aktionen">⋯</summary>
                <div class="actions-panel" style="width:220px;">
                  <div class="actions-row" style="justify-content:flex-end;">
                    <button type="button" class="danger" data-action="plDelSession" data-at="${esc(s.at)}">Einkauf löschen</button>
                  </div>
                </div>
              </details>
            `;

            const rows = s.items
              .map((e) => {
                const ing = ingMap.get(e.ingredientId);
                const ingName = ing?.name || "(unbekannt)";
                const packs = Number(e.packs) || 0;
                const buyAmt = Number(e.buyAmount) || 0;
                const unit = e.unit || ing?.unit || "";
                const amountText = `${esc(packs)} Packung(en) · ${esc(Number(buyAmt.toFixed(4)))} ${esc(unit)}`;

                const priceHtml = showItemPrices ? `<div class="pl-price">${esc(euro(e.total))}</div>` : ``;

                const itemActions = `
                  <details class="actions-menu pl-actions" data-menu="entry" data-id="${esc(e.id)}">
                    <summary title="Aktionen">⋯</summary>
                    <div class="actions-panel" style="width:220px;">
                      <div class="actions-row" style="justify-content:flex-end;">
                        <button type="button" class="info" data-action="plEditEntry" data-id="${esc(e.id)}">Bearbeiten</button>
                        <button type="button" class="danger" data-action="plDelEntry" data-id="${esc(e.id)}">Löschen</button>
                      </div>
                    </div>
                  </details>
                `;

                return `
                  <div class="pl-item">
                    <div class="pl-item-left">
                      <div class="pl-name">${esc(ingName)}</div>
                      <div class="small muted2" style="margin-top:2px;">${amountText}</div>
                    </div>
                    <div class="pl-item-right">
                      ${priceHtml}
                      ${itemActions}
                    </div>
                  </div>
                `;
              })
              .join("");

            return `
              <div class="card pl-session">
                <div class="pl-session-head">
                  <div>
                    <div class="pl-date">${esc(fmtDateTime(s.at))}</div>
                    <div class="small muted2" style="margin-top:4px;">${esc(s.items.length)} Position(en)</div>
                  </div>
                  <div class="pl-session-right">
                    <div class="pl-total">${esc(euro(s.total))}</div>
                    ${sessionActions}
                  </div>
                </div>
                <div class="pl-items">${rows}</div>
              </div>
            `;
          })
          .join("")
      : `<p class="small">Kein purchaseLog-Eintrag für diesen Filter.</p>`;

    const toast = undoSnapshot
      ? `
        <div class="toast-float" style="position:fixed; left:50%; bottom:18px; transform:translateX(-50%); z-index:9999;">
          <div class="toast-inner" style="display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--border); border-radius:14px; background: color-mix(in srgb, var(--panel) 92%, transparent); box-shadow:0 14px 40px rgba(0,0,0,0.55);">
            <div class="small" style="opacity:0.95;">${esc(undoMessage)}</div>
            <button type="button" data-action="plUndo">Rückgängig</button>
            <button type="button" data-action="plToastClose" title="Schließen" style="min-width:40px;">✕</button>
          </div>
        </div>
      `
      : "";

    container.innerHTML = `
      <div class="card">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
          <div>
            <h2 style="margin:0 0 6px 0;">purchaseLog verwalten</h2>
            <p class="small" style="margin:0;">Hier kannst du alte Käufe bearbeiten/löschen (wirkt auf Ausgaben-Stats, nicht auf den Vorrat).</p>
          </div>
          <button type="button" class="info" data-action="back">← Einstellungen</button>
        </div>
      </div>

      <div class="card">
        <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
          <input id="pl-q" type="text" placeholder="Suchen (z.B. Eier)" value="${esc(ui.q)}" style="min-width:220px;" />

          <select id="pl-range">
            <option value="all" ${ui.range === "all" ? "selected" : ""}>Alle</option>
            <option value="7" ${ui.range === "7" ? "selected" : ""}>Letzte 7 Tage</option>
            <option value="30" ${ui.range === "30" ? "selected" : ""}>Letzte 30 Tage</option>
            <option value="365" ${ui.range === "365" ? "selected" : ""}>Letzte 365 Tage</option>
          </select>

          <select id="pl-limit" title="Max. angezeigte Einträge">
            <option value="50" ${ui.limit === 50 ? "selected" : ""}>Zeige 50</option>
            <option value="200" ${ui.limit === 200 ? "selected" : ""}>Zeige 200</option>
            <option value="1000" ${ui.limit === 1000 ? "selected" : ""}>Zeige 1000</option>
          </select>
        </div>

        <div class="small muted2" style="margin-top:10px;">
          Treffer: <b>${esc(totalCount)}</b> · angezeigt: <b>${esc(shownCount)}</b> · Summe (angezeigt): <b>${esc(euro(shownSum))}</b>
        </div>

        ${listHtml}
      </div>

      ${toast}
    `;

    if (container.__plBound) return;
    container.__plBound = true;

    const rerender = () => window.renderPurchaseLogView(container, state, persist);

    container.addEventListener("change", (e) => {
      const el = e.target;
      if (el && el.id === "pl-range") {
        ui.range = el.value;
        rerender();
        return;
      }
      if (el && el.id === "pl-limit") {
        ui.limit = Number(el.value) || 200;
        rerender();
      }
    });

    container.addEventListener("input", (e) => {
      const el = e.target;
      if (el && el.id === "pl-q") {
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

      if (action === "plUndo") {
        if (!undoSnapshot) return;
        if (undoSnapshot.purchaseLog) state.purchaseLog = undoSnapshot.purchaseLog;
        clearUndo();
        persist();
        rerender();
        return;
      }

      if (action === "plToastClose") {
        clearUndo();
        rerender();
        return;
      }

      if (action === "plDelEntry") {
        const id = btn.getAttribute("data-id") || "";
        if (!id) return;

        const before = clone(state.purchaseLog);
        const next = (state.purchaseLog || []).filter((x) => x?.id !== id);
        if (next.length === (state.purchaseLog || []).length) return;

        state.purchaseLog = next;
        setUndo({ purchaseLog: before }, "purchaseLog-Eintrag gelöscht.");
        persist();
        rerender();
        return;
      }

      if (action === "plDelSession") {
        const at = btn.getAttribute("data-at") || "";
        if (!at) return;

        const before = clone(state.purchaseLog);
        const next = (state.purchaseLog || []).filter((x) => x?.at !== at);
        if (next.length === (state.purchaseLog || []).length) return;

        state.purchaseLog = next;
        setUndo({ purchaseLog: before }, "Einkauf (Session) gelöscht.");
        persist();
        rerender();
        return;
      }

      if (action === "plEditEntry") {
        const id = btn.getAttribute("data-id") || "";
        if (!id) return;

        const entry = (state.purchaseLog || []).find((x) => x?.id === id);
        if (!entry) return;

        const ing = ingMap.get(entry.ingredientId);
        const ingName = ing?.name || "(unbekannt)";
        const packAmount = Number(ing?.amount) || 0;
        const unit = entry.unit || ing?.unit || "";

        const before = clone(state.purchaseLog);

        const packs0 = Number(entry.packs) || 0;
        const total0 = Number(entry.total) || 0;
        const amount0 = packAmount > 0 ? packs0 * packAmount : Number(entry.buyAmount) || 0;

        buildModal({
          title: `purchaseLog bearbeiten: ${ingName}`,
          okText: "Speichern",
          okClass: "primary",
          contentHTML: `
            <div class="row">
              <label>
                <div class="small">Packungen</div>
                <input id="pl-e-packs" type="number" step="1" min="0" value="${esc(packs0)}" />
              </label>
              <label>
                <div class="small">Preis (€)</div>
                <input id="pl-e-total" type="number" step="0.01" min="0" value="${esc(total0.toFixed(2))}" />
              </label>
            </div>
            <div class="small muted2" style="margin-top:8px;">
              Menge: <b id="pl-e-amount">${esc(Number(amount0.toFixed(4)))}</b> ${esc(unit)}
              ${packAmount > 0 ? `(Grundlage: ${esc(packAmount)} ${esc(unit)} pro Packung)` : ``}
            </div>
          `,
          onConfirm: (m, close) => {
            const packs = Number(m.querySelector("#pl-e-packs")?.value) || 0;
            const tot = Number(m.querySelector("#pl-e-total")?.value) || 0;

            entry.packs = packs;
            entry.total = tot;
            if (packAmount > 0) {
              entry.buyAmount = packs * packAmount;
              entry.unit = unit;
            }

            setUndo({ purchaseLog: before }, "purchaseLog-Eintrag bearbeitet.");
            persist();
            close();
            rerender();
          }
        });
      }
    });
  };
})();
