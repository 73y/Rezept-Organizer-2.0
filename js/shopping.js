/* js/shopping.js
   Einkaufsliste (packs-only) + Einkaufen-Modus + Abschluss + Undo
   + Scan (Barcode) im Einkaufsmodus
   + Gekauft-Status als Zähler (packs) statt bool

   Passt zu app.js: window.renderShoppingView(container, state, persist)
*/
(() => {
  const esc = (s) => (window.utils?.esc ? window.utils.esc(s) : String(s ?? ""));
  const uid = () => (window.utils?.uid ? window.utils.uid() : window.models.uid());
  const euro = (n) => (window.utils?.euro ? window.utils.euro(Number(n) || 0) : window.models.euro(Number(n) || 0));
  const clone = (obj) => (window.utils?.clone ? window.utils.clone(obj) : JSON.parse(JSON.stringify(obj)));

  // ── OFF helpers (js/shopping/openFoodFacts.js) ──
  const cleanBarcode = (raw) => window.openFoodFacts.cleanBarcode(raw);
  const fetchOffSuggestion = (s, p, b) => window.openFoodFacts.fetchOffSuggestion(s, p, b);
  const offDebugHtml = (s) => window.openFoodFacts.offDebugHtml(s);

  // ── Receipt parsing (js/shopping/receiptParsing.js) ──
  const fmtDate = (iso) => window.receiptParsing.fmtDate(iso);
  const guessReceiptMeta = (text) => window.receiptParsing.guessReceiptMeta(text);
  const parseReceiptItemsFromText = (text) => window.receiptParsing.parseReceiptItemsFromText(text);
  const extractTextFromPdfFile = (file) => window.receiptParsing.extractTextFromPdfFile(file);
  const prefillReceiptTextFromFile = (el, f) => window.receiptParsing.prefillReceiptTextFromFile(el, f);

  // ── Receipt ↔ state (js/shopping/receiptData.js) ──
  const receiptProgress = (r) => window.receiptData.receiptProgress(r);
  const deleteReceiptAndRelated = (s, id) => window.receiptData.deleteReceiptAndRelated(s, id);
  const upsertPurchaseLogFromReceiptItem = (s, r, it) => window.receiptData.upsertPurchaseLogFromReceiptItem(s, r, it);
  const upsertPantryFromReceiptItem = (s, r, it) => window.receiptData.upsertPantryFromReceiptItem(s, r, it);

  function openReceiptDetailModal(state, persist, receiptId) {
    const receipt = (state.receipts || []).find((r) => r && r.id === receiptId);
    if (!receipt) return window.ui?.toast?.("Bon nicht gefunden.");

    const renderBody = () => {
      const r = (state.receipts || []).find((x) => x && x.id === receiptId);
      if (!r) return `<div class="small">Bon nicht gefunden.</div>`;

      const { matched, skipped, done, total } = receiptProgress(r);

      const ing = (state.ingredients || []).slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));

      const rows = (r.items || []).map((it) => {
        const isMain = it.kind === "item";
        const mapped = it.matchedIngredientId ? ing.find((x) => x.id === it.matchedIngredientId) : null;

        const select = isMain
          ? `
            <select data-action="map" data-item-id="${esc(it.id)}" style="width:100%;">
              <option value="">— Zutat wählen —</option>
              ${ing
                .map((x) => `<option value="${esc(x.id)}" ${it.matchedIngredientId === x.id ? "selected" : ""}>${esc(x.name || "Unbenannt")}</option>`)
                .join("")}
              <option value="__new__">+ Neue Zutat…</option>
            </select>
          `
          : `<div class="small muted2">Bon-Posten</div>`;

        return `
          <div style="border:1px solid var(--border); border-radius:12px; padding:10px; margin:8px 0;">
            <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
              <div style="min-width:0;">
                <div style="font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(it.rawName || "(unbekannt)")}</div>
                <div class="small muted2" style="margin-top:2px;">
                  ${esc(Math.max(1, Number(it.qty) || 1))}× · ${esc(euro(Number(it.lineTotal) || 0))}
                  ${it.kind === "pfand" ? " · Pfand" : it.kind === "discount" ? " · Rabatt" : ""}
                </div>
                ${mapped ? `<div class="small" style="margin-top:6px;">→ <b>${esc(mapped.name || "")}</b></div>` : ``}
              </div>
              <div style="text-align:right; min-width:120px;">
                ${select}
              </div>
            </div>
          </div>
        `;
      }).join("");

      return `
        <div class="small muted2">Status: <b>${done}/${total}</b> erledigt <span class="muted2">(zugeordnet ${matched}${skipped ? `, übersprungen ${skipped}` : ``})</span></div>
        <div class="small muted2" style="margin-top:2px;">${esc(r.store || "Bon")} · ${esc(fmtDate(r.at))} · Gesamt (berechnet): <b>${esc(euro(r.total || 0))}</b></div>
        <div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end; margin-top:10px;">
          <button class=\"success\" data-action=\"guidedScan\" data-receipt-id=\"${esc(r.id)}\">Geführtes Scannen</button>
          <button class=\"info\" data-action=\"freeScan\" data-receipt-id=\"${esc(r.id)}\">Freies Scannen</button>
        
          <button class="danger" data-action="deleteReceipt" data-receipt-id="${esc(r.id)}">Bon löschen</button>
        </div>
        <div style="margin-top:10px;">${rows || `<div class="small">Keine Positionen erkannt.</div>`}</div>
      `;
    };

    const modal = window.ui?.modal?.({
      title: "Bon – Zuordnen",
      contentHTML: renderBody(),
      okText: "Schließen",
      cancelText: " ",
      onConfirm: (_m, close) => close()
    });

    if (!modal) return;

    // hide cancel button visually if empty
    try {
      const cancelBtn = modal.modal.querySelector('button[data-action="cancel"]');
      if (cancelBtn) cancelBtn.style.display = "none";
    } catch {}

    
    modal.modal.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-action]");
      if (!btn) return;
      const a = btn.getAttribute("data-action");
      
      if (a === "deleteReceipt") {
        const id = btn.getAttribute("data-receipt-id") || receiptId;
        const r = (state.receipts || []).find((x) => x && x.id === id);
        if (!r) return;

        const ok = confirm(`Bon wirklich löschen?

${r.store || "Bon"} · ${fmtDate(r.at)}

Hinweis: Dazu werden auch die zugehörigen Ausgaben-Einträge entfernt.`);
        if (!ok) return;

        deleteReceiptAndRelated(state, id);
        persist();
        modal.close();
        return;
      }

