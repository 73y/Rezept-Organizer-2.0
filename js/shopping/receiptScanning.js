/* js/shopping/receiptScanning.js
   Receipt scanning helpers: tokenize/similarity, guided scan modal, free scan modal.
   Extracted from js/shopping.js (v0.6.10, updated v0.6.11).
   Exposes: window.receiptScanning
*/
(() => {
  const esc = (s) => (window.utils?.esc ? window.utils.esc(s) : String(s ?? ""));
  const uid = () => (window.utils?.uid ? window.utils.uid() : window.models.uid());
  const euro = (n) => (window.utils?.euro ? window.utils.euro(Number(n) || 0) : window.models.euro(Number(n) || 0));

  const cleanBarcode = (raw) => window.openFoodFacts.cleanBarcode(raw);
  const fetchOffSuggestion = (s, p, b) => window.openFoodFacts.fetchOffSuggestion(s, p, b);
  const offDebugHtml = (s) => window.openFoodFacts.offDebugHtml(s);

  const receiptProgress = (r) => window.receiptData.receiptProgress(r);
  const fmtDate = (iso) => window.receiptParsing.fmtDate(iso);
  const upsertPurchaseLogFromReceiptItem = (s, r, it) => window.receiptData.upsertPurchaseLogFromReceiptItem(s, r, it);
  const upsertPantryFromReceiptItem = (s, r, it) => window.receiptData.upsertPantryFromReceiptItem(s, r, it);

  const getIng = (s, id) => window.shoppingCore.getIng(s, id);
  const findIngredientByBarcode = (s, code) => window.shoppingCore.findIngredientByBarcode(s, code);

  // --- 0.4.1: Geführtes Scannen für Bons (Barcode -> Zutat -> Bearbeiten -> weiter scannen) ---
  function tokenizeForMatch(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9äöüß]+/gi, " ")
      .split(" ")
      .map((t) => t.trim())
      .filter((t) => t.length >= 2);
  }

  function nameSimilarity(a, b) {
    const A = new Set(tokenizeForMatch(a));
    const B = new Set(tokenizeForMatch(b));
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    const uni = A.size + B.size - inter;
    return uni > 0 ? inter / uni : 0;
  }

  function suggestIngredientsByName(state, expectedName, limit = 3) {
    const list = Array.isArray(state.ingredients) ? state.ingredients : [];
    const scored = list
      .map((ing) => ({ ing, score: nameSimilarity(expectedName, ing?.name || "") }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return scored;
  }


  function openReceiptGuidedScanModal(state, persist, receiptId, opts = {}) {
    const onFinish = typeof opts.onFinish === "function" ? opts.onFinish : null;

    const getReceipt = () => (state.receipts || []).find((r) => r && r.id === receiptId) || null;

    const findNextItemId = (r) => {
      const items = Array.isArray(r?.items) ? r.items : [];
      const next = items.find((it) => it && it.kind === "item" && !it.matchedIngredientId && !it.skippedAt);
      return next ? next.id : null;
    };

    let currentItemId = null;
    const r0 = getReceipt();
    if (!r0) return window.ui?.toast?.("Bon nicht gefunden.");
    currentItemId = findNextItemId(r0);

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const modal = document.createElement("div");
    modal.className = "modal scan-modal";
    modal.style.maxWidth = "720px";

    modal.innerHTML = `
      <div class="modal-header">
        <div class="modal-title">Geführtes Scannen</div>
        <button class="modal-close" data-action="close" title="Schließen">✕</button>
      </div>
      <div class="modal-body">
        <div class="small muted2" id="rg-meta"></div>
        <div style="display:flex; justify-content:space-between; gap:10px; align-items:center; margin-top:8px;">
          <div class="small" id="rg-progress"></div>
          <button class="info" data-action="openBon">Bon öffnen</button>
        </div>

        <div id="rg-next" style="margin-top:10px;"></div>

        <div class="scan-video-wrap" style="margin-top:10px; max-height:240px; overflow:hidden;">
          <video class="scan-video" id="rg-video" autoplay playsinline muted style="width:100%; max-height:240px; object-fit:cover; display:block; pointer-events:none;"></video>
        </div>

        <div class="row" style="margin-top:6px; align-items:center; justify-content:space-between; gap:10px;">
          <div class="small muted2" id="rg-barcode">Barcode: —</div>
          <button class="info" data-action="resume" title="Nächste Position (ohne Scan)">Weiter</button>
        </div>

        <div class="small muted2" id="rg-msg" style="margin-top:10px;"></div>
        <div id="rg-result" style="margin-top:12px;"></div>

        <div style="display:flex; gap:10px; flex-wrap:nowrap; justify-content:flex-end; margin-top:14px;">
          <button class="danger" data-action="skip">Überspringen</button>
          <button class="primary" data-action="close">Schließen</button>
        </div>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const video = modal.querySelector("#rg-video");
    const metaEl = modal.querySelector("#rg-meta");
    const progEl = modal.querySelector("#rg-progress");
    const nextEl = modal.querySelector("#rg-next");
    const msgEl = modal.querySelector("#rg-msg");
    const barcodeEl = modal.querySelector("#rg-barcode");
    const resultEl = modal.querySelector("#rg-result");

    let stream = null;
    let detector = null;
    let running = false;
    let paused = false;
    let tickTimer = null;

    // Letzte OFF-Antwort (für "Fehlende Angaben eintragen")
    let lastOffSuggestion = null;
    let lastOffCode = "";

    function close() {
      stopCamera();
      overlay.remove();
      onFinish?.();
    }

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });

    function ensureDetector() {
      if (detector) return detector;
      if ("BarcodeDetector" in window) {
        try {
          detector = new window.BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "qr_code"] });
          return detector;
        } catch {}
      }
      detector = null;
      return null;
    }

    async function startCamera() {
      if (running) return;
      const det = ensureDetector();
      if (!det) {
        msgEl.textContent = "Barcode-Scanner wird von diesem Browser nicht unterstützt.";
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        video.srcObject = stream;
        running = true;
        paused = false;
        msgEl.textContent = "Kamera aktiv – Barcode ins Bild halten.";
        tick();
      } catch (e) {
        msgEl.textContent = "Kamera konnte nicht gestartet werden (Berechtigung?).";
      }
    }

    function stopCamera() {
      running = false;
      paused = false;
      if (tickTimer) clearTimeout(tickTimer);
      tickTimer = null;
      if (stream) {
        try {
          stream.getTracks().forEach((t) => t.stop());
        } catch {}
      }
      stream = null;
      try { video.srcObject = null; } catch {}
    }

    function pauseScan() {
      paused = true;
    }

    function resumeScan() {
      if (!running) return startCamera();
      paused = false;
      msgEl.textContent = "Weiter scannen…";
      tick();
    }

    function getCurrentItem(r) {
      if (!r) return null;
      const items = Array.isArray(r.items) ? r.items : [];
      if (currentItemId) {
        const cur = items.find((x) => x && x.id === currentItemId) || null;
        if (cur && cur.kind === "item" && !cur.matchedIngredientId && !cur.skippedAt) return cur;
      }
      currentItemId = findNextItemId(r);
      return currentItemId ? items.find((x) => x && x.id === currentItemId) || null : null;
    }

    function render() {
      const r = getReceipt();
      if (!r) {
        metaEl.textContent = "Bon nicht gefunden.";
        progEl.textContent = "";
        nextEl.innerHTML = "";
        resultEl.innerHTML = "";
        msgEl.textContent = "";
        return;
      }

      const p = receiptProgress(r);
      metaEl.textContent = `${r.store || "Bon"} · ${fmtDate(r.at)} · Gesamt: ${euro(Number(r.total) || 0)}`;
      progEl.innerHTML = `Erledigt: <b>${p.done}/${p.total}</b> <span class="small muted2">(zugeordnet ${p.matched}${p.skipped ? `, übersprungen ${p.skipped}` : ``})</span>`;

      const cur = getCurrentItem(r);
      if (!cur) {
        nextEl.innerHTML = `<div style="padding:10px; border:1px solid var(--border); border-radius:12px;">
          <div style="font-weight:800;">Fertig ✓</div>
          <div class="small muted2" style="margin-top:4px;">Alle Bon-Artikel wurden zugeordnet. Du kannst trotzdem weiter scannen (z.B. andere Sachen) oder schließen.</div>
        </div>`;
        resultEl.innerHTML = "";
        msgEl.textContent = "Fertig – du kannst schließen oder den Bon öffnen.";
        pauseScan();
        stopCamera();
        return;
      }

      nextEl.innerHTML = `
        <div style="padding:10px; border:1px solid var(--border); border-radius:12px;">
          <div class="small muted2">Als nächstes (laut Bon):</div>
          <div style="font-weight:800; margin-top:4px;">${esc(cur.rawName || "(unbekannt)")}</div>
          <div class="small muted2" style="margin-top:4px;">${Math.max(1, Number(cur.qty) || 1)}× · ${euro(Number(cur.lineTotal) || 0)}</div>
        </div>
      `;
      resultEl.innerHTML = "";
      msgEl.textContent = "Barcode scannen…";
    }

    async function assignAndEdit(ingredientId, scannedCode) {
      const r = getReceipt();
      const cur = getCurrentItem(r);
      if (!r || !cur) return;

      cur.matchedIngredientId = ingredientId || null;
      r.updatedAt = new Date().toISOString();

      upsertPurchaseLogFromReceiptItem(state, r, cur);
      // Direkt in Vorrat übernehmen, sobald eine Zutat zugeordnet ist.
      upsertPantryFromReceiptItem(state, r, cur);
      persist();

      // Edit modal (Preis/Haltbarkeit) und danach direkt weiter scannen
      const ing = getIng(state, ingredientId);
      if (!ing || !window.ingredients?.openIngredientModal) {
        currentItemId = findNextItemId(r);
        render();
        if (currentItemId) resumeScan();
        return;
      }

      pauseScan();
      stopCamera();

      window.ingredients.openIngredientModal(state, persist, ing, {
        noNavigate: true,
        // Bon-Scan: Haltbarkeit relativ zum Kaufdatum (Bon-Datum)
        baseDateISO: (typeof getReceipt === "function" ? (getReceipt()?.at || getReceipt()?.createdAt || "") : ""),
        // Bon-Scan: Preis immer dabei (falls Parser mal 0 liefert, muss man ihn trotzdem eintragen)
        prefillPrice: (() => {
          const q = Math.max(1, Number(cur?.qty) || 1);
          const u = Number(cur?.unitPrice);
          const lt = Number(cur?.lineTotal);
          const p = (Number.isFinite(u) && u > 0) ? u : ((Number.isFinite(lt) && lt > 0) ? (lt / q) : 0);
          return p ? (Math.round(p * 100) / 100) : "";
        })(),
        requirePrice: true,
        onDone: () => {
          // Nach dem Bearbeiten nochmal in Vorrat übernehmen (falls vorher wegen fehlender Packungsmenge geskippt).
          try { upsertPantryFromReceiptItem(state, getReceipt() || r, cur); } catch {}
          currentItemId = findNextItemId(getReceipt() || r);
          render();
          if (currentItemId) startCamera();
        }
      });
    }

    async function createAndAssignNew(scannedCode, offPrefill = null) {
      const r = getReceipt();
      const cur = getCurrentItem(r);
      if (!r || !cur) return;
      const off = offPrefill || await fetchOffSuggestion(state, persist, scannedCode);
      const qty = off?.amount && off?.unit ? { amount: off.amount, unit: off.unit } : null;

      const prefillPrice = (() => {
        const q = Math.max(1, Number(cur?.qty) || 1);
        const u = Number(cur?.unitPrice);
        const lt = Number(cur?.lineTotal);
        const p = (Number.isFinite(u) && u > 0) ? u : ((Number.isFinite(lt) && lt > 0) ? (lt / q) : 0);
        return p ? (Math.round(p * 100) / 100) : "";
      })();

      pauseScan();
      stopCamera();

      if (!window.ingredients?.openIngredientModal) {
        window.ui?.toast?.("Zutaten-Modal nicht verfügbar.");
        startCamera();
        return;
      }

      window.ingredients.openIngredientModal(state, persist, null, {
        noNavigate: true,
        baseDateISO: (typeof getReceipt === "function" ? (getReceipt()?.at || getReceipt()?.createdAt || "") : ""),
        prefillBarcode: scannedCode,
        prefillName: (off?.name || cur.rawName || "").trim(),
        prefillAmount: qty?.amount || 1,
        prefillUnit: qty?.unit || "Stück",
        prefillPrice: prefillPrice,
        requirePrice: true,
        prefillNutriments: off?.nutriments || null,
        onSaved: (newIng) => {
          try {
            const rr = getReceipt();
            const item = (rr?.items || []).find((x) => x && x.id === currentItemId) || null;
            if (rr && item && !item.matchedIngredientId && newIng?.id) {
              item.matchedIngredientId = newIng.id;
              rr.updatedAt = new Date().toISOString();
              upsertPurchaseLogFromReceiptItem(state, rr, item);
              // Neu angelegte Zutat -> direkt in Vorrat übernehmen
              upsertPantryFromReceiptItem(state, rr, item);
              persist();
            }
          } catch {}
        },
        onDone: () => {
          // Nach dem Bearbeiten nochmal in Vorrat übernehmen (falls vorher wegen fehlender Packungsmenge geskippt).
          try { upsertPantryFromReceiptItem(state, getReceipt() || r, cur); } catch {}
          currentItemId = findNextItemId(getReceipt() || r);
          render();
          if (currentItemId) startCamera();
        }
      });
    }

    async function handleBarcodeFound(codeRaw) {
      const code = cleanBarcode(codeRaw);
      if (!code) return;

      try { if (barcodeEl) barcodeEl.textContent = `Barcode: ${code}`; } catch {}

      const r = getReceipt();
      const cur = getCurrentItem(r);
      if (!r || !cur) return;

      pauseScan();

      const ingByBarcode = findIngredientByBarcode(state, code);
      if (ingByBarcode) {
        const score = nameSimilarity(cur.rawName || "", ingByBarcode.name || "");
        const OK = 0.35;

        if (score < OK) {
          // Suspicious match -> ask to confirm
          resultEl.innerHTML = `
            <div style="border:1px solid var(--border); border-radius:12px; padding:10px;">
              <div style="font-weight:800;">Erkannt: ${esc(ingByBarcode.name || "")}</div>
              <div class="small muted2" style="margin-top:4px;">Barcode: <b>${esc(code)}</b></div>
${offDebugHtml(state, code)}
<div class="small muted2" style="margin-top:4px;">Das passt evtl. nicht zu „${esc(cur.rawName || "")}". Trotzdem zuordnen?</div>
              <div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end; margin-top:10px;">
                <button class="primary" data-action="assignIng" data-ingredient-id="${esc(ingByBarcode.id)}" data-code="${esc(code)}">Trotzdem zuordnen</button>
                <button data-action="resume">Weiter scannen</button>
              </div>
            </div>
          `;
          msgEl.textContent = "Bestätigen oder weiter scannen.";
          return;
        }

        // Auto-assign + edit
        resultEl.innerHTML = `<div class="small muted2">Zuordnung: ${esc(ingByBarcode.name || "")} · Barcode: <b>${esc(code)}</b> …</div>`;
        msgEl.textContent = `Zuordnung: ${ingByBarcode.name || ""} · Barcode: ${code}`;
        await assignAndEdit(ingByBarcode.id, code);
        return;
      }
      // Try Open Food Facts (so we can show OFF debug + prefill)
      msgEl.textContent = "Unbekannter Barcode – Open Food Facts wird geprüft…";
      let offTmp = null;
      try {
        offTmp = await fetchOffSuggestion(state, persist, code);
      } catch (e) {
        const why = String(e?.message || e || "Fehler");
        msgEl.textContent = `OFF-Check fehlgeschlagen: ${why}`;
        resultEl.innerHTML = `<div class="small muted2">${esc(msgEl.textContent)}</div>${offDebugHtml(state, code)}`;
        return;
      }
      const offNameTmp = String(offTmp?.name || "").trim();
      if (offNameTmp) {
        // Use OFF name for better suggestions if it looks useful
        try { cur.offName = offNameTmp; } catch {}
      }


      // Merken, damit wir es (falls unvollständig) per Button ins Bearbeiten übernehmen können.
      lastOffSuggestion = offTmp;
      lastOffCode = code;

      // Prüfen, ob wirklich "alles da ist", was wir automatisch übernehmen wollen.
      // Wichtig: Wenn etwas fehlt (z.B. Nährwerte), NICHT automatisch ins Bearbeiten springen.
      const missing = [];
      if (!(offTmp && offTmp.name)) missing.push("Name");
      if (!(offTmp && offTmp.amount && offTmp.unit)) missing.push("Menge/Einheit");

      const hasNutriments = (() => {
        const n = offTmp?.nutriments;
        if (!n || typeof n !== "object") return false;
        // reicht, wenn wenigstens EIN sinnvoller Wert da ist
        const keys = ["kcalPer100","proteinPer100","carbsPer100","fatPer100"];
        return keys.some((k) => n[k] != null && n[k] !== "" && !Number.isNaN(Number(n[k])));
      })();
      if (!hasNutriments) missing.push("Nährwerte");

      if (offTmp && offTmp.name) {
        // Wichtig: NICHT automatisch ins Bearbeiten springen.
        // Der Nutzer soll bewusst bestätigen (und sieht vorher, ob etwas fehlt).
        const complete = missing.length === 0;
        msgEl.textContent = complete
          ? "Open Food Facts: Treffer – bereit zum Übernehmen."
          : `Open Food Facts: Produkt gefunden, aber es fehlen: ${missing.join(", ")}.`;

        const title = complete ? "Produkt gefunden" : "Produkt gefunden – Angaben fehlen";
        const note = complete
          ? "Alle Daten sind da. Du kannst sie jetzt übernehmen."
          : "Du kannst jetzt entscheiden: weiter scannen oder die fehlenden Angaben eintragen.";
        const btnText = complete ? "Daten übernehmen" : "Fehlende Angaben eintragen";

        resultEl.innerHTML = `
          <div style="border:1px solid var(--border); border-radius:12px; padding:10px;">
            <div style="font-weight:800;">${esc(title)}</div>
            ${complete ? `` : `<div class="small muted2" style="margin-top:4px;">Fehlt: <b>${esc(missing.join(", "))}</b></div>`}
            <div class="small muted2" style="margin-top:6px;">${esc(note)}</div>
            ${offDebugHtml(state, code)}
            <div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end; margin-top:10px;">
              <button class="success" data-action="editOff" data-code="${esc(code)}">${esc(btnText)}</button>
              <button data-action="resume">Weiter scannen</button>
            </div>
          </div>
        `;
        return;
      }

const sug = suggestIngredientsByName(state, (cur.offName || cur.rawName || ""), 3);
      const sugRows = sug.length
        ? sug.map((x) => `
            <button data-action="assignIng" data-ingredient-id="${esc(x.ing.id)}" data-code="${esc(code)}" style="text-align:left;">
              ${esc(x.ing.name || "")} <span class="small muted2">(${Math.round(x.score * 100)}%)</span>
            </button>
          `).join("")
        : `<div class="small muted2">Keine passenden Vorschläge.</div>`;

      resultEl.innerHTML = `
        <div style="border:1px solid var(--border); border-radius:12px; padding:10px;">
          <div style="font-weight:800;">Unbekannter Barcode</div>
          <div class="small muted2" style="margin-top:4px;">Barcode: <b>${esc(code)}</b></div>
${offDebugHtml(state, code)}
<div class="small muted2" style="margin-top:4px;">Wähle eine passende Zutat oder lege eine neue an.</div>
          <div style="display:grid; gap:8px; margin-top:10px;">${sugRows}</div>
          <div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end; margin-top:12px;">
            <button class="success" data-action="newIng" data-code="${esc(code)}">+ Neue Zutat aus Barcode</button>
            <button class="info" data-action="openBon">Manuell zuordnen</button>
            <button data-action="resume">Weiter scannen</button>
          </div>
        </div>
      `;
      msgEl.textContent = "Unbekannter Barcode – Auswahl nötig.";
    }

    async function tick() {
      if (!running || paused) return;
      const det = ensureDetector();
      if (!det) return;

      try {
        const codes = await det.detect(video);
        if (codes && codes.length) {
          const raw = codes[0]?.rawValue || "";
          if (raw) return handleBarcodeFound(raw);
        }
      } catch {}
      tickTimer = setTimeout(tick, 200);
    }

    modal.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("button[data-action]");
      if (!btn) return;
      const a = btn.getAttribute("data-action");

      if (a === "close") return close();

      if (a === "openBon") {
        window.receiptModals?.openReceiptDetailModal?.(state, persist, receiptId);
        return;
      }

      if (a === "skip") {
        // Robust: immer verhindern, dass irgendein "Default" (z.B. Form-Submit) dazwischenfunkt
        try { ev.preventDefault?.(); ev.stopPropagation?.(); } catch {}

        const r = getReceipt();
        const cur = getCurrentItem(r);
        if (!r || !cur) return;

        const label = (cur.rawName || cur.name || "Position").trim();
        const ok = confirm(`Wirklich überspringen?

${label}${cur.qty && Number(cur.qty) > 1 ? ` (${cur.qty}×)` : ""}

Hinweis: Wird als erledigt markiert. Es wird NICHT in den Vorrat gebucht.
Die Zutat wird aber in „Zutaten" angelegt (minimal), damit du sie später sauber bearbeiten kannst.`);
        if (!ok) return;

        // 1) Minimal-Zutat sicher anlegen (falls noch nicht vorhanden)
        try {
          const nameRaw = String(label || "").trim();
          if (nameRaw) {
            const exists = (state.ingredients || []).some((x) => String(x?.name || "").trim().toLowerCase() === nameRaw.toLowerCase());
            if (!exists) {
              const newIng = {
                id: uid(),
                name: nameRaw,
                barcode: "",
                amount: 1,
                unit: "Stück",
                price: 0,
                shelfLifeDays: 0,
                nutriments: null,
                categoryId: null,
                unlisted: false
              };
              if (!Array.isArray(state.ingredients)) state.ingredients = [];
              state.ingredients.push(newIng);
            }
          }
        } catch {}

        // 2) Bon-Position als erledigt markieren
        try {
          cur.skippedAt = new Date().toISOString();
          cur.skipReason = "skipped";
          r.updatedAt = new Date().toISOString();
          persist();
        } catch {}

        // zum nächsten Item
        currentItemId = findNextItemId(getReceipt());
        render();
        if (currentItemId) resumeScan();
        return;
      }

      if (a === "resume") {
        resultEl.innerHTML = "";
        resumeScan();
        return;
      }

      if (a === "assignIng") {
        const ingId = btn.getAttribute("data-ingredient-id");
        const code = btn.getAttribute("data-code");
        resultEl.innerHTML = `<div class="small muted2">Zuordnung…</div>`;
        await assignAndEdit(ingId, code);
        return;
      }

      if (a === "editOff") {
        const code = btn.getAttribute("data-code") || "";
        if (!lastOffSuggestion || code !== lastOffCode) {
          resultEl.innerHTML = `<div class="small muted2">Daten nicht verfügbar – bitte erneut scannen.</div>`;
          return;
        }
        resultEl.innerHTML = `<div class="small muted2">Öffne Bearbeiten…</div>`;
        try { await createAndAssignNew(code, lastOffSuggestion); } catch {}
        return;
      }

      if (a === "newIng") {
        const code = btn.getAttribute("data-code");
        resultEl.innerHTML = `<div class="small muted2">Open Food Facts…</div>`;
        await createAndAssignNew(code);
        return;
      }
    });

    // initial
    render();
    startCamera();
  }

  // --- 0.4.2: Freies Scannen für Bons (Barcode -> Vorschläge (Top 3 Bon-Items) -> Bearbeiten -> weiter scannen) ---
  function suggestReceiptItemsByName(receipt, queryName, limit = 3) {
    const items = Array.isArray(receipt?.items) ? receipt.items : [];
    const open = items.filter((it) => it && it.kind === "item" && !it.matchedIngredientId);
    if (!open.length) return [];

    const q = String(queryName || "").trim();
    if (!q) return open.slice(0, limit).map((it) => ({ it, score: 0 }));

    const scored = open
      .map((it) => ({ it, score: nameSimilarity(q, it.rawName || "") }))
      .sort((a, b) => b.score - a.score);

    // Wenn alles 0 ist, zeigen wir einfach die ersten offenen Items.
    if (!scored[0] || scored[0].score <= 0) return open.slice(0, limit).map((it) => ({ it, score: 0 }));
    return scored.slice(0, limit);
  }

  function isGoodAutoMatch(top, second) {
    const s1 = top?.score ?? 0;
    const s2 = second?.score ?? 0;
    // konservativ: nur auto wenn wirklich deutlich
    if (s1 >= 0.78) return true;
    if (s1 >= 0.58 && (s1 - s2) >= 0.22) return true;
    return false;
  }

  function openReceiptFreeScanModal(state, persist, receiptId, opts = {}) {
    const onFinish = typeof opts.onFinish === "function" ? opts.onFinish : null;
    const getReceipt = () => (state.receipts || []).find((r) => r && r.id === receiptId) || null;

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const modal = document.createElement("div");
    modal.className = "modal scan-modal";
    modal.style.maxWidth = "720px";

    modal.innerHTML = `
      <div class="modal-header">
        <div class="modal-title">Freies Scannen</div>
        <button class="modal-close" data-action="close" title="Schließen">✕</button>
      </div>
      <div class="modal-body">
        <div class="small muted2" id="rf-meta"></div>
        <div style="display:flex; justify-content:space-between; gap:10px; align-items:center; margin-top:8px;">
          <div class="small" id="rf-progress"></div>
          <button class="info" data-action="openBon">Bon öffnen</button>
        </div>

        <div id="rf-banner" style="margin-top:10px;"></div>

        <div class="scan-video-wrap" style="margin-top:10px; max-height:240px; overflow:hidden;">
          <video class="scan-video" id="rf-video" autoplay playsinline muted style="width:100%; max-height:240px; object-fit:cover; display:block; pointer-events:none;"></video>
        </div>

        <div class="small muted2" id="rf-msg" style="margin-top:10px;"></div>
        <div id="rf-result" style="margin-top:12px;"></div>

        <div style="display:flex; gap:10px; flex-wrap:nowrap; justify-content:flex-end; margin-top:14px;">
          <button class="danger" data-action="skip">Überspringen</button>
          <button class="primary" data-action="close">Schließen</button>
        </div>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const video = modal.querySelector("#rf-video");
    const metaEl = modal.querySelector("#rf-meta");
    const progEl = modal.querySelector("#rf-progress");
    const bannerEl = modal.querySelector("#rf-banner");
    const msgEl = modal.querySelector("#rf-msg");
    const resultEl = modal.querySelector("#rf-result");

    let stream = null;
    let detector = null;
    let running = false;
    let paused = false;
    let tickTimer = null;

    let lastCode = "";
    let lastAt = 0;

    function close() {
      stopCamera();
      overlay.remove();
      onFinish?.();
    }

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });

    function ensureDetector() {
      if (detector) return detector;
      if ("BarcodeDetector" in window) {
        try {
          detector = new window.BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "qr_code"] });
          return detector;
        } catch {}
      }
      detector = null;
      return null;
    }

    async function startCamera() {
      if (running) return;
      const det = ensureDetector();
      if (!det) {
        msgEl.textContent = "Barcode-Scanner wird von diesem Browser nicht unterstützt.";
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        video.srcObject = stream;
        running = true;
        paused = false;
        msgEl.textContent = "Kamera aktiv – Barcode ins Bild halten.";
        tick();
      } catch {
        msgEl.textContent = "Kamera konnte nicht gestartet werden (Berechtigung?).";
      }
    }

    function stopCamera() {
      running = false;
      paused = false;
      if (tickTimer) clearTimeout(tickTimer);
      tickTimer = null;
      if (stream) {
        try { stream.getTracks().forEach((t) => t.stop()); } catch {}
      }
      stream = null;
      try { video.srcObject = null; } catch {}
    }

    function pauseScan() { paused = true; }

    function resumeScan() {
      if (!running) return startCamera();
      paused = false;
      msgEl.textContent = "Weiter scannen…";
      tick();
    }

    function renderHeader() {
      const r = getReceipt();
      if (!r) {
        metaEl.textContent = "Bon nicht gefunden.";
        progEl.textContent = "";
        bannerEl.innerHTML = "";
        return;
      }
      const p = receiptProgress(r);
      metaEl.textContent = `${r.store || "Bon"} · ${fmtDate(r.at)} · Gesamt: ${euro(Number(r.total) || 0)}`;
      progEl.innerHTML = `Erledigt: <b>${p.done}/${p.total}</b> <span class="small muted2">(zugeordnet ${p.matched}${p.skipped ? `, übersprungen ${p.skipped}` : ``})</span>`;
      if (p.total > 0 && p.done >= p.total) {
        bannerEl.innerHTML = `
          <div style="padding:10px; border:1px solid var(--border); border-radius:12px;">
            <div style="font-weight:800;">Fertig ✓</div>
            <div class="small muted2" style="margin-top:4px;">Alle Bon-Artikel sind zugeordnet. Du kannst trotzdem weiter scannen (z.B. extra Produkte).</div>
          </div>
        `;
      } else {
        bannerEl.innerHTML = `
          <div style="padding:10px; border:1px solid var(--border); border-radius:12px;">
            <div style="font-weight:800;">Bon offen</div>
            <div class="small muted2" style="margin-top:4px;">Scanne Produkte – bei Unsicherheit wählst du den passenden Bon-Artikel aus.</div>
          </div>
        `;
      }
    }

    function pickReceiptItemById(r, itemId) {
      if (!r) return null;
      return (r.items || []).find((x) => x && x.id === itemId) || null;
    }

    async function editIngredientThenResume(ing, opts = {}) {
      if (!ing || !window.ingredients?.openIngredientModal) {
        resumeScan();
        return;
      }
      pauseScan();
      stopCamera();

      const r = (typeof getReceipt === "function") ? getReceipt() : null;
      const baseDateISO = String(r?.at || r?.createdAt || "");

      const extOnDone = typeof opts?.onDone === "function" ? opts.onDone : null;

      window.ingredients.openIngredientModal(state, persist, ing, {
        ...(opts || {}),
        noNavigate: true,
        baseDateISO,
        requirePrice: true,
        onDone: (info) => {
          try { extOnDone?.(info); } catch {}
          renderHeader();
          startCamera();
        }
      });
    }

    async function assignReceiptItemAndEdit(r, itemId, ingredientId) {
      const item = pickReceiptItemById(r, itemId);
      if (!r || !item) return;
      item.matchedIngredientId = ingredientId || null;
      r.updatedAt = new Date().toISOString();
      upsertPurchaseLogFromReceiptItem(state, r, item);
      persist();

      const ing = getIng(state, ingredientId);
      await editIngredientThenResume(ing, {
        prefillPrice: (() => {
          const q = Math.max(1, Number(item?.qty) || 1);
          const u = Number(item?.unitPrice);
          const lt = Number(item?.lineTotal);
          const p = (Number.isFinite(u) && u > 0) ? u : ((Number.isFinite(lt) && lt > 0) ? (lt / q) : 0);
          return p ? (Math.round(p * 100) / 100) : "";
        })()
      });
    }

    async function createIngredientFlow({ code, prefillName, prefillAmount, prefillUnit, prefillPrice, prefillNutriments, onCreated }) {
      if (!window.ingredients?.openIngredientModal) {
        window.ui?.toast?.("Zutaten-Modal nicht verfügbar.");
        resumeScan();
        return;
      }
      pauseScan();
      stopCamera();
      window.ingredients.openIngredientModal(state, persist, null, {
        noNavigate: true,
        baseDateISO: (typeof getReceipt === "function" ? (getReceipt()?.at || getReceipt()?.createdAt || "") : ""),
        prefillBarcode: code,
        prefillName: prefillName || "",
        prefillAmount: prefillAmount || 1,
        prefillUnit: prefillUnit || "Stück",
        prefillPrice: (prefillPrice ?? ""),
        requirePrice: true,
        prefillNutriments: prefillNutriments || null,
        onSaved: (newIng) => {
          try { onCreated?.(newIng); } catch {}
        },
        onDone: () => {
          renderHeader();
          startCamera();
        }
      });
    }

    function renderPickList({ title, subtitle, barcode, picksHTML, extraHTML }) {
      resultEl.innerHTML = `
        <div style="border:1px solid var(--border); border-radius:12px; padding:10px;">
          <div style="font-weight:800;">${esc(title || "Auswahl")}</div>
          ${subtitle ? `<div class="small muted2" style="margin-top:4px;">${esc(subtitle)}</div>` : ``}
          ${barcode ? `<div class="small muted2" style="margin-top:6px;">Barcode: <b>${esc(barcode)}</b></div>` : ``}
          <div style="display:grid; gap:8px; margin-top:10px;">${picksHTML || ""}</div>
          ${extraHTML ? `<div style="margin-top:12px;">${extraHTML}</div>` : ``}
        </div>
      `;
    }

    async function handleBarcodeFound(codeRaw) {
      const code = cleanBarcode(codeRaw);
      if (!code) return;

      const now = Date.now();
      if (code === lastCode && (now - lastAt) < 1400) return; // Doppelt-Scan abfangen
      lastCode = code;
      lastAt = now;

      const r = getReceipt();
      if (!r) return;

      pauseScan();
      renderHeader();

      const p = receiptProgress(r);
      const openItems = (r.items || []).filter((it) => it && it.kind === "item" && !it.matchedIngredientId);

      const ing = findIngredientByBarcode(state, code);
      if (ing) {
        // Wenn Bon schon fertig: nur bearbeiten oder weiter
        if (!openItems.length) {
          renderPickList({
            title: `Erkannt: ${ing.name || "Zutat"}`,
            subtitle: "Bon ist fertig – das Produkt ist vermutlich extra / nicht auf dem Bon.",
            barcode: code,
            picksHTML: "",
            extraHTML: `
              <div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end;">
                <button class="success" data-action="editIng" data-ingredient-id="${esc(ing.id)}">Zutat bearbeiten</button>
                <button data-action="resume">Weiter scannen</button>
              </div>
            `
          });
          msgEl.textContent = "Bon fertig – optional bearbeiten.";
          return;
        }

        const sug = suggestReceiptItemsByName(r, ing.name || "", 3);
        const picks = sug.map((x) => {
          const it = x.it;
          const score = Number(x.score) || 0;
          const pct = score > 0 ? `${Math.round(score * 100)}%` : "";
          return `
            <button data-action="pickItem" data-item-id="${esc(it.id)}" data-ingredient-id="${esc(ing.id)}" style="text-align:left;">
              ${esc(it.rawName || "(unbekannt)")} <span class="small muted2">${esc(Math.max(1, Number(it.qty) || 1))}× · ${esc(euro(Number(it.lineTotal) || 0))}${pct ? " · " + pct : ""}</span>
            </button>
          `;
        }).join("");

        // Auto, wenn sehr sicher
        if (sug[0] && isGoodAutoMatch(sug[0], sug[1])) {
          msgEl.textContent = `Zuordnung (auto): ${sug[0].it.rawName} · Barcode: ${code}`;
          resultEl.innerHTML = `<div class="small muted2">Zuordnung…</div>`;
          await assignReceiptItemAndEdit(r, sug[0].it.id, ing.id);
          return;
        }

        renderPickList({
          title: `Erkannt: ${ing.name || "Zutat"}`,
          subtitle: "Welcher Bon-Artikel passt dazu? (Top 3)",
          barcode: code,
          picksHTML: picks || `<div class="small muted2">Keine offenen Bon-Artikel.</div>`,
          extraHTML: `
            <div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end;">
              <button class="info" data-action="notOnBon" data-ingredient-id="${esc(ing.id)}">Nicht auf Bon</button>
              <button class="success" data-action="editIng" data-ingredient-id="${esc(ing.id)}">Zutat bearbeiten</button>
              <button data-action="resume">Weiter scannen</button>
            </div>
          `
        });
        msgEl.textContent = "Bitte Bon-Artikel wählen oder überspringen.";
        return;
      }

      // Unbekannter Barcode
      msgEl.textContent = "Unbekannter Barcode – Vorschläge werden geladen…";
      const off = await fetchOffSuggestion(state, persist, code);
      const offName = String(off?.name || "").trim();

      if (!openItems.length) {
        renderPickList({
          title: offName ? `Unbekannt: ${offName}` : "Unbekannter Barcode",
          subtitle: "Bon ist fertig – du kannst das Produkt trotzdem als Zutat anlegen.",
          barcode: code,
          picksHTML: "",
          extraHTML: `
            <div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end;">
              <button class="success" data-action="newExtra" data-code="${esc(code)}">+ Neues Produkt hinzufügen</button>
              <button data-action="resume">Weiter scannen</button>
            </div>
          `
        });
        msgEl.textContent = "Bon fertig – extra Produkt möglich.";
        return;
      }

      const sug = suggestReceiptItemsByName(r, offName || code, 3);
      const picks = sug.map((x) => {
        const it = x.it;
        const score = Number(x.score) || 0;
        const pct = score > 0 ? `${Math.round(score * 100)}%` : "";
        return `
          <button data-action="createAndAssign" data-item-id="${esc(it.id)}" data-code="${esc(code)}" style="text-align:left;">
            ${esc(it.rawName || "(unbekannt)")} <span class="small muted2">${esc(Math.max(1, Number(it.qty) || 1))}× · ${esc(euro(Number(it.lineTotal) || 0))}${pct ? " · " + pct : ""}</span>
          </button>
        `;
      }).join("");

      renderPickList({
        title: offName ? `Unbekannt: ${offName}` : "Unbekannter Barcode",
        subtitle: "Wähle den passenden Bon-Artikel (Top 3) oder lege das Produkt als extra an.",
        barcode: code,
        picksHTML: picks || `<div class="small muted2">Keine offenen Bon-Artikel.</div>`,
        extraHTML: `
          <div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end;">
            <button class="success" data-action="newExtra" data-code="${esc(code)}">+ Neues Produkt hinzufügen</button>
            <button class="info" data-action="openBon">Bon öffnen</button>
            <button data-action="resume">Weiter scannen</button>
          </div>
        `
      });

      msgEl.textContent = "Auswahl nötig.";
    }

    async function tick() {
      if (!running || paused) return;
      const det = ensureDetector();
      if (!det) return;

      try {
        const codes = await det.detect(video);
        if (codes && codes.length) {
          const raw = codes[0]?.rawValue || "";
          if (raw) return handleBarcodeFound(raw);
        }
      } catch {}
      tickTimer = setTimeout(tick, 200);
    }

    modal.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("button[data-action]");
      if (!btn) return;
      const a = btn.getAttribute("data-action");

      if (a === "close") return close();
      if (a === "openBon") return window.receiptModals?.openReceiptDetailModal?.(state, persist, receiptId);
      if (a === "resume") {
        resultEl.innerHTML = "";
        resumeScan();
        return;
      }

      const r = getReceipt();
      if (!r) return;

      if (a === "editIng") {
        const ingId = btn.getAttribute("data-ingredient-id");
        const ing = getIng(state, ingId);
        await editIngredientThenResume(ing);
        return;
      }

      if (a === "notOnBon") {
        // einfach weiter (optional: edit)
        resultEl.innerHTML = "";
        resumeScan();
        return;
      }

      if (a === "skip") {
        try { ev.preventDefault?.(); ev.stopPropagation?.(); } catch {}

        // Im freien Scannen: nächstes offenes Bon-Item überspringen
        const items = Array.isArray(r.items) ? r.items : [];
        const cur = items.find((it) => it && it.kind === "item" && !it.matchedIngredientId && !it.skippedAt) || null;
        if (!cur) {
          msgEl.textContent = "Kein offener Bon-Artikel mehr zum Überspringen.";
          return;
        }

        const label = (cur.rawName || cur.name || "Position").trim();
        const ok = confirm(`Wirklich überspringen?\n\n${label}${cur.qty && Number(cur.qty) > 1 ? ` (${cur.qty}×)` : ""}\n\nHinweis: Wird als erledigt markiert. Es wird NICHT in den Vorrat gebucht.\nDie Zutat wird aber in „Zutaten" angelegt (minimal), damit du sie später sauber bearbeiten kannst.`);
        if (!ok) return;

        // Minimal-Zutat anlegen (falls noch nicht vorhanden)
        try {
          const nameRaw = String(label || "").trim();
          if (nameRaw) {
            const exists = (state.ingredients || []).some((x) => String(x?.name || "").trim().toLowerCase() === nameRaw.toLowerCase());
            if (!exists) {
              const newIng = { id: uid(), name: nameRaw, barcode: "", amount: 1, unit: "Stück", price: 0, shelfLifeDays: 0, nutriments: null, categoryId: null, unlisted: false };
              if (!Array.isArray(state.ingredients)) state.ingredients = [];
              state.ingredients.push(newIng);
            }
          }
        } catch {}

        // Bon-Position als erledigt markieren
        try {
          cur.skippedAt = new Date().toISOString();
          cur.skipReason = "skipped";
          r.updatedAt = new Date().toISOString();
          persist();
        } catch {}

        resultEl.innerHTML = "";
        msgEl.textContent = "Übersprungen.";
        renderHeader();
        resumeScan();
        return;
      }

      if (a === "pickItem") {
        const itemId = btn.getAttribute("data-item-id");
        const ingId = btn.getAttribute("data-ingredient-id");
        resultEl.innerHTML = `<div class="small muted2">Zuordnung…</div>`;
        await assignReceiptItemAndEdit(r, itemId, ingId);
        return;
      }

      if (a === "createAndAssign") {
        const itemId = btn.getAttribute("data-item-id");
        const code = btn.getAttribute("data-code");
        const off = await fetchOffSuggestion(state, persist, code);
        const qty = off?.amount && off?.unit ? { amount: off.amount, unit: off.unit } : null;
        await createIngredientFlow({
          code,
          prefillName: (off?.name || "").trim(),
          prefillAmount: qty?.amount || 1,
          prefillUnit: qty?.unit || "Stück",
          prefillPrice: (() => {
            const item = pickReceiptItemById(r, itemId);
            const q = Math.max(1, Number(item?.qty) || 1);
            const u = Number(item?.unitPrice);
            const lt = Number(item?.lineTotal);
            const p = (Number.isFinite(u) && u > 0) ? u : ((Number.isFinite(lt) && lt > 0) ? (lt / q) : 0);
            return p ? (Math.round(p * 100) / 100) : "";
          })(),
          prefillNutriments: off?.nutriments || null,
          onCreated: (newIng) => {
            if (!newIng?.id) return;
            const item = pickReceiptItemById(r, itemId);
            if (!item) return;
            item.matchedIngredientId = newIng.id;
            r.updatedAt = new Date().toISOString();
            upsertPurchaseLogFromReceiptItem(state, r, item);
            persist();
          }
        });
        return;
      }

      if (a === "newExtra") {
        const code = btn.getAttribute("data-code");
        const off = await fetchOffSuggestion(state, persist, code);
        const qty = off?.amount && off?.unit ? { amount: off.amount, unit: off.unit } : null;
        await createIngredientFlow({
          code,
          prefillName: (off?.name || "").trim(),
          prefillAmount: qty?.amount || 1,
          prefillUnit: qty?.unit || "Stück",
          prefillNutriments: off?.nutriments || null,
          onCreated: () => {}
        });
        return;
      }
    });

    renderHeader();
    startCamera();
  }

  window.receiptScanning = { openReceiptGuidedScanModal, openReceiptFreeScanModal };
})();
