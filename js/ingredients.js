(() => {
  const esc = (s) => (window.utils?.esc ? window.utils.esc(s) : String(s ?? ""));

  const uid = () => (window.utils?.uid ? window.utils.uid() : window.models.uid());
  const toNum = (v) => (window.utils?.toNumber ? window.utils.toNumber(v) : window.models.toNumber(v));
  const euro = (n) => (window.utils?.euro ? window.utils.euro(n) : window.models.euro(n));

  const normalizeUnit = (u) => {
    const raw = String(u ?? "").trim();
    const low = raw.toLowerCase();
    if (!raw) return "";
    if (low === "stück" || low === "stk" || low.includes("stück")) return "Stück";
    if (low === "g" || low.includes("gram")) return "g";
    if (low === "ml" || low.includes("milli")) return "ml";
    return raw;
  };

  const cleanBarcode = (raw) => {
    const s = String(raw ?? "").trim();
    if (!s) return "";
    // EAN/UPC sind praktisch immer nur Zahlen. Wir strippen alles andere.
    return s.replace(/\s+/g, "").replace(/[^0-9]/g, "");
  };

  const isValidBarcode = (code) => {
    const c = cleanBarcode(code);
    // EAN-8 / UPC / EAN-13 / EAN-14
    return !!c && c.length >= 8 && c.length <= 14;
  };


  const pad2 = (n) => String(n).padStart(2, "0");

  function formatDDMMYYFromUTC(utcMs) {
    const d = new Date(utcMs);
    const dd = pad2(d.getUTCDate());
    const mm = pad2(d.getUTCMonth() + 1);
    const yy = pad2(d.getUTCFullYear() % 100);
    return `${dd}.${mm}.${yy}`;
  }

  // Input: "12.03" / "12.03.26" / "12.03.2027"  -> days between baseDate (date-only) and best-before date
  function parseBestBeforeInput(raw, baseDate) {
    const s0 = String(raw ?? "").trim();
    if (!s0) return { ok: false, empty: true };

    const cleaned = s0
      .replace(/\s+/g, "")
      .replace(/[\/\-]/g, ".")
      .replace(/\.+$/g, "");

    const parts = cleaned.split(".").filter(Boolean);
    if (parts.length < 2 || parts.length > 3) return { ok: false };

    const dd = Number(parts[0]);
    const mm = Number(parts[1]);
    if (!Number.isInteger(dd) || !Number.isInteger(mm) || dd < 1 || dd > 31 || mm < 1 || mm > 12) return { ok: false };

    const base = (baseDate instanceof Date && Number.isFinite(baseDate.getTime())) ? baseDate : new Date();
    const baseUTC = Date.UTC(base.getFullYear(), base.getMonth(), base.getDate());

    const yearProvided = parts.length === 3;
    let yyyy;
    if (yearProvided) {
      const y = Number(parts[2]);
      if (!Number.isInteger(y)) return { ok: false };
      yyyy = (y < 100) ? (2000 + y) : y;
    } else {
      yyyy = base.getFullYear();
    }

    const makeUTC = (Y) => Date.UTC(Y, mm - 1, dd);

    let expUTC = makeUTC(yyyy);
    // Validate date existence (e.g. 31.02 invalid)
    {
      const d = new Date(expUTC);
      if (d.getUTCFullYear() !== yyyy || d.getUTCMonth() !== (mm - 1) || d.getUTCDate() !== dd) return { ok: false };
    }

    // If user did not provide a year and date is before baseDate -> assume next year
    if (!yearProvided && expUTC < baseUTC) {
      expUTC = makeUTC(yyyy + 1);
      const d2 = new Date(expUTC);
      if (d2.getUTCFullYear() !== (yyyy + 1) || d2.getUTCMonth() !== (mm - 1) || d2.getUTCDate() !== dd) return { ok: false };
      yyyy = yyyy + 1;
    }

    const days = Math.max(0, Math.round((expUTC - baseUTC) / 86400000));
    const normalized = `${pad2(dd)}.${pad2(mm)}.${pad2(yyyy % 100)}`;

    return { ok: true, expUTC, days, normalized, yearProvided };
  }




  // Open Food Facts Autofill (Barcode -> Name/Packung)
  const OFF_FIELDS = "product_name,product_name_de,quantity,product_quantity,product_quantity_unit,brands,nutriments,ingredients_text,ingredients_text_de,ingredients,allergens,allergens_from_ingredients,allergens_from_user,allergens_tags";
  const OFF_BASE = "https://world.openfoodfacts.net/api/v2/product/";
  const OFF_BASE_FALLBACK = "https://world.openfoodfacts.org/api/v2/product/";
  const OFF_V0_NET = "https://world.openfoodfacts.net/api/v0/product/";
  const OFF_V0_ORG = "https://world.openfoodfacts.org/api/v0/product/";

  function ensureLookupCache(state) {
    if (!state || typeof state !== "object") return {};
    if (!state.barcodeLookupCache || typeof state.barcodeLookupCache !== "object") state.barcodeLookupCache = {};
    return state.barcodeLookupCache;
  }

  function parseOffQuantity(qty, unitRaw) {
    const n = Number(qty);
    if (!Number.isFinite(n) || n <= 0) return null;
    const u = String(unitRaw || "").trim().toLowerCase();

    // weight
    if (u === "g" || u === "gram" || u === "grams") return { amount: n, unit: "g" };
    if (u === "kg" || u === "kilogram" || u === "kilograms") return { amount: n * 1000, unit: "g" };

    // volume
    if (u === "ml" || u === "milliliter" || u === "milliliters") return { amount: n, unit: "ml" };
    if (u === "l" || u === "lt" || u === "liter" || u === "liters") return { amount: n * 1000, unit: "ml" };
    if (u === "cl") return { amount: n * 10, unit: "ml" };
    if (u === "dl") return { amount: n * 100, unit: "ml" };

    // pieces
    if (u === "pcs" || u === "pc" || u === "piece" || u === "pieces" || u === "stk" || u.includes("stück")) return { amount: n, unit: "Stück" };

    return null;
  }

  function parseQuantityString(text) {
    const raw = String(text || "").trim().toLowerCase();
    if (!raw) return null;

    // multipack: 6x250 g -> wir nehmen 250 g als Packungsgröße
    const multi = raw.match(/(\d+(?:[\.,]\d+)?)\s*[x×]\s*(\d+(?:[\.,]\d+)?)\s*([a-zäöü]+)/i);
    if (multi) {
      const qty = Number(String(multi[2]).replace(",", "."));
      const unit = multi[3];
      return parseOffQuantity(qty, unit);
    }

    // normal: 200 g / 1l / 0.5 l
    const m = raw.match(/(\d+(?:[\.,]\d+)?)\s*([a-zäöü]+)/i);
    if (!m) return null;
    const qty = Number(String(m[1]).replace(",", "."));
    const unit = m[2];
    return parseOffQuantity(qty, unit);
  }

  function round1(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return null;
    return Math.round(x * 10) / 10;
  }

  function pickNutri(nutr, keyBase, preferMl) {
    if (!nutr || typeof nutr !== "object") return null;
    const a = preferMl ? `${keyBase}_100ml` : `${keyBase}_100g`;
    const b = preferMl ? `${keyBase}_100g` : `${keyBase}_100ml`;
    const v1 = nutr[a];
    if (Number.isFinite(Number(v1))) return Number(v1);
    const v2 = nutr[b];
    if (Number.isFinite(Number(v2))) return Number(v2);
    return null;
  }

  function pickKcal(nutr, preferMl) {
    // 1) direkt kcal
    const kcal = pickNutri(nutr, "energy-kcal", preferMl);
    if (kcal !== null) return kcal;

    // 2) fallback: kJ -> kcal (1 kJ = 0.239006 kcal)
    const kj = pickNutri(nutr, "energy", preferMl);
    if (kj !== null) return Number(kj) * 0.239006;

    return null;
  }

    async function fetchOffSuggestion(state, persist, barcode) {
    const code = cleanBarcode(barcode);
    if (!isValidBarcode(code)) return null;

    const cache = ensureLookupCache(state);
    const cached = cache[code];
    if (cached && typeof cached === "object" && (cached.name || cached.ingredientsText || (cached.amount && cached.unit))) return cached;

    const debug = (state.__debug ||= {});
    debug.lastOff = { code, at: new Date().toISOString(), result: "miss", best: null, tries: [] };

    const tryFetch = async (url, asJson) => {
      const entry = { url, ok: false, status: null, ct: "", jsonStatus: null, statusVerbose: "", productName: "", note: "" };
      debug.lastOff.tries.push(entry);

      try {
        const res = await fetch(url, { method: "GET" });
        entry.status = res.status;
        entry.ct = (res.headers.get("content-type") || "").toLowerCase();

        if (!res.ok) {
          entry.note = `HTTP ${res.status}`;
          return null;
        }

        if (!asJson) return await res.text();

        if (!entry.ct.includes("application/json")) {
          entry.note = `content-type ${entry.ct || "?"}`;
          return null;
        }

        const json = await res.json();
        entry.ok = true;

        entry.jsonStatus = typeof json?.status === "number" ? json.status : null;
        entry.statusVerbose = String(json?.status_verbose || "").trim();

        const prod = json?.product && typeof json.product === "object" ? json.product : null;
        const pn = prod ? (prod.product_name_de || prod.product_name || prod.generic_name || "") : "";
        entry.productName = String(pn || "").trim();

        if (entry.jsonStatus === 0) {
          entry.note = `status=0 ${entry.statusVerbose || ""}`.trim();
          return null;
        }
        if (!prod) {
          entry.note = entry.note ? `${entry.note} | no product` : "no product";
          return null;
        }

        return json;
      } catch (e) {
        entry.note = String(e?.message || e || "fetch failed");
        return null;
      }
    };

    const parseProd = (prod) => {
      if (!prod || typeof prod !== "object") return null;

      const name = String(prod.product_name_de || prod.product_name || prod.generic_name || "").trim();
      const brands = String(prod.brands || "").trim();

      let parsed = null;
      if (prod.product_quantity && prod.product_quantity_unit) parsed = parseOffQuantity(`${prod.product_quantity}${prod.product_quantity_unit}`);
      if (!parsed && prod.quantity) parsed = parseQuantityString(String(prod.quantity));

      const ingredientsText = String(prod.ingredients_text_de || prod.ingredients_text || "").trim();
      const nutriments = prod.nutriments && typeof prod.nutriments === "object" ? prod.nutriments : null;

      if (!name && !brands && !parsed && !nutriments && !ingredientsText) return null;

      return {
        name: name || "",
        brands: brands || "",
        ingredientsText: ingredientsText || "",
        amount: parsed?.amount ? Math.round(parsed.amount * 100) / 100 : null,
        unit: parsed?.unit || "",
        rawQuantity: String(prod.quantity || "").trim(),
        nutriments,
        fetchedAt: new Date().toISOString()
      };
    };

    // IMPORTANT: use production (.org) first. The .net domain is staging and may behave differently / require auth.
    const urls = [
      `${OFF_BASE_FALLBACK}${encodeURIComponent(code)}?fields=${encodeURIComponent(OFF_FIELDS)}&lc=de&cc=de`,
      `${OFF_V0_FALLBACK}${encodeURIComponent(code)}.json`,
      `${OFF_BASE}${encodeURIComponent(code)}?fields=${encodeURIComponent(OFF_FIELDS)}&lc=de&cc=de`,
      `${OFF_V0}${encodeURIComponent(code)}.json`
    ];

    for (const url of urls) {
      const json = await tryFetch(url, true);
      if (!json || typeof json !== "object") continue;

      const prod = json.product && typeof json.product === "object" ? json.product : null;
      const out = parseProd(prod);

      if (!out || !(out.name || out.ingredientsText || (out.amount && out.unit) || out.nutriments)) {
        const last = debug.lastOff.tries[debug.lastOff.tries.length - 1];
        if (last && last.ok && !last.note) last.note = "product present but mapping empty";
        continue;
      }

      cache[code] = out;
      debug.lastOff.result = "hit";
      debug.lastOff.best = { name: out.name || "", brands: out.brands || "", amount: out.amount || null, unit: out.unit || "" };

      if (typeof persist === "function") persist();
      return out;
    }

    debug.lastOff.result = "miss";
    if (typeof persist === "function") persist();
    return null;
  }

  const ui = {
    openIngredientMenus: new Set(),
    packsByIngredient: new Map(),
    flash: null,
    flashTimeout: null,

    // 0.3.0 Filter
    filterCat: "all", // "all" | "none" | <categoryId>
    showUnlisted: false
  };

  function buildModal({
    title,
    contentHTML,
    okText = "Speichern",
    cancelText = "Abbrechen",
    okClass = "primary",
    onConfirm,
    onCancel
  }) {
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

    

    // Haltbarkeit: Datum -> Tage (Basis: baseDate)
    const shelfDateEl = modal.querySelector("#i-shelf-date");
    const shelfInfoEl = modal.querySelector("#i-shelf-info");
    const updateShelfInfo = () => {
      if (!shelfDateEl || !shelfInfoEl) return;
      const raw = (shelfDateEl.value || "").trim();
      if (!raw) {
        shelfInfoEl.textContent = "";
        return;
      }
      const p = parseBestBeforeInput(raw, baseDate);
      if (!p?.ok) {
        shelfInfoEl.textContent = "Bitte Datum als TT.MM oder TT.MM.JJ eingeben.";
        return;
      }
      shelfInfoEl.textContent = `${p.days} Tag(e) haltbar`;
    };

    if (shelfDateEl) {
      shelfDateEl.addEventListener("input", updateShelfInfo);
      shelfDateEl.addEventListener("blur", () => {
        const raw = (shelfDateEl.value || "").trim();
        if (!raw) return updateShelfInfo();
        const p = parseBestBeforeInput(raw, baseDate);
        if (p?.ok) shelfDateEl.value = p.normalized;
        updateShelfInfo();
      });
      updateShelfInfo();
    }
modal.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-action");
      if (action === "close" || action === "cancel") {
        onCancel?.(modal, close);
        return close();
      }
      if (action === "ok") return onConfirm?.(modal, close);
    });

    return { overlay, modal, close };
  }

  function setFlash(text) {
    ui.flash = text;
    if (ui.flashTimeout) clearTimeout(ui.flashTimeout);
    ui.flashTimeout = setTimeout(() => {
      ui.flash = null;
      const v = document.querySelector("#view-ingredients");
      if (v && !v.classList.contains("hidden")) window.app.navigate("ingredients");
    }, 2500);
  }

  function ingredientsSorted(state) {
    return (state.ingredients || [])
      .slice()
      .sort((a, b) => (a.name || "").localeCompare(b.name || "", "de"));
  }

  // 0.3.0 Kategorien
  function ingredientCategoriesSorted(state) {
    const cats = Array.isArray(state.ingredientCategories) ? state.ingredientCategories : [];
    return cats.slice().sort((a, b) => (a.name || "").localeCompare(b.name || "", "de"));
  }

  function categoryNameById(state, id) {
    if (!id) return "";
    const cats = Array.isArray(state.ingredientCategories) ? state.ingredientCategories : [];
    const c = cats.find((x) => String(x.id) === String(id));
    return c ? String(c.name || "") : "";
  }

  function categorySelectOptionsHTML(state, selectedId) {
    const cats = ingredientCategoriesSorted(state);
    const sel = String(selectedId || "");
    const opts = [`<option value="" ${sel ? "" : "selected"}>Ohne Kategorie</option>`];
    for (const c of cats) {
      opts.push(`<option value="${esc(c.id)}" ${String(c.id) === sel ? "selected" : ""}>${esc(c.name)}</option>`);
    }
    return opts.join("");
  }

  function getPacks(ingredientId) {
    const v = ui.packsByIngredient.get(ingredientId);
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 1;
  }

  function setPacks(ingredientId, value) {
    const n = Number(value);
    ui.packsByIngredient.set(ingredientId, Number.isFinite(n) && n > 0 ? Math.round(n) : 1);
  }

  function unitPriceText(ing) {
    const price = Number(ing.price) || 0;
    const amt = Number(ing.amount) || 0;
    if (!amt || !price) return "—";
    const per = price / amt;
    if (!Number.isFinite(per) || per <= 0) return "—";
    // pro 100g/ml wirkt oft sinnvoll, aber bei Stück lieber pro Stück
    if (String(ing.unit || "").toLowerCase() === "stück") return `${euro(per)} / Stk`;
    return `${euro(per * 100)} / 100 ${String(ing.unit || "")}`;
  }

  function ingredientCardHTML(state, ing) {
    const packLabel = `${Number(ing.amount) || 0} ${esc(ing.unit || "")}`.trim();
    const price = Number(ing.price) || 0;
    const shelf = Number(ing.shelfLifeDays) || 0;
    const cat = categoryNameById(state, ing.categoryId);

    const open = ui.openIngredientMenus.has(ing.id) ? "open" : "";

    return `
      <div class="card" style="margin:10px 0;">
        <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
          <div style="min-width:0; flex:1;">
            <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
              <div style="font-weight:750; font-size:18px; line-height:1.1;">${esc(ing.name)}${ing.unlisted ? ` <span class="small" style="opacity:0.85;">(ungelistet)</span>` : ``}</div>
              <span class="small" style="border:1px solid var(--border); padding:4px 10px; border-radius:999px;">Packung: <b>${esc(packLabel)}</b></span>
              ${cat ? `<span class="small" style="border:1px solid var(--border); padding:4px 10px; border-radius:999px;">Kategorie: <b>${esc(cat)}</b></span>` : ``}
            </div>
            <div class="small" style="margin-top:8px; opacity:0.9; display:flex; gap:10px; flex-wrap:wrap;">
              <span>Preis: <b>${esc(euro(price))}</b></span>
              <span>·</span>
              <span>Einheit: ${esc(unitPriceText(ing))}</span>
              ${shelf > 0 ? `<span>· Haltbarkeit: ${esc(shelf)} Tag(e)</span>` : ``}
            </div>
          </div>

          <div style="display:flex; gap:10px; align-items:flex-start;">
            <details class="actions-menu ing-actions" data-ingredient="${esc(ing.id)}" ${open}>
              <summary title="Aktionen">⋯</summary>
              <div class="actions-panel">
                <div class="actions-row" style="justify-content:space-between; align-items:center;">
                  <span class="small muted2">Packungen</span>
                  <input data-action="packs" data-ingredient-id="${esc(ing.id)}" type="number" min="1" step="1" value="${esc(getPacks(ing.id))}" style="width:90px;" />
                </div>
                <div class="actions-row">
                  <button class="success" data-action="addShop" data-ingredient-id="${esc(ing.id)}">Zur Einkaufsliste</button>
                </div>
                <div class="actions-row" style="justify-content:space-between;">
                  <button class="info" data-action="edit" data-ingredient-id="${esc(ing.id)}">Bearbeiten</button>
                  <button class="danger" data-action="del" data-ingredient-id="${esc(ing.id)}">Löschen</button>
                </div>
              </div>
            </details>
          </div>
        </div>
      </div>
    `;
  }

  function ensureShoppingSession(state) {
    if (!Array.isArray(state.shopping)) state.shopping = [];
    if (!state.shoppingSession || typeof state.shoppingSession !== "object") {
      state.shoppingSession = { active: false, checked: {}, startedAt: null };
    }
    if (!state.shoppingSession.checked || typeof state.shoppingSession.checked !== "object") {
      state.shoppingSession.checked = {};
    }
  }

  function addIngredientToShopping(state, ingredientId, packsToAdd = 1) {
    ensureShoppingSession(state);

    const add = Math.max(1, Math.round(Number(packsToAdd) || 1));
    const it = state.shopping.find((x) => x.ingredientId === ingredientId);

    if (!it) {
      state.shopping.push({ id: uid(), ingredientId, packs: add });
      return;
    }

    const before = Math.max(1, Math.round(Number(it.packs) || 1));
    it.packs = before + add;
  }
  function openBarcodeScannerModal(state, persist) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const modal = document.createElement("div");
    modal.className = "modal scan-modal";
    modal.style.maxWidth = "720px";

    modal.innerHTML = `
      <div class="modal-header">
        <div class="modal-title">Barcode scannen</div>
        <button class="modal-close" data-action="close" title="Schließen">✕</button>
      </div>

      <div class="modal-body">
        <div class="scan-video-wrap">
          <video id="scan-video" class="scan-video" autoplay playsinline></video>
          <div class="scan-hint small muted2">Kamera auf den Barcode halten (EAN). Wenn dein Gerät das Scannen nicht unterstützt: „Ohne Barcode“.</div>
        </div>

        <div class="scan-result" id="scan-result">
          <span class="small muted2">Noch kein Barcode erkannt.</span>
        </div>

        <div id="scan-msg" class="small" style="margin-top:10px; color: rgba(239,68,68,0.9);"></div>
      </div>

      <div class="modal-footer" style="justify-content:space-between;">
        <div style="display:flex; gap:10px; flex-wrap:wrap;">
          <button data-action="nobarcode">Ohne Barcode</button>
        </div>
        <div style="display:flex; gap:10px; flex-wrap:wrap;">
          <button class="info" data-action="rescan">Neu scannen</button>
          <button class="success" data-action="next" disabled>Weiter</button>
        </div>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const video = modal.querySelector("#scan-video");
    const msg = modal.querySelector("#scan-msg");
    const hint = modal.querySelector(".scan-hint");
    const result = modal.querySelector("#scan-result");
    const nextBtn = modal.querySelector('button[data-action="next"]');

    let stream = null;
    let detector = null;
    let raf = null;
    let scanning = false;
    let lastTick = 0;
    let scannedCode = "";
    let matchedIng = null;
    let offSuggestion = null;

    function setMsg(text, kind = "error") {
      if (!msg) return;
      msg.style.color = kind === "ok" ? "rgba(34,197,94,0.95)" : kind === "warn" ? "rgba(245,158,11,0.95)" : "rgba(239,68,68,0.9)";
      msg.textContent = text || "";
    }

    function setResult(code, ing, off = null, loading = false) {
      if (!result) return;
      if (!code) {
        result.innerHTML = `<span class=\"small muted2\">Noch kein Barcode erkannt.</span>`;
        return;
      }

      if (ing) {
        const packLabel = `${Number(ing.amount) || 0} ${esc(ing.unit || "")}`.trim();
        result.innerHTML = `
          <div class=\"small muted2\" style=\"margin-bottom:6px;\">Erkannt</div>
          <div style=\"font-size:18px; font-weight:900;\">${esc(ing.name)}</div>
          <div class=\"small muted2\" style=\"margin-top:6px;\">Packung: <b>${esc(packLabel)}</b> · Barcode: <b>${esc(code)}</b></div>
        `;
        return;
      }

      const hasOff = !!(off && (off.name || (off.amount && off.unit)));
      const extra = loading
        ? `<div class=\"small muted2\" style=\"margin-top:10px; border-top:1px solid var(--border); padding-top:10px;\">Suche Produktdaten…</div>`
        : hasOff
          ? `
            <div class=\"small\" style=\"margin-top:10px; border-top:1px solid var(--border); padding-top:10px;\">
              <div class=\"small muted2\" style=\"margin-bottom:6px;\">Vorschlag (Open Food Facts)</div>
              ${off.name ? `<div style=\"font-weight:900;\">${esc(off.name)}</div>` : ``}
              ${(off.amount && off.unit) ? `<div class=\"small muted2\" style=\"margin-top:6px;\">Packung: <b>${esc(off.amount)} ${esc(off.unit)}</b></div>` : ``}
              ${off.brands ? `<div class=\"small muted2\" style=\"margin-top:6px;\">Marke: ${esc(off.brands)}</div>` : ``}
              ${off.nutriments ? (() => {
                  const n = off.nutriments;
                  const parts = [];
                  if (Number.isFinite(n.kcalPer100)) parts.push(`${esc(n.kcalPer100)} kcal/${esc(n.base)}`);
                  if (Number.isFinite(n.proteinPer100)) parts.push(`Protein ${esc(n.proteinPer100)} g`);
                  if (Number.isFinite(n.carbsPer100)) parts.push(`KH ${esc(n.carbsPer100)} g`);
                  if (Number.isFinite(n.fatPer100)) parts.push(`Fett ${esc(n.fatPer100)} g`);
                  if (!parts.length) return ``;
                  return `<div class=\"small muted2\" style=\"margin-top:6px;\">Nährwerte: ${parts.join(" · ")}</div>`;
                })() : ``}
            </div>
          `
          : ``;

      result.innerHTML = `
        <div class=\"small muted2\" style=\"margin-bottom:6px;\">Unbekannt</div>
        <div style=\"font-size:18px; font-weight:900; letter-spacing:0.5px;\">${esc(code)}</div>
        <div class=\"small muted2\" style=\"margin-top:6px;\">Du kannst jetzt eine neue Zutat anlegen.</div>
        ${extra}
      `;
    }

    function setNextEnabled(on) {
      if (nextBtn) nextBtn.disabled = !on;
    }

    function setNextLabel(label) {
      if (!nextBtn) return;
      nextBtn.textContent = label;
    }

    async function startCamera() {
      if (!video) return;

      if (!navigator.mediaDevices?.getUserMedia) {
        if (hint) hint.textContent = "Kamera wird vom Browser nicht unterstützt.";
        setMsg("Kamera wird vom Browser nicht unterstützt. Nutze ‚Ohne Barcode‘.", "warn");
        return;
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 }
          },
          audio: false
        });

        video.srcObject = stream;
        await video.play();
      } catch (e) {
        if (hint) hint.textContent = "Kamera-Zugriff blockiert. Erlaube Kamera in den Website-Einstellungen.";
        setMsg("Kamera-Zugriff nicht möglich. Erlaube Kamera – oder nutze ‚Ohne Barcode‘.", "warn");
      }
    }

    function stopCamera() {
      scanning = false;
      if (raf) cancelAnimationFrame(raf);
      raf = null;

      try {
        if (stream) {
          for (const t of stream.getTracks()) t.stop();
        }
      } catch {}

      stream = null;
      detector = null;
    }

    async function ensureDetector() {
      if (detector) return detector;
      if (typeof BarcodeDetector === "undefined") return null;
      try {
        detector = new BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"] });
        return detector;
      } catch {
        return null;
      }
    }

    async function tick(ts) {
      if (!scanning) return;
      raf = requestAnimationFrame(tick);

      if (ts - lastTick < 160) return;
      lastTick = ts;

      const det = await ensureDetector();
      if (!det || !video) {
        scanning = false;
        if (hint) hint.textContent = "Scanner wird auf diesem Gerät nicht unterstützt. Nutze ‚Ohne Barcode‘.";
        setMsg("Scanner nicht unterstützt. Nutze ‚Ohne Barcode‘.", "warn");
        return;
      }

      if (video.readyState < 2) return;

      try {
        const res = await det.detect(video);
        if (Array.isArray(res) && res.length) {
          const raw = res[0]?.rawValue || "";
          const code = cleanBarcode(raw);
          if (code) {
            scannedCode = code;
            matchedIng = (state.ingredients || []).find((x) => cleanBarcode(x?.barcode) === code) || null;
            offSuggestion = null;

            if (matchedIng) {
              setResult(code, matchedIng, null, false);
              setMsg(`Erkannt: ${matchedIng.name}`, "ok");
              setNextLabel("Bearbeiten");
              setNextEnabled(true);
              scanning = false;
              return;
            }

            // Unbekannt -> Open Food Facts Autofill versuchen
            setResult(code, null, null, true);
            setMsg("Suche Produktdaten…", "warn");
            setNextEnabled(false);
            scanning = false;

            offSuggestion = await fetchOffSuggestion(state, persist, code);

            if (offSuggestion) {
              setResult(code, null, offSuggestion, false);
              setMsg(offSuggestion.name ? ("Vorschlag gefunden: " + offSuggestion.name) : "Vorschlag gefunden", "ok");
              setNextLabel("Übernehmen");
            } else {
              setResult(code, null, null, false);
              const last = state.__debug?.lastOff;
              const note = last?.tries?.slice(-1)?.[0]?.note || last?.tries?.slice(-1)?.[0]?.status || "";
              setMsg(note ? `Unbekannt: ${code} (OFF: ${note})` : `Unbekannt: ${code}`, "ok");
              setNextLabel("Zutat anlegen");
            }
            setNextEnabled(true);
          }
        }
      } catch {
        // ignore
      }
    }

    function startScan() {
      setMsg("");
      scanning = true;
      lastTick = 0;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    }

    function close() {
      stopCamera();
      overlay.remove();
    }

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });

    modal.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const a = btn.getAttribute("data-action");

      if (a === "close") return close();

      if (a === "nobarcode") {
        close();
        openIngredientModal(state, persist, null, { prefillBarcode: "" });
        return;
      }

      if (a === "rescan") {
        scannedCode = "";
        matchedIng = null;
        offSuggestion = null;
        setResult("", null);
        setMsg("");
        setNextLabel("Weiter");
        setNextEnabled(false);
        startScan();
        return;
      }

      if (a === "next") {
        if (!scannedCode) {
          setMsg("Noch kein Barcode erkannt. Bitte kurz warten oder ‚Ohne Barcode‘.", "warn");
          return;
        }

        const code = scannedCode;

        // Wenn schon bekannt: direkt bearbeiten
        const existing = matchedIng || (state.ingredients || []).find((x) => cleanBarcode(x?.barcode) === code) || null;
        close();

        if (existing) {
          openIngredientModal(state, persist, existing, { prefillBarcode: code });
          return;
        }

        openIngredientModal(state, persist, null, { prefillBarcode: code, prefillName: offSuggestion?.name || "", prefillAmount: offSuggestion?.amount || "", prefillUnit: offSuggestion?.unit || "", prefillBrands: offSuggestion?.brands || "", prefillNutriments: offSuggestion?.nutriments || null });
      }
    });

    // Start
    setTimeout(async () => {
      setResult("", null);
      setNextLabel("Weiter");
      setNextEnabled(false);
      await startCamera();
      startScan();
    }, 0);
  }
  function openIngredientCategoriesModal(state, persist, { onSaved } = {}) {
    if (!Array.isArray(state.ingredientCategories)) state.ingredientCategories = [];

    const cats = ingredientCategoriesSorted(state);
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
      <div class="small muted2">Kategorien für Zutaten. Beim Löschen wird die Kategorie bei betroffenen Zutaten entfernt.</div>
      <div style="margin-top:12px;">
        <label class="small">Neue Kategorie</label><br/>
        <div class="row" style="align-items:center;">
          <div style="flex:1; min-width:220px;"><input id="cat-new" placeholder="z. B. Gemüse" /></div>
          <div style="flex:0 0 auto;"><button type="button" class="info" data-action="catAdd">Hinzufügen</button></div>
        </div>
      </div>
      <div style="margin-top:12px;">
        <h3 style="margin:0 0 8px 0;">Liste</h3>
        <div id="cat-list">${rows || `<div class="small">Noch keine Kategorien.</div>`}</div>
      </div>
      <div class="small" id="cat-msg" style="margin-top:10px; color: rgba(239,68,68,0.9);"></div>
    `;

    const { modal } = buildModal({
      title: "Zutaten-Kategorien",
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
        state.ingredientCategories = next;

        // Referenzen bereinigen
        const valid = new Set(next.map((c) => String(c.id)));
        for (const ing of state.ingredients || []) {
          if (ing?.categoryId && !valid.has(String(ing.categoryId))) ing.categoryId = null;
        }

        persist();
        close();
        onSaved?.();
      }
    });

    function rebuildList() {
      const list = modal.querySelector("#cat-list");
      if (!list) return;
      const cats2 = ingredientCategoriesSorted(state);
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
        const dup = (state.ingredientCategories || []).some((c) => String(c.name || "").trim().toLowerCase() === name.toLowerCase());
        if (dup) {
          if (msg) msg.textContent = "Kategorie existiert schon.";
          return;
        }
        state.ingredientCategories.push({ id: uid(), name });
        if (inp) inp.value = "";
        rebuildList();
      }

      if (a === "catDel") {
        const id = btn.getAttribute("data-id") || "";
        state.ingredientCategories = (state.ingredientCategories || []).filter((c) => String(c.id) !== String(id));
        rebuildList();
      }
    });
  }

  function openIngredientModal(state, persist, ingOrNull, opts = {}) {
    const isEdit = !!ingOrNull;
    const noNavigate = !!opts?.noNavigate;
    const onSaved = typeof opts?.onSaved === "function" ? opts.onSaved : null;
    const onDone = typeof opts?.onDone === "function" ? opts.onDone : null;

    const unitRaw = String(ingOrNull?.unit || "").trim();
    const preUnitRaw = !isEdit ? String(opts?.prefillUnit ?? "").trim() : "";
    const unitNorm = normalizeUnit(isEdit ? unitRaw : (preUnitRaw || unitRaw));
    const knownUnits = ["Stück", "g", "ml"];
    const hasCustom = unitNorm && !knownUnits.includes(unitNorm);

    const preBarcode = cleanBarcode(String(opts?.prefillBarcode ?? ingOrNull?.barcode ?? ""));

    const catSel = String(ingOrNull?.categoryId || "");
    const unlistedDefault = !!ingOrNull?.unlisted;


    const baseDate = (() => {
      const raw = String(opts?.baseDateISO ?? "").trim();
      const d = raw ? new Date(raw) : new Date();
      return Number.isFinite(d.getTime()) ? d : new Date();
    })();

    const shelfDateValue = (() => {
      const pre = String(opts?.prefillShelfDate ?? "").trim();
      if (!isEdit && pre) return pre;

      const daysRaw = isEdit ? (ingOrNull?.shelfLifeDays ?? "") : (opts?.prefillShelfLifeDays ?? "");
      const days = Number(daysRaw);
      if (Number.isFinite(days) && days > 0) {
        const baseUTC = Date.UTC(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
        const expUTC = baseUTC + Math.round(days) * 86400000;
        return formatDDMMYYFromUTC(expUTC);
      }
      return "";
    })();


    const unitOption = (value, label) =>
      `<option value="${esc(value)}" ${unitNorm === value ? "selected" : ""}>${esc(label)}</option>`;

    const content = `
      <div class="row">
        <div>
          <label class="small">Name</label><br/>
          <input id="i-name" placeholder="z. B. Eier" value="${esc(isEdit ? (ingOrNull?.name || "") : (opts?.prefillName || ""))}" />
        </div>
        <div>
          <label class="small">Menge pro Packung</label><br/>
          <input id="i-amount" type="number" min="0" step="0.01" placeholder="z. B. 10" value="${esc(isEdit ? (ingOrNull?.amount ?? "") : (opts?.prefillAmount ?? ""))}" />
        </div>
        <div>
          <label class="small">Einheit</label><br/>
          <select id="i-unit" style="width:100%;">
            <option value="" ${unitNorm ? "" : "selected"}>Bitte wählen…</option>
            ${unitOption("Stück", "Stück")}
            ${unitOption("g", "Gramm (g)")}
            ${unitOption("ml", "Milliliter (ml)")}
            ${hasCustom ? unitOption(unitNorm, `Andere: ${unitNorm}`) : ""}
          </select>
        </div>
      </div>

      <div class="row" style="margin-top:10px; align-items:flex-end;">
        <div>
          <label class="small">Kategorie</label><br/>
          <select id="i-cat" style="width:100%;">
            ${categorySelectOptionsHTML(state, catSel)}
          </select>
          <div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;">
            <button type="button" class="info" data-action="catQuickAdd">+ Neue Kategorie</button>
            <button type="button" class="info" data-action="manageCats">Kategorien…</button>
          </div>
        </div>
        <div style="flex:0 0 auto; min-width:180px;">
          <label class="small">Anzeige</label><br/>
          <label class="small" style="display:flex; gap:8px; align-items:center; opacity:0.95;">
            <input id="i-unlisted" type="checkbox" ${unlistedDefault ? "checked" : ""} />
            Ungelistet
          </label>
          <div class="small muted2" style="margin-top:6px;">Ungelistete Zutaten sind normal versteckt, erscheinen aber in Rezepten.</div>
        </div>
      </div>

      ${(!isEdit && (opts?.prefillName || opts?.prefillAmount)) ? `<div class="small muted2" style="margin-top:8px;">Vorschlag aus Barcode-Daten übernommen. Preis/Haltbarkeit ggf. ergänzen.</div>` : ``}

      <div class="row" style="margin-top:10px;">
        <div>
          <label class="small">Preis pro Packung (€)</label><br/>
          <input id="i-price" type="number" min="0" step="0.01" placeholder="z. B. 2,99" value="${esc((opts?.prefillPrice !== undefined && opts?.prefillPrice !== null && opts?.prefillPrice !== "") ? opts.prefillPrice : (ingOrNull?.price ?? ""))}" />
        </div>
        <div>
          <label class="small">Haltbarkeit (Datum)</label><br/>
          <input id="i-shelf-date" type="text" inputmode="numeric" placeholder="TT.MM oder TT.MM.JJ" value="${esc(shelfDateValue)}" />
          <div class="small muted2" id="i-shelf-info" style="margin-top:6px;"></div>
        </div>
        <div>
          <label class="small">Barcode</label><br/>
          <div class="barcode-view" id="i-barcode-view">${preBarcode ? esc(preBarcode) : "—"}</div>
          <input id="i-barcode" type="hidden" value="${esc(preBarcode)}" />
          <div class="small muted2" style="margin-top:6px;">Automatisch beim Scannen. Manuelle Eingabe ist aus.</div>
          ${preBarcode ? `<button type="button" class="danger" data-action="clearBarcode" style="margin-top:8px;">Barcode entfernen</button>` : ``}
        </div>
      </div>

      
      <details class="nutri-details" style="margin-top:12px;">
        <summary class="small">Nährwerte (optional)</summary>
        <div class="small muted2" style="margin-top:6px;">Pro ${esc((() => {
          const u = normalizeUnit(isEdit ? unitRaw : (String(opts?.prefillUnit ?? "").trim() || unitRaw));
          return u === "ml" ? "100ml" : "100g";
        })())}. Werte sind optional und können später ergänzt werden.</div>
        <div class="row" style="margin-top:10px;">
          <div>
            <label class="small">kcal</label><br/>
            <input id="i-kcal" type="number" min="0" step="0.1" placeholder="z. B. 250" value="${esc((() => {
              const n = isEdit ? ingOrNull?.nutriments : (opts?.prefillNutriments || null);
              return n && Number.isFinite(Number(n.kcalPer100)) ? Number(n.kcalPer100) : "";
            })())}" />
          </div>
          <div>
            <label class="small">Protein (g)</label><br/>
            <input id="i-protein" type="number" min="0" step="0.1" placeholder="z. B. 10" value="${esc((() => {
              const n = isEdit ? ingOrNull?.nutriments : (opts?.prefillNutriments || null);
              return n && Number.isFinite(Number(n.proteinPer100)) ? Number(n.proteinPer100) : "";
            })())}" />
          </div>
          <div>
            <label class="small">Kohlenhydrate (g)</label><br/>
            <input id="i-carbs" type="number" min="0" step="0.1" placeholder="z. B. 5" value="${esc((() => {
              const n = isEdit ? ingOrNull?.nutriments : (opts?.prefillNutriments || null);
              return n && Number.isFinite(Number(n.carbsPer100)) ? Number(n.carbsPer100) : "";
            })())}" />
          </div>
          <div>
            <label class="small">Fett (g)</label><br/>
            <input id="i-fat" type="number" min="0" step="0.1" placeholder="z. B. 20" value="${esc((() => {
              const n = isEdit ? ingOrNull?.nutriments : (opts?.prefillNutriments || null);
              return n && Number.isFinite(Number(n.fatPer100)) ? Number(n.fatPer100) : "";
            })())}" />
          </div>
        </div>
      </details>
<div class="small" id="i-msg" style="margin-top:10px; color: rgba(239,68,68,0.9);"></div>
    `;

    const { modal } = buildModal({
      title: isEdit ? "Zutat bearbeiten" : "Neue Zutat",
      contentHTML: content,
      okText: isEdit ? "Speichern" : "Hinzufügen",
      okClass: "success",
      onConfirm: (m, close) => {
        const msg = m.querySelector("#i-msg");
        if (msg) msg.textContent = "";

        const name = (m.querySelector("#i-name")?.value || "").trim();
        const barcodeRaw = m.querySelector("#i-barcode")?.value || "";
        const barcode = cleanBarcode(barcodeRaw);

        const amount = toNum(m.querySelector("#i-amount")?.value);
        const unit = normalizeUnit(m.querySelector("#i-unit")?.value);
        const price = toNum(m.querySelector("#i-price")?.value);
        const shelfRaw = (m.querySelector("#i-shelf-date")?.value || "").trim();
        let shelf = 0;
        if (shelfRaw) {
          const parsedShelf = parseBestBeforeInput(shelfRaw, baseDate);
          if (!parsedShelf?.ok) return (msg.textContent = "Haltbarkeit bitte als Datum eingeben: TT.MM oder TT.MM.JJ.");
          shelf = parsedShelf.days;
        }
        const kcal = toNum(m.querySelector("#i-kcal")?.value);
        const protein = toNum(m.querySelector("#i-protein")?.value);
        const carbs = toNum(m.querySelector("#i-carbs")?.value);
        const fat = toNum(m.querySelector("#i-fat")?.value);

        const categoryId = (m.querySelector("#i-cat")?.value || "").trim() || null;
        const unlisted = !!m.querySelector("#i-unlisted")?.checked;

        const nutriBase = (unit === "ml") ? "100ml" : "100g";
        const nutriments = (() => {
          const out = {
            base: nutriBase,
            kcalPer100: Number.isFinite(kcal) ? Math.round(kcal * 10) / 10 : null,
            proteinPer100: Number.isFinite(protein) ? Math.round(protein * 10) / 10 : null,
            carbsPer100: Number.isFinite(carbs) ? Math.round(carbs * 10) / 10 : null,
            fatPer100: Number.isFinite(fat) ? Math.round(fat * 10) / 10 : null
          };
          if (out.kcalPer100 === null && out.proteinPer100 === null && out.carbsPer100 === null && out.fatPer100 === null) return null;
          return out;
        })();


        if (!name) return (msg.textContent = "Bitte Name eingeben.");
        if (barcode && !isValidBarcode(barcode)) return (msg.textContent = "Barcode ist ungültig (8–14 Ziffern). Bitte entfernen.");

        const dup = barcode ? (state.ingredients || []).find((x) => cleanBarcode(x?.barcode) === barcode && x.id !== ingOrNull?.id) : null;
        if (dup) return (msg.textContent = `Barcode ist schon bei „${dup.name}“ gespeichert.`);

        if (!Number.isFinite(amount) || amount <= 0) return (msg.textContent = "Bitte Menge pro Packung > 0 eingeben.");
        if (!unit) return (msg.textContent = "Bitte Einheit wählen (Stück / g / ml)." );
        // Preis ist normalerweise optional (0 = unbekannt).
        // Im Bon-Scan kann er erzwungen werden (opts.requirePrice).
        const requirePrice = !!opts?.requirePrice;
        let priceVal = Number.isFinite(price) ? price : null;
        if (priceVal !== null && priceVal < 0) return (msg.textContent = "Preis darf nicht negativ sein.");
        if (requirePrice && priceVal === null) return (msg.textContent = "Bitte Preis eingeben (z. B. 2,99).");

        if (isEdit) {
          const it = state.ingredients.find((x) => x.id === ingOrNull.id);
          if (!it) return (msg.textContent = "Zutat nicht gefunden.");

          it.name = name;
          it.barcode = barcode || "";
          it.amount = amount;
          it.unit = unit;
          it.price = Number(((priceVal ?? 0) || 0).toFixed(2));
          it.shelfLifeDays = shelf;
          it.nutriments = nutriments || null;

          it.categoryId = categoryId;
          it.unlisted = unlisted;

          persist();
          const saved = it;
          close();
          onSaved?.(saved);
          onDone?.({ saved: true, ingredient: saved, isNew: false });
          if (!noNavigate) window.app.navigate("ingredients");
          return;
        }

        const newIng = {
          id: uid(),
          name,
          barcode: barcode || "",
          amount,
          unit,
          price: Number(((priceVal ?? 0) || 0).toFixed(2)),
          shelfLifeDays: shelf,
          nutriments: nutriments || null,

          categoryId,
          unlisted
        };

        state.ingredients.push(newIng);

        persist();
        close();
        onSaved?.(newIng);
        onDone?.({ saved: true, ingredient: newIng, isNew: true });
        if (!noNavigate) window.app.navigate("ingredients");
      },
      onCancel: () => {
        onDone?.({ saved: false, ingredient: null, isNew: !isEdit });
      }
    });

    function refreshCategorySelect() {
      const sel = modal.querySelector("#i-cat");
      if (!sel) return;
      const cur = String(sel.value || "");
      sel.innerHTML = categorySelectOptionsHTML(state, cur);
      sel.value = cur;
    }

    modal.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const a = btn.getAttribute("data-action");

      // Barcode entfernen ohne Tastatur
      if (a === "clearBarcode") {
        const hidden = modal.querySelector("#i-barcode");
        const view = modal.querySelector("#i-barcode-view");
        if (hidden) hidden.value = "";
        if (view) view.textContent = "—";
        btn.remove();
        return;
      }



      // Kategorie schnell anlegen (ohne aus dem Bearbeiten-Fenster zu fliegen)
      if (a === "catQuickAdd") {
        const content = `
          <div class="small muted2">Neue Zutaten-Kategorie anlegen. Danach bist du wieder im Bearbeiten-Fenster.</div>
          <div style="margin-top:12px;">
            <label class="small">Name</label><br/>
            <input id="cat-q-name" placeholder="z. B. Gemüse" />
          </div>
          <div class="small" id="cat-q-msg" style="margin-top:10px; color: rgba(239,68,68,0.9);"></div>
        `;

        buildModal({
          title: "Neue Kategorie",
          contentHTML: content,
          okText: "Anlegen",
          okClass: "success",
          cancelText: "Abbrechen",
          onConfirm: (m, close) => {
            const msg = m.querySelector("#cat-q-msg");
            if (msg) msg.textContent = "";

            const name = String(m.querySelector("#cat-q-name")?.value || "").trim();
            if (!name) {
              if (msg) msg.textContent = "Bitte einen Namen eingeben.";
              return;
            }

            if (!Array.isArray(state.ingredientCategories)) state.ingredientCategories = [];
            const dup = state.ingredientCategories.some((c) => String(c?.name || "").trim().toLowerCase() === name.toLowerCase());
            if (dup) {
              if (msg) msg.textContent = "Kategorie existiert schon.";
              return;
            }

            const id = uid();
            state.ingredientCategories.push({ id, name });
            state.ingredientCategories.sort((a, b) => (a.name || "").localeCompare(b.name || "", "de"));

            persist();
            close();

            // im Zutat-Modal direkt auswählen
            const sel = modal.querySelector("#i-cat");
            if (sel) {
              sel.innerHTML = categorySelectOptionsHTML(state, id);
              sel.value = String(id);
            }
          }
        });

        return;
      }
      // Kategorien verwalten
      if (a === "manageCats") {
        openIngredientCategoriesModal(state, persist, {
          onSaved: () => {
            refreshCategorySelect();
          }
        });
      }
    });

    // Fokus
    setTimeout(() => modal.querySelector("#i-name")?.focus(), 0);
  }


  function openDeleteModal(state, persist, ingredientId) {
    const ing = (state.ingredients || []).find((x) => x.id === ingredientId);
    if (!ing) return;

    const usedInPantry = Array.isArray(state.pantry) && state.pantry.some((x) => x.ingredientId === ingredientId);
    const usedInShopping = Array.isArray(state.shopping) && state.shopping.some((x) => x.ingredientId === ingredientId);
    const usedInRecipes =
      Array.isArray(state.recipes) && state.recipes.some((r) => (r.items || []).some((it) => it.ingredientId === ingredientId));

    const warn = usedInPantry || usedInShopping || usedInRecipes;

    const content = `
      <div class="small" style="opacity:0.95;">Zutat <b>${esc(ing.name)}</b> löschen?</div>
      ${
        warn
          ? `<div class="small" style="margin-top:10px; color: rgba(245,158,11,0.9);">
               Hinweis: Diese Zutat wird noch verwendet (Vorrat / Einkaufsliste / Rezepte).
               Beim Löschen werden die verknüpften Einträge ebenfalls bereinigt.
             </div>`
          : ``
      }
      <div class="small" style="margin-top:10px; opacity:0.85;">Das kann nicht rückgängig gemacht werden.</div>
    `;

    buildModal({
      title: "Löschen bestätigen",
      contentHTML: content,
      okText: "Löschen",
      okClass: "danger",
      onConfirm: (_m, close) => {
        if (window.actions?.deleteIngredientCascade) {
          window.actions.deleteIngredientCascade(ingredientId);
        } else {
          // Fallback (alt)
          state.ingredients = (state.ingredients || []).filter((x) => x.id !== ingredientId);
          if (Array.isArray(state.shopping)) state.shopping = state.shopping.filter((x) => x.ingredientId !== ingredientId);
          if (state.shoppingSession?.checked) delete state.shoppingSession.checked[ingredientId];
          if (Array.isArray(state.pantry)) state.pantry = state.pantry.filter((x) => x.ingredientId !== ingredientId);
          if (Array.isArray(state.recipes)) {
            for (const r of state.recipes) {
              if (!Array.isArray(r.items)) continue;
              r.items = r.items.filter((it) => it.ingredientId !== ingredientId);
            }
          }
          persist();
        }
        close();
        window.app.navigate("ingredients");
      }
    });
  }

    // Expose modals for other views (z.B. Bon-Scanner)
  window.ingredients = window.ingredients || {};
  window.ingredients.openIngredientModal = function (state, persist, ingOrNull, opts) {
    return openIngredientModal(state, persist, ingOrNull, opts || {});
  };