if (a === "guidedScan") {
        openReceiptGuidedScanModal(state, persist, receiptId, {
          onFinish: () => {
            const body = modal.modal.querySelector(".modal-body");
            if (body) body.innerHTML = renderBody();
          }
        });
        return;
      }
      if (a === "freeScan") {
        openReceiptFreeScanModal(state, persist, receiptId, {
          onFinish: () => {
            const body = modal.modal.querySelector(".modal-body");
            if (body) body.innerHTML = renderBody();
          }
        });
        return;
      }
    });

modal.modal.addEventListener("change", (ev) => {
      const sel = ev.target.closest("select[data-action='map']");
      if (!sel) return;
      const itemId = sel.getAttribute("data-item-id");
      const v = sel.value;

      const r = (state.receipts || []).find((x) => x && x.id === receiptId);
      if (!r) return;

      const it = (r.items || []).find((x) => x && x.id === itemId);
      if (!it) return;

      const doSet = (ingredientIdOrNull) => {
        it.matchedIngredientId = ingredientIdOrNull || null;
        r.updatedAt = new Date().toISOString();

        // keep purchaseLog in sync
        upsertPurchaseLogFromReceiptItem(state, r, it);

        persist();
        // re-render body
        const body = modal.modal.querySelector(".modal-body");
        if (body) body.innerHTML = renderBody();
      };

      if (v === "__new__") {
        const suggested = it.rawName || "";
        const modal = window.ui?.modal?.({
          title: "Neue Zutat",
          contentHTML: `
            <div class="small muted2" style="margin-bottom:8px;">Name:</div>
            <input id="new-ing-name" class="input" value="${esc(suggested)}" placeholder="z.B. Paprika" />
            <div class="small muted2" style="margin-top:10px;">Packgröße/Preis kannst du später im Zutaten-Tab setzen.</div>
          `,
          okText: "Anlegen",
          cancelText: "Abbrechen",
          onConfirm: (m2, close2) => {
            const name = (m2.querySelector("#new-ing-name")?.value || "").trim();
            if (!name) {
              window.ui?.toast?.("Bitte Name eingeben.");
              return;
            }
            const unitPrice = (() => {
              const u = Number(it?.unitPrice);
              const q = Math.max(1, Number(it?.qty) || 1);
              const lt = Number(it?.lineTotal);
              const p = (Number.isFinite(u) && u > 0) ? u : ((Number.isFinite(lt) && lt > 0) ? (lt / q) : 0);
              return p ? (Math.round(p * 100) / 100) : 0;
            })();
            const newIng = { id: uid(), name, barcode: "", amount: 1, unit: "Stück", price: unitPrice, shelfLifeDays: 0 };
            state.ingredients.push(newIng);
            persist();
            close2();
            doSet(newIng.id);
          }
        });
        return;
      }

      doSet(v || null);
    });
  }

  
  // ── Receipt scanning (js/shopping/receiptScanning.js) ──
  const openReceiptGuidedScanModal = (...args) => window.receiptScanning.openReceiptGuidedScanModal(...args);
  const openReceiptFreeScanModal = (...args) => window.receiptScanning.openReceiptFreeScanModal(...args);

