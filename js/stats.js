(() => {
  const DAY = 24 * 60 * 60 * 1000;

  // UI-only state (nicht im LocalStorage): Zeitraum-Auswahl
  let RANGE_MODE = "30d"; // "7d" | "30d" | "month" | "year"

  function setRangeMode(mode) {
    if (!["7d", "30d", "month", "year"].includes(mode)) mode = "30d";
    RANGE_MODE = mode;
    try {
      const c = document.querySelector("#view-stats");
      const s = window.app?.getState ? window.app.getState() : null;
      if (c && s) window.renderStatsView(c, s);
    } catch (_) {}
  }

  // Expose for inline onclick
  window.statsSetRange = setRangeMode;
  const esc = (s) => (window.utils?.esc ? window.utils.esc(s) : String(s ?? ""));
  const euro = (n) => (window.utils?.euro ? window.utils.euro(n) : (window.models?.euro ? window.models.euro(Number(n) || 0) : `${(Number(n) || 0).toFixed(2)} €`));
  const parseDateMaybe = window.utils?.parseDateMaybe || function (v) {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function fmtTimer(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(sec / 60);
    const r = sec % 60;
    return `${m}:${String(r).padStart(2, "0")}`;
  }

  function startOfMonth(d) {
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }
  function startOfYear(d) {
    return new Date(d.getFullYear(), 0, 1);
  }

  function rangeInfo(now) {
    if (RANGE_MODE === "7d") {
      return { key: "7d", label: "7 Tage", start: new Date(now.getTime() - 7 * DAY), days: 7 };
    }
    if (RANGE_MODE === "month") {
      const start = startOfMonth(now);
      const days = Math.max(1, Math.ceil((now.getTime() - start.getTime()) / DAY));
      return { key: "month", label: "Monat", start, days };
    }
    if (RANGE_MODE === "year") {
      const start = startOfYear(now);
      const days = Math.max(1, Math.ceil((now.getTime() - start.getTime()) / DAY));
      return { key: "year", label: "Jahr", start, days };
    }
    // default 30d
    return { key: "30d", label: "30 Tage", start: new Date(now.getTime() - 30 * DAY), days: 30 };
  }

  function collectCookEntries(state) {
    const out = [];
    for (const r of state.recipes || []) {
      const h = r?.cookHistory;
      if (!Array.isArray(h)) continue;
      for (const e of h) {
        const at = parseDateMaybe(e.at);
        const seconds = Number(e.seconds) || 0;
        if (!at || seconds <= 0) continue;
        out.push({ at, seconds, recipeId: r.id, recipeName: r.name || "Unbenannt" });
      }
    }
    return out;
  }

  function findIngredient(state, id) {
    return (state.ingredients || []).find((x) => x.id === id) || null;
  }

  // purchaseLog: [{ id, at, total, ingredientId, packs, buyAmount, unit }]
  function collectPurchaseItems(state) {
    const arr = Array.isArray(state.purchaseLog) ? state.purchaseLog : [];
    return arr
      .map((e) => ({
        id: e?.id,
        at: parseDateMaybe(e?.at),
        atISO: String(e?.at || ""),
        total: Number(e?.total) || 0,
        ingredientId: e?.ingredientId || null,
        packs: Number(e?.packs) || 0,
        buyAmount: Number(e?.buyAmount) || 0,
        unit: (e?.unit || "").toString()
      }))
      .filter((x) => x.at && Number.isFinite(x.total) && x.total > 0);
  }

  function collectPurchaseEntries(state) {
    return collectPurchaseItems(state).map((x) => ({ at: x.at, total: x.total }));
  }


  function collectWasteEntries(state) {
    const arr = Array.isArray(state.wasteLog) ? state.wasteLog : [];
    return arr
      .map((e) => ({
        id: e?.id,
        at: parseDateMaybe(e?.at),
        atISO: String(e?.at || ""),
        ingredientId: e?.ingredientId || null,
        amount: Number(e?.amount) || 0,
        unit: (e?.unit || "").toString(),
        total: Number(e?.cost ?? e?.total ?? 0) || 0
      }))
      .filter((x) => x.at && x.total > 0);
  }

  function sumSeconds(entries) {
    return entries.reduce((a, x) => a + (Number(x.seconds) || 0), 0);
  }
  function sumMoney(entries) {
    return entries.reduce((a, x) => a + (Number(x.total) || 0), 0);
  }

  function avgPerDay(total, days) {
    if (!Number.isFinite(total) || days <= 0) return 0;
    return total / days;
  }

  function topRecipes(entries, fromDate, limit = 8) {
    const m = new Map(); // id -> {name,count,seconds}
    for (const e of entries) {
      if (e.at < fromDate) continue;
      const cur = m.get(e.recipeId) || { name: e.recipeName, count: 0, seconds: 0 };
      cur.count += 1;
      cur.seconds += e.seconds;
      m.set(e.recipeId, cur);
    }
    return Array.from(m.entries())
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.count - a.count || b.seconds - a.seconds)
      .slice(0, limit);
  }

  function topRecipesByTime(entries, fromDate, limit = 8) {
    const m = new Map();
    for (const e of entries) {
      if (e.at < fromDate) continue;
      const cur = m.get(e.recipeId) || { name: e.recipeName, count: 0, seconds: 0 };
      cur.count += 1;
      cur.seconds += e.seconds;
      m.set(e.recipeId, cur);
    }
    return Array.from(m.entries())
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.seconds - a.seconds || b.count - a.count)
      .slice(0, limit);
  }

  function topIngredientsBySpend(state, purchaseItems, fromDate, limit = 8) {
    const m = new Map();
    for (const e of purchaseItems) {
      if (e.at < fromDate) continue;
      const id = e.ingredientId || "__unknown";
      const ing = e.ingredientId ? findIngredient(state, e.ingredientId) : null;
      const name = ing?.name || (e.ingredientId ? "Gelöschte Zutat" : "Unbekannt");
      const unit = (ing?.unit || e.unit || "").toString();
      const cur = m.get(id) || { name, unit, total: 0, packs: 0, amount: 0, count: 0 };
      cur.total += Number(e.total) || 0;
      cur.packs += Number(e.packs) || 0;
      cur.amount += Number(e.buyAmount) || 0;
      cur.count += 1;
      m.set(id, cur);
    }
    return Array.from(m.entries())
      .map(([id, v]) => ({ id, ...v, total: Number((v.total || 0).toFixed(2)) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, limit);
  }

  function topIngredientsByWaste(state, wasteItems, fromDate, limit = 6) {
    const m = new Map();
    for (const e of wasteItems) {
      if (e.at < fromDate) continue;
      const id = e.ingredientId || "__unknown";
      const ing = e.ingredientId ? findIngredient(state, e.ingredientId) : null;
      const name = ing?.name || (e.ingredientId ? "Gelöschte Zutat" : "Unbekannt");
      const unit = (ing?.unit || e.unit || "").toString();
      const cur = m.get(id) || { name, unit, total: 0, amount: 0, count: 0 };
      cur.total += Number(e.total) || 0;
      cur.amount += Number(e.amount) || 0;
      cur.count += 1;
      m.set(id, cur);
    }
    return Array.from(m.entries())
      .map(([id, v]) => ({ id, ...v, total: Number((v.total || 0).toFixed(2)) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, limit);
  }

  function segButton(mode, label) {
    const active = RANGE_MODE === mode ? "active" : "";
    return `<button type="button" class="seg-btn ${active}" onclick="window.statsSetRange('${esc(mode)}')">${esc(label)}</button>`;
  }

  window.renderStatsView = function (container, state) {
    const now = new Date();
    const range = rangeInfo(now);

    const cooks = collectCookEntries(state);
    const cooksRange = cooks.filter((x) => x.at >= range.start);
    const secRange = sumSeconds(cooksRange);
    const avgCookSession = cooksRange.length ? Math.round(secRange / cooksRange.length) : 0;
    const avgCookDay = avgPerDay(secRange, range.days);

    const topCount = topRecipes(cooks, range.start, 8);
    const topTime = topRecipesByTime(cooks, range.start, 8);

    const purchaseItems = collectPurchaseItems(state);
    const buys = purchaseItems.map((x) => ({ at: x.at, total: x.total }));
    const buysRange = buys.filter((x) => x.at >= range.start);
    const spentRange = sumMoney(buysRange);


    const waste = collectWasteEntries(state);
    const wasteRangeArr = waste.filter((x) => x.at >= range.start);
    const wastedRange = sumMoney(wasteRangeArr);

    const hasSpend = buys.length > 0 || (Array.isArray(state.wasteLog) && state.wasteLog.length > 0);

    const topRecipesCountHtml = topCount.length
      ? topCount
          .map(
            (x, i) => `
              <div class="small" style="display:flex; justify-content:space-between; gap:10px; padding:6px 0; border-top:1px solid var(--border);">
                <div>${esc(i + 1)}. ${esc(x.name)}</div>
                <div style="opacity:0.85;">${esc(x.count)}× · ${esc(fmtTime(x.seconds))}</div>
              </div>
            `
          )
          .join("")
      : `<p class="small">Noch keine Kochdaten – sobald du „Kochen → Fertig gekocht“ benutzt, füllt sich das.</p>`;

    const topRecipesTimeHtml = topTime.length
      ? topTime
          .map(
            (x, i) => `
              <div class="small" style="display:flex; justify-content:space-between; gap:10px; padding:6px 0; border-top:1px solid var(--border);">
                <div>${esc(i + 1)}. ${esc(x.name)}</div>
                <div style="opacity:0.85;">${esc(fmtTime(x.seconds))} · ${esc(x.count)}×</div>
              </div>
            `
          )
          .join("")
      : `<p class="small">Noch keine Kochdaten.</p>`;

    const topIngSpend = topIngredientsBySpend(state, purchaseItems, range.start, 8);
    const topIngWaste = topIngredientsByWaste(state, waste, range.start, 6);

    const topIngHtml = topIngSpend.length
      ? topIngSpend
          .map(
            (x, i) => `
              <div class="small" style="display:flex; justify-content:space-between; gap:10px; padding:6px 0; border-top:1px solid var(--border);">
                <div style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(i + 1)}. ${esc(x.name)}</div>
                <div style="opacity:0.92; white-space:nowrap;">${esc(euro(x.total))}</div>
              </div>
            `
          )
          .join("")
      : `<p class="small">Noch keine Einkäufe im purchaseLog.</p>`;

    const topWasteHtml = topIngWaste.length
      ? topIngWaste
          .map(
            (x) => `
              <div class="small" style="display:flex; justify-content:space-between; gap:10px; padding:6px 0; border-top:1px solid var(--border);">
                <div style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(x.name)}</div>
                <div style="opacity:0.92; white-space:nowrap;">${esc(euro(x.total))}</div>
              </div>
            `
          )
          .join("")
      : `<p class="small">Noch kein Verderb geloggt.</p>`;

    const lastCook = cooks
      .slice()
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .filter((x) => x.at >= range.start)
      .slice(0, 5);
    const lastCookHtml = lastCook.length
      ? lastCook
          .map((e) => `
            <div class="small" style="display:flex; justify-content:space-between; gap:10px; padding:6px 0; border-top:1px solid var(--border);">
              <div style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(e.recipeName)}</div>
              <div style="opacity:0.85; white-space:nowrap;">${esc(fmtTime(e.seconds))}</div>
            </div>
          `)
          .join("")
      : `<p class="small">Noch nichts gekocht.</p>`;

    container.innerHTML = `
      <div class="card">
        <h2 style="margin:0 0 6px 0;">Stats</h2>
        <div class="stats-head">
          <div class="small">Übersicht: Kochzeit, Ausgaben, Top-Listen.</div>
          <div class="seg" role="tablist" aria-label="Zeitraum">
            ${segButton("7d", "7")}
            ${segButton("30d", "30")}
            ${segButton("month", "Monat")}
            ${segButton("year", "Jahr")}
          </div>
        </div>
      </div>

      <div class="row stats-row">
        <div class="card" style="margin:0;">
          <h3 style="margin:0 0 10px 0;">Kochen · ${esc(range.label)}</h3>
          <div class="stats-kpi">
            <div class="stats-kpi-main">${esc(fmtTime(secRange))}</div>
            <div class="small">${esc(cooksRange.length)}× gekocht · Ø/Session <b>${esc(fmtTimer(avgCookSession))}</b> · Ø/Tag <b>${esc(fmtTime(avgCookDay))}</b></div>
          </div>
        </div>

        <div class="card" style="margin:0;">
          <h3 style="margin:0 0 10px 0;">Zuletzt gekocht</h3>
          ${lastCookHtml}
          <div style="display:flex; justify-content:flex-end; margin-top:10px; gap:10px; flex-wrap:wrap;">
            <button type="button" class="info" onclick="window.app.navigate('cookhistory')">CookHistory verwalten</button>
          </div>
        </div>
      </div>

      <div class="row stats-row">
        <div class="card" style="margin:0;">
          <h3 style="margin:0 0 10px 0;">Top Rezepte (${esc(range.label)})</h3>
          <div class="small" style="opacity:0.85; margin-bottom:6px;">nach Häufigkeit</div>
          ${topRecipesCountHtml}
        </div>

        <div class="card" style="margin:0;">
          <h3 style="margin:0 0 10px 0;">Top Kochzeit (${esc(range.label)})</h3>
          <div class="small" style="opacity:0.85; margin-bottom:6px;">nach Gesamtzeit</div>
          ${topRecipesTimeHtml}
        </div>
      </div>

      <div class="card">
        <h3 style="margin:0 0 10px 0;">Ausgaben</h3>

        ${
          hasSpend
            ? `
              <div class="row" style="margin-top:10px;">
                <div class="card" style="margin:0; padding:12px;">
                  <div class="small" style="opacity:0.85;">Ausgaben · ${esc(range.label)}</div>
                  <div class="stats-kpi-main" style="margin-top:6px;">${esc(euro(spentRange))}</div>
                  <div class="small" style="margin-top:6px;">Ø/Tag: <b>${esc(euro(avgPerDay(spentRange, range.days)))}</b></div>
                </div>

                <div class="card" style="margin:0; padding:12px;">
                  <div class="small" style="opacity:0.85;">Verdorben · ${esc(range.label)}</div>
                  <div class="stats-kpi-main" style="margin-top:6px;">${esc(euro(wastedRange))}</div>
                  <div class="small" style="margin-top:6px;">Ø/Tag: <b>${esc(euro(avgPerDay(wastedRange, range.days)))}</b></div>
                </div>
              </div>
            `
            : `
              <p class="small" style="opacity:0.9;">
                Ausgaben/Verderb-Stats sind vorbereitet, aber es gibt noch keine Daten.
                Nächster Schritt: Wenn du in der Einkaufsliste „gekauft“ abhakst, schreiben wir einen Log-Eintrag (Datum + Betrag).
              </p>
            `
        }

        <div style="display:flex; justify-content:flex-end; margin-top:10px; gap:10px; flex-wrap:wrap;">
          <button type="button" onclick="window.app.navigate('shopping')">Zur Einkaufsliste</button>
          <button type="button" onclick="window.app.navigate('recipes')">Zu Rezepten</button>
          <button type="button" class="info" onclick="window.app.navigate('purchaselog')">purchaseLog verwalten</button>
        </div>
      </div>

      <div class="row stats-row">
        <div class="card" style="margin:0;">
          <h3 style="margin:0 0 10px 0;">Top Zutatenkosten (${esc(range.label)})</h3>
          ${topIngHtml}
        </div>

        <div class="card" style="margin:0;">
          <h3 style="margin:0 0 10px 0;">Top Verdorben (${esc(range.label)})</h3>
          ${topWasteHtml}
        </div>
      </div>
    `;
  };
})();
