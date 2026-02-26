/* js/shopping/shoppingScanner.js
   Shopping barcode scanner modal (Einkaufsmodus).
   Extracted from js/shopping.js (v0.6.11).
   Exposes: window.shoppingScanner = { openShoppingScannerModal }
*/
(() => {
  const esc = (s) => (window.utils?.esc ? window.utils.esc(s) : String(s ?? ""));

  const cleanBarcode = (raw) => window.openFoodFacts.cleanBarcode(raw);
  const getIng = (s, id) => window.shoppingCore.getIng(s, id);
  const getRequiredPacks = (s, id) => window.shoppingCore.getRequiredPacks(s, id);
  const getBoughtCount = (s, id) => window.shoppingCore.getBoughtCount(s, id);
  const findIngredientByBarcode = (s, code) => window.shoppingCore.findIngredientByBarcode(s, code);
  const incBought = (s, id, d) => window.shoppingCore.incBought(s, id, d);
  const changePacks = (s, id, delta) => window.shoppingCore.changePacks(s, id, delta);
  const decBought = (s, id, d) => window.shoppingCore.decBought(s, id, d);

  // ---- Scanner Modal (Shopping) ----
  function openShoppingScannerModal(container, state, persist) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const modal = document.createElement("div");
    modal.className = "modal scan-modal";

    modal.innerHTML = `
      <div class="modal-header">
        <div class="modal-title">Barcode scannen</div>
        <button class="modal-close" data-action="close" title="Schließen">✕</button>
      </div>
      <div class="modal-body">
        <div class="scan-video-wrap">
          <div class="scan-hint small muted2">Kamera auf den Barcode halten. Nach Erkennung wird automatisch <b>+1</b> als gekauft gezählt.</div>
          <video class="scan-video" id="s-scan-video" autoplay playsinline muted></video>
        </div>

        <div class="small" id="s-scan-msg" style="margin-top:10px;"></div>

        <div class="scan-result" id="s-scan-result" style="margin-top:12px;">
          <span class="small muted2">Noch kein Barcode erkannt.</span>
        </div>

        <div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end; margin-top:12px;">
          <button data-action="rescan">Weiter scannen</button>
          <button data-action="close">Schließen</button>
        </div>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function close() {
      stopCamera();
      overlay.remove();
    }

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });

    const video = modal.querySelector("#s-scan-video");
    const msg = modal.querySelector("#s-scan-msg");
    const result = modal.querySelector("#s-scan-result");

    let stream = null;
    let raf = null;
    let detector = null;
    let paused = false;
    let lastCode = "";
    let lastAt = 0;
    let currentIngredientId = null;

    function setMsg(text, kind = "") {
      if (!msg) return;
      msg.textContent = text || "";
      msg.className = "small";
      if (kind === "warn") msg.classList.add("warn");
      if (kind === "success") msg.classList.add("success");
    }

    function renderResult() {
      if (!currentIngredientId) {
        result.innerHTML = `<span class="small muted2">Noch kein Barcode erkannt.</span>`;
        return;
      }

      const ing = getIng(state, currentIngredientId);
      const onList = !!(state.shopping || []).some((x) => String(x.ingredientId) === String(currentIngredientId));

      if (!ing) {
        result.innerHTML = `
          <div style="font-weight:750;">Unbekannter Barcode</div>
                    <div class="small muted2" style="margin-top:6px;">Barcode: <b>${esc(lastCode || "")}</b></div>
<div class="small muted2" style="margin-top:6px;">Diese Zutat ist noch nicht in deinen Zutaten gespeichert.</div>
          <div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end; margin-top:10px;">
            <button class="info" data-action="goIngredients">Zu Zutaten</button>
          </div>
        `;
        return;
      }

      const req = getRequiredPacks(state, currentIngredientId) || 0;
      const bought = getBoughtCount(state, currentIngredientId);
      const packLabel = `${ing.amount ?? ""}${ing.unit ? " " + ing.unit : ""}`.trim();

      if (!onList) {
        result.innerHTML = `
          <div style="font-weight:800; line-height:1.2;">${esc(ing.name)}</div>
                    <div class="small muted2" style="margin-top:6px;">Barcode: <b>${esc(lastCode || "")}</b></div>
<div class="small muted2" style="margin-top:6px;">Nicht auf der Einkaufsliste.</div>
          <div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end; margin-top:10px;">
            <button class="info" data-action="addToList" data-ingredient-id="${esc(String(currentIngredientId))}">Zur Liste hinzufügen (+1)</button>
          </div>
        `;
        return;
      }

      const done = req > 0 && bought >= req;
      result.innerHTML = `
        <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
          <div style="min-width:0; flex:1;">
            <div style="font-weight:800; line-height:1.2;">${esc(ing.name)}</div>
            <div class="small muted2" style="margin-top:6px;">Packung: <b>${esc(packLabel)}</b></div>
            <div class="small muted2" style="margin-top:4px;">Barcode: <b>${esc(lastCode || "")}</b></div>
            <div class="small" style="margin-top:8px;">Gekauft: <b>${bought}/${req || 0}</b> ${done ? "✓" : ""}</div>
          </div>
          ${done ? `<span class="pill exp-green">Fertig</span>` : ``}
        </div>
        <div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end; margin-top:12px;">
          <button data-action="buyDec" data-ingredient-id="${esc(String(currentIngredientId))}">−</button>
          <button class="success" data-action="buyInc" data-ingredient-id="${esc(String(currentIngredientId))}">+</button>
        </div>
      `;
    }

    async function getDetector() {
      if (typeof BarcodeDetector === "undefined") return null;
      try {
        detector = detector || new BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"] });
        return detector;
      } catch {
        return null;
      }
    }

    async function startCamera() {
      paused = false;
      currentIngredientId = null;
      renderResult();
      setMsg("", "");

      const det = await getDetector();
      if (!det) {
        setMsg("Scanner wird auf diesem Gerät nicht unterstützt.", "warn");
        return;
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false
        });
        video.srcObject = stream;
        await video.play();
        tick();
      } catch (e) {
        setMsg("Kamera-Zugriff nicht möglich. Bitte Kamera erlauben.", "warn");
      }
    }

    function stopCamera() {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      paused = true;
      if (stream) {
        try {
          for (const t of stream.getTracks()) t.stop();
        } catch {}
      }
      stream = null;
    }

    function pauseScanning() {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      paused = true;
    }

    async function handleFound(code) {
      const now = Date.now();
      if (code === lastCode && now - lastAt < 1400) return; // debounce
      lastCode = code;
      lastAt = now;

      const ing = findIngredientByBarcode(state, code);
      currentIngredientId = ing?.id ? String(ing.id) : null;

      if (!currentIngredientId) {
        setMsg("Unbekannter Barcode. Bitte erst in Zutaten anlernen.", "warn");
        renderResult();
        pauseScanning();
        return;
      }

      // Wenn nicht im Einkaufsmodus, nur anzeigen
      if (!state.shoppingSession.active) {
        setMsg("Nicht im Einkaufsmodus. Starte zuerst „Einkaufen starten".", "warn");
        renderResult();
        pauseScanning();
        return;
      }

      // Wenn auf Liste: automatisch +1 als gekauft
      const onList = (state.shopping || []).some((x) => String(x.ingredientId) === String(currentIngredientId));
      if (onList) {
        incBought(state, currentIngredientId, 1);
        persist();
        window.renderShoppingView?.(container, state, persist);
        setMsg("Erkannt. +1 gekauft.", "success");
      } else {
        setMsg("Erkannt, aber nicht auf der Liste.", "warn");
      }

      renderResult();
      pauseScanning();
    }

    async function tick() {
      if (paused) return;
      if (!detector || !video || video.readyState < 2) {
        raf = requestAnimationFrame(tick);
        return;
      }

      try {
        const barcodes = await detector.detect(video);
        if (Array.isArray(barcodes) && barcodes.length) {
          const raw = barcodes[0]?.rawValue || "";
          const code = cleanBarcode(raw);
          if (code) {
            await handleFound(code);
            return;
          }
        }
      } catch {
        // ignore
      }

      raf = requestAnimationFrame(tick);
    }

    modal.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const a = btn.getAttribute("data-action");
      const ingredientId = btn.getAttribute("data-ingredient-id");

      if (a === "close") return close();

      if (a === "rescan") {
        paused = false;
        currentIngredientId = null;
        renderResult();
        setMsg("", "");
        tick();
        return;
      }

      if (a === "goIngredients") {
        close();
        window.app?.navigate?.("ingredients");
        return;
      }

      if (a === "addToList" && ingredientId) {
        changePacks(state, String(ingredientId), +1);
        persist();
        window.renderShoppingView?.(container, state, persist);
        setMsg("Zur Liste hinzugefügt.", "success");
        renderResult();
        return;
      }

      if (a === "buyInc" && ingredientId) {
        if (!state.shoppingSession.active) return;
        incBought(state, String(ingredientId), 1);
        persist();
        window.renderShoppingView?.(container, state, persist);
        renderResult();
        return;
      }

      if (a === "buyDec" && ingredientId) {
        if (!state.shoppingSession.active) return;
        decBought(state, String(ingredientId), 1);
        persist();
        window.renderShoppingView?.(container, state, persist);
        renderResult();
        return;
      }
    });

    // start
    startCamera();
  }

  window.shoppingScanner = { openShoppingScannerModal };
})();
