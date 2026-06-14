const SEGMENTS = [
  { letter: "B", min: 1, max: 15, theme: "theme-b", color: "#1f7cff" },
  { letter: "I", min: 16, max: 30, theme: "theme-i", color: "#00a884" },
  { letter: "N", min: 31, max: 45, theme: "theme-n", color: "#ffb000" },
  { letter: "G", min: 46, max: 60, theme: "theme-g", color: "#ff5a1f" },
  { letter: "O", min: 61, max: 75, theme: "theme-o", color: "#8d55ff" },
];

const HOST_TOKEN_PREFIX = "bingo.hostToken.";
const LOCK_RENEW_MS = 30000;
const DRAW_ROLL_TIMING = Object.freeze({
  rouletteStart: 240,
  rouletteDuration: 5400,
  suspenseMin: 900,
  suspenseMax: 1500,
  fakeOutSuspenseMin: 420,
  fakeOutSuspenseMax: 680,
});
const RESULT_GLOW_VISIBLE_MS = 3000;
const RESULT_GLOW_FADE_MS = 1100;
const DRAW_ROLL_TICKS = 21;
const DRAW_FAKE_OUT_CHANCE = 0.38;
const LAUNCH_COUNT_SCHEDULE = [5, 4, 3, 2, 1, 0];

const state = {
  mode: "viewer",
  lobby: null,
  draw: null,
  drawn: [],
  pool: Array.from({ length: 75 }, (_, index) => index + 1),
  hostToken: null,
  channel: null,
  lockTimer: null,
  lastRenderedNumber: null,
  lastRenderedDrawSignature: "",
  subscribedDrawId: null,
  loadingState: false,
  drawAnimating: false,
  drawCycleTimer: null,
  drawDotTimer: null,
  drawRollRunId: 0,
  launchedBallAnimationId: null,
  resultGlowTimer: null,
  resultGlowFadeTimer: null,
  flyingBalls: [],
};

const els = {
  ball: document.getElementById("currentBall"),
  ballLetter: document.querySelector(".ball-letter"),
  ballNumber: document.querySelector(".ball-number"),
  claimHostForm: document.getElementById("claimHostForm"),
  renameLobbyForm: document.getElementById("renameLobbyForm"),
  lobbyNameEditInput: document.getElementById("lobbyNameEditInput"),
  confetti: document.getElementById("confetti"),
  copyButton: document.getElementById("copyButton"),
  createLobbyForm: document.getElementById("createLobbyForm"),
  drawButton: document.getElementById("drawButton"),
  historyBody: document.getElementById("historyBody"),
  joinCodeInput: document.getElementById("joinCodeInput"),
  joinLobbyForm: document.getElementById("joinLobbyForm"),
  lobbyCodeLabel: document.getElementById("lobbyCodeLabel"),
  lobbyNameInput: document.getElementById("lobbyNameInput"),
  createHostCredentialInput: document.getElementById("createHostCredentialInput"),
  claimHostCredentialInput: document.getElementById("claimHostCredentialInput"),
  lobbyNameLabel: document.getElementById("lobbyNameLabel"),
  lobbyOverlay: document.getElementById("lobbyOverlay"),
  lobbyStatus: document.getElementById("lobbyStatus"),
  rolePanel: document.getElementById("rolePanel"),
  roleEyebrow: document.getElementById("roleEyebrow"),
  appTitle: document.getElementById("app-title"),
  remainingCount: document.getElementById("remainingCount"),
  resetButton: document.getElementById("resetButton"),
  resultText: document.getElementById("resultText"),
  resultHero: document.querySelector(".result-hero"),
  rollingResults: document.getElementById("rollingResults"),
  segmentBoard: document.getElementById("segmentBoard"),
  segmentLabel: document.getElementById("segmentLabel"),
  sessionPanel: document.getElementById("sessionPanel"),
  welcomeActions: document.getElementById("welcomeActions"),
};

const confetti = {
  ctx: els.confetti.getContext("2d"),
  pieces: [],
  animationId: null,
};

function getSupabaseConfig() {
  const config = window.BINGO_SUPABASE_CONFIG || {};
  const missing = !config.url || !config.anonKey || config.url.includes("YOUR_PROJECT_REF") || config.anonKey.includes("YOUR_SUPABASE_ANON_KEY");
  return missing ? null : config;
}

const supabaseConfig = getSupabaseConfig();
const supabaseClient = supabaseConfig && window.supabase
  ? window.supabase.createClient(supabaseConfig.url, supabaseConfig.anonKey)
  : null;

function setStatus(message, isError = false) {
  els.lobbyStatus.textContent = message;
  els.lobbyStatus.style.color = isError ? "#b42318" : "var(--muted)";
}

function cleanLobbyName(name) {
  return String(name || "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function requireHostCredential(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Ingresa la credencial fija del evento.");
  }
  return value;
}

function renderLobbyTitle(name) {
  const fallback = "Bingo Online 2026 - Rotary Club Rukapillán";
  const title = cleanLobbyName(name) || fallback;
  els.appTitle.textContent = title;
  els.appTitle.title = title;
}

function requireSupabase() {
  if (!supabaseClient) {
    throw new Error("Configura Supabase URL y anon key en supabaseConfig.js antes de usar lobbies en vivo.");
  }
}

function normalizeCode(code) {
  return String(code || "").trim().toUpperCase();
}

function tokenKey(lobbyCode) {
  return `${HOST_TOKEN_PREFIX}${normalizeCode(lobbyCode)}`;
}

function firstRpcRow(data) {
  return Array.isArray(data) ? data[0] : data;
}

function isMissingRpcError(error) {
  if (!error) return false;
  const code = String(error.code || "");
  const message = String(error.message || error.details || error.hint || "").toLowerCase();
  return (
    code === "PGRST202" ||
    code === "42883" ||
    message.includes("could not find the function") ||
    message.includes("function public.update_lobby_name") ||
    message.includes("function update_lobby_name") ||
    message.includes("schema cache") ||
    message.includes("does not exist")
  );
}

function isPermissionError(error) {
  if (!error) return false;
  const code = String(error.code || "");
  const message = String(error.message || error.details || "").toLowerCase();
  return code === "42501" || message.includes("permission") || message.includes("row-level security") || message.includes("rls");
}

function lobbyRenameUnavailableMessage(reason = "") {
  const suffix = reason ? ` ${reason}` : "";
  return `Cambio de nombre no disponible.${suffix} La sala sigue funcionando; ejecuta supabase/update_lobby_name_rpc.sql para habilitar esta opción.`;
}

function friendlyErrorMessage(error, fallback = "Ocurrió un error inesperado.") {
  if (isMissingRpcError(error)) return lobbyRenameUnavailableMessage("Falta la función update_lobby_name.");
  if (isPermissionError(error)) return lobbyRenameUnavailableMessage("Supabase bloqueó la actualización por permisos.");
  return error?.message || fallback;
}