function openReceiptsHub(state, persist) {
    const render = () => {
      const receipts = (state.receipts || []).slice().sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
      const rows = receipts.map((r) => {
        const p = receiptProgress(r);
        return `
          <div style="border:1px solid var(--border); border-radius:14px; padding:10px; margin:8px 0;">
            <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
              <div style="min-width:0;">
                <div style="font-weight:800;">${esc(r.store || "Bon")} · ${esc(fmtDate(r.at))}</div>
                <div class="small muted2" style="margin-top:2px;">Gesamt: <b>${esc(euro(Number(r.total) || 0))}</b> · ${esc(p.done)}/${esc(p.total)} erledigt</div>
              </div>
              <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end;">
                <button class="success" data-action="scanReceipt" data-receipt-id="${esc(r.id)}">Scannen</button>
                <button class="info" data-action="openReceipt" data-receipt-id="${esc(r.id)}">Öffnen</button>
                <button class="danger" data-action="deleteReceipt" data-receipt-id="${esc(r.id)}">Löschen</button>
              </div>
            </div>
          </div>
        `;
      }).join("");

      return `
        <div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:space-between; align-items:center;">
          <button class="success" data-action="importReceipt">Bon importieren</button>
          <div class="small muted2">PDF (online) oder Text einfügen (offline)</div>
        </div>
        <div style="margin-top:10px;">
          ${rows || `<div class="small">Noch keine Bons importiert.</div>`}
        </div>
      `;
    };

    const modal = window.ui?.modal?.({
      title: "Bons",
      contentHTML: render(),
      okText: "Schließen",
      cancelText: " ",
      onConfirm: (_m, close) => close()
    });
    if (!modal) return;

    try {
      const cancelBtn = modal.modal.querySelector('button[data-action="cancel"]');
      if (cancelBtn) cancelBtn.style.display = "none";
    } catch {}

    modal.modal.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-action]");
      if (!btn) return;
      const a = btn.getAttribute("data-action");
      if (a === "importReceipt") {
        openReceiptImport(state, persist, () => {
          const body = modal.modal.querySelector(".modal-body");
          if (body) body.innerHTML = render();
        });
        return;
      }
      if (a === "scanReceipt") {
        const id = btn.getAttribute("data-receipt-id");
        if (!id) return;

        window.ui?.modal?.({
          title: "Scannen",
          contentHTML: `<div class="small muted2">Modus wählen:</div>
            <div class="small" style="margin-top:6px;">
              <b>Geführt</b> zeigt dir den nächsten Bon-Artikel. <br/>
              <b>Frei</b> zeigt dir Top-3 Vorschläge.
            </div>`,
          okText: "Geführt",
          cancelText: "Frei",
          okClass: "success",
          onConfirm: (_m3, close3) => {
            close3();
            openReceiptGuidedScanModal(state, persist, id, {
              onFinish: () => {
                const body = modal.modal.querySelector(".modal-body");
                if (body) body.innerHTML = render();
              }
            });
          },
          onCancel: () => {
            openReceiptFreeScanModal(state, persist, id, {
              onFinish: () => {
                const body = modal.modal.querySelector(".modal-body");
                if (body) body.innerHTML = render();
              }
            });
          }
        });
        return;
      }

      
      if (a === "deleteReceipt") {
        const id = btn.getAttribute("data-receipt-id");
        if (!id) return;
        const r = (state.receipts || []).find((x) => x && x.id === id);
        if (!r) return;

        const ok = confirm(`Bon wirklich löschen?

${r.store || "Bon"} · ${fmtDate(r.at)}

Hinweis: Dazu werden auch die zugehörigen Ausgaben-Einträge entfernt (damit du den Bon sauber neu importieren kannst).`);
        if (!ok) return;

        deleteReceiptAndRelated(state, id);
        persist();

        const body = modal.modal.querySelector(".modal-body");
        if (body) body.innerHTML = render();
        return;
      }

