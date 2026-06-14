const SEGMENTS = [
  { letter: "B", min: 1, max: 15, theme: "theme-b", color: "#1f7cff" },
  { letter: "I", min: 16, max: 30, theme: "theme-i", color: "#00a884" },
  { letter: "N", min: 31, max: 45, theme: "theme-n", color: "#ffb000" },
  { letter: "G", min: 46, max: 60, theme: "theme-g", color: "#ff5a1f" },
  { letter: "O", min: 61, max: 75, theme: "theme-o", color: "#8d55ff" },
];

const HOST_TOKEN_PREFIX = "bingo.hostToken.";
const LOCK_RENEW_MS = 30000;
const DRAW_SUSPENSE_MS = 9200;
const DRAW_REVEAL_SETTLE_MS = 850;
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
  launchedBallAnimationId: null,
  flyingBalls: [],
};

const els = {
  ball: document.getElementById("currentBall"),
  ballLetter: document.querySelector(".ball-letter"),
  ballNumber: document.querySelector(".ball-number"),
  claimHostForm: document.getElementById("claimHostForm"),
  claimPasswordInput: document.getElementById("claimPasswordInput"),
  confetti: document.getElementById("confetti"),
  copyButton: document.getElementById("copyButton"),
  createLobbyForm: document.getElementById("createLobbyForm"),
  drawButton: document.getElementById("drawButton"),
  historyBody: document.getElementById("historyBody"),
  hostPasswordInput: document.getElementById("hostPasswordInput"),
  joinCodeInput: document.getElementById("joinCodeInput"),
  joinLobbyForm: document.getElementById("joinLobbyForm"),
  lobbyCodeLabel: document.getElementById("lobbyCodeLabel"),
  lobbyNameInput: document.getElementById("lobbyNameInput"),
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
  els.claimHostForm.hidden = isHost;
  els.resetButton.hidden = !isHost;
  els.lobbyNameLabel.textContent = isHost
    ? "Ya tienes control de anfitrión"
    : "Introduce la contraseña para tomar control";
  render();
}

