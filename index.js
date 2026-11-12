// BetterGravity Token HUD Plugin
//
// Native-looking HUD chip in Antigravity's titlebar toolbar showing live
// context-window usage; click opens a compact two-column panel (no scroll)
// with token breakdown, model, quota and session info.
// Read-only: walks React fibers to find the cascade context provider and
// polls provider.getState(). Owns only its own DOM; cleans up on dispose.

if (typeof window.__bettergravity_tokenhud_cleanup === "function") {
  try {
    window.__bettergravity_tokenhud_cleanup();
  } catch {}
}

/* ── Constants & state ───────────────────────────────────────────────────── */
const ROOT = "tbgh";
const POLL_MS = 1000;
const ARC_R = 7; // chip mini progress-arc radius
const ARC_C = 2 * Math.PI * ARC_R;

let chip = null;
let chipPct = null;
let chipArc = null;
let panel = null;
let panelBody = null;
let panelOpen = false;
let scanFailed = false;

/* ── Formatting helpers ──────────────────────────────────────────────────── */
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);

const fmtInt = (n) => {
  const v = Number(n);
  return n == null || !Number.isFinite(v) ? "—" : v.toLocaleString("tr-TR");
};

const fmtK = (n) => {
  const v = Number(n);
  if (n == null || !Number.isFinite(v)) return "—";
  return v >= 1000 ? Math.round(v / 1000) + "k" : String(Math.round(v));
};

const fmtPct = (n) =>
  n == null || !Number.isFinite(n)
    ? "—"
    : n.toLocaleString("tr-TR", { maximumFractionDigits: 1 }) + "%";

const fmtUsd = (n) => {
  const v = Number(n);
  return n == null || !Number.isFinite(v) ? "—" : "$" + v.toFixed(2);
};

const fmtDate = (ms) => {
  const d = Number(ms);
  if (ms == null || !Number.isFinite(d) || d <= 0) return "—";
  try {
    return new Date(d).toLocaleString("tr-TR", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit"
    });
  } catch {
    return "—";
  }
};

const shortId = (id) => (id ? String(id).slice(0, 8) : "—");

const wsName = (traj) => {
  try {
    const uri = traj?.metadata?.workspaces?.[0]?.workspaceFolderAbsoluteUri;
    if (!uri) return null;
    const seg = decodeURIComponent(String(uri).replace(/\/+$/, ""))
      .split("/")
      .pop();
    return seg || null;
  } catch {
    return null;
  }
};

/* ── React fiber scan ────────────────────────────────────────────────────── */
// Find the object with both agentStateProvider + selectedModel
// (cascadeContext.state of the cascade shell component).

function findCascadeCtx() {
  try {
    const seen = new Set();
    const isTarget = (o) =>
      o && typeof o === "object" && o.agentStateProvider && o.selectedModel;

    const walk = (fiber) => {
      while (fiber) {
        if (seen.has(fiber)) return null;
        seen.add(fiber);
        const p = fiber.memoizedProps;
        if (isTarget(p)) return p;
        if (p && typeof p === "object" && isTarget(p.cascadeContext?.state)) {
          return p.cascadeContext.state;
        }
        if (fiber.child) {
          const hit = walk(fiber.child);
          if (hit) return hit;
        }
        fiber = fiber.sibling;
      }
      return null;
    };

    const els = document.body ? document.body.querySelectorAll("*") : [];
    for (const el of els) {
      for (const k in el) {
        if (k.startsWith("__reactFiber")) {
          const hit = walk(el[k]);
          if (hit) return hit;
          break;
        }
      }
    }
    return null;
  } catch (e) {
    if (!scanFailed) {
      scanFailed = true;
      try { plugin.log.warn("fiber scan failed: " + e); } catch {}
    }
    return null;
  }
}