if (a === "openReceipt") {
        const id = btn.getAttribute("data-receipt-id");
        if (!id) return;
        openReceiptDetailModal(state, persist, id);
      }
    });
  }

  function openReceiptImport(state, persist, onDone) {
    const content = `
      <div class="small muted2" style="margin-bottom:8px;">
        Du kannst entweder ein PDF auswählen (online lädt die PDF-Lib) oder den Text aus dem Bon hier einfügen (offline).
      </div>
      <div style="display:grid; gap:10px;">
        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
          <button id="receipt-pick-btn" type="button" class="info">PDF auswählen</button>
          <div id="receipt-picked-name" class="small muted2">Keine Datei gewählt</div>
          <!--
            WICHTIG (Android): nicht display:none, sonst kann der Picker "nichts" tun.
            Außerdem kein capture-Attribut, sonst bietet Samsung oft nur Kamera/Galerie.
          -->
          <input id="receipt-file" type="file" accept=".pdf,application/pdf"
            style="position:absolute; left:-9999px; width:1px; height:1px; opacity:0;" />
        </div>
        <textarea id="receipt-text" class="input" style="min-height:140px; white-space:pre;" placeholder="Bon-Text hier einfügen…"></textarea>
      </div>
      <div class="small muted2" style="margin-top:8px;">
        Tipp: Wenn PDF-Import nicht geht, öffne den Bon am PC, kopiere alles und füge es hier ein.
      </div>
    `;

    const modal = window.ui?.modal?.({
      title: "Bon importieren",
      contentHTML: content,
      okText: "Vorschau",
      cancelText: "Abbrechen",
      onConfirm: async (m, close) => {
        const file = (m.__receiptFile || m.querySelector("#receipt-file")?.files?.[0] || null);
        const ta = m.querySelector("#receipt-text");
        let pasted = (ta?.value || "").trim();

        // If a PDF was selected, we try to auto-read it right away (prefillReceiptTextFromFile sets __receiptTextPromise).
        // When user taps "Vorschau" while the PDF is still being read, we wait for it here.
        if (!pasted && m.__receiptTextPromise) {
          try {
            await m.__receiptTextPromise;
            pasted = (ta?.value || "").trim();
          } catch {}
        }

        if (!file && !pasted) {
          window.ui?.toast?.("Bitte PDF wählen oder Text einfügen.");
          return;
        }

        let text = pasted;
        try {
          if (!text && file) {
            if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
              window.ui?.toast?.("PDF wird gelesen…", { timeoutMs: 3500 });
              text = await extractTextFromPdfFile(file);
            } else {
              text = await file.text();
            }
          }
        } catch (err) {
          console.warn(err);
          window.ui?.toast?.("PDF-Import fehlgeschlagen. Bitte Text einfügen.");
          return;
        }

        const meta = guessReceiptMeta(text);
        const items = parseReceiptItemsFromText(text);

        if (!items.length) {
          window.ui?.toast?.("Keine Artikel erkannt. Bitte Text prüfen.");
          return;
        }

        const total = items.reduce((s, it) => s + (Number(it.lineTotal) || 0), 0);

        // preview
        const previewRows = items.slice(0, 18).map((it) => `
          <div class="small" style="display:flex; justify-content:space-between; gap:10px;">
            <span style="max-width:72%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(it.rawName)}</span>
            <span>${esc(it.qty)}×</span>
            <span>${esc(euro(it.lineTotal))}</span>
          </div>
        `).join("");

        window.ui?.modal?.({
          title: "Bon Vorschau",
          contentHTML: `
            <div class="small muted2">${esc(meta.store)} · ${esc(fmtDate(meta.at))}</div>
            <div class="small muted2" style="margin-top:4px;">Erkannt: <b>${esc(items.length)}</b> Position(en). Gesamt (berechnet): <b>${esc(euro(total))}</b></div>
            <div style="margin-top:10px; display:grid; gap:6px;">${previewRows}</div>
            ${items.length > 18 ? `<div class="small muted2" style="margin-top:8px;">… und ${esc(items.length - 18)} weitere.</div>` : ``}
          `,
          okText: "Importieren",
          cancelText: "Abbrechen",
          onConfirm: (_m2, close2) => {
            const receipt = {
              id: uid(),
              at: meta.at,
              store: meta.store,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              total: Math.round(total * 100) / 100,
              items
            };

            if (!Array.isArray(state.receipts)) state.receipts = [];
            state.receipts.push(receipt);

            // purchaseLog sofort anlegen (A)
            for (const it of items) {
              upsertPurchaseLogFromReceiptItem(state, receipt, it);
            }

            persist();
            close2();
            close();

            onDone?.();
            // direkt in Detail, damit man zuordnen kann
            openReceiptDetailModal(state, persist, receipt.id);
          }
        });
      }
    });

    // PDF picker wiring
    try {
      const root = modal?.modal || document;
      const pickBtn = root.querySelector("#receipt-pick-btn");
      const fileInput = root.querySelector("#receipt-file");
      const nameEl = root.querySelector("#receipt-picked-name");

      if (pickBtn && fileInput) {
        pickBtn.addEventListener("click", async () => {
          // NOTE (Android/Samsung): <input type=file> can sometimes only show Kamera/Galerie.
          // If supported, prefer the File System Access API, which opens a real file picker.
          if (window.showOpenFilePicker) {
            try {
              const handles = await window.showOpenFilePicker({
                multiple: false,
                excludeAcceptAllOption: false,
                types: [
                  {
                    description: "PDF",
                    accept: { "application/pdf": [".pdf"] }
                  }
                ]
              });
              const handle = handles && handles[0];
              if (handle) {
                const f = await handle.getFile();
                try { root.__receiptFile = f; } catch {}
                if (nameEl) nameEl.textContent = f ? f.name : "Keine Datei gewählt";
                // Auto-read into textarea
                try { prefillReceiptTextFromFile(root, f); } catch {}
                // clear the fallback input so we don't read stale files
                try { fileInput.value = ""; } catch {}
                return;
              }
            } catch (e) {
              // user cancelled -> do nothing
              if (e && e.name === "AbortError") return;
              console.warn("showOpenFilePicker failed, falling back", e);
            }
          }

          // Fallback: input.click()
          try { fileInput.value = ""; } catch {}
          fileInput.click();
        });

        fileInput.addEventListener("change", () => {
          const f = fileInput.files?.[0] || null;
          try { root.__receiptFile = f; } catch {}
          if (nameEl) nameEl.textContent = f ? f.name : "Keine Datei gewählt";
          try { prefillReceiptTextFromFile(root, f); } catch {}
        });
      }
    } catch (e) {
      console.warn("Receipt PDF picker hook failed", e);
    }
  }


  // ── Shopping core (js/shopping/shoppingCore.js) ──
  const ensureState = (s) => window.shoppingCore.ensureState(s);
  const getIng = (s, id) => window.shoppingCore.getIng(s, id);
  const findIngredientByBarcode = (s, code) => window.shoppingCore.findIngredientByBarcode(s, code);
  const getRequiredPacks = (s, id) => window.shoppingCore.getRequiredPacks(s, id);
  const getBoughtCount = (s, id) => window.shoppingCore.getBoughtCount(s, id);
  const setBoughtCount = (s, id, n) => window.shoppingCore.setBoughtCount(s, id, n);
  const incBought = (s, id, d) => window.shoppingCore.incBought(s, id, d);
  const decBought = (s, id, d) => window.shoppingCore.decBought(s, id, d);
  const normalizeShopping = (s) => window.shoppingCore.normalizeShopping(s);
  const groupShopping = (s) => window.shoppingCore.groupShopping(s);
  const calcExpiresAt = (at, days) => window.shoppingCore.calcExpiresAt(at, days);
  const startShopping = (s) => window.shoppingCore.startShopping(s);
  const cancelShopping = (s) => window.shoppingCore.cancelShopping(s);
  const changePacks = (s, id, delta) => window.shoppingCore.changePacks(s, id, delta);
  const removeAll = (s, id) => window.shoppingCore.removeAll(s, id);
  const checkout = (s) => window.shoppingCore.checkout(s);
  const setUndo = (snapshot, msg) => window.shoppingCore.setUndo(snapshot, msg);
  const clearUndo = () => window.shoppingCore.clearUndo();
  const undo = (s, p, c) => window.shoppingCore.undo(s, p, c);

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
        setMsg("Nicht im Einkaufsmodus. Starte zuerst „Einkaufen starten“.", "warn");
        renderResult();
        pauseScanning();
        return;
      }

      // Wenn auf Liste: automatisch +1 als gekauft
      const onList = (state.shopping || []).some((x) => String(x.ingredientId) === String(currentIngredientId));
      if (onList) {
        incBought(state, currentIngredientId, 1);
        persist();
        renderShoppingView(container, state, persist);
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
        renderShoppingView(container, state, persist);
        setMsg("Zur Liste hinzugefügt.", "success");
        renderResult();
        return;
      }

      if (a === "buyInc" && ingredientId) {
        if (!state.shoppingSession.active) return;
        incBought(state, String(ingredientId), 1);
        persist();
        renderShoppingView(container, state, persist);
        renderResult();
        return;
      }

      if (a === "buyDec" && ingredientId) {
        if (!state.shoppingSession.active) return;
        decBought(state, String(ingredientId), 1);
        persist();
        renderShoppingView(container, state, persist);
        renderResult();
        return;
      }
    });

    // start
    startCamera();
  }

  // ---- render ----
  function renderShoppingView(container, state, persist) {
    ensureState(state);

    // bind once
    if (!container.__shoppingBound) {
      container.__shoppingBound = true;

      container.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-action]");
        if (!btn) return;

        const action = btn.getAttribute("data-action");
        const ingredientId = btn.getAttribute("data-ingredient-id");
        const recipeId = btn.getAttribute("data-recipe-id");

        // Snapshot for destructive actions (packs change that removes / removeAll)
        const takeSnapshot = () =>
          ({
            shopping: clone(state.shopping),
            pantry: clone(state.pantry),
            purchaseLog: clone(state.purchaseLog),
            shoppingSession: clone(state.shoppingSession)
          });

        if (action === "planRemove" && recipeId) {
          window.recipesLogic?.removePlannedRecipe?.(state, recipeId);
          window.recipesLogic?.reconcileShoppingWithPlan?.(state, { mode: "raise" }); // nicht reduzieren
          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "receipts") {
          openReceiptsHub(state, persist);
          return;
        }

        if (action === "planClean") {
          const ok = window.confirm(
            "Bereinigen reduziert Plan-Zutaten auf den Bedarf der geplanten Rezepte.\n\nManuelle Extras können dabei verschwinden.\n\nFortfahren?"
          );
          if (!ok) return;

          window.recipesLogic?.reconcileShoppingWithPlan?.(state, { mode: "exact" });
          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "start") {
          startShopping(state);
          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "cancel") {
          cancelShopping(state);
          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "scan") {
          openShoppingScannerModal(container, state, persist);
          return;
        }

        if (action === "buyInc" && ingredientId) {
          incBought(state, ingredientId, 1);
          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "buyDec" && ingredientId) {
          decBought(state, ingredientId, 1);
          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "inc" && ingredientId) {
          changePacks(state, ingredientId, +1);
          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "dec" && ingredientId) {
          const snap = takeSnapshot();
          const before = state.shopping.find((x) => x.ingredientId === ingredientId);
          const beforePacks = before ? Math.max(1, Math.round(Number(before.packs) || 1)) : 0;

          changePacks(state, ingredientId, -1);

          // Wenn der Eintrag dadurch komplett verschwunden ist -> Undo anbieten
          const stillThere = state.shopping.some((x) => x.ingredientId === ingredientId);
          if (!stillThere && beforePacks === 1) {
            setUndo(snap, "Eintrag entfernt.");
          }

          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "remove" && ingredientId) {
          const snap = takeSnapshot();
          removeAll(state, ingredientId);
          setUndo(snap, "Entfernt.");
          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "checkout") {
          const res = checkout(state);
          if (!res.ok) return;

          setUndo(res.snapshot, "Abgeschlossen. In den Vorrat übertragen.");
          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "undo") {
          undo(state, persist, container);
          return;
        }

        if (action === "toastClose") {
          clearUndo();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "textToggle") {
          const itemId = btn.getAttribute("data-item-id") || "";
          const it = (state.shopping || []).find(x => x.id === itemId);
          if (it) it.done = !it.done;
          persist();
          renderShoppingView(container, state, persist);
          return;
        }

        if (action === "textRemove") {
          const itemId = btn.getAttribute("data-item-id") || "";
          state.shopping = (state.shopping || []).filter(x => x.id !== itemId);
          persist();
          renderShoppingView(container, state, persist);
          return;
        }
      });
    }

    const groups = groupShopping(state);
    const active = !!state.shoppingSession.active;

    const boughtLines = groups.filter((g) => getBoughtCount(state, g.ingredientId) > 0).length;

    const boughtTotal = groups.reduce((sum, g) => {
      const bought = Math.min(g.packs, getBoughtCount(state, g.ingredientId));
      if (!bought) return sum;
      const ing = getIng(state, g.ingredientId);
      return sum + (Number(ing?.price) || 0) * bought;
    }, 0);

    const allTotal = groups.reduce((sum, g) => {
      const ing = getIng(state, g.ingredientId);
      return sum + (Number(ing?.price) || 0) * g.packs;
    }, 0);

    const rows = groups
      .map((g) => {
        const ing = getIng(state, g.ingredientId);
        const name = ing?.name || "(Unbekannte Zutat)";
        const packLabel = ing ? `${ing.amount ?? ""}${ing.unit ? " " + ing.unit : ""}`.trim() : "";

        const bought = Math.min(g.packs, getBoughtCount(state, g.ingredientId));
        const done = bought >= g.packs;

        return `
          <div style="display:flex; justify-content:space-between; gap:12px; align-items:center; padding:10px 0; border-top:1px solid var(--border);">
            <div style="min-width:0; flex:1;">
              <div style="font-weight:650; line-height:1.2;">${esc(name)}</div>
              <div class="small" style="margin-top:4px; opacity:0.9;">
                ${g.packs}× ${esc(packLabel)} · <b>${esc(euro((Number(ing?.price) || 0) * g.packs))}</b>
                ${g.planMin && g.planMin > 0 ? ` · <span class=\"small\" style=\"opacity:0.85;\">Plan: mind. <b>${g.planMin}×</b></span>` : ""}
              </div>
              ${
                active
                  ? `<div class="small" style="margin-top:6px;">Gekauft: <b>${bought}/${g.packs}</b> ${done ? "✓" : ""}</div>`
                  : ``
              }
            </div>

            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end;">
              ${
                active
                  ? `
                    <button data-action="buyDec" data-ingredient-id="${esc(g.ingredientId)}">−</button>
                    <button class="success" data-action="buyInc" data-ingredient-id="${esc(g.ingredientId)}">+</button>
                  `
                  : `
                    <button data-action="dec" data-ingredient-id="${esc(g.ingredientId)}">−</button>
                    <button data-action="inc" data-ingredient-id="${esc(g.ingredientId)}">+</button>
                    <button class="danger" data-action="remove" data-ingredient-id="${esc(g.ingredientId)}">Entfernen</button>
                  `
              }
            </div>
          </div>
        `;
      })
      .join("");

    const headerActions = active
      ? `
        <span class="small" style="border:1px solid var(--border); padding:4px 10px; border-radius:999px;">Im Einkauf</span>
        <button class="info" data-action="scan">Scannen</button>
        <button data-action="cancel">Abbrechen</button>
        <button class="success" data-action="checkout" ${boughtLines === 0 ? "disabled" : ""}>
          Abschließen / Bezahlt (${boughtLines}) · ${esc(euro(boughtTotal))}
        </button>
      `
      : `
        <button class="info" data-action="start" ${groups.length === 0 ? "disabled" : ""}>Einkaufen starten</button>
        <button class="info" data-action="receipts">Bon</button>
        <span class="small" style="opacity:0.9;">Gesamt: <b>${esc(euro(allTotal))}</b></span>
      `;

    const toast = window.shoppingCore.hasUndo?.()
      ? `
        <div class="toast-float" style="position:fixed; left:50%; bottom:18px; transform:translateX(-50%); z-index:9999;">
          <div class="toast-inner" style="display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--border); border-radius:14px; background:rgba(15,17,22,0.95); box-shadow:0 14px 40px rgba(0,0,0,0.55);">
            <div class="small" style="opacity:0.95;">${esc(window.shoppingCore.getUndoMessage?.() || "Aktion durchgeführt.")}</div>
            <button data-action="undo">Rückgängig</button>
            <button data-action="toastClose" title="Schließen" style="min-width:40px;">✕</button>
          </div>
        </div>
      `
      : "";

    const planned = Array.isArray(state.plannedRecipes) ? state.plannedRecipes : [];
    const recipes = Array.isArray(state.recipes) ? state.recipes : [];

    const planSummary = window.recipesLogic?.computePlanSummary?.(state) || { byIngredient: new Map() };
    const neededCount = Array.from(planSummary.byIngredient.values()).filter((x) => (Number(x.requiredPacks) || 0) > 0).length;

    const plannedChips = planned
      .slice()
      .sort((a, b) => String(a.addedAt || "").localeCompare(String(b.addedAt || "")))
      .map((p) => {
        const r = recipes.find((x) => String(x.id) === String(p.recipeId));
        const name = r?.name || "(Rezept gelöscht)";
        const portions = Math.max(1, Math.round(Number(p.portionsWanted) || 1));
        return `
          <span class="chip">
            <span style="font-weight:700; max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(name)}</span>
            <span class="muted2">${portions} Port.</span>
            <button class="danger chip-x" data-action="planRemove" data-recipe-id="${esc(String(p.recipeId))}" title="Entfernen">✕</button>
          </span>
        `;
      })
      .join("");

    const plannedSection = `
      <div style="margin-top:12px; padding:10px; border:1px dashed var(--border); border-radius:14px;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
          <div style="min-width:0; flex:1;">
            <div style="font-weight:750;">Geplante Rezepte</div>
            <div class="small" style="opacity:0.88; margin-top:4px;">
              ${planned.length ? `Plan beeinflusst <b>${neededCount}</b> Zutat(en).` : "Noch keine Rezepte geplant."}
            </div>
          </div>
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end;">
            <button class="warn" data-action="planClean" ${planned.length ? "" : "disabled"}>Bereinigen</button>
          </div>
        </div>

        <div class="chips" style="margin-top:10px;">
          ${planned.length ? plannedChips : ""}
        </div>
      </div>
    `;

    const textItems = (state.shopping || []).filter(it => it?.type === "text");
    const textRows = textItems.map(it => `
      <div style="display:flex; gap:10px; align-items:center; padding:8px 0; border-top:1px solid var(--border);">
        <button data-action="textToggle" data-item-id="${esc(it.id)}"
          style="min-width:36px; font-size:18px; line-height:1;"
          title="${it.done ? "Als nicht erledigt markieren" : "Abhaken"}">${it.done ? "✓" : "○"}</button>
        <span style="flex:1; ${it.done ? "text-decoration:line-through; opacity:0.55;" : ""}">${esc(it.label)}</span>
        <button class="danger" data-action="textRemove" data-item-id="${esc(it.id)}">Entfernen</button>
      </div>
    `).join("");

    container.innerHTML = `
      <div class="card">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
          <h2 style="margin:0;">Einkaufsliste</h2>
          <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; justify-content:flex-end;">
            ${headerActions}
          </div>
        </div>

        ${plannedSection}

        <div style="margin-top:10px;">
          ${groups.length ? rows : `<div class="small" style="padding:10px 0;">Noch nichts auf der Einkaufsliste.</div>`}
        </div>

        ${textItems.length ? `
          <div style="margin-top:12px;">
            <div class="small muted2" style="margin-bottom:4px;">Generische Zutaten (Rezept-Notizen)</div>
            ${textRows}
          </div>
        ` : ""}
      </div>
      ${toast}
    `;
  }

  window.openReceiptDetailModal = openReceiptDetailModal;
  window.renderShoppingView = renderShoppingView;
})();
