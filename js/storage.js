// js/storage.js
// Local-first Persist + Normalizer + Recovery

const STORAGE_KEY = "einkauf_rezepte_v1";

// Auto-Recovery: wird bei jedem erfolgreichen Save/Load aktualisiert.
const RECOVERY_KEY = "einkauf_rezepte_v1__recovery";

// Restore-Point: wird nur vor destruktiven Aktionen gesetzt (Import/Demo/etc.).
const RESTORE_POINT_KEY = "einkauf_rezepte_v1__restore_point";

const META_KEY = "einkauf_rezepte_v1__meta";
const QUARANTINE_PREFIX = "einkauf_rezepte_v1__quarantine__";
const QUARANTINE_LIMIT = 3;

function uid() {
  try {
    if (window.crypto?.randomUUID) return crypto.randomUUID();
  } catch {}
  return `id_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function setStorageReport(partial) {
  const prev = window.__storageReport && typeof window.__storageReport === "object" ? window.__storageReport : {};
  window.__storageReport = { ...prev, ...partial };
}

function getStorageReport() {
  const r = window.__storageReport && typeof window.__storageReport === "object" ? window.__storageReport : {};
  return {
    status: r.status || "ok", // ok | empty | recovered | reset | warning
    message: r.message || "",
    at: r.at || null,
    details: r.details || null
  };
}

// expose (read-only)
window.getStorageReport = getStorageReport;

function writeMeta(meta) {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {}
}

function readMeta() {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function listQuarantines() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(QUARANTINE_PREFIX)) continue;
      out.push(k);
    }
  } catch {}
  out.sort();
  return out;
}

function trimQuarantines() {
  const keys = listQuarantines();
  const extra = keys.length - QUARANTINE_LIMIT;
  if (extra <= 0) return;
  for (let i = 0; i < extra; i++) {
    try {
      localStorage.removeItem(keys[i]);
    } catch {}
  }
}

function quarantineRaw(raw, reason) {
  try {
    const key = `${QUARANTINE_PREFIX}${Date.now()}`;
    localStorage.setItem(key, String(raw || ""));
    trimQuarantines();
    setStorageReport({
      status: "warning",
      message: "Daten waren beschädigt und wurden zur Analyse gesichert.",
      at: nowIso(),
      details: { reason: String(reason || ""), quarantineKey: key }
    });
  } catch {
    // ignore
  }
}

function defaultState() {
  return {
    ingredients: [], // {id,name,amount,unit,price,shelfLifeDays}
    recipes: [],
    plannedRecipes: [],
    shopping: [],
    pantry: [],
    purchaseLog: [],
    wasteLog: [],
    shoppingSession: { active: false, checked: {}, startedAt: null },
    settings: { enableCookTimer: true, theme: "dark" },

        // Bons / Belege (Import aus PDF/Text)
    // receipts: [{id, at, store, total, createdAt, updatedAt, items:[{id, rawName, qty, unitPrice, lineTotal, matchedIngredientId, kind}]}]
    receipts: [],

    // Cache für Barcode->Produkt (Open Food Facts Autofill)
    barcodeLookupCache: {}
  };
}


function sanitizeNutriments(n) {
  if (!n || typeof n !== "object") return null;

  const base = (String(n.base || "").trim() === "100ml") ? "100ml" : "100g";

  const pick = (key) => {
    const v = Number(n[key]);
    return Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
  };

  const out = {
    base,
    kcalPer100: pick("kcalPer100"),
    proteinPer100: pick("proteinPer100"),
    carbsPer100: pick("carbsPer100"),
    fatPer100: pick("fatPer100"),
    sugarPer100: pick("sugarPer100"),
    fiberPer100: pick("fiberPer100"),
    saltPer100: pick("saltPer100")
  };

  const has = Object.keys(out).some((k) => k !== "base" && out[k] !== null);
  return has ? out : null;
}

function migrateIngredient(old) {
  // Neues Format schon vorhanden?
  if (old && typeof old === "object" && "amount" in old && "unit" in old && "price" in old) {
    const barcode = (String(old.barcode ?? "").trim()).replace(/\s+/g, "").replace(/[^0-9]/g, "");
    return { ...old, barcode: barcode || "", nutriments: sanitizeNutriments(old.nutriments) };
  }

  const id = old?.id ?? (window.crypto?.randomUUID ? crypto.randomUUID() : "id_" + Date.now());
  const name = old?.name ?? "";

  const amount = Number(old?.packAmount ?? 0);
  const unit = (old?.defaultUnit || old?.packUnit || "g").toString();
  const price = Number(old?.packPrice ?? 0);
  const shelfLifeDays = Number(old?.shelfLifeDays ?? 0);

  const barcode = (String(old?.barcode ?? "").trim()).replace(/\s+/g, "").replace(/[^0-9]/g, "");

  return { id, name, barcode, amount, unit, price, shelfLifeDays, nutriments: sanitizeNutriments(old?.nutriments) };
}


function migrateReceiptItem(old) {
  if (!old || typeof old !== "object") return null;
  const id = old.id ? String(old.id) : uid();
  const rawName = String(old.rawName ?? old.name ?? "").trim();
  const qty = Math.max(1, Math.round(Number(old.qty ?? old.packs ?? 1) || 1));

  const unitPrice = Number(String(old.unitPrice ?? "").replace(",", "."));
  const lineTotal = Number(String(old.lineTotal ?? old.total ?? "").replace(",", "."));

  const kindRaw = String(old.kind || "").toLowerCase();
  const kind = ["item", "pfand", "discount", "misc"].includes(kindRaw) ? kindRaw : "item";

  const matchedIngredientId = old.matchedIngredientId ? String(old.matchedIngredientId) : null;

  const up = Number.isFinite(unitPrice) ? unitPrice : (Number.isFinite(lineTotal) ? lineTotal / qty : 0);
  const lt = Number.isFinite(lineTotal) ? lineTotal : (Number.isFinite(unitPrice) ? unitPrice * qty : 0);

  return {
    id,
    rawName,
    qty,
    unitPrice: Math.round((Number(up) || 0) * 100) / 100,
    lineTotal: Math.round((Number(lt) || 0) * 100) / 100,
    matchedIngredientId,
    kind
  };
}

function migrateReceipt(old) {
  if (!old || typeof old !== "object") return null;
  const id = old.id ? String(old.id) : uid();
  const at = old.at ? String(old.at) : nowIso();
  const store = String(old.store ?? "REWE").trim() || "REWE";
  const createdAt = old.createdAt ? String(old.createdAt) : nowIso();
  const updatedAt = old.updatedAt ? String(old.updatedAt) : createdAt;

  const items = Array.isArray(old.items) ? old.items.map(migrateReceiptItem).filter(Boolean) : [];
  const totalNum = Number(String(old.total ?? "").replace(",", "."));
  const total = Number.isFinite(totalNum) ? totalNum : items.reduce((s, it) => s + (Number(it.lineTotal) || 0), 0);

  return { id, at, store, createdAt, updatedAt, total: Math.round(total * 100) / 100, items };
}

function ensureStateShape(state) {
  state = state && typeof state === "object" ? state : {};
  const base = defaultState();

  const next = {
    ...base,
    ...state
  };

  next.ingredients = Array.isArray(next.ingredients) ? next.ingredients.map(migrateIngredient) : [];
  next.recipes = Array.isArray(next.recipes) ? next.recipes : [];

  next.plannedRecipes = Array.isArray(next.plannedRecipes) ? next.plannedRecipes : [];
  // ✅ plannedRecipes normalisieren
  next.plannedRecipes = next.plannedRecipes
    .filter((x) => x && typeof x === "object" && x.recipeId)
    .map((x) => ({
      recipeId: String(x.recipeId),
      portionsWanted: Math.max(1, Math.round(Number(x.portionsWanted) || 1)),
      addedAt: x.addedAt ? String(x.addedAt) : new Date().toISOString()
    }));

  next.shopping = Array.isArray(next.shopping) ? next.shopping : [];
  next.pantry = Array.isArray(next.pantry) ? next.pantry : [];
  next.purchaseLog = Array.isArray(next.purchaseLog) ? next.purchaseLog : [];
  next.wasteLog = Array.isArray(next.wasteLog) ? next.wasteLog : [];


  next.receipts = Array.isArray(next.receipts) ? next.receipts.map(migrateReceipt).filter(Boolean) : [];
  // ✅ Barcode Cache normalisieren
  next.barcodeLookupCache = next.barcodeLookupCache && typeof next.barcodeLookupCache === "object" ? next.barcodeLookupCache : {};


  if (!next.shoppingSession || typeof next.shoppingSession !== "object") {
    next.shoppingSession = { active: false, checked: {}, startedAt: null };
  } else {
    next.shoppingSession.active = !!next.shoppingSession.active;
    next.shoppingSession.checked =
      next.shoppingSession.checked && typeof next.shoppingSession.checked === "object" ? next.shoppingSession.checked : {};
    next.shoppingSession.startedAt = next.shoppingSession.startedAt ?? null;
  }

  if (!next.settings || typeof next.settings !== "object") {
    next.settings = { enableCookTimer: true, theme: "dark" };
  } else if (!("enableCookTimer" in next.settings)) {
    next.settings.enableCookTimer = true;
  }

  if (!("theme" in next.settings)) next.settings.theme = "dark";

  // ✅ CookHistory normalisieren (ids ergänzen + Länge begrenzen)
  for (const r of next.recipes) {
    if (!r || typeof r !== "object") continue;
    r.items = Array.isArray(r.items) ? r.items : [];

    const raw = Array.isArray(r.cookHistory) ? r.cookHistory : [];
    const fixed = [];

    for (const e of raw) {
      if (!e || typeof e !== "object") continue;
      const at = e.at ? String(e.at) : "";
      if (!at) continue;
      const sec = Math.max(0, Math.floor(Number(e.seconds) || 0));
      fixed.push({ id: e.id ? String(e.id) : uid(), at, seconds: sec });
    }

    // älteste rauswerfen
    if (fixed.length > 30) fixed.splice(0, fixed.length - 30);
    r.cookHistory = fixed;

    // lastCook* Felder setzen
    if (fixed.length) {
      const last = fixed[fixed.length - 1];
      r.lastCookSeconds = last.seconds;
      r.lastCookAt = last.at;
    }
  }

  return next;
}

/**
 * Pantry-Normalizer: identische Lose zusammenfassen.
 * "Identisch" = gleicher ingredientId + gleicher Kauf-TAG + gleicher Ablauf-TAG + gleiche unit.
 * (Zeit wird bewusst ignoriert, damit Mehrfach-Packs aus einem Checkout gemerged werden.)
 */
function normalizePantry(state) {
  if (!Array.isArray(state.pantry) || state.pantry.length === 0) return;

  const ingMap = new Map((state.ingredients || []).map((i) => [i.id, i]));

  const dateKey = (iso) => (iso ? String(iso).slice(0, 10) : ""); // YYYY-MM-DD

  const safeNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const packSizeOf = (ing) => {
    const a = safeNum(ing?.amount);
    return a && a > 0 ? a : null;
  };

  const remainingValue = (p, ing) => {
    // 1) cost hat Prio (ist "Restwert" nach Verbrauch)
    const c = safeNum(p.cost);
    if (c !== null) return c;

    const amt = safeNum(p.amount) ?? 0;
    const packSize = packSizeOf(ing);

    // 2) pricePaid vorhanden -> auf Restmenge skalieren (wenn Packsize bekannt)
    const paid = safeNum(p.pricePaid);
    if (paid !== null) {
      if (packSize && packSize > 0) {
        const ratio = Math.max(0, Math.min(1, amt / packSize));
        return paid * ratio;
      }
      return paid;
    }

    // 3) fallback: Ingredient-Preis -> skalieren
    const ip = safeNum(ing?.price);
    if (ip !== null && packSize && packSize > 0) {
      return ip * (amt / packSize);
    }

    return 0;
  };

  const unitCostFromIngredient = (ing) => {
    const packSize = safeNum(ing?.amount);
    const packPrice = safeNum(ing?.price);
    if (packSize && packSize > 0 && packPrice !== null) return packPrice / packSize;
    return null;
  };

  const keyFor = (p) => {
    const ingId = p?.ingredientId ?? "";
    const ing = ingMap.get(ingId);
    const unit = (p?.unit ?? ing?.unit ?? "").toString();

    const boughtDay = dateKey(p?.boughtAt);
    const expDay = dateKey(p?.expiresAt);

    // Wenn beides fehlt, NICHT mergen (sonst klebt alles zusammen)
    if (!boughtDay && !expDay) return `__unique__|${p?.id ?? Math.random().toString(36).slice(2)}`;

    return `${ingId}|${unit}|${boughtDay}|${expDay}`;
  };

  const groups = new Map();

  for (const p of state.pantry) {
    if (!p || typeof p !== "object") continue;

    const ingId = p.ingredientId ?? null;
    const ing = ingId ? ingMap.get(ingId) : null;

    const key = keyFor(p);

    if (!groups.has(key)) {
      // Basis-Objekt übernehmen, aber amount/cost sauber neu aufbauen
      groups.set(key, {
        ...p,
        unit: p.unit ?? ing?.unit ?? null,
        amount: 0,
        cost: 0
      });
    }

    const g = groups.get(key);

    const amt = safeNum(p.amount) ?? 0;
    g.amount += amt;

    g.cost += remainingValue(p, ing);

    // Step: erste sinnvolle Step behalten
    if (g.step == null && p.step != null) g.step = p.step;

    // falls irgendwas in g fehlt, aus p füllen
    if (!g.boughtAt && p.boughtAt) g.boughtAt = p.boughtAt;
    if (!g.expiresAt && p.expiresAt) g.expiresAt = p.expiresAt;
  }

  const merged = Array.from(groups.values()).map((m) => {
    m.amount = Number((Number(m.amount) || 0).toFixed(4));

    // Grundstein-Preis: wenn möglich cost immer neu berechnen
    const ing = ingMap.get(m.ingredientId);
    const uc = unitCostFromIngredient(ing);
    if (uc !== null) {
      m.unitCost = uc;
      m.cost = Number((m.amount * uc).toFixed(2));
    } else {
      // Fallback: bisheriger (gemergter) Wert
      m.cost = Number((Number(m.cost) || 0).toFixed(2));
    }
    return m;
  });

  // Sortierung: frühestes Ablaufdatum zuerst
  merged.sort((a, b) => {
    const ae = a.expiresAt ? new Date(a.expiresAt).getTime() : Infinity;
    const be = b.expiresAt ? new Date(b.expiresAt).getTime() : Infinity;
    if (ae !== be) return ae - be;
    const ab = a.boughtAt ? new Date(a.boughtAt).getTime() : 0;
    const bb = b.boughtAt ? new Date(b.boughtAt).getTime() : 0;
    return ab - bb;
  });

  state.pantry = merged;
}

function postLoadRepair(state) {
  // 0) Referenzintegrität (Orphans entfernen; Logs bleiben erhalten)
  try {
    if (window.audit && typeof window.audit.repairReferences === "function") {
      window.audit.repairReferences(state);
    }
  } catch (e) {
    console.warn("Audit/Repair Fehler:", e);
  }

  // 1) Pantry normalisieren
  try {
    normalizePantry(state);
  } catch (e) {
    console.warn("Pantry-Normalizer Fehler:", e);
  }

  // 2) plannedRecipes -> Shopping anheben (wenn verfügbar)
  try {
    if (typeof window.reconcileShoppingWithPlan === "function") {
      window.reconcileShoppingWithPlan(state, { mode: "raise" });
    }
  } catch (e) {
    console.warn("Plan-Reconcile Fehler:", e);
  }
}

function safeParseJson(raw) {
  const text = String(raw || "");
  return JSON.parse(text);
}

function loadStateFromKey(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  const parsed = safeParseJson(raw);
  return parsed;
}

function writeMainAndRecovery(state) {
  // persist both (best effort)
  const txt = JSON.stringify(state);
  localStorage.setItem(STORAGE_KEY, txt);
  localStorage.setItem(RECOVERY_KEY, txt);

  const meta = readMeta() || {};
  meta.lastSavedAt = nowIso();
  meta.schema = 1;
  writeMeta(meta);
}

function loadState() {
  // Default report
  setStorageReport({ status: "ok", message: "", at: null, details: null });

  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const fresh = ensureStateShape(defaultState());
    postLoadRepair(fresh);

    try {
      writeMainAndRecovery(fresh);
    } catch {}

    setStorageReport({ status: "empty", message: "Keine lokalen Daten gefunden (frischer Start).", at: nowIso() });
    return fresh;
  }

  try {
    const parsed = safeParseJson(raw);
    const next = ensureStateShape(parsed);
    postLoadRepair(next);

    // Auto-Recovery aktualisieren
    try {
      writeMainAndRecovery(next);
    } catch {}

    setStorageReport({ status: "ok", message: "", at: nowIso() });
    return next;
  } catch (e) {
    console.warn("State kaputt:", e);
    quarantineRaw(raw, e?.message || "parse");

    // Versuch: Recovery laden
    try {
      const recParsed = loadStateFromKey(RECOVERY_KEY);
      const rec = ensureStateShape(recParsed);
      postLoadRepair(rec);

      try {
        writeMainAndRecovery(rec);
      } catch {}

      setStorageReport({
        status: "recovered",
        message: "Deine Daten waren beschädigt. Es wurde automatisch ein Backup geladen.",
        at: nowIso(),
        details: { source: "recovery" }
      });
      return rec;
    } catch (e2) {
      console.warn("Recovery auch kaputt:", e2);
      const fresh = ensureStateShape(defaultState());
      postLoadRepair(fresh);

      try {
        writeMainAndRecovery(fresh);
      } catch {}

      setStorageReport({
        status: "reset",
        message: "Deine Daten waren nicht lesbar (auch Backup). Es wurde ein frischer Zustand erstellt.",
        at: nowIso(),
        details: { source: "default" }
      });
      return fresh;
    }
  }
}

function saveState(state) {
  try {
    // sanitize before saving (cheap)
    const next = ensureStateShape(state);
    postLoadRepair(next);

    writeMainAndRecovery(next);

    setStorageReport({ status: "ok", message: "", at: nowIso() });
    return next;
  } catch (e) {
    console.warn("Save fehlgeschlagen:", e);
    setStorageReport({
      status: "warning",
      message: "Speichern fehlgeschlagen (siehe Konsole).",
      at: nowIso(),
      details: { error: String(e?.message || e) }
    });
    return null;
  }
}

function resetState() {
  // In-App "Alle Daten löschen" sollte wirklich ALLES entfernen.
  // Sonst kann die Recovery-Funktion die Daten beim nächsten Laden wiederherstellen.
  deleteAllLocalData();
}

function deleteAllLocalData() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(RECOVERY_KEY);
    localStorage.removeItem(RESTORE_POINT_KEY);
    localStorage.removeItem(META_KEY);

    // Quarantines
    for (const k of listQuarantines()) {
      try {
        localStorage.removeItem(k);
      } catch {}
    }
  } catch {}
}

function setRestorePoint(state) {
  try {
    const txt = JSON.stringify(ensureStateShape(state));
    localStorage.setItem(RESTORE_POINT_KEY, txt);
    const meta = readMeta() || {};
    meta.restorePointAt = nowIso();
    writeMeta(meta);
    return true;
  } catch {
    return null;
  }
}

function hasRestorePoint() {
  try {
    return !!localStorage.getItem(RESTORE_POINT_KEY);
  } catch {
    return null;
  }
}

function restoreFromRestorePoint() {
  const raw = localStorage.getItem(RESTORE_POINT_KEY);
  if (!raw) return null;
  const parsed = safeParseJson(raw);
  const next = ensureStateShape(parsed);
  postLoadRepair(next);
  writeMainAndRecovery(next);
  setStorageReport({ status: "ok", message: "Wiederherstellung erfolgreich.", at: nowIso(), details: { source: "restorePoint" } });
  return next;
}

function exportStateJson(state, { pretty = true } = {}) {
  const payload = {
    app: "einkauf_rezepte",
    schema: 1,
    exportedAt: nowIso(),
    state: ensureStateShape(state)
  };
  return JSON.stringify(payload, null, pretty ? 2 : 0);
}

function importStateText(text) {
  const raw = String(text || "");
  const parsed = safeParseJson(raw);

  // akzeptiert: entweder Wrapper {state: {...}} oder direkt State
  const maybeState = parsed && typeof parsed === "object" && parsed.state && typeof parsed.state === "object" ? parsed.state : parsed;

  const next = ensureStateShape(maybeState);
  postLoadRepair(next);
  return next;
}

function repairState(state) {
  const next = ensureStateShape(state);
  postLoadRepair(next);
  writeMainAndRecovery(next);
  setStorageReport({ status: "ok", message: "Daten wurden geprüft und gespeichert.", at: nowIso(), details: { source: "repair" } });
  return next;
}

function buildDemoState() {
  const demo = ensureStateShape(defaultState());

  // Ingredients
  const ing = [
    { id: "ing_reis", name: "Reis", amount: 1000, unit: "g", price: 2.49, shelfLifeDays: 365 },
    { id: "ing_huhn", name: "Hähnchenbrust", amount: 400, unit: "g", price: 4.99, shelfLifeDays: 3 },
    { id: "ing_kaese", name: "Käse", amount: 200, unit: "g", price: 2.29, shelfLifeDays: 14 },
    { id: "ing_tom", name: "Tomaten", amount: 6, unit: "Stück", price: 2.19, shelfLifeDays: 7 },
    { id: "ing_jogh", name: "Joghurt", amount: 500, unit: "g", price: 1.59, shelfLifeDays: 10 },
    { id: "ing_wrap", name: "Wraps", amount: 6, unit: "Stück", price: 1.99, shelfLifeDays: 14 }
  ];
  demo.ingredients = ing;

  // Pantry (ein paar Chargen)
  const today = new Date();
  const iso = (d) => d.toISOString();
  const addDays = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

  demo.pantry = [
    { id: uid(), ingredientId: "ing_reis", amount: 650, unit: "g", boughtAt: iso(addDays(-20)), expiresAt: iso(addDays(250)) },
    { id: uid(), ingredientId: "ing_huhn", amount: 400, unit: "g", boughtAt: iso(addDays(-1)), expiresAt: iso(addDays(2)) },
    { id: uid(), ingredientId: "ing_kaese", amount: 120, unit: "g", boughtAt: iso(addDays(-5)), expiresAt: iso(addDays(5)) },
    { id: uid(), ingredientId: "ing_tom", amount: 4, unit: "Stück", boughtAt: iso(addDays(-2)), expiresAt: iso(addDays(3)) },
    { id: uid(), ingredientId: "ing_wrap", amount: 6, unit: "Stück", boughtAt: iso(addDays(-4)), expiresAt: iso(addDays(8)) }
  ];

  // Recipes
  demo.recipes = [
    {
      id: "rec_wrap",
      name: "Chicken-Wrap",
      portions: 2,
      description: "Schnell, simpel, gut für unterwegs.",
      instructions: "Huhn anbraten. Alles in Wraps rollen.",
      items: [
        { ingredientId: "ing_huhn", amount: 300, unit: "g" },
        { ingredientId: "ing_wrap", amount: 2, unit: "Stück" },
        { ingredientId: "ing_tom", amount: 2, unit: "Stück" },
        { ingredientId: "ing_jogh", amount: 100, unit: "g" }
      ],
      cookHistory: [
        { id: uid(), at: iso(addDays(-3)), seconds: 900 },
        { id: uid(), at: iso(addDays(-1)), seconds: 780 }
      ]
    },
    {
      id: "rec_reis",
      name: "Reis + Käse",
      portions: 1,
      description: "Notfallgericht.",
      instructions: "Reis kochen, Käse drüber.",
      items: [
        { ingredientId: "ing_reis", amount: 150, unit: "g" },
        { ingredientId: "ing_kaese", amount: 60, unit: "g" }
      ],
      cookHistory: [{ id: uid(), at: iso(addDays(-10)), seconds: 1200 }]
    }
  ];

  // Logs
  demo.purchaseLog = [
    { id: uid(), at: iso(addDays(-20)), total: 2.49, ingredientId: "ing_reis", packs: 1, buyAmount: 1000, unit: "g" },
    { id: uid(), at: iso(addDays(-5)), total: 2.29, ingredientId: "ing_kaese", packs: 1, buyAmount: 200, unit: "g" },
    { id: uid(), at: iso(addDays(-1)), total: 4.99, ingredientId: "ing_huhn", packs: 1, buyAmount: 400, unit: "g" }
  ];

  demo.wasteLog = [
    { id: uid(), at: iso(addDays(-15)), ingredientId: "ing_tom", amount: 2, unit: "Stück", value: 0.7 }
  ];

  demo.shopping = [];
  demo.plannedRecipes = [];
  demo.shoppingSession = { active: false, checked: {}, startedAt: null };

  postLoadRepair(demo);
  return demo;
}

// expose helpers for Settings
window.dataTools = {
  deleteAllLocalData,
  setRestorePoint,
  hasRestorePoint,
  restoreFromRestorePoint,
  exportStateJson,
  importStateText,
  repairState,
  buildDemoState,
  listQuarantines,
  getAuditReport: () => (window.audit && typeof window.audit.getLastAuditReport === "function" ? window.audit.getLastAuditReport() : null)
};