/* ── Data collection ─────────────────────────────────────────────────────── */
function collect() {
  const ctx = findCascadeCtx();
  if (!ctx) return null;

  const state = (ctx.agentStateProvider && ctx.agentStateProvider.getState?.()) || {};
  const model = ctx.selectedModel || {};
  const cwu = state.contextWindowUsage || {};
  const traj = state.trajectorySlice || {};
  const turns = Array.isArray(state.turns) ? state.turns : [];
  const groups = Array.isArray(cwu.tokenGroups)
    ? cwu.tokenGroups.slice().sort((a, b) => (b.numTokens || 0) - (a.numTokens || 0))
    : [];

  const est = Number(cwu.estimatedTokensUsed) || 0;
  const max = Number(cwu.maxContextTokens) || 0;
  const pct = max > 0 ? (est / max) * 100 : null;

  // Steps + per-step ModelUsageStats (server truth). The loaded slice may be
  // partial for long conversations; sums are then marked with a "*" and a tooltip.
  const steps = Array.isArray(traj.stepsInSlice) ? traj.stepsInSlice : [];
  const sliceStart = Number(traj.stepsSlice?.startIndex) || 0;
  const totalSteps = Number(traj.totalStepsLength) || 0;
  const stepsFull = sliceStart === 0 && totalSteps > 0 && steps.length === totalSteps;
  const partial = steps.length > 0 && !stepsFull ? ` (yüklü: ${steps.length}/${totalSteps})` : "";

  const usage = { input: 0, output: 0, thinking: 0, cache: 0, gen: 0, user: 0 };
  let firstTs = null, lastTs = null;
  for (const st of steps) {
    if (st?.step?.case === "userInput") usage.user++;
    const md = st?.metadata || {};
    const mu = md.modelUsage;
    if (mu) {
      usage.gen++;
      usage.input += Number(mu.inputTokens) || 0;
      usage.output += Number(mu.outputTokens) || 0;
      usage.thinking += Number(mu.thinkingOutputTokens) || 0;
      usage.cache += (Number(mu.cacheReadTokens) || 0) + (Number(mu.cacheWriteTokens) || 0);
    }
    const ts = md.completedAt || md.finishedGeneratingAt || md.createdAt;
    const secs = Number(ts?.seconds);
    if (secs > 0) {
      const ms = secs * 1000 + Math.round((Number(ts.nanos) || 0) / 1e6);
      if (firstTs == null || ms < firstTs) firstTs = ms;
      if (lastTs == null || ms > lastTs) lastTs = ms;
    }
  }

  const hasSteps = steps.length > 0;
  const sessionStart = firstTs ?? (turns.length ? turns[0].startTimeMs : null);
  const lastActivity = lastTs ?? (turns.length ? turns[turns.length - 1].startTimeMs : null);
  const userMsgs = stepsFull ? usage.user : turns.length;

  // Paid accounts only; free accounts leave this empty.
  const cost = state.costSummary?.total?.estimatedCostUsd ?? null;

  const quota = model.quotaInfo;
  let quotaReset = null;
  try {
    const secs = Number(quota?.resetTime?.seconds);
    if (Number.isFinite(secs) && secs > 0) quotaReset = secs * 1000;
  } catch {}

  return {
    conversationId: state.conversationId,
    workspace: wsName(traj),
    modelLabel: model.label || model.modelId || "—",
    modelId: model.modelId || "—",
    max,
    est,
    pct,
    groups,
    partial,
    compactions: state.compactionInfo?.compactedAtStepIndices?.length || 0,
    steps: totalSteps,
    userMsgs,
    assistantMsgs: hasSteps ? usage.gen : null,
    sessionStart,
    lastActivity,
    usageInput: hasSteps ? usage.input : null,
    usageOutput: hasSteps ? usage.output : null,
    usageThinking: hasSteps ? usage.thinking : null,
    usageCache: hasSteps ? usage.cache : null,
    quota: quota ? quota.remainingFraction * 100 : null,
    quotaReset,
    cost,
    idle: !!state.fullyIdle
  };
}

/* ── Rendering ───────────────────────────────────────────────────────────── */
const LEVELS = ["ok", "warn", "danger", "off"];
const levelOf = (d) =>
  d == null
    ? "off"
    : d.pct == null
      ? "off"
      : d.pct >= 80 ? "danger" : d.pct >= 50 ? "warn" : "ok";

function cell(label, value, cls, title) {
  const t = title ? ` title="${esc(title)}"` : "";
  return (
    `<div class="${ROOT}-cell"${t}><span class="${ROOT}-l">${esc(label)}</span>` +
    `<span class="${ROOT}-v ${cls || ""}">${esc(value)}</span></div>`
  );
}

