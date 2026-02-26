/* js/shopping/receiptModals.js
   Receipt modals: detail view, hub (list), and import flow.
   Extracted from js/shopping.js (v0.6.11).
   Exposes: window.receiptModals = { openReceiptDetailModal, openReceiptsHub, openReceiptImport }
*/
(() => {
  const esc = (s) => (window.utils?.esc ? window.utils.esc(s) : String(s ?? ""));
  const uid = () => (window.utils?.uid ? window.utils.uid() : window.models.uid());
  const euro = (n) => (window.utils?.euro ? window.utils.euro(Number(n) || 0) : window.models.euro(Number(n) || 0));

  const fmtDate = (iso) => window.receiptParsing.fmtDate(iso);
  const guessReceiptMeta = (text) => window.receiptParsing.guessReceiptMeta(text);
  const parseReceiptItemsFromText = (text) => window.receiptParsing.parseReceiptItemsFromText(text);
  const extractTextFromPdfFile = (file) => window.receiptParsing.extractTextFromPdfFile(file);
  const prefillReceiptTextFromFile = (el, f) => window.receiptParsing.prefillReceiptTextFromFile(el, f);

  const receiptProgress = (r) => window.receiptData.receiptProgress(r);
  const deleteReceiptAndRelated = (s, id) => window.receiptData.deleteReceiptAndRelated(s, id);
  const upsertPurchaseLogFromReceiptItem = (s, r, it) => window.receiptData.upsertPurchaseLogFromReceiptItem(s, r, it);

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
          <button class="success" data-action="guidedScan" data-receipt-id="${esc(r.id)}">Geführtes Scannen</button>
          <button class="info" data-action="freeScan" data-receipt-id="${esc(r.id)}">Freies Scannen</button>

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
        window.receiptScanning?.openReceiptGuidedScanModal?.(state, persist, receiptId, {
          onFinish: () => {
            const body = modal.modal.querySelector(".modal-body");
            if (body) body.innerHTML = renderBody();
          }
        });
        return;
      }
      if (a === "freeScan") {
        window.receiptScanning?.openReceiptFreeScanModal?.(state, persist, receiptId, {
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
            window.receiptScanning?.openReceiptGuidedScanModal?.(state, persist, id, {
              onFinish: () => {
                const body = modal.modal.querySelector(".modal-body");
                if (body) body.innerHTML = render();
              }
            });
          },
          onCancel: () => {
            window.receiptScanning?.openReceiptFreeScanModal?.(state, persist, id, {
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

  window.receiptModals = { openReceiptDetailModal, openReceiptsHub, openReceiptImport };
})();
