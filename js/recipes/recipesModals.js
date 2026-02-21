(() => {
  const uid = () => (window.utils?.uid ? window.utils.uid() : (window.models?.uid ? window.models.uid() : `id_${Date.now()}_${Math.random().toString(16).slice(2)}`));

  const esc = (s) => (window.utils?.esc ? window.utils.esc(s) : String(s ?? ""));

  const L = () => window.recipesLogic;

  const fmt = (n) => {
    const x = Number(n) || 0;
    return x.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  };

  function basePortionsOf(recipe) {
    const p = Math.round(Number(recipe?.portions) || 1);
    return p > 0 ? p : 1;
  }

  function normalizeDesiredPortions(v) {
    const n = Math.max(1, Math.round(Number(v) || 1));
    return n;
  }

  function multiplierFromPortions(recipe, desiredPortions) {
    const base = basePortionsOf(recipe);
    return base > 0 ? desiredPortions / base : 1;
  }

  function portionControlsHTML(recipe, desiredPortions) {
    const base = basePortionsOf(recipe);
    return `
      <div class="portionbar">
        <div class="portionbar-left">
          <div class="small muted2">Portionen</div>
          <div class="small muted2" style="margin-top:2px;">Grundrezept: <b>${esc(base)}</b></div>
        </div>
        <div class="stepper" style="margin-left:auto;">
          <button type="button" class="btn-mini" data-action="portion_minus" aria-label="Portionen minus">−</button>
          <input id="portion-input" class="step-input" type="number" min="1" step="1" value="${esc(desiredPortions)}" />
          <button type="button" class="btn-mini" data-action="portion_plus" aria-label="Portionen plus">+</button>
        </div>
      </div>
    `;
  }

  function ensureSettings(state) {
    if (!state.settings || typeof state.settings !== "object") state.settings = {};
    if (typeof state.settings.enableCookTimer === "undefined") state.settings.enableCookTimer = true;
    return state.settings;
  }

  function timerEnabled(state) {
    return ensureSettings(state).enableCookTimer !== false;
  }

  // buildModal: extraButtons + onAction für mehrere Buttons
  function buildModal({
    title,
    contentHTML,
    okText = "OK",
    cancelText = "Abbrechen",
    okClass = "primary",
    maxWidth = 720,
    maxHeight = "78vh",
    extraButtons = [], // [{ action:"x", text:"..", className:"" }]
    onConfirm,
    onAction
  }) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const modal = document.createElement("div");
    modal.className = "modal";
    modal.style.maxWidth = `${maxWidth}px`;
    modal.style.maxHeight = `${maxHeight}`;

    const extraHtml = (extraButtons || [])
      .map((b) => `<button data-action="${esc(b.action)}" class="${esc(b.className || "")}">${esc(b.text)}</button>`)
      .join("");

    modal.innerHTML = `
      <div class="modal-header">
        <div class="modal-title">${esc(title)}</div>
        <button class="modal-close" data-action="close" title="Schließen">✕</button>
      </div>

      <div id="m-body" class="modal-body">${contentHTML}</div>

      <div id="m-footer" class="modal-footer">
        <button data-action="cancel">${esc(cancelText)}</button>
        ${extraHtml}
        <button data-action="ok" class="${esc(okClass)}">${esc(okText)}</button>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function close() {
      overlay.remove();
    }

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });

    modal.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;

      const action = btn.getAttribute("data-action");
      if (action === "close" || action === "cancel") return close();
      if (action === "ok") return onConfirm?.(modal, close);

      onAction?.(action, modal, close);
    });

    return { overlay, modal, close };
  }

  function openAddToShoppingModal(state, persist, recipe) {
    // „🛒“ am Rezept = Rezept planen (plannedRecipes) + Einkaufsliste global anheben
    const base = basePortionsOf(recipe);
    let desiredPortions = base;

    // plannedRecipes sicherstellen
    L().ensurePlannedRecipes?.(state);

    const wasPlanned = (state.plannedRecipes || []).some((x) => String(x.recipeId) === String(recipe.id));

    const content = `
      ${portionControlsHTML(recipe, desiredPortions)}
      <div class="small" style="opacity:0.85; margin:10px 0 6px 0;">
        Plan berücksichtigt Vorrat. Die Einkaufsliste wird <b>nur angehoben</b> (niemals automatisch reduziert).
      </div>
      <div id="plan-lines"></div>
      <div id="plan-msg" class="small" style="margin-top:10px; opacity:0.9;"></div>
    `;

    const modalObj = buildModal({
      title: `Planen · ${recipe.name}`,
      contentHTML: content,
      okText: wasPlanned ? "Plan aktualisieren" : "Plan hinzufügen",
      okClass: "primary",
      onConfirm: (_modal, close) => {
        L().upsertPlannedRecipe?.(state, recipe.id, desiredPortions);
        L().reconcileShoppingWithPlan?.(state, { mode: "raise" });

        persist();
        close();
        // Wichtig: nicht automatisch zur Einkaufsliste wechseln.
      }
    });

    function simPlan() {
      const basePlan = Array.isArray(state.plannedRecipes) ? state.plannedRecipes.slice() : [];
      const next = basePlan.filter((x) => String(x.recipeId) !== String(recipe.id));
      next.push({ recipeId: String(recipe.id), portionsWanted: desiredPortions, addedAt: new Date().toISOString() });
      return next;
    }

    function currentShoppingPacks(ingredientId) {
      const it = (state.shopping || []).find((x) => String(x.ingredientId) === String(ingredientId));
      return it ? Math.max(1, Math.round(Number(it.packs) || 1)) : 0;
    }

    function render() {
      const mult = multiplierFromPortions(recipe, desiredPortions);

      const before = L().computePlanSummary?.(state) || { byIngredient: new Map() };
      const after = L().computePlanSummary?.(state, simPlan()) || { byIngredient: new Map() };

      const host = modalObj.modal.querySelector("#plan-lines");
      const msg = modalObj.modal.querySelector("#plan-msg");
      if (!host || !msg) return;

      const items = (recipe.items || [])
        .map((it) => {
          const ing = L().getIng(state, it.ingredientId);
          if (!ing) return null;

          const row = after.byIngredient.get(String(ing.id));
          if (!row) return null;

          const curPacks = currentShoppingPacks(ing.id);
          const reqPacks = Math.max(0, Math.round(Number(row.requiredPacks) || 0));
          const targetPacks = reqPacks > 0 ? Math.max(curPacks, reqPacks) : curPacks;

          const beforeReq = before.byIngredient.get(String(ing.id))?.requiredPacks || 0;

          return {
            id: ing.id,
            name: ing.name,
            unit: ing.unit,
            need: row.need,
            have: row.have,
            missing: row.missing,
            reqPacks,
            beforeReq: Math.max(0, Math.round(Number(beforeReq) || 0)),
            curPacks,
            targetPacks,
            willRaise: targetPacks > curPacks && reqPacks > 0
          };
        })
        .filter(Boolean);

      const raiseCount = items.filter((x) => x.willRaise).length;

      host.innerHTML = items
        .map((x) => {
          const ok = x.missing <= 0;

          const deltaReq = x.reqPacks - x.beforeReq;
          const deltaTxt = deltaReq === 0 ? "" : deltaReq > 0 ? ` · Δ Plan +${deltaReq}` : ` · Δ Plan ${deltaReq}`;

          const raiseTxt = x.willRaise ? ` → wird auf <b>${x.targetPacks}</b> angehoben` : "";

          return `
            <div class="card" style="margin:8px 0; padding:10px;">
              <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
                <div style="min-width:0; flex:1;">
                  <div style="font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(x.name)}</div>
                  <div class="small" style="margin-top:4px; opacity:0.9;">
                    Vorrat: <b>${esc(fmt(x.have))}</b> ${esc(x.unit)}
                    · Plan-Bedarf: <b>${esc(fmt(x.need))}</b> ${esc(x.unit)}
                    ${ok ? `· ✅ ok` : `· Fehlt: <b>${esc(fmt(x.missing))}</b> ${esc(x.unit)}`}
                  </div>
                  <div class="small" style="margin-top:4px; opacity:0.9;">
                    Packungen nötig: <b>${esc(String(x.reqPacks))}</b>${deltaTxt}
                    · Einkaufsliste: <b>${esc(String(x.curPacks))}</b>${raiseTxt}
                  </div>
                </div>
              </div>
            </div>
          `;
        })
        .join("");

      if (!items.length) {
        msg.textContent = "Keine Zutaten im Rezept.";
      } else if (raiseCount === 0) {
        msg.textContent = "Einkaufsliste muss nicht erhöht werden (alles schon abgedeckt).";
      } else {
        msg.textContent = `Einkaufsliste wird bei ${raiseCount} Zutat(en) angehoben.`;
      }

      const multTxt = (mult || 1).toFixed(2).replace(/\.00$/, "");
      const titleEl = modalObj.modal.querySelector(".modal-title");
      if (titleEl) titleEl.textContent = `Planen · ${recipe.name} · ${desiredPortions} Portionen (x${multTxt})`;
    }

    // Stepper
    modalObj.modal.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-action");
      if (action !== "portion_minus" && action !== "portion_plus") return;

      const delta = action === "portion_plus" ? base : -base;
      desiredPortions = normalizeDesiredPortions(desiredPortions + delta);
      const inp = modalObj.modal.querySelector("#portion-input");
      if (inp) inp.value = String(desiredPortions);
      render();
    });

    modalObj.modal.addEventListener("input", (e) => {
      const t = e.target;
      if (t && t.id === "portion-input") {
        desiredPortions = normalizeDesiredPortions(t.value);
        render();
      }
    });

    render();
  }

  // Anleitung: jede Zeile = 1 Schritt
  function getStepLines(recipe) {
    const raw = String(recipe.instructions || "").trim();
    if (!raw) return [];
    return raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/^\d+[\)\.\-]\s*/, "").replace(/^\-\s*/, ""));
  }

  function formatTimer(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, "0")}`;
  }

  function saveCookTime(recipe, seconds, meta = {}) {
    const sec = Math.max(0, Math.floor(Number(seconds) || 0));
    if (!recipe) return;

    recipe.cookHistory = Array.isArray(recipe.cookHistory) ? recipe.cookHistory : [];
    const at = new Date().toISOString();
    recipe.cookHistory.push({ id: uid(), at, seconds: sec, ...meta });

    // begrenzen
    if (recipe.cookHistory.length > 30) recipe.cookHistory.splice(0, recipe.cookHistory.length - 30);
    recipe.lastCookSeconds = sec;
    recipe.lastCookAt = at;
  }

  function openCookWizard(state, persist, recipe, desiredPortions, multiplier, mode, lines) {
    const steps = [];

    const desc = String(recipe.description || "").trim();
    if (desc) steps.push({ title: "Beschreibung", text: desc });

    const instr = getStepLines(recipe);
    if (instr.length) instr.forEach((t, i) => steps.push({ title: `Schritt ${i + 1}`, text: t }));
    else steps.push({ title: "Anleitung", text: "Keine Anleitung vorhanden." });

    let idx = 0;
    const startMs = Date.now();
    const isTimerOn = timerEnabled(state);

    const content = `
      <div style="display:flex; justify-content:space-between; gap:12px; align-items:center; margin-bottom:10px;">
        <div class="small" id="cw-progress" style="opacity:0.9;"></div>
        <div class="small" id="cw-timer" style="opacity:0.9; ${isTimerOn ? "" : "display:none;"}">Zeit: 0:00</div>
      </div>

      <div style="border:1px solid var(--border); border-radius:12px; padding:12px; background:#121622;">
        <div id="cw-title" style="font-weight:700; font-size:16px;"></div>
        <div id="cw-text" class="small" style="margin-top:8px; white-space:pre-wrap; opacity:0.95;"></div>
      </div>

      <div style="margin-top:10px;">
        <div class="small" style="opacity:0.75;">Nächster Schritt:</div>
        <div id="cw-next" class="small" style="margin-top:4px; opacity:0.9;"></div>
      </div>
    `;

    let intervalId = null;

    const multTxt = (multiplier || 1).toFixed(2).replace(/\.00$/, "");
    const modalObj = buildModal({
      title: `Kochen · ${recipe.name} · ${desiredPortions} Portionen (x${multTxt})`,
      contentHTML: content,
      okText: "Fertig gekocht",
      okClass: "primary",
      extraButtons: [
        { action: "prev", text: "Zurück" },
        { action: "next", text: "Weiter", className: "primary" }
      ],
      maxWidth: 760,
      onConfirm: (_modal, close) => {
        const elapsed = Math.floor((Date.now() - startMs) / 1000);

        const finalize = (overrideSeconds = null) => {
          // Bestände abziehen
          const epsStueck = 0.01;
          const epsOther = 0.5;

          for (const x of lines) {
            const eps = x.unit === "Stück" ? epsStueck : epsOther;

            if (mode === "skip_missing") {
              if ((Number(x.have) || 0) + eps < (Number(x.need) || 0)) continue;
            }
            L().consumeFromPantry(state, x.ingredientId, x.need, x.unit);
          }

          if (isTimerOn) {
            const secToSave = overrideSeconds == null ? elapsed : Math.floor(Number(overrideSeconds) || 0);
            saveCookTime(recipe, secToSave, { portions: desiredPortions, multiplier });
          }

          persist();
          close();
          window.app.navigate("inventory");
        };

        // Wenn zu schnell: kurz nachfragen (optional)
        if (isTimerOn && elapsed < 15) {
          buildModal({
            title: "Zeit speichern?",
            contentHTML: `
              <div class="small" style="opacity:0.9;">
                Gemessene Zeit: <b>${esc(formatTimer(elapsed))}</b> – das wirkt sehr schnell.
              </div>
              <div style="margin-top:10px;">
                <label class="small">Wenn du willst: echte Minuten eingeben</label><br/>
                <input id="t-min" type="number" min="0" step="0.5" placeholder="z. B. 12" style="max-width:140px;" />
                <span class="small" style="opacity:0.8;">Minuten</span>
              </div>
              <div class="small" style="margin-top:10px; opacity:0.8;">
                Leer lassen = gemessene Zeit verwenden.
              </div>
            `,
            okText: "Speichern & fertig",
            okClass: "primary",
            extraButtons: [{ action: "ignore", text: "Ohne Zeit speichern" }],
            onConfirm: (m, close2) => {
              const min = Number(m.querySelector("#t-min")?.value);
              close2();
              if (Number.isFinite(min) && min > 0) finalize(min * 60);
              else finalize(null);
            },
            onAction: (action, _m, close2) => {
              if (action === "ignore") {
                // ohne Zeit speichern
                close2();
                const prev = ensureSettings(state);
                const was = prev.enableCookTimer;
                prev.enableCookTimer = false;
                finalize(null);
                prev.enableCookTimer = was; // nur fürs Speichern einmal aus
              }
            }
          });
          return;
        }

        finalize(null);
      },
      onAction: (action, modal) => {
        if (action === "prev") idx = Math.max(0, idx - 1);
        if (action === "next") idx = Math.min(steps.length - 1, idx + 1);
        renderWizard(modal);
      }
    });

    function renderWizard(modal) {
      const titleEl = modal.querySelector("#cw-title");
      const textEl = modal.querySelector("#cw-text");
      const nextEl = modal.querySelector("#cw-next");
      const progEl = modal.querySelector("#cw-progress");

      const s = steps[idx];
      const next = steps[idx + 1];

      progEl.textContent = `Seite ${idx + 1} / ${steps.length}`;
      titleEl.textContent = s.title;
      textEl.textContent = s.text;
      nextEl.textContent = next ? next.text : "—";

      const prevBtn = modal.querySelector('button[data-action="prev"]');
      const nextBtn = modal.querySelector('button[data-action="next"]');
      if (prevBtn) prevBtn.disabled = idx === 0;
      if (nextBtn) nextBtn.disabled = idx === steps.length - 1;
    }

    renderWizard(modalObj.modal);

    if (isTimerOn) {
      const timerEl = modalObj.modal.querySelector("#cw-timer");
      intervalId = window.setInterval(() => {
        if (!timerEl) return;
        const elapsed = Math.floor((Date.now() - startMs) / 1000);
        timerEl.textContent = `Zeit: ${formatTimer(elapsed)}`;
      }, 1000);
    }

    // wenn Modal geschlossen wird: interval sauber stoppen
    const origClose = modalObj.close;
    modalObj.close = () => {
      if (intervalId) window.clearInterval(intervalId);
      origClose();
    };
  }

  function openCookModal(state, persist, recipe) {
    const base = basePortionsOf(recipe);
    let desiredPortions = base;

    const content = `
      ${portionControlsHTML(recipe, desiredPortions)}
      <div class="small" style="opacity:0.85; margin:10px 0 6px 0;">Bestand wird berücksichtigt.</div>
      <div id="cook-lines"></div>
      <div id="cook-msg" class="small" style="margin-top:10px; opacity:0.9;"></div>
    `;

    const modalObj = buildModal({
      title: `Kochen · ${recipe.name}`,
      contentHTML: content,
      okText: "Kochen starten",
      okClass: "primary",
      onConfirm: (_modal, close) => {
        const mult = multiplierFromPortions(recipe, desiredPortions);
        const lines = computeLines(mult);
        const missingLines = lines.filter((x) => x.missing > 0);

        if (missingLines.length) {
          const ok = window.confirm(
            `Es fehlen ${missingLines.length} Zutat(en).\n\nTrotzdem kochen? (Es wird nur aus dem vorhandenen Bestand verbraucht.)`
          );
          if (!ok) return; // Modal bleibt offen
        }

        close();
        openCookWizard(state, persist, recipe, desiredPortions, mult, "partial", lines);
      }
    });

    function computeLines(multiplier) {
      return (recipe.items || [])
        .map((it) => {
          const ing = L().getIng(state, it.ingredientId);
          if (!ing) return null;

          const need = (Number(it.amount) || 0) * multiplier;
          const have = L().pantryAvailable(state, it.ingredientId);
          const missing = Math.max(0, need - have);

          return { ingredientId: ing.id, name: ing.name, unit: ing.unit, need, have, missing };
        })
        .filter(Boolean);
    }

    function render() {
      const mult = multiplierFromPortions(recipe, desiredPortions);
      const lines = computeLines(mult);
      const missingLines = lines.filter((x) => x.missing > 0);

      const host = modalObj.modal.querySelector("#cook-lines");
      const msg = modalObj.modal.querySelector("#cook-msg");
      if (!host || !msg) return;

      host.innerHTML = lines
        .map((x) => {
          const ok = x.missing <= 0;
          return `
            <div class="card" style="margin:8px 0; padding:10px;">
              <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
                <div style="min-width:0; flex:1;">
                  <div style="font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(x.name)}</div>
                  <div class="small" style="margin-top:4px; opacity:0.9;">
                    Vorrat: <b>${esc(fmt(x.have))}</b> ${esc(x.unit)}
                    · Verbrauch: <b>${esc(fmt(x.need))}</b> ${esc(x.unit)}
                    ${ok ? `· ✅ ok` : `· ❗ fehlt: <b>${esc(fmt(x.missing))}</b> ${esc(x.unit)}`}
                  </div>
                </div>
                <div class="small" style="opacity:${ok ? "0.85" : "1"};">${ok ? "vorhanden" : "fehlt"}</div>
              </div>
            </div>
          `;
        })
        .join("");

      if (!missingLines.length) {
        msg.textContent = "Alles da – du kannst direkt kochen.";
      } else {
        msg.textContent = `Es fehlt etwas (${missingLines.length} Zutat(en)). Du kannst trotzdem kochen (Kochen starten) oder abbrechen und erst zur Einkaufsliste hinzufügen.`;
      }

      const multTxt = (mult || 1).toFixed(2).replace(/\.00$/, "");
      const titleEl = modalObj.modal.querySelector(".modal-title");
      if (titleEl) titleEl.textContent = `Kochen · ${recipe.name} · ${desiredPortions} Portionen (x${multTxt})`;
    }

    modalObj.modal.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-action");
      if (action !== "portion_minus" && action !== "portion_plus") return;
      const delta = action === "portion_plus" ? base : -base;
      desiredPortions = normalizeDesiredPortions(desiredPortions + delta);
      const inp = modalObj.modal.querySelector("#portion-input");
      if (inp) inp.value = String(desiredPortions);
      render();
    });

    modalObj.modal.addEventListener("input", (e) => {
      const t = e.target;
      if (t && t.id === "portion-input") {
        desiredPortions = normalizeDesiredPortions(t.value);
        render();
      }
    });

    render();
  }

  window.recipesModals = {
    buildModal,
    openAddToShoppingModal,
    openCookModal
  };
})();
