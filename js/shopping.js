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
    const bestName = String(dbg.best?.name || "").trim();
    const head = res ? `${res}${bestName ? `: ${bestName.slice(0, 40)}` : ""} — ` : "";

    return (head + parts.join(" | ")).slice(0, 260);
  }

  function offDebugHtml(state, code) {
    const line = offDebugLineFromState(state, code);
    if (!line) return "";
    return `<div class="small muted2" style="margin-top:4px;">OFF: ${esc(line)}</div>`;
  }



  // ---- Bon / Beleg (0.4.0) ----
  const RECEIPT_STOP_RE = /(summe|gesamt|zu\s*zahlen|zahlbetrag|\bmwst\b|\bust\b|kartenzahlung|\bec\b|\bbar\b|r\.?\s*zahlung|rundung)/i;
  const RECEIPT_PRICE_RE = /-?\d{1,3}(?:\.\d{3})*,\d{2}/g;

  function parseEuroStr(s) {
    const v = String(s || "").replace(/\./g, "").replace(",", ".").replace(/[^0-9\-\.]/g, "");
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("de-DE", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  function guessReceiptMeta(text) {
    const t = String(text || "");
    const store = /\brewe\b/i.test(t) ? "REWE" : "Bon";

    let at = null;
    const dmY = t.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    const hm = t.match(/(\d{2}):(\d{2})/);
    if (dmY) {
      const dd = Number(dmY[1]), mm = Number(dmY[2]), yy = Number(dmY[3]);
      const hh = hm ? Number(hm[1]) : 12;
      const mi = hm ? Number(hm[2]) : 0;
      const d = new Date(yy, mm - 1, dd, hh, mi, 0, 0);
      if (!Number.isNaN(d.getTime())) at = d.toISOString();
    }
    if (!at) at = new Date().toISOString();

    return { store, at };
  }

  function parseReceiptItemsFromText(text) {
    const lines = String(text || "")
      .replace(/\r/g, "\n")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const items = [];
    let started = false;

    for (const lineRaw of lines) {
      const line = String(lineRaw || "").trim();
      if (!line) continue;

      if (started && RECEIPT_STOP_RE.test(line)) break;

      const matches = line.match(RECEIPT_PRICE_RE);
      if (!matches || matches.length === 0) continue;

      const lastStr = matches[matches.length - 1];
      const lastIdx = line.lastIndexOf(lastStr);
      if (lastIdx < 0) continue;

      // Heuristic: ignore lines that look like headers or phone numbers, etc.
      if (/^tel\b|^kasse\b|^filiale\b/i.test(line)) continue;

      started = true;

      const lineTotal = parseEuroStr(lastStr);
      if (!Number.isFinite(lineTotal)) continue;

      const secondLastStr = matches.length >= 2 ? matches[matches.length - 2] : null;
      const unitPriceMaybe = secondLastStr ? parseEuroStr(secondLastStr) : NaN;

      let namePart = line.slice(0, lastIdx).trim();
      if (secondLastStr) {
        const idx2 = namePart.lastIndexOf(secondLastStr);
        if (idx2 >= 0 && idx2 + secondLastStr.length >= namePart.length - 1) {
          namePart = namePart.slice(0, idx2).trim();
        }
      }

      let qty = 1;
      const mQty = namePart.match(/^(\d+)\s*[xX]\s+(.+)$/);
      if (mQty) {
        qty = Math.max(1, Math.round(Number(mQty[1]) || 1));
        namePart = String(mQty[2] || "").trim();
      } else if (Number.isFinite(unitPriceMaybe) && unitPriceMaybe > 0) {
        const ratio = lineTotal / unitPriceMaybe;
        const r = Math.round(ratio);
        if (Number.isFinite(ratio) && r > 0 && Math.abs(ratio - r) < 0.05) qty = r;
      }

      const unitPrice = Number.isFinite(unitPriceMaybe) && unitPriceMaybe > 0 ? unitPriceMaybe : (lineTotal / qty);

      const rawName = namePart.replace(/\s{2,}/g, " ").trim();

      // classify
      const low = rawName.toLowerCase();
      let kind = "item";
      if (/pfand/.test(low)) kind = "pfand";
      else if (/rabatt|coupon|gutschein|payback|aktion|bonus/.test(low)) kind = "discount";
      else if (/(^|[^a-z0-9äöüß])(mwst|ust)($|[^a-z0-9äöüß])/.test(low)) kind = "misc";

      items.push({
        id: uid(),
        rawName: rawName || "(unbekannt)",
        qty: Math.max(1, qty),
        unitPrice: Math.round((Number(unitPrice) || 0) * 100) / 100,
        lineTotal: Math.round((Number(lineTotal) || 0) * 100) / 100,
        matchedIngredientId: null,
        kind
      });
    }

    return items;
  }

  // If pdf text extraction "glues" multiple receipt rows into one long line,
  // we try to split it back into multiple lines by cutting after price tokens.
  // This is a heuristic, but it fixes the common case where the PDF has tiny line spacing.
  function splitMergedReceiptLine(line) {
    const s = String(line || "").replace(/\s{2,}/g, " ").trim();
    if (!s) return [];
    const ms = Array.from(s.matchAll(RECEIPT_PRICE_RE));
    if (ms.length <= 3) return [s];

    const out = [];
    let lastCut = 0;

    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      let end = (m.index || 0) + String(m[0] || "").length;

      // If two prices are basically adjacent (unit price + line total), keep them in one segment.
      if (i + 1 < ms.length) {
        const n = ms[i + 1];
        const gap = (n.index || 0) - end;
        if (gap >= 0 && gap <= 3) {
          end = (n.index || 0) + String(n[0] || "").length;
          i++;
        }
      }

      const seg = s.slice(lastCut, end).trim();
      lastCut = end;

      if (seg && /[A-Za-zÄÖÜäöüß]/.test(seg)) out.push(seg);
    }

    const rest = s.slice(lastCut).trim();
    if (rest && /[A-Za-zÄÖÜäöüß]/.test(rest)) out.push(rest);

    return out.length ? out : [s];
  }


  async function ensurePdfJs() {
    // pdf.js (UMD build) – needs to attach window.pdfjsLib
    if (window.pdfjsLib && window.pdfjsLib.getDocument) return window.pdfjsLib;

    // Use a stable UMD build (v2). Newer v4 builds are often ESM-only and won't attach globals.
    const SOURCES = [
      {
        lib: "https://cdn.jsdelivr.net/npm/pdfjs-dist@2.16.105/build/pdf.min.js",
        worker: "https://cdn.jsdelivr.net/npm/pdfjs-dist@2.16.105/build/pdf.worker.min.js"
      },
      {
        lib: "https://unpkg.com/pdfjs-dist@2.16.105/build/pdf.min.js",
        worker: "https://unpkg.com/pdfjs-dist@2.16.105/build/pdf.worker.min.js"
      },
      {
        lib: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js",
        worker: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js"
      }
    ];

    const loadScript = (src) => new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => resolve(true);
      s.onerror = () => reject(new Error("PDF-Lib konnte nicht geladen werden."));
      document.head.appendChild(s);
    });

    let lastErr = null;

    for (const src of SOURCES) {
      try {
        await loadScript(src.lib);
        const lib = window.pdfjsLib;
        if (lib && lib.getDocument) {
          if (lib.GlobalWorkerOptions) lib.GlobalWorkerOptions.workerSrc = src.worker;
          return lib;
        }
      } catch (e) {
        lastErr = e;
      }
    }

    throw lastErr || new Error("PDF-Lib konnte nicht geladen werden.");
  }

  async function extractTextFromPdfFile(file) {
    const pdfjsLib = await ensurePdfJs();
    if (!pdfjsLib || !pdfjsLib.getDocument) throw new Error("PDF-Lib fehlt.");

    const buf = await file.arrayBuffer();

    // Some environments (esp. PWA) may block the worker URL -> pdf.js throws "fake worker" error.
    // Fallback: disable worker and try again.
    let doc;
    try {
      doc = await pdfjsLib.getDocument({ data: buf }).promise;
    } catch (e) {
      const msg = String(e?.message || e || "");
      if (!pdfjsLib.disableWorker) {
        try {
          pdfjsLib.disableWorker = true;
          doc = await pdfjsLib.getDocument({ data: buf }).promise;
        } catch (e2) {
          throw new Error(msg || String(e2?.message || e2 || "PDF konnte nicht geladen werden."));
        }
      } else {
        throw new Error(msg || "PDF konnte nicht geladen werden.");
      }
    }

    const linesOut = [];

    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();

      const items = (content.items || [])
        .map((it) => ({
          str: String(it.str || "").trim(),
          x: it.transform ? Number(it.transform[4]) || 0 : 0,
          y: it.transform ? Number(it.transform[5]) || 0 : 0
        }))
        .filter((it) => it.str);

      // Sort: top->bottom, left->right
      items.sort((a, b) => b.y - a.y || a.x - b.x);

      // Adaptive y tolerance: some PDFs have very tight line spacing.
      // We estimate a threshold from y-differences of distinct y-values.
      const yVals = Array.from(new Set(items.map((it) => Math.round(it.y * 10) / 10))).sort((a, b) => b - a);
      const diffs = [];
      for (let i = 1; i < yVals.length; i++) {
        const d = Math.abs(yVals[i - 1] - yVals[i]);
        if (d > 0.05) diffs.push(d);
      }
      diffs.sort((a, b) => a - b);
      const med = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 3.0;
      const yTol = Math.max(1.2, Math.min(3.0, (Number(med) || 3.0) * 0.65));

      let curY = null;
      let prevX = null;
      let cur = [];

      const pushLine = (line) => {
        const cleaned = String(line || "").replace(/\s{2,}/g, " ").trim();
        if (!cleaned) return;
        const priceCount = (cleaned.match(RECEIPT_PRICE_RE) || []).length;

        // If a line contains many prices, it's often multiple receipt rows glued together.
        if (priceCount >= 6 || (priceCount >= 4 && cleaned.length > 120)) {
          const parts = splitMergedReceiptLine(cleaned);
          for (const part of parts) linesOut.push(part);
          return;
        }
        linesOut.push(cleaned);
      };

      const flush = () => {
        if (!cur.length) return;
        pushLine(cur.join(" "));
        cur = [];
      };

      for (const it of items) {
        if (curY === null) {
          curY = it.y;
          prevX = it.x;
          cur.push(it.str);
          continue;
        }

        const dy = Math.abs(it.y - curY);

        // New row if y jumps enough…
        let newRow = dy > yTol;

        // …or if x resets to the left while y slightly changed (tight line spacing).
        if (!newRow && prevX !== null) {
          const xReset = it.x < (prevX - 120);
          if (xReset && dy > (yTol * 0.25)) newRow = true;
        }

        if (newRow) {
          flush();
          curY = it.y;
          prevX = it.x;
        } else {
          prevX = it.x;
        }

        cur.push(it.str);
      }

      flush();
      linesOut.push(""); // page break
    }

    const out = linesOut.join("\n").trim();
    if (!out) throw new Error("PDF enthält keinen lesbaren Text.");
    return out;
  }

  // Auto-read selected receipt file and prefill textarea (so user doesn't need to press "Vorschau" just to read)
  async function prefillReceiptTextFromFile(modalEl, file) {
    if (!modalEl || !file) return;
    const ta = modalEl.querySelector("#receipt-text");
    const nameEl = modalEl.querySelector("#receipt-picked-name");
    if (!ta) return;

    // Don't overwrite user edits
    if (String(ta.value || "").trim()) return;

    const isPdf = (file.type === "application/pdf") || file.name.toLowerCase().endsWith(".pdf");
    const isText = (file.type === "text/plain") || file.name.toLowerCase().endsWith(".txt");

    // Token to ignore stale async results
    modalEl.__receiptAutoToken = (modalEl.__receiptAutoToken || 0) + 1;
    const token = modalEl.__receiptAutoToken;

    const setLabel = (suffix) => {
      if (!nameEl) return;
      const base = file?.name ? file.name : "Datei";
      nameEl.textContent = suffix ? `${base} ${suffix}` : base;
    };

    setLabel("(wird gelesen…)");

    const p = (async () => {
      if (isPdf) return await extractTextFromPdfFile(file);
      if (isText) return await file.text();
      return await file.text();
    })();

    modalEl.__receiptTextPromise = p;

    try {
      const text = await p;
      if (modalEl.__receiptAutoToken !== token) return;
      if (!String(ta.value || "").trim()) ta.value = text;
      setLabel("✓");
      window.ui?.toast?.("Bon-Datei geladen ✓", { timeoutMs: 1500 });
    } catch (e) {
      if (modalEl.__receiptAutoToken !== token) return;
      setLabel("(nicht lesbar)");
      console.warn(e);
      window.ui?.toast?.("PDF konnte nicht gelesen werden – bitte Text einfügen.", { timeoutMs: 3500 });
    }
  }
  function receiptProgress(receipt) {
    const items = Array.isArray(receipt?.items) ? receipt.items : [];
    const main = items.filter((x) => x.kind === "item");
    const total = main.length;
    const matched = main.filter((x) => x.matchedIngredientId).length;
    return { matched, total };
  }

  
  function deleteReceiptAndRelated(state, receiptId) {
    if (!receiptId) return;
    state.receipts = (state.receipts || []).filter((r) => r && r.id !== receiptId);
    // Remove any purchaseLog entries that came from this receipt (to avoid stats ghosts & duplicates after re-import)
    state.purchaseLog = (state.purchaseLog || []).filter((e) => !(e && e.source === "receipt" && e.receiptId === receiptId));
  }

