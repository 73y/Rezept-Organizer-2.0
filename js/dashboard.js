(() => {
  const esc = (s) => (window.utils?.esc ? window.utils.esc(s) : String(s ?? ""));

  const DAY = 24 * 60 * 60 * 1000;

  const euro = (n) => (window.utils?.euro ? window.utils.euro(n) : (window.models?.euro ? window.models.euro(n) : `${(Number(n) || 0).toFixed(2)} €`));

  function findIngredient(state, id) {
    return (state.ingredients || []).find((x) => x.id === id) || null;
  }

  const parseDateMaybe = window.utils?.parseDateMaybe || function (v) {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  function getExpiresAt(state, p) {
    const direct =
      parseDateMaybe(p.expiresAt) ||
      parseDateMaybe(p.expires) ||
      parseDateMaybe(p.expiry) ||
      parseDateMaybe(p.expiryDate);
    if (direct) return direct;

    const ing = findIngredient(state, p.ingredientId);
    const bought = parseDateMaybe(p.boughtAt) || parseDateMaybe(p.purchasedAt) || parseDateMaybe(p.createdAt);
    const days = Number(ing?.shelfLifeDays) || 0;
    if (bought && days > 0) return new Date(bought.getTime() + days * DAY);
    return null;
  }

  function daysLeft(expiresAt) {
    if (!expiresAt) return null;
    const diff = expiresAt.getTime() - Date.now();
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

  function fmtDate(d) {
    if (!d) return "—";
    return d.toLocaleDateString("de-DE");
  }

  function collectCookEntries(state) {
    const out = [];
    for (const r of state.recipes || []) {
      const h = r?.cookHistory;
      if (!Array.isArray(h)) continue;
      for (const e of h) {
        const d = parseDateMaybe(e.at);
        const s = Number(e.seconds) || 0;
        if (!d || s <= 0) continue;
        out.push({ at: d, seconds: s });
      }
    }
    return out;
  }

  function sumSeconds(entries) {
    return entries.reduce((a, x) => a + (Number(x.seconds) || 0), 0);
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function collectPurchaseEntries(state) {
    const arr = Array.isArray(state.purchaseLog) ? state.purchaseLog : [];
    return arr
      .map((e) => ({ at: parseDateMaybe(e.at), total: Number(e.total) || 0 }))
      .filter((x) => x.at && Number.isFinite(x.total) && x.total > 0);
  }

  function collectWasteEntries(state) {
    const arr = Array.isArray(state.wasteLog) ? state.wasteLog : [];
    return arr
      .map((e) => ({ at: parseDateMaybe(e.at), total: Number(e.cost ?? e.total ?? 0) || 0 }))
      .filter((x) => x.at && Number.isFinite(x.total) && x.total > 0);
  }

  function sumMoney(entries) {
    return entries.reduce((a, x) => a + (Number(x.total) || 0), 0);
  }

  function groupSoon(state) {
    const pantry = Array.isArray(state.pantry) ? state.pantry : [];
    const map = new Map();
    for (const p of pantry) {
      if (!p?.ingredientId) continue;
      if (!map.has(p.ingredientId)) map.set(p.ingredientId, []);
      map.get(p.ingredientId).push(p);
    }

    const out = [];
    for (const [ingredientId, lots] of map.entries()) {
      const ing = findIngredient(state, ingredientId);
      const name = ing?.name || "Unbekannt";
      const unit = ing?.unit || lots[0]?.unit || "";
      const totalAmount = lots.reduce((s, x) => s + (Number(x.amount ?? x.qty ?? 0) || 0), 0);

      // earliest expiry across lots
      let earliest = null;
      for (const l of lots) {
        const exp = getExpiresAt(state, l);
        if (!exp) continue;
        if (!earliest || exp.getTime() < earliest.getTime()) earliest = exp;
      }
      const left = daysLeft(earliest);
      if (left === null) continue;

      out.push({ ingredientId, name, unit, totalAmount, earliest, left });
    }

    out.sort((a, b) => a.left - b.left);
    return out.slice(0, 8);
  }

  function dataNoticeHtml() {
    const report = typeof window.getStorageReport === "function" ? window.getStorageReport() : { status: "ok" };
    const st = report?.status || "ok";
    if (st === "ok" || st === "empty") return "";

    const pill =
      st === "recovered"
        ? `<span class="pill exp-yellow">Backup</span>`
        : st === "reset"
          ? `<span class="pill exp-red">Reset</span>`
          : `<span class="pill exp-orange">Hinweis</span>`;

    const msg = report?.message || "Es gab ein Problem beim Laden/Speichern der Daten.";

    return `
      <div class="card" style="border:1px solid rgba(234,179,8,0.35);">
        <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
          <div>
            <div style="display:flex; gap:10px; align-items:center;">
              <div style="font-weight:650;">Daten-Hinweis</div>
              ${pill}
            </div>
            <div class="small" style="opacity:0.9; margin-top:6px;">${esc(msg)}</div>
            <div class="small muted2" style="margin-top:6px;">Details/Tools findest du in <b>Einstellungen → Daten</b>.</div>
          </div>
          <div style="display:flex; justify-content:flex-end;">
            <button type="button" class="info" onclick="window.app.navigate('settings')">Zu Einstellungen</button>
          </div>
        </div>
      </div>
    `;
  }

  window.renderDashboardView = function (container, state) {
    const soon = groupSoon(state);

    const soonHtml = soon.length
      ? soon
          .map((x) => {
            const cls = expiryClass(x.left);
            const pill = expiryPillText(x.left);
            return `
              <div class="card exp-card ${cls}" style="margin:10px 0; padding:12px;">
                <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
                  <div>
                    <div style="font-weight:650;">${esc(x.name)}</div>
                    <div class="small" style="opacity:0.85; margin-top:4px;">
                      ${esc(Number(x.totalAmount.toFixed(4)))} ${esc(x.unit)} · Ablauf: ${esc(fmtDate(x.earliest))}
                    </div>
                  </div>
                  <span class="pill ${cls}">${esc(pill)}</span>
                </div>
              </div>
            `;
          })
          .join("")
      : `<p class="small">Noch keine Ablaufdaten im Vorrat – oder noch nichts eingekauft.</p>`;

    // Koch-Stats
    const cooks = collectCookEntries(state);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const weekAgo = new Date(Date.now() - 7 * DAY);

    const cooksMonth = cooks.filter((x) => x.at >= monthStart);
    const cooksWeek = cooks.filter((x) => x.at >= weekAgo);

    const secMonth = sumSeconds(cooksMonth);
    const secWeek = sumSeconds(cooksWeek);

    // Ausgaben / Verdorben
    const yearStart = new Date(now.getFullYear(), 0, 1);

    const buys = collectPurchaseEntries(state);
    const buysWeek = buys.filter((x) => x.at >= weekAgo);
    const buysMonth = buys.filter((x) => x.at >= monthStart);
    const buysYear = buys.filter((x) => x.at >= yearStart);

    const spentWeek = sumMoney(buysWeek);
    const spentMonth = sumMoney(buysMonth);
    const spentYear = sumMoney(buysYear);

    const waste = collectWasteEntries(state);
    const wasteWeekArr = waste.filter((x) => x.at >= weekAgo);
    const wasteMonthArr = waste.filter((x) => x.at >= monthStart);
    const wasteYearArr = waste.filter((x) => x.at >= yearStart);

    const wasteWeek = sumMoney(wasteWeekArr);
    const wasteMonth = sumMoney(wasteMonthArr);
    const wasteYear = sumMoney(wasteYearArr);

    const notice = dataNoticeHtml();

    container.innerHTML = `
      <div class="card">
        <h2 style="margin:0 0 6px 0;">Home</h2>
        <p class="small">Übersicht: „läuft bald ab“, Kochzeit, Ausgaben & Verdorben.</p>
      </div>

      ${notice}

      <div class="card">
        <h3 style="margin:0 0 10px 0;">Läuft bald ab</h3>
        ${soonHtml}
        <div style="display:flex; justify-content:flex-end; margin-top:10px;">
          <button type="button" onclick="window.app.navigate('inventory')">Zum Vorrat</button>
        </div>
      </div>

      <div class="card">
        <h3 style="margin:0 0 10px 0;">Stats</h3>

        <div class="card" style="margin:10px 0; padding:12px;">
          <div style="font-weight:650;">Kochzeit</div>
          <div class="small" style="opacity:0.9; margin-top:4px;">
            Diese Woche: <b>${esc(fmtTime(secWeek))}</b> (${cooksWeek.length}× gekocht)
            <br/>
            Dieser Monat: <b>${esc(fmtTime(secMonth))}</b> (${cooksMonth.length}× gekocht)
          </div>
        </div>

        <div class="card" style="margin:10px 0; padding:12px;">
          <div style="font-weight:650;">Ausgaben</div>
          <div class="small" style="opacity:0.9; margin-top:4px;">
            Diese Woche: <b>${esc(euro(spentWeek))}</b><br/>
            Dieser Monat: <b>${esc(euro(spentMonth))}</b><br/>
            Dieses Jahr: <b>${esc(euro(spentYear))}</b>
          </div>
        </div>

        <div class="card" style="margin:10px 0; padding:12px;">
          <div style="font-weight:650;">Verdorben</div>
          <div class="small" style="opacity:0.9; margin-top:4px;">
            Diese Woche: <b>${esc(euro(wasteWeek))}</b><br/>
            Dieser Monat: <b>${esc(euro(wasteMonth))}</b><br/>
            Dieses Jahr: <b>${esc(euro(wasteYear))}</b>
          </div>
          <div class="small muted2" style="margin-top:6px;">Kommt aus „Abgelaufen/Verdorben“ im Vorrat.</div>
        </div>
      </div>
    `;
  };
})();
