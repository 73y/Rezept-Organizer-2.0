(() => {
  const VIEWS = ["dashboard", "inventory", "ingredients", "recipes", "shopping", "stats", "settings", "purchaselog", "cookhistory"];
  let currentView = "dashboard";
  let state = null;
  const APP_META = window.APP_META || { version: "v0.0.0", buildId: "0", cacheName: "" };

  function setBuildTagStatus(suffix) {
    const el = document.querySelector('.build-tag');
    if (!el) return;
    const base = (APP_META.version || "v0.0.0").trim();
    el.textContent = suffix ? `${base} • ${suffix}` : base;
  }

  const $ = (sel) => document.querySelector(sel);
  const $all = (sel) => Array.from(document.querySelectorAll(sel));

  function title(view) {
    if (view === "dashboard") return "Start";
    if (view === "inventory") return "Vorrat";
    if (view === "ingredients") return "Zutaten";
    if (view === "recipes") return "Rezepte";
    if (view === "shopping") return "Einkaufsliste";
    if (view === "stats") return "Stats";
    if (view === "purchaselog") return "purchaseLog verwalten";
    if (view === "cookhistory") return "CookHistory verwalten";
    return "Einstellungen";
  }

  function applyThemeFromState() {
    const theme = state?.settings?.theme || "dark";
    if (theme === "light") document.documentElement.dataset.theme = "light";
    else document.documentElement.removeAttribute("data-theme");
  }

  function persist({ renderNow = false } = {}) {
    const saved = saveState(state);

    // Keep the same object reference for all modules.
    if (saved && saved !== state) {
      for (const k of Object.keys(state)) delete state[k];
      Object.assign(state, saved);
    }

    applyThemeFromState();
    if (renderNow) render(currentView);
    return state;
  }

  function setActiveTab(view) {
    const active = view === "purchaselog" || view === "cookhistory" ? "settings" : view;
    $all("#tabs .tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === active);
    });
  }

  function render(view) {
    const container = $("#view-" + view);
    if (!container) return;

    const fnMap = {
      dashboard: window.renderDashboardView,
      inventory: window.renderInventoryView,
      ingredients: window.renderIngredientsView,
      recipes: window.renderRecipesView,
      shopping: window.renderShoppingView,
      stats: window.renderStatsView,
      settings: window.renderSettingsView,
      purchaselog: window.renderPurchaseLogView,
      cookhistory: window.renderCookHistoryView
    };

    const fn = fnMap[view];
    if (typeof fn === "function") {
      fn(container, state, persist);
      return;
    }

    container.innerHTML = `
      <div class="card">
        <h2 style="margin:0 0 6px 0;">${title(view)}</h2>
        <p class="small">Modul kommt als nächstes.</p>
      </div>
    `;
  }

  function showView(view) {
    if (!VIEWS.includes(view)) view = "dashboard";
    currentView = view;

    VIEWS.forEach((v) => {
      const el = $("#view-" + v);
      if (!el) return;
      el.classList.toggle("hidden", v !== view);
    });

    setActiveTab(view);
    render(view);
  }

  window.app = {
    getState: () => state,

    // Setzt den State (inkl. Save + Repair-Pipeline aus storage.js).
    // options: { render: true|false }
    setState: (next, options = {}) => {
      state = next;
      const renderNow = options.render !== false;
      persist({ renderNow });
      return state;
    },

    // Zentraler Update-Entry: mutiert einen Clone und committed danach.
    update: (mutator, options = {}) => {
      const c = window.utils?.clone ? window.utils.clone(state) : JSON.parse(JSON.stringify(state));
      mutator?.(c);
      return window.app.setState(c, options);
    },

    persist,
    navigate: showView
  };

  document.addEventListener("DOMContentLoaded", () => {
    // Einheitliche Version-Anzeige (Header)
    setBuildTagStatus("");

    state = loadState();
    applyThemeFromState();

    $all("#tabs .tab").forEach((btn) => {
      btn.addEventListener("click", () => showView(btn.dataset.view));
    });

    showView(currentView);
  });

  // PWA: Service Worker registrieren
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", async () => {
      try {
        let refreshing = false;

        const reg = await navigator.serviceWorker.register("./service-worker.js", {
          updateViaCache: "none"
        });

        // Immer beim Start nach Updates fragen
        try { await reg.update(); } catch {}

        // Wenn ein neuer SW bereit ist: sofort aktivieren
        if (reg.waiting) {
          setBuildTagStatus("Update bereit");
          reg.waiting.postMessage({ type: "SKIP_WAITING" });
        }

        reg.addEventListener("updatefound", () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener("statechange", () => {
            if (sw.state === "installed") {
              if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
              if (navigator.serviceWorker.controller) {
                // Hinweis + sichtbarer Status
                setBuildTagStatus("Update bereit");
                window.ui?.toast?.("Update bereit – neu laden, damit alles frisch ist.", {
                  actionText: "Neu laden",
                  onAction: () => window.location.reload(),
                  timeoutMs: 8000
                });
              }
            }
          });
        });

        navigator.serviceWorker.addEventListener("controllerchange", () => {
          if (refreshing) return;
          refreshing = true;
          setBuildTagStatus("Aktualisiere…");
          window.location.reload();
        });
      } catch (e) {
        console.warn("Service Worker konnte nicht registriert werden:", e);
      }
    });
  }

})();