function findPurchaseLogEntryForReceiptItem(state, receiptId, receiptItemId) {
    return (state.purchaseLog || []).find((e) => e && e.source === "receipt" && e.receiptId === receiptId && e.receiptItemId === receiptItemId) || null;
  }

  function upsertPurchaseLogFromReceiptItem(state, receipt, item) {
    const at = receipt.at;
    const entry = findPurchaseLogEntryForReceiptItem(state, receipt.id, item.id);
    const qty = Math.max(1, Math.round(Number(item.qty) || 1));
    const total = Number(item.lineTotal) || 0;
    const unitPrice = Number(item.unitPrice) || (total / qty);

    if (!entry) {
      state.purchaseLog.push({
        id: uid(),
        at,
        total,
        ingredientId: item.matchedIngredientId || null,
        packs: qty,
        buyAmount: 0,
        unit: "",
        source: "receipt",
        receiptId: receipt.id,
        receiptItemId: item.id,
        rawName: item.rawName,
        qty,
        unitPrice,
        kind: item.kind
      });
      return;
    }

    entry.at = at;
    entry.total = total;
    entry.rawName = item.rawName;
    entry.qty = qty;
    entry.packs = qty;
    entry.unitPrice = unitPrice;
    entry.kind = item.kind;

    entry.ingredientId = item.matchedIngredientId || null;

    if (entry.ingredientId) {
      const ing = (state.ingredients || []).find((x) => x.id === entry.ingredientId) || null;
      if (ing) {
        entry.unit = ing.unit || "";
        const packAmt = Number(ing.amount) || 0;
        entry.buyAmount = packAmt > 0 ? packAmt * qty : 0;

        // Preis nur setzen, wenn bisher leer/0 (vorsichtig)
        const curPrice = Number(ing.price);
        if (!Number.isFinite(curPrice) || curPrice <= 0) {
          ing.price = Math.round(unitPrice * 100) / 100;
        }
      }
    } else {
      entry.unit = "";
      entry.buyAmount = 0;
    }
  }

  function openReceiptDetailModal(state, persist, receiptId) {
    const receipt = (state.receipts || []).find((r) => r && r.id === receiptId);
    if (!receipt) return window.ui?.toast?.("Bon nicht gefunden.");

    const renderBody = () => {
      const r = (state.receipts || []).find((x) => x && x.id === receiptId);
      if (!r) return `<div class="small">Bon nicht gefunden.</div>`;

      const { matched, total } = receiptProgress(r);

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
        <div class="small muted2">Status: <b>${matched}/${total}</b> zugeordnet</div>
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

    if (!modal) return;
    try {
      const m = modal.modal;
      const pickBtn = m.querySelector('#receipt-pick-btn');
      const fileInput = m.querySelector('#receipt-file');
      const fileNameEl = m.querySelector('#receipt-picked-name');

      const setFileLabel = (file) => {
        if (!fileNameEl) return;
        fileNameEl.textContent = file ? file.name : 'Keine Datei gewählt';
      };

      // Fallback: klassischer <input type=file>
      const openHiddenInput = () => {
        if (!fileInput) return;
        fileInput.value = '';
        fileInput.click();
      };

      // Bevorzugt: Native File-Picker (öffnet auf Android zuverlässig "Eigene Dateien")
      const tryNativePicker = async () => {
        if (!window.showOpenFilePicker) return null;
        try {
          const [handle] = await window.showOpenFilePicker({
            multiple: false,
            types: [
              {
                description: 'PDF',
                accept: { 'application/pdf': ['.pdf'] }
              },
              {
                description: 'Text',
                accept: { 'text/plain': ['.txt', '.text'] }
              }
            ]
          });
          if (!handle) return null;
          const f = await handle.getFile();
          return f || null;
        } catch (_) {
          return null;
        }
      };

      if (fileInput) {
        fileInput.addEventListener('change', () => {
          const f = fileInput.files?.[0] || null;
          m.__receiptFile = f;
          setFileLabel(f);
        });
      }

      if (pickBtn) {
        pickBtn.addEventListener('click', async () => {
          const f = await tryNativePicker();
          if (f) {
            m.__receiptFile = f;
            setFileLabel(f);
            return;
          }
          openHiddenInput();
        });
      }
    } catch (err) {
      console.warn('Receipt picker init failed', err);
    }

    });
  }

  
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

  function openReceiptGuidedScanModal(state, persist, receiptId, opts = {}) {
    const onFinish = typeof opts.onFinish === "function" ? opts.onFinish : null;

    const getReceipt = () => (state.receipts || []).find((r) => r && r.id === receiptId) || null;

    const findNextItemId = (r) => {
      const items = Array.isArray(r?.items) ? r.items : [];
      const next = items.find((it) => it && it.kind === "item" && !it.matchedIngredientId);
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

        <div class="scan-video-wrap" style="margin-top:10px;">
          <video class="scan-video" id="rg-video" autoplay playsinline muted></video>
        </div>
        <div class="small muted2" id="rg-barcode" style="margin-top:6px;">Barcode: —</div>

        <div class="small muted2" id="rg-msg" style="margin-top:10px;"></div>
        <div id="rg-result" style="margin-top:12px;"></div>

        <div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end; margin-top:14px;">
          <button data-action="resume">Weiter scannen</button>
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
        if (cur && cur.kind === "item" && !cur.matchedIngredientId) return cur;
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
      progEl.innerHTML = `Zuordnung: <b>${p.matched}/${p.total}</b>`;

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
      persist();

      // Edit modal (Preis/Haltbarkeit) und danach direkt weiter scannen
      const ing = getIng(state, ingredientId);
      if (!ing || !window.ingredients?.openIngredientModal) {
        currentItemId = findNextItemId(r);
        render();
        resumeScan();
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
          currentItemId = findNextItemId(getReceipt() || r);
          render();
          startCamera();
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
              persist();
            }
          } catch {}
        },
        onDone: () => {
          currentItemId = findNextItemId(getReceipt() || r);
          render();
          startCamera();
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
<div class="small muted2" style="margin-top:4px;">Das passt evtl. nicht zu „${esc(cur.rawName || "")}“. Trotzdem zuordnen?</div>
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
        openReceiptDetailModal(state, persist, receiptId);
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

        <div class="scan-video-wrap" style="margin-top:10px;">
          <video class="scan-video" id="rf-video" autoplay playsinline muted></video>
        </div>

        <div class="small muted2" id="rf-msg" style="margin-top:10px;"></div>
        <div id="rf-result" style="margin-top:12px;"></div>

        <div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end; margin-top:14px;">
          <button data-action="resume">Weiter scannen</button>
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
      progEl.innerHTML = `Zuordnung: <b>${p.matched}/${p.total}</b>`;
      if (p.total > 0 && p.matched >= p.total) {
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
      if (a === "openBon") return openReceiptDetailModal(state, persist, receiptId);
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

// initial
    render();
    startCamera();
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
                <div class="small muted2" style="margin-top:2px;">Gesamt: <b>${esc(euro(Number(r.total) || 0))}</b> · ${esc(p.matched)}/${esc(p.total)} zugeordnet</div>
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


  // ---- undo (in-memory) ----
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

  // ---- state helpers ----
  function ensureState(state) {
    if (!Array.isArray(state.ingredients)) state.ingredients = [];
    if (!Array.isArray(state.shopping)) state.shopping = [];
    if (!Array.isArray(state.pantry)) state.pantry = [];
    if (!Array.isArray(state.purchaseLog)) state.purchaseLog = [];
    if (!Array.isArray(state.receipts)) state.receipts = [];
    if (!Array.isArray(state.recipes)) state.recipes = [];
    if (!Array.isArray(state.plannedRecipes)) state.plannedRecipes = [];

    if (!state.shoppingSession || typeof state.shoppingSession !== "object") {
      state.shoppingSession = { active: false, checked: {}, startedAt: null };
    }
    if (!state.shoppingSession.checked || typeof state.shoppingSession.checked !== "object") {
      state.shoppingSession.checked = {};
    }

    normalizeShopping(state);
  }

  function getIng(state, ingredientId) {
    return state.ingredients.find((i) => i.id === ingredientId) || null;
  }

  function findIngredientByBarcode(state, code) {
    const c = cleanBarcode(code);
    if (!c) return null;
    return (
      (state.ingredients || []).find((x) => cleanBarcode(x?.barcode) === c) || null
    );
  }

  function getRequiredPacks(state, ingredientId) {
    const it = (state.shopping || []).find((x) => String(x.ingredientId) === String(ingredientId));
    return it ? Math.max(1, Math.round(Number(it.packs) || 1)) : 0;
  }

  function getBoughtCount(state, ingredientId) {
    const v = state.shoppingSession?.checked?.[ingredientId];
    if (v === true) return Math.max(1, getRequiredPacks(state, ingredientId) || 1);
    if (v === false || v == null) return 0;
    const n = Math.floor(Number(v) || 0);
    return Math.max(0, n);
  }

  function setBoughtCount(state, ingredientId, next) {
    const max = getRequiredPacks(state, ingredientId) || 0;
    const n = Math.max(0, Math.floor(Number(next) || 0));
    const clamped = max ? Math.min(max, n) : n;
    if (!state.shoppingSession || typeof state.shoppingSession !== "object") {
      state.shoppingSession = { active: false, checked: {}, startedAt: null };
    }
    if (!state.shoppingSession.checked || typeof state.shoppingSession.checked !== "object") {
      state.shoppingSession.checked = {};
    }
    if (clamped <= 0) {
      delete state.shoppingSession.checked[ingredientId];
      return 0;
    }
    state.shoppingSession.checked[ingredientId] = clamped;
    return clamped;
  }

  function incBought(state, ingredientId, delta = 1) {
    const cur = getBoughtCount(state, ingredientId);
    return setBoughtCount(state, ingredientId, cur + delta);
  }

  function decBought(state, ingredientId, delta = 1) {
    const cur = getBoughtCount(state, ingredientId);
    return setBoughtCount(state, ingredientId, cur - delta);
  }

  function normalizeShopping(state) {
    // packs-only + duplicates mergen (planMin bleibt erhalten; max)
    const merged = new Map();

    for (const it of state.shopping || []) {
      if (!it || typeof it !== "object") continue;
      if (!it.ingredientId) continue;

      const ing = getIng(state, it.ingredientId);

      let packs = Number(it.packs);
      if (!Number.isFinite(packs) || packs <= 0) {
        // legacy qty/count
        const q = Number(it.qty ?? it.count);
        if (Number.isFinite(q) && q > 0) packs = q;
      }
      if (!Number.isFinite(packs) || packs <= 0) {
        // legacy amount -> packs
        const amt = Number(it.amount);
        const packSize = Number(ing?.amount || 0);
        if (Number.isFinite(amt) && amt > 0 && Number.isFinite(packSize) && packSize > 0) {
          packs = Math.max(1, Math.ceil(amt / packSize));
        }
      }
      if (!Number.isFinite(packs) || packs <= 0) packs = 1;

      let planMin = Number(it.planMin);
      if (!Number.isFinite(planMin) || planMin < 0) planMin = undefined;
      else planMin = Math.round(planMin);

      const key = String(it.ingredientId);
      const cur = merged.get(key);
      if (!cur) {
        const row = { id: it.id || uid(), ingredientId: key, packs: Math.round(packs) };
        if (typeof planMin !== "undefined") row.planMin = planMin;
        merged.set(key, row);
      } else {
        cur.packs += Math.round(packs);
        if (typeof planMin !== "undefined") {
          cur.planMin = Math.max(Number(cur.planMin) || 0, planMin);
        }
      }
    }

    state.shopping = Array.from(merged.values());

    // Wenn etwas nicht mehr auf der Liste steht, aus checked entfernen
    const existingIds = new Set(state.shopping.map((x) => String(x.ingredientId)));
    for (const k of Object.keys(state.shoppingSession.checked || {})) {
      if (!existingIds.has(String(k))) {
        delete state.shoppingSession.checked[k];
        continue;
      }

      // checked kann legacy bool sein -> in Zahl wandeln
      const req = getRequiredPacks(state, String(k));
      const v = state.shoppingSession.checked[k];
      if (v === true) state.shoppingSession.checked[k] = req || 1;
      else if (v === false || v == null) delete state.shoppingSession.checked[k];
      else {
        const n = Math.max(0, Math.floor(Number(v) || 0));
        if (n <= 0) delete state.shoppingSession.checked[k];
        else state.shoppingSession.checked[k] = req ? Math.min(req, n) : n;
      }
    }

    // Wenn Packs reduziert wurden, gekauft-Zähler clampen
    for (const it of state.shopping) {
      const id = String(it.ingredientId);
      const req = Math.max(1, Math.round(Number(it.packs) || 1));
      const curBought = getBoughtCount(state, id);
      if (curBought > req) setBoughtCount(state, id, req);
    }
  }

  function groupShopping(state) {
    const groups = (state.shopping || [])
      .map((it) => ({
        ingredientId: String(it.ingredientId),
        packs: Math.max(1, Math.round(Number(it.packs) || 1)),
        planMin: Math.max(0, Math.round(Number(it.planMin) || 0))
      }))
      .sort((a, b) => {
        const ia = getIng(state, a.ingredientId)?.name || "";
        const ib = getIng(state, b.ingredientId)?.name || "";
        return ia.localeCompare(ib, "de");
      });

    return groups;
  }

  function calcExpiresAt(boughtAtISO, shelfLifeDays) {
    const days = Number(shelfLifeDays || 0);
    if (!Number.isFinite(days) || days <= 0) return null;
    const ms = new Date(boughtAtISO).getTime() + days * 24 * 60 * 60 * 1000;
    return new Date(ms).toISOString();
  }

  function startShopping(state) {
    state.shoppingSession.active = true;
    state.shoppingSession.startedAt = state.shoppingSession.startedAt || new Date().toISOString();
  }

  function cancelShopping(state) {
    state.shoppingSession.active = false;
    state.shoppingSession.checked = {};
    state.shoppingSession.startedAt = null;
  }

  function changePacks(state, ingredientId, delta) {
    const it = state.shopping.find((x) => x.ingredientId === ingredientId);

    if (!it) {
      if (delta > 0) state.shopping.push({ id: uid(), ingredientId, packs: 1 });
      return;
    }

    const before = Math.max(1, Math.round(Number(it.packs) || 1));
    const after = before + delta;

    if (after <= 0) {
      state.shopping = state.shopping.filter((x) => x.ingredientId !== ingredientId);
      delete state.shoppingSession.checked[ingredientId];
      return;
    }

    it.packs = after;

    // clamp bought count
    const curBought = getBoughtCount(state, ingredientId);
    if (curBought > after) setBoughtCount(state, ingredientId, after);
  }

  function removeAll(state, ingredientId) {
    state.shopping = state.shopping.filter((x) => x.ingredientId !== ingredientId);
    delete state.shoppingSession.checked[ingredientId];
  }

  function checkout(state) {
    const groups = groupShopping(state);
    const bought = groups
      .map((g) => ({
        ...g,
        boughtPacks: Math.min(g.packs, getBoughtCount(state, g.ingredientId))
      }))
      .filter((g) => g.boughtPacks > 0);

    if (!bought.length) return { ok: false, reason: "none_checked" };

    const snapshot = {
      shopping: clone(state.shopping),
      pantry: clone(state.pantry),
      purchaseLog: clone(state.purchaseLog),
      shoppingSession: clone(state.shoppingSession)
    };

    const nowISO = new Date().toISOString();

    for (const g of bought) {
      const ing = getIng(state, g.ingredientId);
      if (!ing) continue;

      const packs = g.boughtPacks;
      const buyAmount = (Number(ing.amount) || 0) * packs;
      const total = (Number(ing.price) || 0) * packs;

      state.purchaseLog.push({
        id: uid(),
        at: nowISO,
        total,
        ingredientId: ing.id,
        packs,
        buyAmount,
        unit: ing.unit
      });

      state.pantry.push({
        id: uid(),
        ingredientId: ing.id,
        amount: buyAmount,
        unit: ing.unit,
        boughtAt: nowISO,
        expiresAt: calcExpiresAt(nowISO, ing.shelfLifeDays),
        cost: total
      });

      // Shopping packs reduzieren (gekauft) – Rest bleibt
      const row = state.shopping.find((x) => String(x.ingredientId) === String(g.ingredientId));
      if (row) {
        row.packs = Math.max(1, Math.round(Number(row.packs) || 1)) - packs;
        if (row.packs <= 0) {
          state.shopping = state.shopping.filter((x) => String(x.ingredientId) !== String(g.ingredientId));
        } else if (typeof row.planMin !== "undefined") {
          row.planMin = Math.max(0, Math.round(Number(row.planMin) || 0) - packs);
        }
      }

      delete state.shoppingSession.checked[g.ingredientId];
    }

    // Wenn die Liste jetzt leer ist, Einkaufsmodus beenden
    state.shoppingSession.active = false;
    state.shoppingSession.startedAt = null;

    // Pantry hat sich geändert -> Plan ggf. neu anheben (niemals reduzieren)
    window.recipesLogic?.reconcileShoppingWithPlan?.(state, { mode: "raise" });

    return { ok: true, snapshot };
  }

  function undo(state, persist, container) {
    if (!undoSnapshot) return;
    state.shopping = undoSnapshot.shopping;
    state.pantry = undoSnapshot.pantry;
    state.purchaseLog = undoSnapshot.purchaseLog;
    state.shoppingSession = undoSnapshot.shoppingSession;
    clearUndo();
    persist();
    renderShoppingView(container, state, persist);
  }

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

    const toast = undoSnapshot
      ? `
        <div class="toast-float" style="position:fixed; left:50%; bottom:18px; transform:translateX(-50%); z-index:9999;">
          <div class="toast-inner" style="display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--border); border-radius:14px; background:rgba(15,17,22,0.95); box-shadow:0 14px 40px rgba(0,0,0,0.55);">
            <div class="small" style="opacity:0.95;">${esc(undoMessage || "Aktion durchgeführt.")}</div>
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
      </div>
      ${toast}
    `;
  }

  window.renderShoppingView = renderShoppingView;
})();
