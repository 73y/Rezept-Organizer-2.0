(() => {
  function uid() {
    if (window.crypto?.randomUUID) return crypto.randomUUID();
    return "id_" + Math.random().toString(16).slice(2) + "_" + Date.now();
  }

  function toNumber(v) {
    if (v === null || v === undefined) return NaN;
    return parseFloat(String(v).replace(",", "."));
  }

  function euro(n) {
    const x = Number.isFinite(n) ? n : 0;
    return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(x);
  }

  // Preis pro Einheit (z.B. € pro g / ml / Stück)
  function unitPrice(price, amount) {
    if (!Number.isFinite(price) || !Number.isFinite(amount) || amount <= 0) return null;
    return price / amount;
  }

  window.models = { uid, toNumber, euro, unitPrice };
})();
