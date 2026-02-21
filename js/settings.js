(() => {
  const esc = (s) => (window.utils?.esc ? window.utils.esc(s) : String(s ?? ""));

  const euro = (n) => (window.utils?.euro ? window.utils.euro(Number(n) || 0) : (window.models?.euro ? window.models.euro(Number(n) || 0) : `${(Number(n) || 0).toFixed(2)} €`));

  function ensureSettings(state) {
    if (!state.settings) state.settings = {};
    const s = state.settings;
    if (!s.theme) s.theme = "dark";
    if (typeof s.enableCookTimer !== "boolean") s.enableCookTimer = true;
    return s;
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function statusPill(report) {
    const st = report?.status || "ok";
    if (st === "ok") return `<span class="pill exp-green">OK</span>`;
    if (st === "empty") return `<span class="pill exp-none">Neu</span>`;
    if (st === "recovered") return `<span class="pill exp-yellow">Backup geladen</span>`;
    if (st === "reset") return `<span class="pill exp-red">Zurückgesetzt</span>`;
    return `<span class="pill exp-orange">Warnung</span>`;
  }

  function prettyStatusText(report) {
    const st = report?.status || "ok";
    if (st === "ok") return "Alles gut.";
    if (st === "empty") return "Noch keine Daten gespeichert.";
    if (st === "recovered") return report.message || "Daten waren beschädigt – Recovery-Backup wurde geladen.";
    if (st === "reset") return report.message || "Daten waren nicht lesbar – frischer Zustand wurde erstellt.";
    return report.message || "Hinweis: Es gab ein Problem beim Laden/Speichern.";
  }

  window.renderSettingsView = function (container, state) {
    const settings = ensureSettings(state);

    const purchasesCount = Array.isArray(state.purchaseLog) ? state.purchaseLog.length : 0;
    const purchasesSum = Array.isArray(state.purchaseLog)
      ? state.purchaseLog.reduce((sum, e) => sum + (Number(e?.total) || 0), 0)
      : 0;

    let cookCount = 0;
    let cookSumSeconds = 0;
    for (const r of state.recipes || []) {
      const h = Array.isArray(r?.cookHistory) ? r.cookHistory : [];
      cookCount += h.length;
      cookSumSeconds += h.reduce((sum, e) => sum + (Number(e?.seconds) || 0), 0);
    }

    const fmtDuration = (seconds) => {
      const s = Math.max(0, Math.floor(Number(seconds) || 0));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      if (h > 0) return `${h}h ${m}m`;
      return `${m}m`;
    };

    const report = typeof window.getStorageReport === "function" ? window.getStorageReport() : { status: "ok" };
    const dt = window.dataTools || {};

    const auditReport = typeof dt.getAuditReport === "function" ? dt.getAuditReport() : null;

    const hasRestore = typeof dt.hasRestorePoint === "function" ? dt.hasRestorePoint() : false;
    const quarantines = typeof dt.listQuarantines === "function" ? dt.listQuarantines() : [];

    container.innerHTML = `
      <div class="card">
        <h2 style="margin:0 0 6px 0;">Einstellungen</h2>
        <p class="small" style="margin:0;">Darstellung, Kochen, Daten-Tools und Verwaltung von Logs.</p>
        <p class="small" style="margin:6px 0 0 0; opacity:0.8;">Build: <b>${esc((window.APP_META?.version||"?"))}-${esc((window.APP_META?.buildId||"?"))}</b></p>
      </div>

      <div class="card">
        <h3 style="margin:0 0 10px 0;">Darstellung</h3>
        <label style="display:flex; gap:10px; align-items:center;">
          <input id="s-light" type="checkbox" ${settings.theme === "light" ? "checked" : ""} />
          <span>Hell-Modus</span>
        </label>
        <div class="small" style="margin-top:8px; opacity:0.8;">Standard ist Dark Mode. Hell-Modus schaltet nur die Farben um.</div>
      </div>

      <div class="card">
        <h3 style="margin:0 0 10px 0;">Kochen</h3>
        <label style="display:flex; gap:10px; align-items:center;">
          <input id="s-timer" type="checkbox" ${settings.enableCookTimer ? "checked" : ""} />
          <span>Koch-Timer aktiv</span>
        </label>
        <div class="small" style="margin-top:8px; opacity:0.8;">Wenn aktiv, kannst du beim Kochen Zeiten tracken und in Stats auswerten.</div>
      </div>

      <div class="card">
        <h3 style="margin:0 0 10px 0;">Verwalten</h3>

        <div class="row" style="align-items:flex-start;">
          <div>
            <div style="font-weight:600;">purchaseLog</div>
            <div class="small muted2" style="margin-top:2px;">Einträge: <b>${esc(purchasesCount)}</b> · Summe: <b>${esc(euro(purchasesSum))}</b></div>
          </div>
          <div style="display:flex; justify-content:flex-end; gap:10px;">
            <button type="button" class="info" data-action="gotoPL">Verwalten</button>
          </div>
        </div>

        <div style="height:10px;"></div>

        <div class="row" style="align-items:flex-start;">
          <div>
            <div style="font-weight:600;">CookHistory</div>
            <div class="small muted2" style="margin-top:2px;">Einträge: <b>${esc(cookCount)}</b> · Summe: <b>${esc(fmtDuration(cookSumSeconds))}</b></div>
          </div>
          <div style="display:flex; justify-content:flex-end; gap:10px;">
            <button type="button" class="info" data-action="gotoCH">Verwalten</button>
          </div>
        </div>

        <div class="small" style="margin-top:10px; opacity:0.8;">
          Hinweis: purchaseLog wirkt auf Ausgaben-Stats. CookHistory wirkt auf Kochzeit-Stats.
        </div>
      </div>

      <div class="card">
        <h3 style="margin:0 0 10px 0;">Daten</h3>

        <div class="row" style="align-items:flex-start;">
          <div>
            <div style="display:flex; gap:10px; align-items:center;">
              <div style="font-weight:650;">Status</div>
              ${statusPill(report)}
            </div>
            <div class="small muted2" style="margin-top:6px;">${esc(prettyStatusText(report))}</div>
            ${auditReport ? `<div class="small muted2" style="margin-top:6px;">Audit: entfernt ${esc(auditReport.removed?.shopping || 0)} Shopping, ${esc(auditReport.removed?.pantry || 0)} Pantry, ${esc(auditReport.removed?.plannedRecipes || 0)} Plans, ${esc(auditReport.removed?.recipeItems || 0)} Rezept-Zutaten. ${auditReport.warnings?.length ? `Warnungen: <b>${esc(auditReport.warnings.length)}</b>` : ``}</div>` : ``}
            ${quarantines.length ? `<div class="small muted2" style="margin-top:6px;">Quarantäne-Snapshots: <b>${esc(quarantines.length)}</b> (nur intern, falls Daten kaputt waren)</div>` : ``}
          </div>
          <div style="display:flex; justify-content:flex-end; gap:10px; flex-wrap:wrap;">
            ${hasRestore ? `<button type="button" class="warn" data-action="restorePoint">Vorherigen Stand</button>` : ``}
            <button type="button" class="info" data-action="repair">Prüfen</button>
          </div>
        </div>

        <div style="height:12px;"></div>

        <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
          <button type="button" class="primary" data-action="export">Export JSON</button>

          <label class="buttonlike" style="display:inline-flex; align-items:center; gap:8px; padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--button); color:var(--buttonText); cursor:pointer;">
            <span>Import JSON</span>
            <input id="s-import" type="file" accept="application/json" style="display:none;" />
          </label>

          <button type="button" class="warn" data-action="demo">Demo-Daten laden</button>
          <button type="button" class="danger" data-action="reset">Alle lokalen Daten löschen</button>
          <button type="button" class="info" data-action="refreshApp">App aktualisieren (Cache)</button>
        </div>

        <div class="small" style="margin-top:10px; opacity:0.85;">„App aktualisieren“ löscht nur den Offline-Cache (Service Worker) und lädt neu – Zutaten/Vorrat bleiben erhalten.<br/><br/>
          Import/Export arbeitet lokal im Browser. Export enthält automatisch Metadaten (App + Datum), Import akzeptiert beides: <b>Wrapper</b> oder <b>reinen State</b>.
        </div>
      </div>
      <div class="card" id="about-app-card">
        <h3 style="margin:0 0 10px 0;">Über diese App</h3>
        <div class="small" style="line-height:1.5;">
          App-Version: <b id="about-app-version">?</b><br/>
          Build-ID (App): <span id="about-app-build">?</span><br/>
          SW-Cache (aktiv): <span id="about-sw-cache">?</span><br/>
          SW-Meta: <span id="about-sw-meta">?</span><br/>
          Update-Status: <b id="about-update-status">?</b>
        </div>
        <div class="small" style="margin-top:8px; opacity:0.85;">
          Tipp: Wenn hier „Update verfügbar“ steht, einmal neu laden – dann ist garantiert alles frisch.
        </div>
      </div>

    `;


    // --- About/Version info (aus APP_META + Service Worker) ---
    (async () => {
      try {
        const meta = window.APP_META || {};
        const vEl = container.querySelector("#about-app-version");
        const bEl = container.querySelector("#about-app-build");
        if (vEl) vEl.textContent = meta.version || "?";
        if (bEl) bEl.textContent = meta.buildId || "?";

        // Try to show cache names (best effort, even if SW messaging fails)
        const cacheEl = container.querySelector("#about-sw-cache");
        if (cacheEl && window.caches?.keys) {
          const keys = await caches.keys();
          const metaCache = (meta && meta.cacheName) ? String(meta.cacheName) : "";
          const appKeys = keys.filter(k => String(k).startsWith("einkauf-rezepte-pwa"));

          // If our current release cache exists, show it (most meaningful)
          if (metaCache && keys.includes(metaCache)) {
            cacheEl.textContent = metaCache;
          } else if (appKeys.length) {
            // keys order is not guaranteed -> pick the "newest looking" one
            appKeys.sort().reverse();
            cacheEl.textContent = appKeys[0];
          } else {
            cacheEl.textContent = (keys[0] || "(unbekannt)");
          }
        }

        // Ask SW for meta (best effort)
        const swMetaEl = container.querySelector("#about-sw-meta");
        const statusEl = container.querySelector("#about-update-status");

        const askSwMeta = () => new Promise((resolve) => {
          const regPromise = navigator.serviceWorker?.getRegistration ? navigator.serviceWorker.getRegistration() : Promise.resolve(null);
          regPromise.then((reg) => {
            const sw = reg?.active || navigator.serviceWorker?.controller;
            if (!sw) return resolve(null);

            const ch = new MessageChannel();
            const timeout = setTimeout(() => resolve(null), 1200);
            ch.port1.onmessage = (ev) => {
              clearTimeout(timeout);
              resolve(ev?.data || null);
            };
            try {
              sw.postMessage({ type: "GET_SW_META" }, [ch.port2]);
            } catch {
              clearTimeout(timeout);
              resolve(null);
            }
          }).catch(() => resolve(null));
        });

        const swMetaRaw = await askSwMeta();

// Service Worker might respond in different shapes:
// - { type:"SW_META", meta:{version,buildId,cacheName} }
// - { version, buildId, cacheName } (legacy)
// - { appMeta:{...}, cacheName:"..." } (legacy)
const swMetaObj =
  (swMetaRaw && typeof swMetaRaw === "object" && (swMetaRaw.meta || swMetaRaw.appMeta)) ||
  null;
const swMeta = swMetaObj || swMetaRaw || null;

const swVer = swMeta?.version || swMeta?.appMeta?.version || swMeta?.meta?.version || null;
const swBuild = swMeta?.buildId || swMeta?.appMeta?.buildId || swMeta?.meta?.buildId || null;
const swCacheName =
  swMeta?.cacheName || swMeta?.appMeta?.cacheName || swMeta?.meta?.cacheName || null;

// If SW told us the active cache, prefer that for display
if (cacheEl && swCacheName) {
  cacheEl.textContent = swCacheName;
}

if (swMetaEl) {
  if (swVer || swBuild) {
    swMetaEl.textContent = `${swVer || "?"} • ${swBuild || "?"}`;
  } else {
    swMetaEl.textContent = swMetaRaw ? "(keine Meta)" : "(kein SW aktiv)";
  }
}

// Compute update status
if (statusEl) {
  const targetCache = meta.cacheName || "";
  const cacheTxt = (container.querySelector("#about-sw-cache")?.textContent || "");
  const swOk = !!(swVer && swBuild && meta.version && meta.buildId && swVer === meta.version && swBuild === meta.buildId);
  const cacheOk = !!(targetCache && cacheTxt && cacheTxt.includes(targetCache));
  statusEl.textContent = (swOk || cacheOk) ? "Up to date" : "Update verfügbar";
}
} catch {
        // ignore
      }
    })();


    if (container.__settingsBound) return;
    container.__settingsBound = true;

    container.addEventListener("change", (e) => {
      const el = e.target;

      if (el && el.id === "s-light") {
        settings.theme = el.checked ? "light" : "dark";
        window.app.setState(state);
        return;
      }

      if (el && el.id === "s-timer") {
        settings.enableCookTimer = !!el.checked;
        window.app.setState(state);
        return;
      }

      if (el && el.id === "s-import") {
        const file = el.files && el.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => {
          try {
            const raw = String(reader.result || "");

            // Restore-Point setzen (damit du zurück kannst, falls Import Mist ist)
            if (typeof dt.setRestorePoint === "function") dt.setRestorePoint(state);

            const next = typeof dt.importStateText === "function" ? dt.importStateText(raw) : ensureStateShape(JSON.parse(raw));

            saveState(next);
            window.app.setState(next);
            window.app.navigate("dashboard");
          } catch (err) {
            console.warn("Import fehlgeschlagen:", err);
            alert("Import fehlgeschlagen. Bitte JSON prüfen (siehe Konsole).\n\nTipp: Wenn du willst, schick mir die JSON hier, dann prüfe ich sie dir.");
          } finally {
            el.value = "";
          }
        };
        reader.readAsText(file);
      }
    });

    container.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;

      const action = btn.getAttribute("data-action");

      if (action === "gotoPL") {
        window.app.navigate("purchaselog");
        return;
      }

      if (action === "gotoCH") {
        window.app.navigate("cookhistory");
        return;
      }

      if (action === "export") {
        const yyyyMmDd = new Date().toISOString().slice(0, 10);
        const filename = `einkauf_rezepte_export_${yyyyMmDd}.json`;
        const text = typeof dt.exportStateJson === "function" ? dt.exportStateJson(state, { pretty: true }) : JSON.stringify(state, null, 2);
        downloadText(filename, text);
        return;
      }

      if (action === "repair") {
        try {
          const next = typeof dt.repairState === "function" ? dt.repairState(state) : ensureStateShape(state);
          window.app.setState(next);
          alert("Daten geprüft und gespeichert.");
        } catch (err) {
          console.warn("Repair fehlgeschlagen:", err);
          alert("Prüfen/Reparieren fehlgeschlagen (siehe Konsole).\n\nWenn du willst, exportiere kurz und schick mir die JSON.");
        }
        return;
      }

      if (action === "restorePoint") {
        const ok = confirm("Vorherigen Stand wiederherstellen?\n\nDas ist der Sicherungspunkt vor dem letzten Import/Demo-Laden.");
        if (!ok) return;
        try {
          const next = typeof dt.restoreFromRestorePoint === "function" ? dt.restoreFromRestorePoint() : null;
          if (!next) {
            alert("Kein Sicherungspunkt gefunden.");
            return;
          }
          window.app.setState(next);
          window.app.navigate("dashboard");
        } catch (err) {
          console.warn("Restore fehlgeschlagen:", err);
          alert("Wiederherstellen fehlgeschlagen (siehe Konsole).\n\nWenn du willst, exportiere kurz und schick mir die JSON.");
        }
        return;
      }

      if (action === "demo") {
        const ok = confirm(
          "Demo-Daten laden?\n\nHinweis: Dein aktueller Stand wird als Sicherungspunkt gespeichert, damit du zurück kannst." 
        );
        if (!ok) return;

        try {
          if (typeof dt.setRestorePoint === "function") dt.setRestorePoint(state);
          const demo = typeof dt.buildDemoState === "function" ? dt.buildDemoState() : ensureStateShape(defaultState());
          saveState(demo);
          window.app.setState(demo);
          window.app.navigate("dashboard");
        } catch (err) {
          console.warn("Demo laden fehlgeschlagen:", err);
          alert("Demo laden fehlgeschlagen (siehe Konsole).");
        }
        return;
      }

      
      if (action === "refreshApp") {
        try {
          // 1) Caches löschen
          if (window.caches && caches.keys) {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
          }
          // 2) Service Worker "neu ziehen"
          if ("serviceWorker" in navigator) {
            const reg = await navigator.serviceWorker.getRegistration();
            try { await reg?.update(); } catch {}
            // Wenn waiting da ist -> aktivieren
            if (reg?.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
          }
        } catch (err) {
          console.warn("App aktualisieren fehlgeschlagen:", err);
        }
        window.location.reload();
        return;
      }

if (action === "reset") {
        const ok1 = confirm("Wirklich ALLE lokalen Daten löschen?\n\nDas betrifft auch Backup/Restore-Keys.");
        if (!ok1) return;

        const typed = prompt('Sicherheitsabfrage: Tippe genau "LÖSCHEN" ein, um fortzufahren.');
        if (typed !== "LÖSCHEN") return;

        // 1) LocalStorage (inkl. Backup/Restore)
        if (window.dataTools?.deleteAllLocalData) window.dataTools.deleteAllLocalData();
        else {
          try {
            resetState();
          } catch {}
        }

        // 2) Caches + Service Worker (damit du wirklich "clean slate" hast)
        try {
          if ("caches" in window) {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
          }
        } catch {}
        try {
          if ("serviceWorker" in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map((r) => r.unregister()));
          }
        } catch {}
        try {
          // IndexedDB (falls Browser/Libs was angelegt haben)
          if (indexedDB?.databases) {
            const dbs = await indexedDB.databases();
            await Promise.all((dbs || []).map((d) => d?.name ? new Promise((res) => {
              const req = indexedDB.deleteDatabase(d.name);
              req.onsuccess = req.onerror = req.onblocked = () => res();
            }) : Promise.resolve()));
          }
        } catch {}

        // 3) Frischen State laden + hart reloaden (ohne SW)
        const fresh = loadState();
        window.app.setState(fresh);
        window.app.navigate("dashboard");
        try { window.ui?.toast?.("Alles gelöscht. App lädt frisch neu…"); } catch {}
        window.location.replace("./?fresh=" + Date.now());
        return;
      }
    });
  };
})();