function getSegment(number) {
  return SEGMENTS.find((segment) => number >= segment.min && number <= segment.max);
}

function formatResult(number) {
  const segment = getSegment(number);
  return segment ? `${segment.letter}-${number}` : "--";
}

function ordinalDrawLabel(drawNumber) {
  if (drawNumber === 1) return "1er";
  return `${drawNumber}º`;
}

function ordinalDrawWord(drawNumber) {
  const units = {
    1: "primer",
    2: "segundo",
    3: "tercer",
    4: "cuarto",
    5: "quinto",
    6: "sexto",
    7: "séptimo",
    8: "octavo",
    9: "noveno",
  };
  const tens = {
    10: "décimo",
    20: "vigésimo",
    30: "trigésimo",
    40: "cuadragésimo",
    50: "quincuagésimo",
    60: "sexagésimo",
    70: "septuagésimo",
  };
  const number = Number(drawNumber);
  if (number >= 1 && number <= 9) return units[number];
  if (number in tens) return tens[number];
  const ten = Math.floor(number / 10) * 10;
  const unit = number % 10;
  if (tens[ten] && units[unit]) return `${tens[ten]} ${units[unit]}`;
  return `${number}º`;
}

function drawProgressHtml(dotCount = 3) {
  const drawNumber = state.drawn.length + 1;
  const dots = ".".repeat(clamp(dotCount, 1, 3));
  return `Sorteando el ${ordinalDrawWord(drawNumber)} número <span class="draw-dots">${dots}</span>`;
}

function setDrawProgressLabel(dotCount = 3) {
  els.segmentLabel.innerHTML = drawProgressHtml(dotCount);
}

function startDrawDots() {
  stopDrawDots();
  let dotCount = 1;
  setDrawProgressLabel(dotCount);
  state.drawDotTimer = window.setInterval(() => {
    if (!state.drawAnimating) {
      stopDrawDots();
      return;
    }
    dotCount = dotCount >= 3 ? 1 : dotCount + 1;
    setDrawProgressLabel(dotCount);
  }, 360);
}

function stopDrawDots() {
  if (state.drawDotTimer) {
    window.clearInterval(state.drawDotTimer);
    state.drawDotTimer = null;
  }
}

function toDrawItem(event) {
  const number = Number(event.number);
  const segment = getSegment(number);
  return {
    id: event.id,
    eventIndex: Number(event.event_index),
    number,
    segment,
    result: formatResult(number),
    createdAt: event.created_at,
  };
}

function eventListFromState(cloudState) {
  return (cloudState.events || [])
    .map(toDrawItem)
    .sort((a, b) => b.eventIndex - a.eventIndex);
}

function updateHash(lobbyCode, mode) {
  const params = new URLSearchParams({ lobby: normalizeCode(lobbyCode), mode });
  history.replaceState(null, "", `${location.pathname}${location.search}#${params.toString()}`);
}

function readHashState() {
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  const params = new URLSearchParams(hash);
  const lobby = normalizeCode(params.get("lobby"));
  const mode = params.get("mode") === "host" ? "host" : "viewer";
  return { lobby, mode };
}

function setMode(mode) {
  state.mode = mode === "host" ? "host" : "viewer";
  const isHost = state.mode === "host" && Boolean(state.hostToken);
  els.roleEyebrow.textContent = isHost ? "Anfitrión" : "Espectador";
  els.roleEyebrow.className = `eyebrow role-badge ${isHost ? "host" : "viewer"}`;
  if (els.claimHostForm) els.claimHostForm.hidden = isHost;
  if (els.renameLobbyForm) els.renameLobbyForm.hidden = !isHost;
  els.resetButton.hidden = !isHost;
  els.lobbyNameLabel.textContent = isHost ? "Administración de sala" : "Control de anfitrión";
  if (els.lobbyNameEditInput && state.lobby?.name) els.lobbyNameEditInput.value = state.lobby.name;
  render();
}

function setIdleBall(message = "Esperando nuevo número…") {
  stopResultIdleEffects();
  stopDrawDots();
  resetDrawMotion();
  els.ball.className = "bingo-ball is-idle";
  els.ball.style.background = "var(--g)";
  els.ball.style.filter = "";
  els.ballLetter.textContent = "?";
  els.ballNumber.textContent = "--";
  els.resultText.textContent = message;
  els.resultText.classList.remove("is-randomizing-result");
  els.segmentLabel.textContent = state.draw?.status === "closed" ? "Sorteo cerrado" : "Listo para sortear";
}

function drawSignature(items = state.drawn) {
  return items.map((item) => `${item.eventIndex}:${item.number}`).join("|");
}

function shouldAnimateLatestNumber(previousDrawId, previousLatest, latest, force = false) {
  if (!latest || !state.draw || previousDrawId !== state.draw.id) return false;
  return force || latest.eventIndex !== previousLatest;
}

function renderCurrentBall(animate = false) {
  const latest = state.drawn[0];

  if (!latest) {
    setIdleBall(state.draw?.status === "closed" ? "Sorteo cerrado" : "Esperando nuevo número…");
    return;
  }

  if (animate) {
    els.ball.classList.remove("is-drawing");
    void els.ball.offsetWidth;
  }

  resetDrawMotion();
  els.ball.className = `bingo-ball is-idle ${animate ? "is-drawing" : "has-result"} ${latest.segment.theme}`;
  els.ball.style.background = latest.segment.color;
  els.ball.style.filter = "";
  els.ballLetter.textContent = latest.segment.letter;
  els.ballNumber.textContent = latest.number;
  els.resultText.textContent = latest.result;
  els.resultText.classList.remove("is-randomizing-result");
  els.segmentLabel.textContent = `Segmento ${latest.segment.letter} · ${latest.segment.min}-${latest.segment.max}`;

  if (animate) burstConfetti(latest.segment.color);
}

function render() {
  const remaining = 75 - state.drawn.length;
  const isHost = state.mode === "host" && Boolean(state.hostToken);
  const isActive = state.draw?.status === "active";
  const isConfigured = Boolean(supabaseClient);

  els.remainingCount.textContent = Math.max(remaining, 0);
  if (els.drawButton) els.drawButton.disabled = !isConfigured || !isHost || !isActive || remaining <= 0;
  els.resetButton.disabled = !isConfigured || !isHost || !isActive;
  els.resetButton.hidden = !isHost;

  renderRollingResults();
  renderHistory();
  renderSegmentBoard();
}

