/* js/shopping/receiptParsing.js
   Receipt text/PDF parsing helpers.
   Extracted from js/shopping.js (v0.6.9).
   Exposes: window.receiptParsing
*/
(() => {
  const uid = () => (window.utils?.uid ? window.utils.uid() : window.models.uid());

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


    // REWE Spezial: Mengen-Zeile steht oft als Folgezeile ohne Gesamtpreis:
    //   H-MILCH ... 4,75
    //   5 Stk x 0,95
    // -> diese Zeile NICHT als eigenes Item werten, sondern an das vorherige Item hängen.
    // Achtung: gilt nur, wenn wir schon mindestens ein Haupt-Item haben.
    const mFollow = line.match(/^(\d+)\s*(?:stk|stck|stueck|stück)\s*[xX]\s*([0-9\.]+,[0-9]{2})\b/i);
    if (mFollow && items.length) {
      const last = items[items.length - 1];
      // nur an "item" anhängen (nicht an Pfand/Rabatt/Misc)
      if (last && last.kind === "item") {
        const qtyFollow = Math.max(1, Math.round(Number(mFollow[1]) || 1));
        const unitPriceFollow = parseEuroStr(mFollow[2]);
        if (Number.isFinite(unitPriceFollow) && unitPriceFollow > 0) {
          last.qty = qtyFollow;
          last.unitPrice = Math.round(unitPriceFollow * 100) / 100;
          // lineTotal bleibt aus der vorherigen Zeile (z.B. 4,75)
          // Falls lineTotal aus irgendeinem Grund 0/NaN ist, rekonstruieren wir es.
          const lt = Number(last.lineTotal);
          if (!Number.isFinite(lt) || lt <= 0) {
            last.lineTotal = Math.round((qtyFollow * unitPriceFollow) * 100) / 100;
          }
          continue; // WICHTIG: Folgezeile nicht als eigenes Item übernehmen
        }
      }
    }
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

  window.receiptParsing = { parseReceiptItemsFromText, guessReceiptMeta, fmtDate, extractTextFromPdfFile, prefillReceiptTextFromFile };
})();
