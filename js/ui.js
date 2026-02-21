(() => {
  // js/ui.js
  // Sehr kleine UI-Utilities (Toast + Modal). Optional – Views dürfen weiterhin eigene Modals nutzen.

  const esc = (s) => (window.utils?.esc ? window.utils.esc(s) : String(s ?? ""));

  function ensureToastHost() {
    let host = document.getElementById("toast-host");
    if (host) return host;
    host = document.createElement("div");
    host.id = "toast-host";
    host.style.cssText = `
      position:fixed; left:50%; bottom:18px; transform:translateX(-50%);
      z-index:9999; display:flex; flex-direction:column; gap:10px;
      width:min(720px, calc(100vw - 24px));
      pointer-events:none;
    `;
    document.body.appendChild(host);
    return host;
  }

  function toast(message, { actionText = null, onAction = null, timeoutMs = 8000 } = {}) {
    const host = ensureToastHost();
    const el = document.createElement("div");
    el.style.cssText = `
      pointer-events:auto;
      border:1px solid var(--border);
      border-radius:14px;
      background: color-mix(in srgb, var(--panel) 92%, transparent);
      box-shadow:0 14px 40px rgba(0,0,0,0.55);
      padding:10px 12px;
      display:flex; align-items:center; gap:10px; justify-content:space-between;
    `;

    el.innerHTML = `
      <div style="display:flex; align-items:center; gap:10px; min-width:0;">
        <div class="small" style="opacity:.92; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(message)}</div>
      </div>
      <div style="display:flex; gap:8px; align-items:center;">
        ${actionText ? `<button type="button" class="info" data-action="act" style="min-width:92px;">${esc(actionText)}</button>` : ``}
        <button type="button" data-action="close" title="Schließen" style="min-width:40px;">✕</button>
      </div>
    `;

    let t = null;
    function close() {
      if (t) clearTimeout(t);
      el.remove();
    }

    el.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const a = btn.getAttribute("data-action");
      if (a === "close") return close();
      if (a === "act") {
        try {
          onAction?.();
        } finally {
          close();
        }
      }
    });

    host.appendChild(el);
    if (timeoutMs > 0) t = setTimeout(close, timeoutMs);

    return { close };
  }

  function modal({ title, contentHTML, okText = "OK", cancelText = "Abbrechen", okClass = "primary", onConfirm, onCancel } = {}) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const m = document.createElement("div");
    m.className = "modal";
    m.innerHTML = `
      <div class="modal-header">
        <div class="modal-title">${esc(title || "")}</div>
        <button class="modal-close" data-action="close" title="Schließen">✕</button>
      </div>
      <div class="modal-body">${contentHTML || ""}</div>
      <div class="modal-footer">
        <button data-action="cancel">${esc(cancelText)}</button>
        <button data-action="ok" class="${esc(okClass)}">${esc(okText)}</button>
      </div>
    `;

    overlay.appendChild(m);
    document.body.appendChild(overlay);

    function close() {
      overlay.remove();
    }

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });

    m.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const a = btn.getAttribute("data-action");
      if (a === "close" || a === "cancel") {
        onCancel?.();
        return close();
      }
      if (a === "ok") return onConfirm?.(m, close);
    });

    return { overlay, modal: m, close };
  }

  window.ui = { toast, modal };
})();