function renderRollingResults() {
  const signature = drawSignature();
  if (signature === state.lastRenderedDrawSignature) return;
  state.lastRenderedDrawSignature = signature;

  const latest = state.drawn.slice(0, 3);

  if (!latest.length) {
    els.rollingResults.innerHTML = '<li class="empty">Todavía no hay resultados</li>';
    return;
  }

  els.rollingResults.innerHTML = latest
    .map(
      (item) =>
        `<li class="${item.segment.theme}" style="background:${item.segment.color}">${item.result}</li>`
    )
    .join("");
}

function renderHistory() {
  if (!state.drawn.length) {
    els.historyBody.innerHTML = '<li class="empty-cell">Esperando el primer número</li>';
    return;
  }

  const chronological = state.drawn.slice().reverse();
  els.historyBody.innerHTML = chronological
    .map(
      (item, index) => `
        <li class="history-item">
          <span class="history-index">${String(index + 1).padStart(2, "0")}</span>
          <span class="tag ${item.segment.theme}">${item.result}</span>
        </li>
      `
    )
    .join("");
}


function setResettingDrawVisual(isResetting) {
  els.rollingResults.classList.toggle("is-resetting-draw", Boolean(isResetting));
  els.historyBody.classList.toggle("is-resetting-draw", Boolean(isResetting));
}

function renderSegmentBoard() {
  const drawnNumbers = new Set(state.drawn.map((item) => item.number));

  els.segmentBoard.innerHTML = SEGMENTS.map((segment) => {
    const numbers = [];
    for (let number = segment.min; number <= segment.max; number += 1) {
      const isDrawn = drawnNumbers.has(number);
      numbers.push(
        `<span class="number-chip ${isDrawn ? "drawn" : ""}" style="${
          isDrawn ? `background:${segment.color}` : ""
        }">${number}</span>`
      );
    }

    return `
      <article class="segment-column">
        <div class="segment-title ${segment.theme}">${segment.letter}</div>
        <div class="number-grid">${numbers.join("")}</div>
      </article>
    `;
  }).join("");
}

function renderFromCloudState(cloudState, { animateLatest = false, preserveCurrentBall = false } = {}) {
  const previousDrawId = state.draw?.id;
  const previousLatest = state.drawn[0]?.eventIndex;

  state.lobby = cloudState.lobby;
  state.draw = cloudState.draw;
  state.drawn = eventListFromState(cloudState);
  state.pool = Array.from({ length: 75 }, (_, index) => index + 1).filter(
    (number) => !state.drawn.some((item) => item.number === number)
  );

  els.lobbyOverlay.hidden = true;
  els.sessionPanel.hidden = false;
  els.rolePanel.hidden = false;
  els.lobbyCodeLabel.textContent = state.lobby.lobby_code;
  renderLobbyTitle(state.lobby.name);
  if (els.lobbyNameEditInput) els.lobbyNameEditInput.value = state.lobby.name || "";

  const latest = state.drawn[0];
  const shouldAnimate = shouldAnimateLatestNumber(previousDrawId, previousLatest, latest, animateLatest);
  if (!preserveCurrentBall) renderCurrentBall(Boolean(shouldAnimate));

  if (state.draw.status === "closed") {
    setStatus("Sorteo cerrado. Esperando nuevo sorteo…");
  } else if (state.mode === "host" && state.hostToken) {
    setStatus(`Sala activa ${state.lobby.lobby_code}. Comparte este código con los jugadores.`);
  } else {
    setStatus("Espectador. Esperando nuevo número…");
  }

  setMode(state.mode);
}

async function loadLobbyState(lobbyCode, options = {}) {
  requireSupabase();
  if (state.drawAnimating && !options.allowDuringDraw) return null;
  if (state.loadingState) return null;
  state.loadingState = true;
  try {
    const code = normalizeCode(lobbyCode);
    const { data, error } = await supabaseClient.rpc("get_lobby_state", { p_lobby_code: code });
    if (error) throw error;
    renderFromCloudState(data, options);
    subscribeToLobby(state.draw.id);
    return data;
  } finally {
    state.loadingState = false;
  }
}

async function createLobby(name, hostCredential) {
  requireSupabase();
  const checkedCredential = requireHostCredential(hostCredential);
  setStatus("Creando sala…");
  const { data, error } = await supabaseClient.rpc("create_lobby", {
    p_name: cleanLobbyName(name),
    p_host_password: checkedCredential,
  });
  if (error) throw error;

  const row = firstRpcRow(data);
  const code = normalizeCode(row.lobby_code);
  sessionStorage.setItem(tokenKey(code), row.host_token);
  state.hostToken = row.host_token;
  setMode("host");
  updateHash(code, "host");
  await loadLobbyState(code);
  startHostLockRenewal();
}

async function joinLobby(lobbyCode) {
  const code = normalizeCode(lobbyCode);
  state.hostToken = sessionStorage.getItem(tokenKey(code));
  setMode(state.hostToken ? "host" : "viewer");
  updateHash(code, state.hostToken ? "host" : "viewer");
  await loadLobbyState(code);
  if (state.hostToken) startHostLockRenewal();
}

async function claimHost(lobbyCode, hostCredential) {
  requireSupabase();
  const checkedCredential = requireHostCredential(hostCredential);
  setStatus("Tomando control…");
  const { data, error } = await supabaseClient.rpc("claim_host", {
    p_lobby_code: normalizeCode(lobbyCode),
    p_host_password: checkedCredential,
    p_lock_holder: "host",
  });
  if (error) throw error;

  const row = firstRpcRow(data);
  const code = normalizeCode(lobbyCode);
  sessionStorage.setItem(tokenKey(code), row.host_token);
  state.hostToken = row.host_token;
  setMode("host");
  updateHash(code, "host");
  await loadLobbyState(code);
  startHostLockRenewal();
}

