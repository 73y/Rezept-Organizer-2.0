(() => {
  // Zentrale Build-/Versions-Infos.
  // Regel: bei JEDEM Update die version erhöhen. buildId kann pro Deploy neu sein.
  const version = "v0.5.8";
  const buildId = "20260222125751";

  // Production nur auf GitHub Pages (und optional eigener Domain). Alles andere = Dev.
  // Damit vermeidest du beim Entwickeln (localhost/LAN/ngrok) das "alte Datei"-Chaos durch SW.
  const isProd = (() => {
    const h = String(location?.hostname || "").toLowerCase();
    // GitHub Pages
    if (h.endsWith("github.io")) return true;
    // Optional: eigene Domain hier ergänzen
    // if (h === "deine-domain.de") return true;
    return false;
  })();

  const meta = {
    version,
    buildId,
    isProd,
    // Ein Cache-Name, der *beides* enthält: Release + Build.
    // So siehst du im UI sofort, ob SW/Cache wirklich zu deinem Release passt.
    cacheName: `einkauf-rezepte-pwa-${version}-${buildId}`
  };

  // In normalen Seiten ist `self` == `window`. Im Service Worker ist `self` der SW-Global.
  try {
    (typeof self !== "undefined" ? self : window).APP_META = meta;
  } catch {
    // ignore
  }
})();
