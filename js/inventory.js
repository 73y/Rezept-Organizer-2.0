(() => {
  // UI-only state (nicht im LocalStorage): welche Aktionen-Menüs offen sind
  const ui = {
    openIngredientMenus: new Set(),
    _toggleBound: false
  };
  const esc = (s) => (window.utils?.esc ? window.utils.esc(s) : String(s ?? ""));
  const toNum = (v) => (window.utils?.toNumber ? window.utils.toNumber(v) : (window.models?.toNumber ? window.models.toNumber(v) : Number(v)));
  const euro = (v) => (window.utils?.euro ? window.utils.euro(v) : (window.models?.euro ? window.models.euro(v) : `${(Number(v) || 0).toFixed(2)} €`));
  const uid = () => (window.utils?.uid ? window.utils.uid() : (window.models?.uid ? window.models.uid() : Math.random().toString(36).slice(2, 10)));
  const clone = (obj) => (window.utils?.clone ? window.utils.clone(obj) : JSON.parse(JSON.stringify(obj)));

  const DAY = 24 * 60 * 60 * 1000;

  // ---- undo (in-memory, 10s) ----
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

  function applyUndo(state, persist) {
    if (!undoSnapshot) return;
    state.pantry = undoSnapshot.pantry;
    state.settings = undoSnapshot.settings;
    if (undoSnapshot && Object.prototype.hasOwnProperty.call(undoSnapshot, 'wasteLog')) state.wasteLog = Array.isArray(undoSnapshot.wasteLog) ? undoSnapshot.wasteLog : [];

    // Optional: nach Undo wieder sauber mergen
    if (typeof normalizePantry === "function") normalizePantry(state);

    clearUndo();
    persist();
    window.app.navigate("inventory");
  }

  function getIng(state, id) {
    return (state.ingredients || []).find((x) => x.id === id) || null;
  }

  // ---- Grundstein-Preis (Ingredient ist die Wahrheit) ----
  function unitCostFromIngredient(ing) {
    const packSize = Number(ing?.amount) || 0;
    const packPrice = Number(ing?.price) || 0;
    if (Number.isFinite(packSize) && packSize > 0 && Number.isFinite(packPrice) && packPrice >= 0) {
      return packPrice / packSize;
    }
    return null;
  }

  function round2(n) {
    return Number((Number(n) || 0).toFixed(2));
  }

  function costForAmount(amount, ing) {
    const uc = unitCostFromIngredient(ing);
    if (uc === null) {
      // Fallback: wenn kein Grundstein vorhanden ist, nutze gespeicherten Wert
      return null;
    }
    return round2((Number(amount) || 0) * uc);
  }

  // Re-Preisung: sorgt dafür, dass alte/kaputte Werte sofort wieder stimmen
  function repriceLotsForIngredient(state, ingredientId) {
    const ing = getIng(state, ingredientId);
    const uc = unitCostFromIngredient(ing);
    if (uc === null) return false;

    let changed = false;
    for (const p of state.pantry || []) {
      if (p?.ingredientId !== ingredientId) continue;
      const nextCost = round2((Number(p.amount) || 0) * uc);
      if (Number(p.cost) !== nextCost || Number(p.unitCost) !== uc) {
        p.unitCost = uc;
        p.cost = nextCost;
        changed = true;
      }
    }
    return changed;
  }

  function repriceAllPantry(state) {
    let changed = false;
    const ids = new Set((state.pantry || []).map((p) => p?.ingredientId).filter(Boolean));
    for (const id of ids) {
      if (repriceLotsForIngredient(state, id)) changed = true;
    }
    return changed;
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("de-DE");
  }

  function isManualLot(p) {
    return p?.source === "manual";
  }

  function lotDateLabel(p) {
    return isManualLot(p) ? "Eingetragen" : "Gekauft";
  }

  function lotDateValue(p) {
    return (isManualLot(p) ? p?.enteredAt : p?.boughtAt) ?? p?.boughtAt ?? null;
  }


  function dateRangeForLots(lots, key) {
    const times = (lots || [])
      .map((x) => parseDateMaybe(x?.[key])?.getTime())
      .filter((t) => Number.isFinite(t));
    if (!times.length) return "—";
    const min = Math.min(...times);
    const max = Math.max(...times);
    const a = new Date(min).toLocaleDateString("de-DE");
    const b = new Date(max).toLocaleDateString("de-DE");
    return min === max ? a : `${a}–${b}`;
  }

  function parseDateMaybe(v) {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function daysLeftISO(expiresAt) {
    const d = parseDateMaybe(expiresAt);
    if (!d) return null;
    const diff = d.getTime() - Date.now();
    return Math.ceil(diff / DAY);
  }

  function expiryClass(daysLeft) {
    if (daysLeft === null) return "exp-none";
    if (daysLeft <= 1) return "exp-red";
    if (daysLeft <= 3) return "exp-orange";
    if (daysLeft <= 7) return "exp-yellow";
    return "exp-green";
  }

  function expiryPillText(daysLeft) {
    if (daysLeft === null) return "kein Ablauf";
    if (daysLeft < 0) return "abgelaufen";
    if (daysLeft === 0) return "heute";
    if (daysLeft === 1) return "in 1 Tag";
    return `in ${daysLeft} Tagen`;
  }

  function epsilon(unit) {
    return unit === "Stück" ? 0.01 : 0.5;
  }

  // Default-Schritt: Stück = 1, sonst ~10% der Packungsmenge
  function defaultConsumeStep(ing, unit) {
    if (unit === "Stück") return 1;
    const pack = Number(ing?.amount) || 0;
    if (Number.isFinite(pack) && pack > 0) return Math.max(1, Math.round(pack * 0.1));
    return 1;
  }

  function addDaysISO(iso, days) {
    const d = new Date(iso);
    d.setDate(d.getDate() + days);
    return d.toISOString();
  }

  function sortLotsFIFO(a, b) {
    const ae = a.expiresAt ? new Date(a.expiresAt).getTime() : Infinity;
    const be = b.expiresAt ? new Date(b.expiresAt).getTime() : Infinity;
    if (ae !== be) return ae - be;
    const ab = a.boughtAt ? new Date(a.boughtAt).getTime() : 0;
    const bb = b.boughtAt ? new Date(b.boughtAt).getTime() : 0;
    return ab - bb;
  }

  // FIFO-Verbrauch: erst Charge mit frühestem Ablauf
  function consumeFIFO(state, ingredientId, amount, unit) {
    let need = Number(amount) || 0;
    if (need <= 0) return;

    const ing = getIng(state, ingredientId);
    const eps = epsilon(unit);
    const lots = (state.pantry || []).filter((p) => p.ingredientId === ingredientId).slice().sort(sortLotsFIFO);
    if (!lots.length) return;

    const byId = new Map(lots.map((l) => [l.id, l]));

    const uc = unitCostFromIngredient(ing) ?? 0;

    for (const lot of lots) {
      if (need <= 0) break;
      const curAmt = Number(lot.amount) || 0;
      if (curAmt <= eps) continue;

      const take = Math.min(curAmt, need);

      // Grundstein: cost immer aus Ingredient ableiten
      lot.amount = Number((curAmt - take).toFixed(4));
      if (uc > 0) {
        lot.unitCost = uc;
        lot.cost = round2((Number(lot.amount) || 0) * uc);
      }

      need -= take;
    }

    state.pantry = (state.pantry || [])
      .map((p) => (p.ingredientId === ingredientId && byId.has(p.id) ? byId.get(p.id) : p))
      .filter((p) => {
        if (p.ingredientId !== ingredientId) return true;
        return (Number(p.amount) || 0) > eps;
      });

    // Nach Verbrauch nochmal sicher neu bepreisen (falls alte Lots im State hingen)
    repriceLotsForIngredient(state, ingredientId);
  }

  // Schritt "zurücklegen" / korrigieren: wir addieren auf die "neueste" Charge
  function addBackStep(state, ingredientId, amount, unit) {
    const step = Number(amount) || 0;
    if (step <= 0) return;

    const ing = getIng(state, ingredientId);
    const lots = (state.pantry || []).filter((p) => p.ingredientId === ingredientId);
    if (!lots.length) return;

    // Ziel: neueste Charge (spätester Ablauf / sonst spätester Kauf)
    const target = lots
      .slice()
      .sort((a, b) => {
        const ae = a.expiresAt ? new Date(a.expiresAt).getTime() : -Infinity;
        const be = b.expiresAt ? new Date(b.expiresAt).getTime() : -Infinity;
        if (ae !== be) return ae - be;
        const ab = a.boughtAt ? new Date(a.boughtAt).getTime() : 0;
        const bb = b.boughtAt ? new Date(b.boughtAt).getTime() : 0;
        return ab - bb;
      })
      .pop();

    if (!target) return;

    const uc = unitCostFromIngredient(ing) ?? 0;

    const cur = Number(target.amount) || 0;
    target.amount = Number((cur + step).toFixed(4));
    if (uc > 0) {
      target.unitCost = uc;
      target.cost = round2((Number(target.amount) || 0) * uc);
    }

    repriceLotsForIngredient(state, ingredientId);
  }

  function groupPantry(state) {
    const map = new Map();
    for (const p of state.pantry || []) {
      if (!p?.ingredientId) continue;
      if (!map.has(p.ingredientId)) map.set(p.ingredientId, []);
      map.get(p.ingredientId).push(p);
    }

    const groups = [];
    for (const [ingredientId, lots] of map.entries()) {
      const ing = getIng(state, ingredientId);
      const unit = (ing?.unit || lots[0]?.unit || "").toString();
      const sortedLots = lots.slice().sort(sortLotsFIFO);

      const totalAmount = sortedLots.reduce((s, x) => s + (Number(x.amount) || 0), 0);
      // Grundstein: Kosten immer aus Ingredient ableiten
      const totalCost = sortedLots.reduce((s, x) => {
        const c = costForAmount(x.amount, ing);
        return s + (c !== null ? c : (Number(x.cost ?? x.pricePaid ?? 0) || 0));
      }, 0);

      const firstWithExp = sortedLots.find((x) => !!x.expiresAt) || null;
      const earliestExpiresAt = firstWithExp?.expiresAt ?? null;
      const left = earliestExpiresAt ? daysLeftISO(earliestExpiresAt) : null;

      groups.push({
        ingredientId,
        name: ing?.name || "Unbekannte Zutat",
        unit,
        totalAmount,
        totalCost,
        lots: sortedLots,
        earliestExpiresAt,
        daysLeft: left
      });
    }

    groups.sort((a, b) => {
      const ae = a.earliestExpiresAt ? new Date(a.earliestExpiresAt).getTime() : Infinity;
      const be = b.earliestExpiresAt ? new Date(b.earliestExpiresAt).getTime() : Infinity;
      if (ae !== be) return ae - be;
      return a.name.localeCompare(b.name, "de");
    });

    return groups;
  }

  function ensureSettings(state) {
    state.settings ||= {};
    state.settings.pantryConsumeSteps ||= {};
    return state.settings;
  }

  function dateInputFromISO(iso) {
    if (!iso) return "";
    const d = parseDateMaybe(iso);
    if (!d) return "";
    // UTC-Datum aus ISO (funktioniert gut, wenn wir selber ISO mit UTC speichern)
    return new Date(d.getTime()).toISOString().slice(0, 10);
  }

  function isoFromDateInput(value) {
    if (!value) return null;
    const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const da = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo, da, 12, 0, 0)); // 12:00 UTC (vermeidet TZ-Off-by-1)
    return dt.toISOString();
  }

  function dateInputAddDays(days) {
    if (!Number.isFinite(days) || days <= 0) return "";
    const base = new Date();
    base.setDate(base.getDate() + days);
    const y = base.getFullYear();
    const m = String(base.getMonth() + 1).padStart(2, "0");
    const d = String(base.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function buildModal({ title, contentHTML, okText = "Speichern", cancelText = "Abbrechen", okClass = "primary", onConfirm }) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const modal = document.createElement("div");
    modal.className = "modal";
    modal.style.maxWidth = "720px";

    modal.innerHTML = `
      <div class="modal-header">
        <div class="modal-title">${esc(title)}</div>
        <button class="modal-close" data-action="close" title="Schließen">✕</button>
      </div>

      <div class="modal-body">${contentHTML}</div>

      <div class="modal-footer">
        <button data-action="cancel">${esc(cancelText)}</button>
        <button data-action="ok" class="${esc(okClass)}">${esc(okText)}</button>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function close() {
      overlay.remove();
    }

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });

    modal.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-action");
      if (action === "close" || action === "cancel") return close();
      if (action === "ok") return onConfirm?.(modal, close);
    });

    return { overlay, modal, close };
  }

  window.renderInventoryView = function (container, state, persist) {
    if (!Array.isArray(state.pantry)) state.pantry = [];
    if (!Array.isArray(state.wasteLog)) state.wasteLog = [];
    if (!Array.isArray(state.ingredients)) state.ingredients = [];
    const settings = ensureSettings(state);

    // Migration/Drift-Fix: alte Pantry-Werte sofort auf Grundstein-Preis umstellen
    const changed = repriceAllPantry(state);
    if (changed) persist();

    const groups = groupPantry(state);

    // Aufräumen: Menüs für Zutaten entfernen, die es nicht mehr gibt
    for (const id of Array.from(ui.openIngredientMenus)) {
      if (!groups.some((g) => g.ingredientId === id)) ui.openIngredientMenus.delete(id);
    }

    const inventoryTotalCost = groups.reduce((s, g) => s + (Number(g.totalCost) || 0), 0);

    const ings = (state.ingredients || [])
      .slice()
      .sort((a, b) => (a.name || "").localeCompare(b.name || "", "de"));

    const listHtml = groups.length
      ? groups
          .map((g) => {
            const cls = expiryClass(g.daysLeft);
            const pill = expiryPillText(g.daysLeft);

            const allManual = g.lots.every((x) => isManualLot(x));
            const boughtRange = dateRangeForLots(g.lots, allManual ? "enteredAt" : "boughtAt");
            const expRange = dateRangeForLots(g.lots, "expiresAt");

            const ing = getIng(state, g.ingredientId);
            const baseStep = defaultConsumeStep(ing, g.unit);
            const saved = Number(settings.pantryConsumeSteps[g.ingredientId]);
            const stepVal = Number.isFinite(saved) && saved > 0 ? saved : baseStep;

            const wasteLabel = g.daysLeft !== null && g.daysLeft < 0 ? "Abgelaufen" : "Verdorben";

            const hasMultiple = g.lots.length > 1;
            const singleLotId = !hasMultiple ? g.lots[0]?.id : null;

            const lotRow = (p) => {
              const left = p.expiresAt ? daysLeftISO(p.expiresAt) : null;
              const c = expiryClass(left);
              const pill2 = expiryPillText(left);
              const wasteLotLabel = left !== null && left < 0 ? "Abgelaufen" : "Verdorben";
              const lotCost = Number(p.cost ?? p.pricePaid ?? 0) || 0;
              const dLabel = lotDateLabel(p);
              const dVal = lotDateValue(p);

              return `
                <div class="batch-row">
                  <div class="batch-left">
                    <div><b>${esc(Number(p.amount) || 0)}</b> ${esc(g.unit)}</div>
                    <div class="muted2">${esc(dLabel)}: ${esc(fmtDate(dVal))} · Ablauf: ${esc(fmtDate(p.expiresAt))}</div>
                  </div>
                  <div class="batch-right" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; justify-content:flex-end;">
                    <span class="pill ${c}">${esc(pill2)}</span>
                    <span class="muted2" style="white-space:nowrap;">${esc(euro(lotCost))}</span>

                    <details class="lot-actions">
                      <summary title="Aktionen">⋯</summary>
                      <div class="actions-panel" style="min-width:180px;">
                        <button type="button" class="info" data-action="editLot" data-lot-id="${esc(p.id)}">Bearbeiten</button>
                        <button type="button" class="danger" data-action="deleteLot" data-lot-id="${esc(p.id)}">Löschen</button>
                        <button type="button" class="danger" data-action="wasteLot" data-lot-id="${esc(p.id)}">${esc(wasteLotLabel)}</button>
                      </div>
                    </details>
                  </div>
                </div>
              `;
            };

            const lotsHtml = g.lots.map(lotRow).join("");

            const menuOpenAttr = ui.openIngredientMenus.has(g.ingredientId) ? " open" : "";

            return `
              <div class="card pantry-item exp-card ${cls}" data-ingredient="${esc(g.ingredientId)}">
                <div class="pantry-head">
                  <div class="pantry-left">
                    <div class="pantry-title">${esc(g.name)}</div>
                    <span class="pill ${cls} pantry-pill">${esc(pill)}</span>
                  </div>

                  <div class="pantry-right">
                    <div class="pantry-topright">
                      <div class="pantry-cost">Wert: <b>${esc(euro(Number(g.totalCost) || 0))}</b></div>

                      <details class="actions-menu"${menuOpenAttr}>
                        <summary title="Aktionen">⋯</summary>
                        <div class="actions-panel">
                          <div class="actions-row">
                            <button type="button" data-action="consumeStep" data-ingredient-id="${esc(g.ingredientId)}" title="Schritt verbrauchen">−</button>
                            <input
                              data-step="${esc(g.ingredientId)}"
                              class="step-input"
                              type="number"
                              inputmode="decimal"
                              min="0"
                              step="${esc(baseStep)}"
                              value="${esc(stepVal)}"
                              title="Schrittgröße (Minus/Plus)"
                            />
                            <button type="button" data-action="addStep" data-ingredient-id="${esc(g.ingredientId)}" title="Schritt zurücklegen / hinzufügen">+</button>
                            <button type="button" class="warn" data-action="consumeAll" data-ingredient-id="${esc(g.ingredientId)}" title="Alles verbrauchen">Verbraucht</button>
                          </div>

                          <div class="actions-row" style="justify-content:flex-end;">
                            ${
                              !hasMultiple && singleLotId
                                ? `
                                  <button type="button" class="info" data-action="editLot" data-lot-id="${esc(singleLotId)}">Bearbeiten</button>
                                  <button type="button" class="danger" data-action="deleteLot" data-lot-id="${esc(singleLotId)}">Löschen</button>
                                `
                                : `
                                  <span class="small muted2">Chargen unten ausklappen</span>
                                `
                            }
                          </div>

                          <div class="actions-row" style="justify-content:flex-end;">
                            <button type="button" class="danger" data-action="wasteIngredient" data-ingredient-id="${esc(g.ingredientId)}" title="Als verdorben/abgelaufen entfernen">${esc(wasteLabel)}</button>
                          </div>
                        </div>
                      </details>
                    </div>
                  </div>
                </div>

                <div class="pantry-footer">
                  <div class="pantry-amountline"><b>${esc(Number(g.totalAmount.toFixed(4)))}</b> ${esc(g.unit)}</div>
                  <div class="pantry-dates-right muted2">
                    <div>${esc(allManual ? "Eingetragen" : "Gekauft")}: ${esc(boughtRange)}</div>
                    <div>Ablauf: ${esc(expRange)}</div>
                  </div>
                </div>

                ${
                  hasMultiple
                    ? `
                      <details class="batch-details batch-details-compact">
                        <summary>Chargen (${esc(g.lots.length)})</summary>
                        <div class="batch-list">${lotsHtml}</div>
                      </details>
                    `
                    : ``
                }
              </div>
            `;
          })
          .join("")
      : `<p class="small">Noch leer. Einkauf abhaken → landet hier.</p>`;


    const toast = undoSnapshot
      ? `
        <div class="toast-float" style="position:fixed; left:50%; bottom:18px; transform:translateX(-50%); z-index:9999;">
          <div class="toast-inner" style="display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--border); border-radius:14px; background: color-mix(in srgb, var(--panel) 92%, transparent); box-shadow:0 14px 40px rgba(0,0,0,0.55);">
            <div class="small" style="opacity:0.95;">${esc(undoMessage || "Aktion durchgeführt.")}</div>
            <button data-action="undo">Rückgängig</button>
            <button data-action="toastClose" title="Schließen" style="min-width:40px;">✕</button>
          </div>
        </div>
      `
      : "";

    container.innerHTML = `
      <div class="card">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
          <div>
            <h2 style="margin:0 0 6px 0;">Vorrat</h2>
            <p class="small" style="margin:0;">Aktionen pro Zutat über „⋯“. Hinzufügen über „+“.</p>
          </div>

          <div style="text-align:right;">
            <div class="small muted2">Gesamtwert</div>
            <div style="font-weight:750; font-size:18px; line-height:1.1;">${esc(euro(inventoryTotalCost))}</div>
          </div>
        </div>
      </div>

      <div class="card">
        <h3 style="margin:0 0 10px 0;">Bestand</h3>
        ${listHtml}
      </div>
      <button class="fab" type="button" data-action="openAdd" title="Zum Vorrat hinzufügen">+</button>
      ${toast}
    `;

    // Toggle-Tracking für <details>: damit Menüs nach einem Re-Render offen bleiben
    if (!ui._toggleBound) {
      ui._toggleBound = true;
      container.addEventListener(
        "toggle",
        (e) => {
          const details = e.target;
          if (!(details instanceof HTMLDetailsElement)) return;

          // Haupt-Menü pro Zutat
          if (details.classList.contains("actions-menu")) {
            const card = details.closest(".pantry-item");
            const ingId = card?.getAttribute("data-ingredient");
            if (!ingId) return;
            if (details.open) ui.openIngredientMenus.add(ingId);
            else ui.openIngredientMenus.delete(ingId);
          }
        },
        true
      );
    }

    // Stepgröße per Ingredient speichern (Input ist die Schrittgröße)
    container.oninput = (e) => {
      const input = e.target.closest("input[data-step]");
      if (!input) return;
      const ingId = input.getAttribute("data-step");
      const v = toNum(input.value);
      if (!Number.isFinite(v) || v <= 0) return;
      settings.pantryConsumeSteps[ingId] = v;
      persist();
    };

    // Buttons: Schritt verbrauchen / zurücklegen / alles verbrauchen + Edit/Delete
    container.onclick = (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;

      const action = btn.getAttribute("data-action");

      // toast actions
      if (action === "undo") {
        applyUndo(state, persist);
        return;
      }
      if (action === "toastClose") {
        clearUndo();
        window.app.navigate("inventory");
        return;
      }

      // Floating + : Zum Vorrat hinzufügen
      if (action === "openAdd") {
        if (!ings.length) {
          buildModal({
            title: "Zum Vorrat hinzufügen",
            contentHTML: `<p class="small">Bitte erst Zutaten anlegen.</p>`,
            okText: "OK",
            cancelText: "Schließen",
            okClass: "primary",
            onConfirm: (_m, close) => close()
          });
          return;
        }

        const content = `
          <div class="row">
            <div>
              <label class="small">Zutat</label><br/>
              <select id="a-ing">
                <option value="">— auswählen —</option>
                ${ings.map((i) => `<option value="${esc(i.id)}">${esc(i.name)} (${esc(i.amount)} ${esc(i.unit)})</option>`).join("")}
              </select>
              <div class="small muted2" style="margin-top:6px;" id="a-packinfo">—</div>
            </div>
            <div>
              <label class="small">Menge</label><br/>
              <div style="display:flex; gap:8px; align-items:center;">
                <input id="a-amount" type="number" step="0.1" min="0" value="" style="width:140px;"/>
                <span class="small muted2" id="a-unit">—</span>
              </div>
              <div class="small" style="margin-top:6px;" id="a-calc">—</div>
            </div>
            <div>
              <label class="small">Ablaufdatum</label><br/>
              <input id="a-exp" type="date" value=""/>
              <div class="small muted2" style="margin-top:6px;">Optional, aber empfohlen.</div>
            </div>
          </div>
        `;

        const { modal } = buildModal({
          title: "Zum Vorrat hinzufügen",
          contentHTML: content,
          okText: "Hinzufügen",
          okClass: "success",
          onConfirm: (m, close) => {
            const ingId = m.querySelector("#a-ing")?.value || "";
            const ing = getIng(state, ingId);
            if (!ing) return;

            const amt = toNum(m.querySelector("#a-amount")?.value);
            if (!Number.isFinite(amt) || amt <= 0) return;

            const packSize = Number(ing.amount) || 0;
            const packPrice = Number(ing.price) || 0;
            const packs = packSize > 0 ? amt / packSize : 0;
            const cost = Number.isFinite(packs) ? Number((packs * packPrice).toFixed(2)) : 0;
            const unitCost = packSize > 0 ? packPrice / packSize : (amt > 0 ? cost / amt : 0);

            const expRaw = m.querySelector("#a-exp")?.value || "";
            const expiresAt = expRaw ? isoFromDateInput(expRaw) : null;

            const snap = { pantry: clone(state.pantry), settings: clone(state.settings), wasteLog: clone(state.wasteLog) };

            const now = new Date().toISOString();
            state.pantry.push({
              id: uid(),
              ingredientId: ing.id,
              amount: Number(amt.toFixed(4)),
              unit: ing.unit,
              boughtAt: now,
              enteredAt: now,
              source: "manual",
              expiresAt,
              cost,
              unitCost: Number.isFinite(unitCost) ? Number(unitCost.toFixed(6)) : 0
            });

            if (typeof normalizePantry === "function") normalizePantry(state);

            setUndo(snap, "Zum Vorrat hinzugefügt.");
            persist();
            close();
            window.app.navigate("inventory");
          }
        });

        const sel = modal.querySelector("#a-ing");
        const amountEl = modal.querySelector("#a-amount");
        const unitEl = modal.querySelector("#a-unit");
        const calcEl = modal.querySelector("#a-calc");
        const packInfoEl = modal.querySelector("#a-packinfo");
        const expEl = modal.querySelector("#a-exp");

        function updateCalc() {
          const ing = getIng(state, sel?.value);
          if (!ing) {
            if (unitEl) unitEl.textContent = "—";
            if (calcEl) calcEl.textContent = "—";
            if (packInfoEl) packInfoEl.textContent = "—";
            if (expEl) expEl.value = "";
            return;
          }

          const unit = (ing.unit || "").toString();
          if (unitEl) unitEl.textContent = unit;

          const packSize = Number(ing.amount) || 0;
          const packPrice = Number(ing.price) || 0;
          if (packInfoEl) packInfoEl.textContent = packSize > 0 ? `Packung: ${packSize} ${unit} · ${euro(packPrice)}` : `Packung: —`;

          if (amountEl && !amountEl.value) {
            amountEl.value = packSize > 0 ? String(packSize) : "";
          }

          if (amountEl) amountEl.step = unit === "Stück" ? "1" : "0.1";

          const amt = toNum(amountEl?.value);
          if (!Number.isFinite(amt) || amt <= 0 || packSize <= 0) {
            if (calcEl) calcEl.textContent = "—";
          } else {
            const packs = amt / packSize;
            const cost = packs * packPrice;
            const packsTxt = Number.isFinite(packs) ? packs.toFixed(2) : "—";
            if (calcEl) calcEl.textContent = `Entspricht ca. ${packsTxt} Packung(en) · Wert: ${euro(cost)}`;
          }

          if (expEl && !expEl.value) {
            const days = Number(ing.shelfLifeDays || 0);
            expEl.value = days > 0 ? dateInputAddDays(days) : "";
          }
        }

        if (sel) sel.addEventListener("change", () => {
          if (amountEl) amountEl.value = "";
          if (expEl) expEl.value = "";
          updateCalc();
        });
        if (amountEl) amountEl.addEventListener("input", updateCalc);

        updateCalc();
        return;
      }

      // lot actions
      if (action === "deleteLot" || action === "editLot" || action === "wasteLot") {
        const lotId = btn.getAttribute("data-lot-id");
        if (!lotId) return;

        const lot = (state.pantry || []).find((p) => p.id === lotId);
        if (!lot) return;

        if (action === "deleteLot") {
          const snap = { pantry: clone(state.pantry), settings: clone(state.settings), wasteLog: clone(state.wasteLog) };
          state.pantry = (state.pantry || []).filter((p) => p.id !== lotId);

          if (typeof normalizePantry === "function") normalizePantry(state);

          setUndo(snap, "Charge gelöscht.");
          persist();
          window.app.navigate("inventory");
          return;
        if (action === "wasteLot") {
          // Verdorben/abgelaufen entsorgen (mit Log für Stats)
          if (!Array.isArray(state.wasteLog)) state.wasteLog = [];
          const ing = getIng(state, lot.ingredientId);
          const unit = (ing?.unit || lot.unit || "").toString();
          const amount = Number(lot.amount) || 0;
          const cost = costForAmount(amount, ing);
          const lotCost = cost !== null ? cost : (Number(lot.cost ?? lot.pricePaid ?? 0) || 0);

          const snap = { pantry: clone(state.pantry), settings: clone(state.settings), wasteLog: clone(state.wasteLog) };

          state.wasteLog.push({
            id: uid(),
            at: new Date().toISOString(),
            ingredientId: lot.ingredientId,
            amount: Number(amount.toFixed(4)),
            unit,
            cost: round2(lotCost)
          });

          state.pantry = (state.pantry || []).filter((p) => p.id !== lotId);

          if (typeof normalizePantry === "function") normalizePantry(state);

          setUndo(snap, "Als verdorben entfernt.");
          persist();
          window.app.navigate("inventory");
          return;
        }

        }

        // editLot
        const ing = getIng(state, lot.ingredientId);
        const unit = (ing?.unit || lot.unit || "").toString();
        const autoCostNow = costForAmount(lot.amount, ing);
        const lotCostNow = autoCostNow !== null ? autoCostNow : (Number(lot.cost ?? lot.pricePaid ?? 0) || 0);

        const content = `
          <div class="row">
            <div>
              <label class="small">Menge (${esc(unit)})</label><br/>
              <input id="e-amount" type="number" step="0.1" min="0" value="${esc(Number(lot.amount) || 0)}"/>
            </div>
            <div>
              <label class="small">Ablaufdatum</label><br/>
              <input id="e-exp" type="date" value="${esc(dateInputFromISO(lot.expiresAt))}"/>
              <div class="small" style="margin-top:6px;">Leer lassen = kein Ablaufdatum.</div>
            </div>
            <div>
              <label class="small">Wert</label><br/>
              <div class="pill" style="display:inline-block; margin-top:6px;">${esc(euro(lotCostNow))}</div>
              <div class="small muted2" style="margin-top:6px;">Wert wird automatisch aus der Zutat berechnet (Packungspreis + Packungsmenge).</div>
            </div>
          </div>
        `;

        buildModal({
          title: `Charge bearbeiten: ${esc(ing?.name || "Zutat")}`,
          contentHTML: content,
          okText: "Speichern",
          okClass: "success",
          onConfirm: (modal, close) => {
            const snap = { pantry: clone(state.pantry), settings: clone(state.settings), wasteLog: clone(state.wasteLog) };

            const amount = toNum(modal.querySelector("#e-amount")?.value);
            if (!Number.isFinite(amount) || amount <= 0) return;

            const expRaw = modal.querySelector("#e-exp")?.value || "";
            const expiresAt = expRaw ? isoFromDateInput(expRaw) : null;

            const p = (state.pantry || []).find((x) => x.id === lotId);
            if (!p) return;

            p.amount = Number(amount.toFixed(4));
            p.expiresAt = expiresAt;

            // Grundstein: Wert immer aus Ingredient ableiten
            repriceLotsForIngredient(state, p.ingredientId);

            if (typeof normalizePantry === "function") normalizePantry(state);

            setUndo(snap, "Charge bearbeitet.");
            persist();
            close();
            window.app.navigate("inventory");
          }
        });

        return;
      }

      // ingredient actions
      const ingId = btn.getAttribute("data-ingredient-id");
      if (!ingId) return;

      const g = groups.find((x) => x.ingredientId === ingId);
      const ing = getIng(state, ingId);
      const unit = (g?.unit || ing?.unit || "").toString();
      const baseStep = defaultConsumeStep(ing, unit);
      const stepVal = Number(settings.pantryConsumeSteps[ingId]) || baseStep;


      if (action === "wasteIngredient") {
        if (!Array.isArray(state.wasteLog)) state.wasteLog = [];
        const snap = { pantry: clone(state.pantry), settings: clone(state.settings), wasteLog: clone(state.wasteLog) };

        const lots = (state.pantry || []).filter((p) => p.ingredientId === ingId);
        const totalAmount = lots.reduce((s, p) => s + (Number(p.amount) || 0), 0);

        // Grundstein: Kosten aus Ingredient ableiten (Fallback: gespeicherter cost)
        const totalCost = lots.reduce((s, p) => {
          const c = costForAmount(p.amount, ing);
          return s + (c !== null ? c : (Number(p.cost ?? p.pricePaid ?? 0) || 0));
        }, 0);

        if (totalAmount > epsilon(unit)) {
          state.wasteLog.push({
            id: uid(),
            at: new Date().toISOString(),
            ingredientId: ingId,
            amount: Number(totalAmount.toFixed(4)),
            unit,
            cost: round2(totalCost)
          });
        }

        state.pantry = (state.pantry || []).filter((p) => p.ingredientId !== ingId);

        if (typeof normalizePantry === "function") normalizePantry(state);

        setUndo(snap, "Als verdorben entfernt.");
        persist();
        window.app.navigate("inventory");
        return;
      }

      if (action === "consumeStep") {
        const snap = { pantry: clone(state.pantry), settings: clone(state.settings), wasteLog: clone(state.wasteLog) };
        consumeFIFO(state, ingId, stepVal, unit);

        if (typeof normalizePantry === "function") normalizePantry(state);

        setUndo(snap, `− ${stepVal} ${unit} verbraucht.`);
        persist();
        window.app.navigate("inventory");
        return;
      }

      if (action === "addStep") {
        const snap = { pantry: clone(state.pantry), settings: clone(state.settings), wasteLog: clone(state.wasteLog) };
        addBackStep(state, ingId, stepVal, unit);

        if (typeof normalizePantry === "function") normalizePantry(state);

        setUndo(snap, `+ ${stepVal} ${unit} hinzugefügt.`);
        persist();
        window.app.navigate("inventory");
        return;
      }

      if (action === "consumeAll") {
        const snap = { pantry: clone(state.pantry), settings: clone(state.settings), wasteLog: clone(state.wasteLog) };
        const total = (state.pantry || [])
          .filter((p) => p.ingredientId === ingId)
          .reduce((s, p) => s + (Number(p.amount) || 0), 0);

        if (total > epsilon(unit)) {
          consumeFIFO(state, ingId, total, unit);
        }

        if (typeof normalizePantry === "function") normalizePantry(state);

        setUndo(snap, "Alles verbraucht.");
        persist();
        window.app.navigate("inventory");
      }
    };
  };
})();