async function updateLobbyName(name) {
  requireSupabase();
  if (!state.lobby || !state.hostToken) return;
  const nextName = cleanLobbyName(name);
  if (!nextName) throw new Error("El nombre de la sala no puede estar vacío.");
  if (nextName === cleanLobbyName(state.lobby.name)) {
    setStatus(`Sala activa ${state.lobby.lobby_code}. Sin cambios en el nombre.`);
    return;
  }

  setStatus("Actualizando nombre de sala…");

  const rpcResult = await supabaseClient.rpc("update_lobby_name", {
    p_lobby_code: normalizeCode(state.lobby.lobby_code),
    p_host_token: state.hostToken,
    p_name: nextName,
  });

  if (rpcResult.error) {
    const rpcError = rpcResult.error;
    const directResult = await supabaseClient
      .from("lobbies")
      .update({ name: nextName })
      .eq("id", state.lobby.id)
      .select("id,name")
      .single();

    if (directResult.error) {
      console.warn("Lobby rename failed", { rpcError, directError: directResult.error });
      if (isMissingRpcError(rpcError)) {
        throw new Error(lobbyRenameUnavailableMessage("Falta la función update_lobby_name."));
      }
      if (isPermissionError(directResult.error)) {
        throw new Error(lobbyRenameUnavailableMessage("Supabase bloqueó la actualización por permisos."));
      }
      throw directResult.error;
    }
  }

  state.lobby.name = nextName;
  renderLobbyTitle(nextName);
  if (els.lobbyNameEditInput) els.lobbyNameEditInput.value = nextName;
  setStatus(`Sala activa ${state.lobby.lobby_code}. Nombre actualizado.`);
  await loadLobbyState(state.lobby.lobby_code, { preserveCurrentBall: true });
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getLaunchedBallCount(completedDraws) {
  const scheduleIndex = Math.min(
    Math.floor(completedDraws / 14),
    LAUNCH_COUNT_SCHEDULE.length - 1
  );
  return LAUNCH_COUNT_SCHEDULE[scheduleIndex];
}

function chooseCycleNumber(availableNumbers) {
  if (!availableNumbers.length) return null;
  return availableNumbers[secureRandomInt(availableNumbers.length)];
}

function renderBallCandidate(number) {
  const segment = getSegment(number);
  if (!segment) return;
  const hiddenNumber = "?".repeat(String(number).length);
  els.ball.className = `bingo-ball is-randomizing ${segment.theme}`;
  els.ball.style.background = segment.color;
  els.ballLetter.textContent = segment.letter;
  els.ballNumber.textContent = number;
  els.resultText.textContent = `?-${hiddenNumber}`;
  els.resultText.classList.add("is-randomizing-result");
  if (!state.drawDotTimer) setDrawProgressLabel(3);
}

function randomFloat(min, max) {
  return min + (secureRandomInt(1000000) / 1000000) * (max - min);
}

function randomFromZone(zone) {
  return randomFloat(zone.min, zone.max);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function easeOutCubic(value) {
  const progress = clamp(value, 0, 1);
  return 1 - Math.pow(1 - progress, 3);
}

function resetDrawMotion() {
  els.ball.style.setProperty("--draw-x", "0px");
  els.ball.style.setProperty("--draw-y", "0px");
  els.ball.style.setProperty("--draw-scale", "1");
  els.ball.style.setProperty("--draw-tilt", "0deg");
  els.ball.style.setProperty("--draw-step-ms", "120ms");
}

function applyDrawTickMotion(progress, tick, stepMs) {
  const remaining = 1 - easeOutCubic(progress);
  const sign = tick % 2 === 0 ? -1 : 1;
  const phase = tick % 4;
  const x = sign * (2.2 * remaining);
  const y = (phase === 0 || phase === 3 ? -1 : 1) * (1.2 * remaining);
  const scale = 0.99 - 0.01 * remaining;
  const tilt = sign * (4.8 * remaining);
  els.ball.style.setProperty("--draw-x", `${x.toFixed(3)}px`);
  els.ball.style.setProperty("--draw-y", `${y.toFixed(3)}px`);
  els.ball.style.setProperty("--draw-scale", scale.toFixed(4));
  els.ball.style.setProperty("--draw-tilt", `${tilt.toFixed(3)}deg`);
  els.ball.style.setProperty("--draw-step-ms", `${Math.max(80, Math.min(460, stepMs || 140)).toFixed(0)}ms`);
}

function stopResultIdleEffects() {
  if (state.resultGlowTimer) {
    window.clearTimeout(state.resultGlowTimer);
    state.resultGlowTimer = null;
  }
  if (state.resultGlowFadeTimer) {
    window.clearTimeout(state.resultGlowFadeTimer);
    state.resultGlowFadeTimer = null;
  }
  els.resultHero.classList.remove("is-result-idle", "is-result-glow", "is-result-glow-fading");
}

function startResultIdleEffects(accentColor) {
  stopResultIdleEffects();
  els.resultHero.style.setProperty("--result-glow-color", accentColor || "#ffffff");
  els.resultHero.classList.add("is-result-idle", "is-result-glow");

  state.resultGlowTimer = window.setTimeout(() => {
    state.resultGlowTimer = null;
    if (state.drawAnimating) return;
    els.resultHero.classList.remove("is-result-glow");
    els.resultHero.classList.add("is-result-glow-fading");

    state.resultGlowFadeTimer = window.setTimeout(() => {
      state.resultGlowFadeTimer = null;
      els.resultHero.classList.remove("is-result-glow-fading");
    }, RESULT_GLOW_FADE_MS);
  }, RESULT_GLOW_VISIBLE_MS);
}

function stopLaunchedBallAnimation({ removeLayer = false } = {}) {
  if (state.launchedBallAnimationId) {
    cancelAnimationFrame(state.launchedBallAnimationId);
    state.launchedBallAnimationId = null;
  }
  state.flyingBalls = [];
  if (removeLayer) els.resultHero.querySelector(".launched-ball-layer")?.remove();
}

function createLaunchedBallLayer(completedDraws) {
  stopLaunchedBallAnimation({ removeLayer: true });

  const count = getLaunchedBallCount(completedDraws);
  if (count <= 0) return null;

  const layer = document.createElement("div");
  layer.className = "launched-ball-layer";
  layer.setAttribute("aria-hidden", "true");
  els.resultHero.appendChild(layer);

  const bounds = els.resultHero.getBoundingClientRect();
  const mainRect = els.ball.getBoundingClientRect();
  const mainSize = clamp(mainRect.width || bounds.width * 0.19, 120, 260);
  const unitX = bounds.width / 20;
  const gravity = 9.81;
  const baseFloorY = Math.max(bounds.height - mainSize * 0.18, mainSize * 0.75);
  const floorY = baseFloorY + 10;
  const unitY = Math.max(24, (baseFloorY - mainSize * 0.35) / 8.5);
  const launchY = -5 - 10 / unitY;
  const launch = { left: [-5, -3], right: [3, 5] };
  const land = { left: [-10, -2], right: [2, 10] };

  const toScreenX = (x, size) => bounds.width / 2 + x * unitX - size / 2;
  const toScreenY = (y, size) => floorY - y * unitY - size / 2;
  const ballTransform = (x, y, item, spinSeconds = 0) => {
    const spin = item.spinDirection * item.spinRps * 360 * spinSeconds;
    return `translate3d(${toScreenX(x, item.size)}px, ${toScreenY(y, item.size)}px, 0) rotate(${spin}deg)`;
  };

  state.flyingBalls = Array.from({ length: count }, (_, index) => {
    const number = chooseCycleNumber(state.pool) || index + 1;
    const segment = getSegment(number) || SEGMENTS[index % SEGMENTS.length];
    const side = secureRandomInt(2) ? "right" : "left";
    const x0 = randomFloat(...launch[side]);
    const x1 = randomFloat(...land[side]);
    const boostedArc = secureRandomInt(10) === 0;
    const apex = randomFloat(5, 8) * (boostedArc ? 1.2 : 1);
    const vy0 = Math.sqrt(2 * gravity * (apex - launchY)) * (boostedArc ? 1.1 : 1);
    const duration = ((vy0 + Math.sqrt(Math.max(0, vy0 * vy0 + 2 * gravity * -launchY))) / gravity) * 1.18;
    const baseShrink = randomFloat(0.05, 0.15);
    const extraShrink = randomFloat(0.05, 0.15);
    const size = mainSize * (1 - baseShrink) * (1 - extraShrink);
    const depth = clamp((mainSize - size) / (mainSize * 0.28), 0, 1);
    const ball = document.createElement("span");
    const item = {
      ball,
      size,
      x0,
      x1,
      y: launchY,
      vx: (x1 - x0) / duration,
      vy: vy0,
      apex,
      duration,
      delay: randomFloat(0.35, 2.65),
      speedBase: randomFloat(1.72, 1.88) * (boostedArc ? 1.08 : 1),
      spinRps: randomFloat(0.3, 1),
      spinDirection: secureRandomInt(2) ? 1 : -1,
      elapsed: 0,
      spinSeconds: 0,
      done: false,
      visible: false,
    };

    ball.className = `launched-ball ${segment.theme}`;
    ball.innerHTML = `
      <span class="launched-letter">${segment.letter}</span>
      <strong class="launched-number">${number}</strong>
    `;
    ball.style.setProperty("--ball-color", segment.color);
    ball.style.setProperty("--launched-size", `${size}px`);
    ball.style.setProperty("--launched-border", `${Math.max(4, size * 0.055)}px`);
    ball.style.setProperty("--launched-letter-size", `${Math.max(11, size * 0.12)}px`);
    ball.style.setProperty("--launched-number-size", `${Math.max(26, size * 0.33)}px`);
    ball.style.setProperty("--launched-number-padding", `${Math.max(10, size * 0.16)}px`);
    ball.style.setProperty("--launched-shade", String(0.10 + depth * 0.08));
    ball.style.setProperty("--launched-edge-shade", String(0.18 + depth * 0.08));
    ball.style.setProperty("--launched-brightness", String(0.97 - depth * 0.035));
    ball.style.zIndex = String(3 - Math.round(depth * 2));
    ball.style.transform = ballTransform(x0, launchY, item);
    layer.appendChild(ball);

    return item;
  });

  const startedAt = performance.now();
  let previousFrameAt = startedAt;

  const animate = (now) => {
    const realElapsed = (now - startedAt) / 1000;
    const frameSeconds = Math.min((now - previousFrameAt) / 1000, 0.05);
    previousFrameAt = now;
    let finished = true;

    for (const item of state.flyingBalls) {
      if (!item.done && realElapsed >= item.delay) {
        if (!item.visible) {
          item.visible = true;
          item.ball.style.visibility = "visible";
        }
        const heightRatio = item.apex > launchY ? clamp((item.y - launchY) / (item.apex - launchY), 0, 1) : 0;
        const heightDrag = 1.10 + 0.55 * Math.pow(1 - heightRatio, 1.0);
        item.elapsed = Math.min(item.duration, item.elapsed + frameSeconds * item.speedBase * heightDrag);
        item.spinSeconds += frameSeconds;
        item.done = item.elapsed >= item.duration;

        const x = item.x0 + item.vx * item.elapsed;
        item.y = launchY + item.vy * item.elapsed - 0.5 * gravity * item.elapsed * item.elapsed;
        item.ball.style.transform = ballTransform(x, item.y, item, item.spinSeconds);
      }
      if (!item.done) finished = false;
    }

    state.launchedBallAnimationId = !finished && state.drawAnimating
      ? requestAnimationFrame(animate)
      : null;
  };

  state.launchedBallAnimationId = requestAnimationFrame(animate);
  return layer;
}

function stopDrawCycle() {
  if (state.drawCycleTimer) {
    cancelAnimationFrame(state.drawCycleTimer);
    state.drawCycleTimer = null;
  }
  state.drawRollRunId += 1;
  stopDrawDots();
  resetDrawMotion();
  stopLaunchedBallAnimation();
}

function candidateNumbersWithout(finalNumber, availableNumbers = state.pool) {
  const visualPool = availableNumbers.filter((number) => number !== finalNumber);
  if (visualPool.length) return visualPool;
  return Array.from({ length: 75 }, (_, index) => index + 1).filter((number) => number !== finalNumber);
}

function chooseDifferentCycleNumber(finalNumber, availableNumbers = state.pool) {
  const pool = candidateNumbersWithout(finalNumber, availableNumbers);
  return pool.length ? pool[secureRandomInt(pool.length)] : null;
}

function buildNumberCycleSequence(totalTicks, terminalNumber, availableNumbers) {
  const poolBase = candidateNumbersWithout(terminalNumber, availableNumbers);
  const sequence = new Array(totalTicks);
  let previous = null;

  for (let index = 0; index < totalTicks - 1; index += 1) {
    const avoidTerminalNearEnd = index >= totalTicks - 4;
    const pool = poolBase.filter(
      (number) => number !== previous && (!avoidTerminalNearEnd || number !== terminalNumber)
    );
    const fallback = pool.length ? pool : poolBase;
    const number = fallback.length ? fallback[secureRandomInt(fallback.length)] : terminalNumber;
    sequence[index] = number;
    previous = number;
  }

  sequence[totalTicks - 1] = terminalNumber;
  return sequence;
}

function buildRollTickOffsets(totalTicks, durationMs) {
  const offsets = new Array(totalTicks);
  const transitions = totalTicks - 1;
  const weights = new Array(transitions);
  let totalWeight = 0;

  offsets[0] = 0;

  for (let step = 0; step < transitions; step += 1) {
    const progress = step / Math.max(1, transitions - 1);
    const weight = 0.92 + Math.pow(progress, 3.05) * 4.55;
    weights[step] = weight;
    totalWeight += weight;
  }

  let elapsed = 0;
  for (let step = 0; step < transitions; step += 1) {
    elapsed += (weights[step] / totalWeight) * durationMs;
    offsets[step + 1] = elapsed;
  }

  offsets[totalTicks - 1] = durationMs;
  return offsets;
}

function tickFromElapsed(elapsedMs, offsets) {
  let low = 0;
  let high = offsets.length - 1;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (offsets[mid] <= elapsedMs) low = mid;
    else high = mid - 1;
  }

  return low;
}

function startNumberCycle(finalNumber, availableNumbers) {
  const runId = ++state.drawRollRunId;
  const shouldFakeOut = Math.random() < DRAW_FAKE_OUT_CHANCE;
  const sequence = buildNumberCycleSequence(DRAW_ROLL_TICKS, finalNumber, availableNumbers);
  const tickOffsets = buildRollTickOffsets(DRAW_ROLL_TICKS, DRAW_ROLL_TIMING.rouletteDuration);
  const suspenseDuration = shouldFakeOut
    ? randomFloat(DRAW_ROLL_TIMING.fakeOutSuspenseMin, DRAW_ROLL_TIMING.fakeOutSuspenseMax)
    : randomFloat(DRAW_ROLL_TIMING.suspenseMin, DRAW_ROLL_TIMING.suspenseMax);
  const startedAt = performance.now();
  const settleAt = DRAW_ROLL_TIMING.rouletteStart + DRAW_ROLL_TIMING.rouletteDuration;
  const revealAt = settleAt + suspenseDuration;
  let lastTick = -1;
  let settled = false;

  return new Promise((resolve) => {
    const cycle = (now) => {
      if (runId !== state.drawRollRunId || !state.drawAnimating) {
        state.drawCycleTimer = null;
        resolve({ completed: false, fakeOut: false, settleNumber: null });
        return;
      }

      const elapsed = now - startedAt;

      if (elapsed >= DRAW_ROLL_TIMING.rouletteStart && !settled) {
        const rouletteElapsed = Math.min(
          elapsed - DRAW_ROLL_TIMING.rouletteStart,
          DRAW_ROLL_TIMING.rouletteDuration
        );
        const tick = tickFromElapsed(rouletteElapsed, tickOffsets);
        if (tick !== lastTick) {
          lastTick = tick;
          const nextOffset = tickOffsets[Math.min(tick + 1, tickOffsets.length - 1)] ?? DRAW_ROLL_TIMING.rouletteDuration;
          const stepMs = Math.max(90, nextOffset - tickOffsets[tick]);
          const progress = rouletteElapsed / DRAW_ROLL_TIMING.rouletteDuration;
          renderBallCandidate(sequence[tick]);
          applyDrawTickMotion(progress, tick, stepMs);
        }
      }

      if (!settled && elapsed >= settleAt) {
        settled = true;
        resetDrawMotion();
      }

      if (elapsed >= revealAt) {
        state.drawCycleTimer = null;
        resolve({ completed: true, fakeOut: shouldFakeOut, settleNumber: finalNumber });
        return;
      }

      state.drawCycleTimer = requestAnimationFrame(cycle);
    };

    state.drawCycleTimer = requestAnimationFrame(cycle);
  });
}

function beginDrawSuspense(completedDraws) {
  stopDrawCycle();
  stopResultIdleEffects();
  state.drawAnimating = true;
  els.resultHero.classList.add("is-draw-active");
  els.ball.classList.remove("is-idle", "is-drawing", "is-revealing", "has-result", "hover-kick", "hover-exit", "is-fake-out-hold", "is-fake-out-resolve");
  els.ball.classList.add("is-randomizing", "is-draw-starting");
  els.resultText.textContent = "?-??";
  els.resultText.classList.add("is-randomizing-result");
  startDrawDots();
  window.setTimeout(() => els.ball.classList.remove("is-draw-starting"), 160);
  createLaunchedBallLayer(completedDraws);
}

async function revealDrawResult({ finalNumber, finalEventIndex, fakeOut = false }) {
  stopDrawCycle();

  const segment = getSegment(finalNumber);
  if (segment) {
    resetDrawMotion();
    els.ball.className = `bingo-ball is-idle has-result ${fakeOut ? "is-fake-out-resolve" : ""} ${segment.theme}`;
    els.ball.style.background = segment.color;
    els.ball.style.filter = "";
    els.ballLetter.textContent = segment.letter;
    els.ballNumber.textContent = finalNumber;
    stopDrawDots();
    els.resultText.textContent = formatResult(finalNumber);
    els.resultText.classList.remove("is-randomizing-result");
    els.segmentLabel.textContent = `Segmento ${segment.letter} · ${segment.min}-${segment.max}`;
    els.resultHero.classList.remove("is-draw-active");
    els.resultHero.querySelector(".launched-ball-layer")?.remove();
    state.drawAnimating = false;
    burstConfetti(segment.color);
    startResultIdleEffects(segment.color);

    if (fakeOut) {
      window.setTimeout(() => els.ball.classList.remove("is-fake-out-resolve"), 390);
    }
  } else {
    stopDrawDots();
    els.resultHero.classList.remove("is-draw-active");
    els.resultHero.querySelector(".launched-ball-layer")?.remove();
    state.drawAnimating = false;
  }
}

async function drawNextNumber() {
  requireSupabase();
  if (!state.draw || !state.hostToken || state.drawAnimating) return;
  const remaining = 75 - state.drawn.length;
  const isHost = state.mode === "host" && Boolean(state.hostToken);
  if (!supabaseClient || !isHost || state.draw.status !== "active" || remaining <= 0) return;

  const completedDraws = state.drawn.length;
  if (els.drawButton) els.drawButton.disabled = true;
  setStatus("Sorteando número…");

  const rpcPromise = supabaseClient.rpc("draw_next_number", {
    p_draw_id: state.draw.id,
    p_host_token: state.hostToken,
  });

  try {
    beginDrawSuspense(completedDraws);
    const { data, error } = await rpcPromise;
    if (error) throw error;

    const row = firstRpcRow(data);
    const finalNumber = Number(row.number);
    const rollResult = await startNumberCycle(finalNumber, state.pool);
    if (!rollResult.completed) {
      stopDrawDots();
      state.drawAnimating = false;
      els.resultHero.classList.remove("is-draw-active");
      els.resultHero.querySelector(".launched-ball-layer")?.remove();
      return;
    }
    await revealDrawResult({
      finalNumber,
      finalEventIndex: Number(row.event_index),
      fakeOut: rollResult.fakeOut,
    });
    await loadLobbyState(state.lobby.lobby_code, {
      animateLatest: false,
      allowDuringDraw: true,
      preserveCurrentBall: true,
    });
  } catch (error) {
    stopDrawCycle();
    stopResultIdleEffects();
    stopDrawDots();
    state.drawAnimating = false;
    els.resultHero.classList.remove("is-draw-active");
    els.resultHero.querySelector(".launched-ball-layer")?.remove();
    els.resultText.classList.remove("is-randomizing-result");
    setStatus(error.message || "No se pudo sacar número", true);
    renderCurrentBall(false);
    render();
  }
}

function drawFromBall(event) {
  if (event.type === "keydown" && !["Enter", " "].includes(event.key)) return;
  event.preventDefault();
  drawNextNumber();
}

function closeDropdownsOnOutsideClick(event) {
  const path = event.composedPath ? event.composedPath() : [];
  for (const details of document.querySelectorAll("details[open]")) {
    if (!path.includes(details)) details.open = false;
  }
}

function returnToLobbySelector() {
  if (!state.lobby) return;
  const wantsChange = confirm("¿Quieres cambiar de sala? Volverás a la pantalla inicial para crear o unirte a otra sala.");
  if (!wantsChange) return;

  if (state.lockTimer) {
    window.clearInterval(state.lockTimer);
    state.lockTimer = null;
  }
  if (state.channel && supabaseClient) {
    supabaseClient.removeChannel(state.channel);
  }

  state.mode = "viewer";
  state.lobby = null;
  state.draw = null;
  state.drawn = [];
  state.pool = Array.from({ length: 75 }, (_, index) => index + 1);
  state.hostToken = null;
  state.channel = null;
  state.lastRenderedNumber = null;
  state.lastRenderedDrawSignature = "";
  state.subscribedDrawId = null;
  stopDrawCycle();
  state.drawCycleTimer = null;
  state.drawRollRunId += 1;
  state.launchedBallAnimationId = null;
  state.flyingBalls = [];

  history.replaceState(null, "", `${location.pathname}${location.search}`);
  els.sessionPanel.hidden = true;
  els.resetButton.hidden = true;
  els.lobbyOverlay.hidden = false;
  renderLobbyTitle("");
  els.lobbyCodeLabel.textContent = "------";
  els.joinCodeInput.focus();
  setIdleBall("¡Presiona la bola para sortear!");
  setStatus("Listo: crea una sala o únete con un código.");
  setMode("viewer");
}

async function closeAndStartNewDraw() {
  requireSupabase();
  if (!state.lobby || !state.draw || !state.hostToken) return;
  if (!confirm("¿Cerrar este sorteo y comenzar un nuevo sorteo? El sorteo cerrado quedará inmutable.")) return;

  els.resetButton.disabled = true;
  setResettingDrawVisual(true);
  setStatus("Cerrando sorteo y creando nuevo sorteo…");
  const { data, error } = await supabaseClient.rpc("close_draw_and_create_new", {
    p_lobby_id: state.lobby.id,
    p_draw_id: state.draw.id,
    p_host_token: state.hostToken,
  });
  if (error) {
    const message = error.message || "No se pudo crear nuevo sorteo";
    console.error("close_draw_and_create_new failed", error);
    setStatus(message, true);
    alert(message);
    setResettingDrawVisual(false);
    render();
    return;
  }

  const row = firstRpcRow(data);
  const code = normalizeCode(state.lobby.lobby_code);
  sessionStorage.setItem(tokenKey(code), row.host_token);
  state.hostToken = row.host_token;
  state.lastRenderedNumber = null;
  state.lastRenderedDrawSignature = "";
  await loadLobbyState(code);
  setResettingDrawVisual(false);
  startHostLockRenewal();
}

function subscribeToLobby(drawId) {
  if (!supabaseClient || !state.lobby || !drawId) return;
  if (state.channel && state.subscribedDrawId === drawId) return;
  if (state.channel) supabaseClient.removeChannel(state.channel);
  state.subscribedDrawId = drawId;

  const reload = (options = {}) => loadLobbyState(state.lobby.lobby_code, options).catch((error) => setStatus(error.message, true));

  state.channel = supabaseClient
    .channel(`bingo-lobby-${state.lobby.id}-${drawId}`)
    .on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "draw_events",
      filter: `draw_id=eq.${drawId}`,
    }, () => reload())
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "draws",
      filter: `lobby_id=eq.${state.lobby.id}`,
    }, (payload) => {
      const next = payload?.new || {};
      const previous = payload?.old || {};
      const meaningful = payload.eventType === "INSERT"
        || next.id !== previous.id
        || next.status !== previous.status
        || next.current_count !== previous.current_count
        || next.last_number !== previous.last_number;
      if (meaningful) reload();
    })
    .on("postgres_changes", {
      event: "UPDATE",
      schema: "public",
      table: "lobbies",
      filter: `id=eq.${state.lobby.id}`,
    }, (payload) => {
      const next = payload?.new || {};
      const previous = payload?.old || {};
      if (!payload?.new || next.active_draw_id !== state.draw?.id || next.name !== previous.name) reload();
    })
    .subscribe((status) => {
      if (status === "SUBSCRIBED") setStatus(state.mode === "host" ? `Sala activa ${state.lobby.lobby_code}` : "Espectador. Esperando nuevo número…");
    });
}