function renderBody(d) {
  if (!panelBody) return;

  if (!d) {
    panelBody.innerHTML =
      `<div class="${ROOT}-empty">Aktif oturum yok — bir cascade açın.</div>`;
    return;
  }

  const lv = levelOf(d);
  const usageCls = lv === "off" ? "" : `${ROOT}-${lv}`;

  let groups = "";
  if (d.groups.length) {
    for (const g of d.groups) {
      groups +=
        `<div class="${ROOT}-cell"><span class="${ROOT}-l">${esc(g.name || "Diğer")}</span>` +
        `<span class="${ROOT}-v">${fmtInt(g.numTokens)}</span></div>`;
    }
  } else {
    groups = `<div class="${ROOT}-cell"><span class="${ROOT}-l">Dağılım yok</span><span class="${ROOT}-v">—</span></div>`;
  }

  const status = d.idle ? "Boşta" : "Çalışıyor";
  const p = d.partial ? " *" : "";

  panelBody.innerHTML =
    `<div class="${ROOT}-sub" title="${esc(d.conversationId || "")}">` +
    `${esc(d.workspace || "workspace yok")} · ${esc(shortId(d.conversationId))} · ${esc(status)}</div>` +
    `<div class="${ROOT}-grid">` +
    cell("Sağlayıcı", "Antigravity") +
    cell("Model", d.modelLabel) +
    cell("Model ID", d.modelId) +
    cell("Kullanım", fmtPct(d.pct), usageCls) +
    cell(
      "Bağlam limiti",
      fmtInt(d.max),
      "",
      "Antigravity sunucusunun bu oturuma atadığı aktif bağlam penceresi; kullanım yüzdesi buna göre hesaplanır. Modelin teorik limiti (örn. 1M) daha yüksek olabilir."
    ) +
    cell("Toplam token", fmtInt(d.est)) +
    cell("Kullanıcı mesajı", fmtInt(d.userMsgs), "", "Dönüş (turn) sayısı — tek bir mesaj yüzlerce adımlık bir ajan koşusu başlatabilir.") +
    cell("Adımlar", fmtInt(d.steps)) +
    cell(
      "Asistan yanıtı",
      d.assistantMsgs == null ? "—" : fmtInt(d.assistantMsgs) + p,
      "",
      "Model çağrısı içeren adım sayısı" + (d.partial ? " — yalnızca yüklü adımlar" + d.partial.replace("yüklü: ", "") : "")
    ) +
    cell("Kompaksiyon", fmtInt(d.compactions), "", "Bağlam sıkıştırma (compaction) sayısı — 0 ise hiç yapılmamış.") +
    cell("Kota", d.quota == null ? "—" : fmtPct(d.quota)) +
    (d.quotaReset ? cell("Kota sıfırlama", fmtDate(d.quotaReset)) : "") +
    (d.cost != null ? cell("Maliyet", fmtUsd(d.cost), "", "costSummary — ücretli planda gelir.") : "") +
    cell(
      "Input token" + p,
      fmtInt(d.usageInput),
      "",
      "Tüm adımların toplam input token'ı (modelUsage). Her adım tüm bağlamı yeniden gönderdiği için toplam bağlamdan büyük olabilir." + (d.partial ? " — yalnızca yüklü adımlar sayıldı" + d.partial.replace("yüklü: ", "") : "")
    ) +
    cell("Output token" + p, fmtInt(d.usageOutput), "", "Tüm adımların toplam output token'ı." + (d.partial ? " — yalnızca yüklü adımlar" : "")) +
    cell("Thinking token" + p, fmtInt(d.usageThinking), "", "Tüm adımların toplam düşünme (thinking) token'ı." + (d.partial ? " — yalnızca yüklü adımlar" : "")) +
    cell("Cache token" + p, fmtInt(d.usageCache), "", "Önbellek okuma + yazma token toplamı." + (d.partial ? " — yalnızca yüklü adımlar" : "")) +
    cell("İlk mesaj", fmtDate(d.sessionStart), "", "İlk adımın zamanı (konuşmanın başlangıcı).") +
    cell("Son aktivite", fmtDate(d.lastActivity), "", "Son adımın tamamlanma zamanı — en doğru son aktivite kaynağı.") +
    `</div>` +
    `<div class="${ROOT}-sect">TOKEN DAĞILIMI</div>` +
    `<div class="${ROOT}-grid">${groups}</div>`;
}

function renderChip(d) {
  if (!chip || !chipPct || !chipArc) return;
  const lv = levelOf(d);

  if (d && d.pct != null) {
    chipPct.textContent = fmtPct(d.pct);
    chipArc.style.strokeDashoffset = String(ARC_C * (1 - Math.min(100, d.pct) / 100));
    chip.title = `Token HUD — ${fmtInt(d.est)} / ${fmtInt(d.max)} token (%${fmtPct(d.pct).replace("%", "")} kullanım)`;
  } else {
    chipPct.textContent = "—";
    chipArc.style.strokeDashoffset = String(ARC_C);
    chip.title = "Token HUD — aktif oturum yok";
  }
  for (const l of LEVELS) chip.classList.remove(`${ROOT}-${l}`);
  chip.classList.add(`${ROOT}-${lv}`);
}

/* ── Panel placement ─────────────────────────────────────────────────────── */
function placePanel() {
  if (!chip || !panel) return;
  const r = chip.getBoundingClientRect();
  const w = panel.offsetWidth;
  panel.style.top = r.bottom + 8 + "px";
  panel.style.right = Math.max(8, window.innerWidth - r.right) + "px";
  panel.style.left = "auto";
  // Keep on-screen if near the bottom edge.
  const h = panel.offsetHeight;
  if (r.bottom + 8 + h > window.innerHeight - 8) {
    panel.style.top = Math.max(8, r.top - h - 8) + "px";
  }
}

function togglePanel(open) {
  panelOpen = open != null ? open : !panelOpen;
  panel.classList.toggle("is-open", panelOpen);
  if (panelOpen) {
    tick();
    requestAnimationFrame(placePanel);
  }
  try {
    plugin.storage.set("tokenhud.open", panelOpen);
  } catch {}
}

