/* js/shopping/openFoodFacts.js
   OpenFoodFacts helpers: barcode cleaning, OFF lookup, debug display.
   Extracted from js/shopping.js (v0.6.9).
   Exposes: window.openFoodFacts
*/
(() => {
  const esc = (s) => (window.utils?.esc ? window.utils.esc(s) : String(s ?? ""));

  const cleanBarcode = (raw) => String(raw ?? "").replace(/\D+/g, "").trim();
  const isValidBarcode = (code) => {
    const c = cleanBarcode(code);
    return !!c && c.length >= 8 && c.length <= 14;
  };

  function offDebugLineFromState(state) {
    const dbg = state?.__debug?.lastOff;
    if (!dbg) return null;

    const tries = Array.isArray(dbg.tries) ? dbg.tries : [];
    const parts = tries.map((t) => {
      let host = "?";
      try { host = new URL(t.url).host; } catch {}
      let s = host;

      if (Number.isFinite(t.status)) s += ` HTTP ${t.status}`;
      if (Number.isFinite(t.jsonStatus)) s += ` status=${t.jsonStatus}`;
      const sv = String(t.statusVerbose || "").trim();
      if (sv) s += ` ${sv}`;

      // show a short product name if we have one and no verbose status
      const pn = String(t.productName || "").trim();
      if (pn && !sv) s += ` name=${pn.slice(0, 28)}`;

      const note = String(t.note || "").trim();
      if (note) s += ` (${note.slice(0, 60)})`;

      return s.trim();
    });

    const res = String(dbg.result || "").toUpperCase();
    const bestName = (typeof dbg.best === "string" ? dbg.best : String(dbg.best?.name || "")).trim();
    const head = res ? `${res}${bestName ? `: ${bestName.slice(0, 40)}` : ""} — ` : "";

    return (head + parts.join(" | ")).slice(0, 260);
  }

  function offDebugHtml(state) {
    const line = offDebugLineFromState(state);
    if (!line) return "";
    return `<div class="small muted2" style="margin-top:4px;">OFF: ${esc(line)}</div>`;
  }

  function ensureBarcodeCache(state) {
    if (!state.barcodeLookupCache || typeof state.barcodeLookupCache !== "object") state.barcodeLookupCache = {};
    return state.barcodeLookupCache;
  }

  function parseOffQuantity(qtyRaw) {
    const s = String(qtyRaw || "").trim();
    if (!s) return null;

    // 6 x 330 ml / 6x330ml / 2 x 500 g
    let m = s.match(/(\d+)\s*[xX]\s*(\d+(?:[.,]\d+)?)\s*(ml|cl|l|g|kg)\b/i);
    if (m) {
      const count = Math.max(1, parseInt(m[1], 10));
      const each = parseFloat(String(m[2]).replace(",", "."));
      let unit = String(m[3]).toLowerCase();
      let amount = each * count;
      if (!Number.isFinite(amount) || amount <= 0) return null;
      if (unit === "kg") { unit = "g"; amount = amount * 1000; }
      if (unit === "l") { unit = "ml"; amount = amount * 1000; }
      if (unit === "cl") { unit = "ml"; amount = amount * 10; }
      return { amount: Math.round(amount * 100) / 100, unit };
    }

    // 500 g / 1 l / 250ml
    m = s.match(/(\d+(?:[.,]\d+)?)\s*(ml|cl|l|g|kg)\b/i);
    if (m) {
      let amount = parseFloat(String(m[1]).replace(",", "."));
      let unit = String(m[2]).toLowerCase();
      if (!Number.isFinite(amount) || amount <= 0) return null;
      if (unit === "kg") { unit = "g"; amount = amount * 1000; }
      if (unit === "l") { unit = "ml"; amount = amount * 1000; }
      if (unit === "cl") { unit = "ml"; amount = amount * 10; }
      return { amount: Math.round(amount * 100) / 100, unit };
    }

    // 10 Stück / 10 stk / 10 pcs
    m = s.match(/(\d+)\s*(stück|stk|pcs|pc)\b/i);
    if (m) {
      const amount = parseInt(m[1], 10);
      if (!Number.isFinite(amount) || amount <= 0) return null;
      return { amount, unit: "Stück" };
    }

    return null;
  }

  function mapOffNutriments(nRaw) {
    // OpenFoodFacts liefert "nutriments" mit Keys wie:
    // energy-kcal_100g, proteins_100g, carbohydrates_100g, fat_100g
    // Unsere Zutaten-Modal erwartet: kcalPer100, proteinPer100, carbsPer100, fatPer100
    if (!nRaw || typeof nRaw !== "object") return null;

    const toNum = (v) => {
      if (v == null || v === "") return null;
      const n = Number(String(v).replace(",", "."));
      return Number.isFinite(n) ? n : null;
    };

    // kcal: bevorzugt das kcal-Feld. Wenn nur kJ da ist: umrechnen (1 kcal ≈ 4.184 kJ)
    const kcalDirect = toNum(nRaw["energy-kcal_100g"] ?? nRaw["energy-kcal"]);
    const kJ = toNum(nRaw["energy_100g"] ?? nRaw["energy"]);
    const kcalFromKJ = (kcalDirect == null && kJ != null) ? (kJ / 4.184) : null;

    const out = {
      kcalPer100: (kcalDirect != null) ? kcalDirect : (kcalFromKJ != null ? Math.round(kcalFromKJ * 10) / 10 : null),
      proteinPer100: toNum(nRaw["proteins_100g"] ?? nRaw["proteins"]),
      carbsPer100: toNum(nRaw["carbohydrates_100g"] ?? nRaw["carbohydrates"]),
      fatPer100: toNum(nRaw["fat_100g"] ?? nRaw["fat"])
    };

    const hasAny = Object.values(out).some((v) => v != null && !Number.isNaN(Number(v)));
    return hasAny ? out : null;
  }

  async function fetchOffSuggestion(state, persist, barcode) {
    const code = cleanBarcode(barcode);
    if (!isValidBarcode(code)) return null;

    const cache = ensureBarcodeCache(state);
    const cached = cache[code];

    // Cache-Hit: Wenn wir schon einen vollständigen Treffer inkl. Nährwerte haben, direkt zurückgeben.
    // Wenn Nährwerte fehlen, versuchen wir einmal OFF nachzuladen (damit alte Cache-Einträge nicht "für immer" unvollständig bleiben).
    if (cached && typeof cached === "object" && (cached.name || cached.ingredientsText || (cached.amount && cached.unit))) {
      if (cached.nutriments) {
        const debug = (state.__debug ||= {});
        debug.lastOff = {
          code,
          at: new Date().toISOString(),
          result: "hit",
          best: cached.name || "",
          tries: [{ url: "barcodeLookupCache", ok: true, status: 200, jsonStatus: 1, statusVerbose: "cached", productName: cached.name || "", note: "cached (cache)" }]
        };
        return cached;
      }
      // else: Cache ist "partial" -> OFF prüfen
    }

    const debug = (state.__debug ||= {});
    debug.lastOff = { code, at: new Date().toISOString(), result: "miss", best: null, tries: [] };

    // Wenn wir einen Cache-Eintrag hatten, aber ohne Nährwerte: als Hinweis in den Debug-Infos.
    if (cached && typeof cached === "object" && (cached.name || cached.ingredientsText || (cached.amount && cached.unit)) && !cached.nutriments) {
      debug.lastOff.tries.push({ url: "barcodeLookupCache", ok: true, status: 200, jsonStatus: 1, statusVerbose: "cached", productName: cached.name || "", note: "cached (partial) – nutriments missing" });
    }

    const tryJson = async (url) => {
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
        if (!entry.ct.includes("application/json")) {
          entry.note = `content-type ${entry.ct || "?"}`;
          return null;
        }

        const json = await res.json();
        entry.ok = true;

        const js = json && typeof json === "object" ? json : null;
        entry.jsonStatus = typeof js?.status === "number" ? js.status : null;
        entry.statusVerbose = String(js?.status_verbose || "").trim();

        const prod = js?.product && typeof js.product === "object" ? js.product : null;
        const pn = prod ? (prod.product_name_de || prod.product_name || prod.generic_name || "") : "";
        entry.productName = String(pn || "").trim();

        // OFF can return HTTP 200 but status=0 ("product not found") or other non-hit states.
        if (entry.jsonStatus === 0) {
          entry.note = `status=0 ${entry.statusVerbose || ""}`.trim();
          return null;
        }
        if (!prod) {
          entry.note = entry.note ? `${entry.note} | no product` : "no product";
          return null;
        }

        return js;
      } catch (e) {
        entry.note = String(e?.message || e || "fetch failed");
        return null;
      }
    };

    const toText = (v) => {
      if (v == null) return "";
      if (typeof v === "string") return v;
      if (typeof v === "number") return String(v);
      if (Array.isArray(v)) return toText(v[0]);
      if (typeof v === "object") return String(v.text || v.value || v.name || "");
      return String(v);
    };

    const parseProd = (prod) => {
      if (!prod || typeof prod !== "object") return null;

      const name = toText(prod.product_name_de || prod.product_name || prod.generic_name || "").trim();
      const brands = toText(prod.brands || "").trim();

      // quantity
      let parsed = null;
      if (prod.product_quantity && prod.product_quantity_unit) parsed = parseOffQuantity(`${prod.product_quantity}${prod.product_quantity_unit}`);
      if (!parsed && prod.quantity) parsed = parseOffQuantity(toText(prod.quantity));

      const ingredientsText = toText(prod.ingredients_text_de || prod.ingredients_text || "").trim();

      const nutriments = mapOffNutriments(prod.nutriments);

      if (!name && !brands && !parsed && !nutriments && !ingredientsText) return null;

      return {
        name: name || "",
        brands: brands || "",
        ingredientsText: ingredientsText || "",
        amount: parsed?.amount ? Math.round(parsed.amount * 100) / 100 : null,
        unit: parsed?.unit || "",
        rawQuantity: toText(prod.quantity || "").trim(),
        nutriments,
        fetchedAt: new Date().toISOString()
      };
    };

    // IMPORTANT: use production (.org) first. The .net domain is staging and may behave differently / require auth.
    const OFF_FIELDS = "product_name,product_name_de,brands,generic_name,quantity,product_quantity,product_quantity_unit,ingredients_text,ingredients_text_de,nutriments,status,status_verbose";
    const OFF_V2_ORG = "https://world.openfoodfacts.org/api/v2/product/";
    const OFF_V2_NET = "https://world.openfoodfacts.net/api/v2/product/";
    const OFF_V0_ORG = "https://world.openfoodfacts.org/api/v0/product/";
    const OFF_V0_NET = "https://world.openfoodfacts.net/api/v0/product/";

    const urls = [
      `${OFF_V2_ORG}${encodeURIComponent(code)}?fields=${encodeURIComponent(OFF_FIELDS)}&lc=de&cc=de`,
      `${OFF_V0_ORG}${encodeURIComponent(code)}.json`,
      `${OFF_V2_NET}${encodeURIComponent(code)}?fields=${encodeURIComponent(OFF_FIELDS)}&lc=de&cc=de`,
      `${OFF_V0_NET}${encodeURIComponent(code)}.json`
    ];

    for (const url of urls) {
      const json = await tryJson(url);
      if (!json || typeof json !== "object") continue;

      const prod = json.product && typeof json.product === "object" ? json.product : null;
      const out = parseProd(prod);

      // If OFF returned a product but we can't map any useful fields, keep trying fallbacks and show a note.
      if (!out || !(out.name || out.ingredientsText || (out.amount && out.unit) || out.nutriments)) {
        const last = debug.lastOff.tries[debug.lastOff.tries.length - 1];
        if (last && last.ok && !last.note) last.note = "product present but mapping empty";
        continue;
      }

      // Keep the best hit, but prefer a hit that includes nutriments.
      // Reason: API v2 with fields sometimes yields partial nutriments; v0 often has full nutriments.
      if (!debug.lastOff.bestOut) {
        debug.lastOff.bestOut = out;
      } else {
        const curBest = debug.lastOff.bestOut;
        const bestHasNut = !!curBest.nutriments;
        const outHasNut = !!out.nutriments;
        if (outHasNut && !bestHasNut) {
          debug.lastOff.bestOut = out;
        }
      }

      // If we already have nutriments, we're good — stop early.
      if (debug.lastOff.bestOut && debug.lastOff.bestOut.nutriments) break;
    }

    const finalOut = debug.lastOff.bestOut || null;
    if (finalOut) {
      cache[code] = finalOut;
      debug.lastOff.result = "hit";
      debug.lastOff.best = { name: finalOut.name || "", brands: finalOut.brands || "", amount: finalOut.amount || null, unit: finalOut.unit || "", hasNutriments: !!finalOut.nutriments };

      if (typeof persist === "function") persist();
      return finalOut;
    }

    // Wenn OFF nichts liefert, aber wir einen Cache-Eintrag haben, geben wir den Cache zurück
    // (damit der Nutzer trotzdem weiterarbeiten kann). Debug zeigt dann klar: cache fallback.
    if (cached && typeof cached === "object" && (cached.name || cached.ingredientsText || (cached.amount && cached.unit))) {
      debug.lastOff.result = "hit-cache";
      debug.lastOff.best = cached.name || "";
      debug.lastOff.tries.push({ url: "barcodeLookupCache", ok: true, status: 200, jsonStatus: 1, statusVerbose: "cached", productName: cached.name || "", note: "cache fallback (OFF miss)" });
      if (typeof persist === "function") persist();
      return cached;
    }

    debug.lastOff.result = "miss";
    if (typeof persist === "function") persist();
    return null;
  }

  window.openFoodFacts = { fetchOffSuggestion, cleanBarcode, isValidBarcode, offDebugLineFromState, offDebugHtml };
})();