function startHostLockRenewal() {
  if (state.lockTimer) window.clearInterval(state.lockTimer);
  if (state.mode !== "host" || !state.hostToken || !state.draw) return;

  state.lockTimer = window.setInterval(async () => {
    if (!state.draw || !state.hostToken) return;
    const { error } = await supabaseClient.rpc("renew_host_lock", {
      p_draw_id: state.draw.id,
      p_host_token: state.hostToken,
    });
    if (error) {
      window.clearInterval(state.lockTimer);
      state.lockTimer = null;
      state.hostToken = null;
      setMode("viewer");
      setStatus("Control del anfitrión perdido. Usa Tomar control.", true);
    }
  }, LOCK_RENEW_MS);
}

async function copyResults() {
  const text = state.drawn
    .slice()
    .reverse()
    .map((item, index) => `${index + 1}. ${item.result}`)
    .join("\n");

  if (!text) return;

  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
  } else {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  els.copyButton.textContent = "Copiado";
  window.setTimeout(() => {
    els.copyButton.textContent = "Copiar";
  }, 1200);
}

function resizeConfettiCanvas() {
  const ratio = window.devicePixelRatio || 1;
  els.confetti.width = window.innerWidth * ratio;
  els.confetti.height = window.innerHeight * ratio;
  els.confetti.style.width = `${window.innerWidth}px`;
  els.confetti.style.height = `${window.innerHeight}px`;
  confetti.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function secureRandomInt(maxExclusive) {
  if (maxExclusive <= 0) return 0;
  const limit = Math.floor(0xffffffff / maxExclusive) * maxExclusive;
  const buffer = new Uint32Array(1);

  do {
    crypto.getRandomValues(buffer);
  } while (buffer[0] >= limit);

  return buffer[0] % maxExclusive;
}

function burstConfetti(accentColor) {
  const colors = [accentColor, "#ffffff", "#1f7cff", "#ff5a1f", "#00a884", "#ffb000"];
  const originX = window.innerWidth / 2;
  const originY = window.innerHeight * 0.36;

  for (let i = 0; i < 115; i += 1) {
    confetti.pieces.push({
      x: originX + secureRandomInt(180) - 90,
      y: originY + secureRandomInt(70) - 35,
      size: 5 + secureRandomInt(8),
      color: colors[secureRandomInt(colors.length)],
      speedX: (secureRandomInt(1200) - 600) / 100,
      speedY: -(secureRandomInt(800) + 350) / 100,
      gravity: 0.16 + secureRandomInt(12) / 100,
      rotation: secureRandomInt(360),
      rotationSpeed: (secureRandomInt(120) - 60) / 10,
      life: 80 + secureRandomInt(50),
    });
  }

  if (!confetti.animationId) animateConfetti();
}

function animateConfetti() {
  const ctx = confetti.ctx;
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  confetti.pieces = confetti.pieces.filter((piece) => {
    piece.x += piece.speedX;
    piece.y += piece.speedY;
    piece.speedY += piece.gravity;
    piece.rotation += piece.rotationSpeed;
    piece.life -= 1;

    ctx.save();
    ctx.translate(piece.x, piece.y);
    ctx.rotate((piece.rotation * Math.PI) / 180);
    ctx.globalAlpha = Math.max(piece.life / 90, 0);
    ctx.fillStyle = piece.color;
    ctx.fillRect(-piece.size / 2, -piece.size / 2, piece.size, piece.size * 0.58);
    ctx.restore();

    return piece.life > 0 && piece.y < window.innerHeight + 40;
  });

  if (confetti.pieces.length) {
    confetti.animationId = requestAnimationFrame(animateConfetti);
  } else {
    confetti.animationId = null;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }
}

function applyHeroScale() {
  const raw = Number(els.resultHero?.dataset.heroScale || 1);
  const scale = Number.isFinite(raw) && raw > 0 ? raw : 1;
  if (!els.resultHero) return;
  const vars = {
    "--hero-scale": scale,
    "--hero-gap": `${10 * scale}px`,
    "--hero-vh-height": `${38 * scale}vh`,
    "--hero-max-height": `${380 * scale}px`,
    "--hero-ball-min": `${170 * scale}px`,
    "--hero-ball-fluid": `${19 * scale}vw`,
    "--hero-ball-max": `${230 * scale}px`,
    "--hero-ball-border": `${12 * scale}px`,
    "--hero-letter-min": `${1.45 * scale}rem`,
    "--hero-letter-fluid": `${2.4 * scale}vw`,
    "--hero-letter-max": `${2.15 * scale}rem`,
    "--hero-number-padding": `${26 * scale}px`,
    "--hero-number-min": `${4.1 * scale}rem`,
    "--hero-number-fluid": `${7 * scale}vw`,
    "--hero-number-max": `${6.45 * scale}rem`,
    "--hero-copy-min": `${1.65 * scale}rem`,
    "--hero-copy-fluid": `${3 * scale}vw`,
    "--hero-copy-max": `${2.8 * scale}rem`,
  };
  for (const [name, value] of Object.entries(vars)) {
    els.resultHero.style.setProperty(name, String(value));
  }
}

let hoverSettleTimer = null;

function randomizeBallHover() {
  if (state.drawAnimating) return;
  if (hoverSettleTimer) {
    window.clearTimeout(hoverSettleTimer);
    hoverSettleTimer = null;
  }
  const rotation = 9.5 + secureRandomInt(451) / 100;
  const rebound = 0.25 + secureRandomInt(86) / 100;
  els.ball.style.setProperty("--hover-rotation", `${rotation}deg`);
  els.ball.style.setProperty("--hover-rebound", `${rebound}deg`);
  els.ball.classList.remove("hover-kick", "hover-exit");
  void els.ball.offsetWidth;
  els.ball.classList.add("hover-kick");
}

function settleBallHover() {
  if (state.drawAnimating) return;
  if (hoverSettleTimer) window.clearTimeout(hoverSettleTimer);
  els.ball.classList.remove("hover-kick");
  els.ball.classList.add("hover-exit");
  hoverSettleTimer = window.setTimeout(() => {
    els.ball.classList.remove("hover-exit");
    hoverSettleTimer = null;
  }, 640);
}

els.createLobbyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await createLobby(els.lobbyNameInput.value, els.createHostCredentialInput?.value || "");
    if (els.createHostCredentialInput) els.createHostCredentialInput.value = "";
  } catch (error) {
    if (els.createHostCredentialInput) els.createHostCredentialInput.value = "";
    setStatus(error.message, true);
  }
});