window.renderIngredientsView = function (container, state, persist) {
    if (!Array.isArray(state.ingredients)) state.ingredients = [];
    if (!Array.isArray(state.recipes)) state.recipes = [];
    if (!Array.isArray(state.pantry)) state.pantry = [];

    ensureShoppingSession(state);

    const cats = ingredientCategoriesSorted(state);
    const validCatIds = new Set(cats.map((c) => String(c.id)));
    if (ui.filterCat !== "all" && ui.filterCat !== "none" && !validCatIds.has(String(ui.filterCat))) ui.filterCat = "all";

    let ings = (state.ingredients || []).slice();
    if (!ui.showUnlisted) ings = ings.filter((ing) => !ing?.unlisted);
    if (ui.filterCat === "none") ings = ings.filter((ing) => !ing?.categoryId);
    else if (ui.filterCat !== "all") ings = ings.filter((ing) => String(ing?.categoryId || "") === String(ui.filterCat));
    ings = ings.sort((a, b) => (a.name || "").localeCompare(b.name || "", "de"));

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
            <h2 style="margin:0 0 6px 0;">Zutaten</h2>
            <p class="small" style="margin:0;">Grundstein pro Zutat (Packung). Aktionen über „⋯“. Hinzufügen über „+“.</p>
            ${ui.flash ? `<div class="small" style="margin-top:8px; opacity:0.95;">${esc(ui.flash)}</div>` : ``}

            <div class="chipbar" style="margin-top:10px;">
              ${chipsHTML}
              <button type="button" class="chipbtn ${ui.showUnlisted ? "active" : ""}" data-action="toggleUnlisted">Ungelistet</button>
              <button type="button" class="chipbtn" data-action="manageCats">Kategorien…</button>
            </div>
          </div>
          <div class="small muted2" style="text-align:right;">${esc(ings.length)} Zutat(en)</div>
        </div>
      </div>

      <div class="card">
        <h3 style="margin:0 0 10px 0;">Liste</h3>
        ${ings.length ? ings.map((ing) => ingredientCardHTML(state, ing)).join("") : `<p class="small">Noch keine Zutaten. Tippe unten rechts auf „+“.</p>`}
      </div>

      <button class="fab" type="button" data-action="openAdd" title="Neue Zutat">+</button>
    `;

    // Toggle-Tracking: damit Menüs nach Re-Render offen bleiben
    if (!container.__ingToggleBound) {
      container.__ingToggleBound = true;
      container.addEventListener(
        "toggle",
        (e) => {
          const details = e.target;
          if (!(details instanceof HTMLDetailsElement)) return;
          if (!details.classList.contains("ing-actions")) return;
          const id = details.getAttribute("data-ingredient") || "";
          if (!id) return;
          if (details.open) ui.openIngredientMenus.add(id);
          else ui.openIngredientMenus.delete(id);
        },
        true
      );
    }

    if (!container.__ingInputBound) {
      container.__ingInputBound = true;
      container.addEventListener(
        "input",
        (e) => {
          const inp = e.target;
          if (!(inp instanceof HTMLInputElement)) return;
          if (inp.getAttribute("data-action") !== "packs") return;
          const id = inp.getAttribute("data-ingredient-id") || "";
          if (!id) return;
          setPacks(id, inp.value);
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
        window.app.navigate("ingredients");
        return;
      }

      if (action === "toggleUnlisted") {
        ui.showUnlisted = !ui.showUnlisted;
        window.app.navigate("ingredients");
        return;
      }

      if (action === "manageCats") {
        openIngredientCategoriesModal(state, persist, {
          onSaved: () => window.app.navigate("ingredients")
        });
        return;
      }

      if (action === "openAdd") {
        // Plus => zuerst Scanner, darunter Option „Ohne Barcode“
        openBarcodeScannerModal(state, persist);
        return;
      }

      const ingId = btn.getAttribute("data-ingredient-id") || "";
      if (!ingId) return;

      if (action === "addShop") {
        const details = btn.closest("details");
        const inp = details?.querySelector("input[data-action=packs]");
        const packs = inp ? Math.max(1, Math.round(toNum(inp.value) || 1)) : getPacks(ingId);
        addIngredientToShopping(state, ingId, packs);
        persist();
        setFlash("Zur Einkaufsliste hinzugefügt.");
        window.app.navigate("ingredients");
        return;
      }

      if (action === "edit") {
        const ing = (state.ingredients || []).find((x) => x.id === ingId);
        if (!ing) return;
        openIngredientModal(state, persist, ing);
        return;
      }

      if (action === "del") {
        openDeleteModal(state, persist, ingId);
      }
    };
  };
})();