/* ── Chip construction (injected into the native titlebar toolbar) ───────── */
const CHIP_CLASSES =
  "agy-button agy-button-icon-lg inline-flex items-center font-medium transition-colors " +
  "select-none outline-none cursor-pointer justify-center disabled:opacity-50 h-7 px-2 " +
  "shrink-0 rounded-lg group bg-transparent text-secondary-foreground hover:text-foreground " +
  "hover:bg-secondary focus-visible:text-foreground focus-visible:bg-secondary";

function buildChip() {
  chip = document.createElement("button");
  chip.id = `${ROOT}-chip`;
  chip.className = CHIP_CLASSES;
  chip.type = "button";
  chip.setAttribute("aria-label", "Token HUD");
  chip.title = "Token HUD";
  chip.style.setProperty("app-region", "no-drag");
  chip.innerHTML =
    `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">` +
    `<circle class="${ROOT}-arc-track" cx="8" cy="8" r="${ARC_R}" stroke-width="1.8"></circle>` +
    `<circle class="${ROOT}-arc" cx="8" cy="8" r="${ARC_R}" stroke-width="1.8" stroke-linecap="round" ` +
    `stroke-dasharray="${ARC_C}" stroke-dashoffset="${ARC_C}" transform="rotate(-90 8 8)"></circle>` +
    `</svg>` +
    `<span id="${ROOT}-chip-pct">—</span>`;
  chipPct = chip.querySelector(`#${ROOT}-chip-pct`);
  chipPct.className = `${ROOT}-ptext`;
  chipArc = chip.querySelector(`.${ROOT}-arc`);
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePanel();
  });
  return chip;
}

function ensureChip(toolbar) {
  try {
    if (!toolbar || toolbar.querySelector(`#${ROOT}-chip`)) return;
    const row = toolbar.querySelector(":scope > div");
    if (!row) return;
    const existing = document.getElementById(`${ROOT}-chip`);
    const el = existing || buildChip();
    if (existing && existing.parentElement) existing.remove();
    row.prepend(el);
  } catch (e) {
    if (!scanFailed) {
      scanFailed = true;
      try { plugin.log.warn("chip inject failed: " + e); } catch {}
    }
  }
}

/* ── Panel construction ──────────────────────────────────────────────────── */
function ensurePanel() {
  if (panel && document.contains(panel)) return;
  if (!document.body) return;
  panel = document.createElement("div");
  panel.id = `${ROOT}-panel`;
  panel.innerHTML =
    `<div class="${ROOT}-head">` +
    `<span class="${ROOT}-title">TOKEN HUD</span>` +
    `<button class="${ROOT}-close" title="Kapat">×</button>` +
    `</div>` +
    `<div class="${ROOT}-body"></div>`;
  panelBody = panel.querySelector(`.${ROOT}-body`);
  panel.querySelector(`.${ROOT}-close`).addEventListener("click", () => togglePanel(false));
  document.body.appendChild(panel);
}

/* ── Poll loop ───────────────────────────────────────────────────────────── */
function tick() {
  let d = null;
  try {
    d = collect();
  } catch (e) {
    if (!scanFailed) {
      scanFailed = true;
      try { plugin.log.warn("collect failed: " + e); } catch {}
    }
  }
  renderChip(d);
  if (panelOpen) {
    renderBody(d);
    placePanel();
  }
}

/* ── Lifecycle ───────────────────────────────────────────────────────────── */
// The plugin can load before <body> exists (early preload) — starting then
// crashes on null body. Defer until the DOM is ready.
let timer = null;
let stopTitlebar = null;
let started = false;

function start() {
  if (started) return;
  started = true;
  ensurePanel();
  stopTitlebar = plugin.dom.observe(
    '[data-testid="pane-titlebar-toolbar"]',
    ensureChip
  );
  // Observe may only fire on future matches — also seed the current toolbar.
  try {
    ensureChip(document.querySelector('[data-testid="pane-titlebar-toolbar"]'));
  } catch {}
  tick();
  timer = setInterval(tick, POLL_MS);
}

if (document.body) start();
else document.addEventListener("DOMContentLoaded", start, { once: true });

const cleanup = () => {
  try { document.removeEventListener("DOMContentLoaded", start); } catch {}
  try { if (timer) clearInterval(timer); } catch {}
  try { stopTitlebar?.(); } catch {}
  try { chip?.remove(); } catch {}
  try { panel?.remove(); } catch {}
  if (window.__bettergravity_tokenhud_cleanup === cleanup) {
    delete window.__bettergravity_tokenhud_cleanup;
  }
};

window.__bettergravity_tokenhud_cleanup = cleanup;
plugin.onDispose(cleanup);