function setIdleBall(message = "Esperando nuevo número…") {
  els.ball.className = "bingo-ball is-idle";
  els.ball.style.background = "var(--g)";
  els.ballLetter.textContent = "?";
  els.ballNumber.textContent = "--";
  els.resultText.textContent = message;
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

  els.ball.className = `bingo-ball ${animate ? "is-drawing" : ""} ${latest.segment.theme}`;
  els.ball.style.background = latest.segment.color;
  els.ballLetter.textContent = latest.segment.letter;
  els.ballNumber.textContent = latest.number;
  els.resultText.textContent = latest.result;
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

function renderFromCloudState(cloudState, { animateLatest = false } = {}) {
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
  els.appTitle.textContent = state.lobby.name || "Bingo Online 2026 - Rotary Club Rukapillán";

  const latest = state.drawn[0];
  const shouldAnimate = shouldAnimateLatestNumber(previousDrawId, previousLatest, latest, animateLatest);
  renderCurrentBall(Boolean(shouldAnimate));

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

async function createLobby(name, hostPassword) {
  requireSupabase();
  setStatus("Creando sala…");
  const { data, error } = await supabaseClient.rpc("create_lobby", {
    p_name: name,
    p_host_password: hostPassword,
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

async function claimHost(lobbyCode, hostPassword) {
  requireSupabase();
  setStatus("Tomando control…");
  const { data, error } = await supabaseClient.rpc("claim_host", {
    p_lobby_code: normalizeCode(lobbyCode),
    p_host_password: hostPassword,
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
  els.ball.className = `bingo-ball is-randomizing ${segment.theme}`;
  els.ball.style.background = segment.color;
  els.ballLetter.textContent = segment.letter;
  els.ballNumber.textContent = number;
  els.resultText.textContent = formatResult(number);
  els.segmentLabel.textContent = `Sorteando ${ordinalDrawLabel(state.drawn.length + 1)} número...`;
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
  const launchY = -5;
  const floorY = Math.max(bounds.height - mainSize * 0.18, mainSize * 0.75);
  const unitY = Math.max(24, (floorY - mainSize * 0.35) / 8.5);
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
    const apex = randomFloat(5, 8);
    const vy0 = Math.sqrt(2 * gravity * (apex - launchY));
    const duration = (2 * vy0) / gravity;
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
      delay: randomFloat(0.35, 1.9),
      speedBase: randomFloat(1.05, 1.1),
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
    ball.style.setProperty("--launched-blur", `${depth * 0.7}px`);
    ball.style.setProperty("--launched-shade", String(0.28 + depth * 0.28));
    ball.style.setProperty("--launched-edge-shade", String(0.46 + depth * 0.24));
    ball.style.setProperty("--launched-brightness", String(0.9 - depth * 0.12));
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
        const heightDrag = 0.42 + 3.15 * Math.pow(1 - heightRatio, 1.55);
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
    window.clearTimeout(state.drawCycleTimer);
    state.drawCycleTimer = null;
  }
  stopLaunchedBallAnimation();
}

function startNumberCycle(availableNumbers) {
  const startedAt = performance.now();
  let tick = 0;

  const cycle = () => {
    const elapsed = performance.now() - startedAt;
    const progress = Math.min(elapsed / DRAW_SUSPENSE_MS, 1);
    const number = chooseCycleNumber(availableNumbers);
    if (number) renderBallCandidate(number);

    if (progress >= 1 || !state.drawAnimating) {
      state.drawCycleTimer = null;
      return;
    }

    tick += 1;
    const interval = 150 + Math.pow(progress, 2.8) * 780 + Math.min(tick, 12) * 5;
    state.drawCycleTimer = window.setTimeout(cycle, interval);
  };

  cycle();
}

function beginDrawSuspense(completedDraws) {
  stopDrawCycle();
  state.drawAnimating = true;
  els.resultHero.classList.add("is-draw-active");
  els.ball.classList.add("is-randomizing");
  createLaunchedBallLayer(completedDraws);
  startNumberCycle(state.pool);
}

async function revealDrawResult({ finalNumber, finalEventIndex }) {
  stopDrawCycle();

  const segment = getSegment(finalNumber);
  if (segment) {
    els.ball.className = `bingo-ball is-revealing ${segment.theme}`;
    els.ball.style.background = segment.color;
    els.ballLetter.textContent = segment.letter;
    els.ballNumber.textContent = finalNumber;
    els.resultText.textContent = formatResult(finalNumber);
    els.segmentLabel.textContent = "Número confirmado";
    burstConfetti(segment.color);
  }

  await sleep(DRAW_REVEAL_SETTLE_MS);
  els.resultHero.classList.remove("is-draw-active");
  els.resultHero.querySelector(".launched-ball-layer")?.remove();
  state.drawAnimating = false;
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
    const [{ data, error }] = await Promise.all([
      rpcPromise,
      sleep(DRAW_SUSPENSE_MS),
    ]);
    if (error) throw error;

    const row = firstRpcRow(data);
    await revealDrawResult({
      finalNumber: Number(row.number),
      finalEventIndex: Number(row.event_index),
    });
    await loadLobbyState(state.lobby.lobby_code, { animateLatest: false, allowDuringDraw: true });
  } catch (error) {
    stopDrawCycle();
    state.drawAnimating = false;
    els.resultHero.classList.remove("is-draw-active");
    els.resultHero.querySelector(".launched-ball-layer")?.remove();
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
  state.launchedBallAnimationId = null;
  state.flyingBalls = [];

  history.replaceState(null, "", `${location.pathname}${location.search}`);
  els.sessionPanel.hidden = true;
  els.resetButton.hidden = true;
  els.lobbyOverlay.hidden = false;
  els.appTitle.textContent = "Bingo Online 2026 - Rotary Club Rukapillán";
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
      if (!payload?.new || payload.new.active_draw_id !== state.draw?.id) reload();
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

function randomizeBallHover() {
  if (state.drawAnimating) return;
  const rotation = 10 + secureRandomInt(501) / 100;
  const rebound = secureRandomInt(301) / 100;
  els.ball.style.setProperty("--hover-rotation", `${rotation}deg`);
  els.ball.style.setProperty("--hover-rebound", `${rebound}deg`);
  els.ball.classList.remove("hover-kick");
  void els.ball.offsetWidth;
  els.ball.classList.add("hover-kick");
}

els.createLobbyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await createLobby(els.lobbyNameInput.value, els.hostPasswordInput.value);
    els.hostPasswordInput.value = "";
  } catch (error) {
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

els.claimHostForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.lobby) return;
  try {
    await claimHost(state.lobby.lobby_code, els.claimPasswordInput.value);
    els.claimPasswordInput.value = "";
  } catch (error) {
    setStatus(error.message, true);
  }
});

if (els.drawButton) els.drawButton.addEventListener("click", drawNextNumber);
els.ball.addEventListener("mouseenter", randomizeBallHover);
els.ball.addEventListener("mouseleave", () => els.ball.classList.remove("hover-kick"));
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
