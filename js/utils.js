(() => {
  // js/utils.js
  // Kleine, zentrale Helfer (keine App-Logik)

  function esc(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function uid() {
    return window.models?.uid ? window.models.uid() : `id_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function toNumber(v) {
    return window.models?.toNumber ? window.models.toNumber(v) : Number(String(v ?? "").replace(",", "."));
  }

  function euro(n) {
    const x = Number(n) || 0;
    return window.models?.euro ? window.models.euro(x) : `${x.toFixed(2)} €`;
  }

  function clone(x) {
    try {
      if (typeof structuredClone === "function") return structuredClone(x);
    } catch {}
    return JSON.parse(JSON.stringify(x));
  }

  function round2(n) {
    return Number((Number(n) || 0).toFixed(2));
  }

  function isFiniteNumber(n) {
    return Number.isFinite(n);
  }

  function dateKey(iso) {
    return iso ? String(iso).slice(0, 10) : "";
  }

  function parseDateMaybe(v) {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function normalizeStr(s) {
    return String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .trim();
  }

  // -----------------------------
  // Open Food Facts helpers
  // (wird von shopping.js genutzt)
  // -----------------------------
  function parseOffQuantity(qty, unitRaw) {
    const n = Number(String(qty ?? "").replace(",", "."));
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
    if (u === "pcs" || u === "pc" || u === "piece" || u === "pieces" || u === "stk" || u.includes("stück")) {
      return { amount: n, unit: "Stück" };
    }

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

  window.utils = {
    esc,
    uid,
    toNumber,
    euro,
    clone,
    round2,
    isFiniteNumber,
    dateKey,
    parseDateMaybe,
    normalizeStr,
    parseOffQuantity,
    parseQuantityString
  };

  // Backwards-compatible: manche Module rufen parseQuantityString() global auf.
  // Damit bricht der OFF-Flow nicht ab.
  try {
    window.parseQuantityString = parseQuantityString;
    window.parseOffQuantity = parseOffQuantity;
  } catch {}
})();