els.joinLobbyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await joinLobby(els.joinCodeInput.value);
  } catch (error) {
    setStatus(error.message, true);
  }
});

if (els.claimHostForm) {
  els.claimHostForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.lobby) return;
    try {
      await claimHost(state.lobby.lobby_code, els.claimHostCredentialInput?.value || "");
      if (els.claimHostCredentialInput) els.claimHostCredentialInput.value = "";
    } catch (error) {
      if (els.claimHostCredentialInput) els.claimHostCredentialInput.value = "";
      setStatus(error.message, true);
    }
  });
}

if (els.renameLobbyForm) {
  els.renameLobbyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.lobby || state.mode !== "host") return;
    try {
      await updateLobbyName(els.lobbyNameEditInput.value);
    } catch (error) {
      setStatus(friendlyErrorMessage(error, "No se pudo cambiar el nombre de la sala."), true);
    }
  });
}

if (els.drawButton) els.drawButton.addEventListener("click", drawNextNumber);
els.ball.addEventListener("mouseenter", randomizeBallHover);
els.ball.addEventListener("mouseleave", settleBallHover);
els.ball.addEventListener("click", drawFromBall);
els.ball.addEventListener("keydown", drawFromBall);
els.resetButton.addEventListener("click", closeAndStartNewDraw);
els.sessionPanel.addEventListener("click", returnToLobbySelector);
els.copyButton.addEventListener("click", copyResults);
document.addEventListener("click", closeDropdownsOnOutsideClick);
window.addEventListener("resize", resizeConfettiCanvas);

window.createLobby = createLobby;
window.joinLobby = joinLobby;
window.claimHost = claimHost;
window.updateLobbyName = updateLobbyName;
window.drawNextNumber = drawNextNumber;
window.closeAndStartNewDraw = closeAndStartNewDraw;
window.getLaunchedBallCount = getLaunchedBallCount;
window.loadLobbyState = loadLobbyState;
window.subscribeToLobby = subscribeToLobby;
window.renderFromCloudState = renderFromCloudState;
window.setMode = setMode;

applyHeroScale();
resizeConfettiCanvas();
setIdleBall("¡Presiona la bola para sortear!");
render();

if (!supabaseClient) {
  setStatus("Configura Supabase URL y anon key en supabaseConfig.js para activar salas en vivo.", true);
} else {
  setStatus("Listo: crea una sala o únete con un código.");
  const boot = readHashState();
  if (boot.lobby) {
    joinLobby(boot.lobby).then(() => {
      if (boot.mode === "host" && state.hostToken) startHostLockRenewal();
    }).catch((error) => setStatus(error.message, true));
  }
}
