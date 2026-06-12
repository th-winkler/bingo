const SEGMENTS = [
  { letter: "B", min: 1, max: 15, theme: "theme-b", color: "#1f7cff" },
  { letter: "I", min: 16, max: 30, theme: "theme-i", color: "#00a884" },
  { letter: "N", min: 31, max: 45, theme: "theme-n", color: "#ffb000" },
  { letter: "G", min: 46, max: 60, theme: "theme-g", color: "#ff5a1f" },
  { letter: "O", min: 61, max: 75, theme: "theme-o", color: "#8d55ff" },
];

const HOST_TOKEN_PREFIX = "bingo.hostToken.";
const LOCK_RENEW_MS = 30000;

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
  modePill: document.getElementById("modePill"),
  remainingCount: document.getElementById("remainingCount"),
  resetButton: document.getElementById("resetButton"),
  resultText: document.getElementById("resultText"),
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
  els.modePill.textContent = isHost ? "Anfitrión" : "Solo lectura";
  els.modePill.className = `mode-pill ${isHost ? "host" : "viewer"}`;
  els.claimHostForm.hidden = isHost;
  if (isHost && els.sessionPanel.open) els.sessionPanel.open = false;
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
  els.drawButton.disabled = !isConfigured || !isHost || !isActive || remaining <= 0;
  els.resetButton.disabled = !isConfigured || !isHost || !isActive;
  els.drawButton.textContent = remaining <= 0 ? "Todos los números ya fueron sorteados" : "Sacar número";
  els.resetButton.textContent = "Nuevo sorteo";
  els.resetButton.hidden = !isHost;

  renderRollingResults();
  renderHistory();
  renderSegmentBoard();
}

function renderRollingResults() {
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
  els.lobbyCodeLabel.textContent = state.lobby.lobby_code;
  els.lobbyNameLabel.textContent = state.lobby.name;

  const latest = state.drawn[0];
  const shouldAnimate = animateLatest || (latest && previousDrawId === state.draw.id && latest.eventIndex !== previousLatest);
  renderCurrentBall(Boolean(shouldAnimate && latest));

  if (state.draw.status === "closed") {
    setStatus("Sorteo cerrado. Esperando nuevo sorteo…");
  } else if (state.mode === "host" && state.hostToken) {
    setStatus(`Lobby activo ${state.lobby.lobby_code}. Comparte este código con los jugadores.`);
  } else {
    setStatus("Solo lectura. Esperando nuevo número…");
  }

  setMode(state.mode);
}

async function loadLobbyState(lobbyCode, options = {}) {
  requireSupabase();
  const code = normalizeCode(lobbyCode);
  const { data, error } = await supabaseClient.rpc("get_lobby_state", { p_lobby_code: code });
  if (error) throw error;
  renderFromCloudState(data, options);
  subscribeToLobby(state.draw.id);
  return data;
}

async function createLobby(name, hostPassword) {
  requireSupabase();
  setStatus("Creando lobby…");
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

async function drawNextNumber() {
  requireSupabase();
  if (!state.draw || !state.hostToken) return;
  els.drawButton.disabled = true;
  setStatus("Sacando número…");
  const { error } = await supabaseClient.rpc("draw_next_number", {
    p_draw_id: state.draw.id,
    p_host_token: state.hostToken,
  });
  if (error) {
    setStatus(error.message || "No se pudo sacar número", true);
    render();
    return;
  }
  await loadLobbyState(state.lobby.lobby_code, { animateLatest: true });
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
    setStatus(error.message || "No se pudo crear nuevo sorteo", true);
    render();
    return;
  }

  const row = firstRpcRow(data);
  const code = normalizeCode(state.lobby.lobby_code);
  sessionStorage.setItem(tokenKey(code), row.host_token);
  state.hostToken = row.host_token;
  state.lastRenderedNumber = null;
  await loadLobbyState(code);
  startHostLockRenewal();
}

function subscribeToLobby(drawId) {
  if (!supabaseClient || !state.lobby || !drawId) return;
  if (state.channel) supabaseClient.removeChannel(state.channel);

  state.channel = supabaseClient
    .channel(`bingo-lobby-${state.lobby.id}`)
    .on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "draw_events",
      filter: `draw_id=eq.${drawId}`,
    }, () => loadLobbyState(state.lobby.lobby_code).catch((error) => setStatus(error.message, true)))
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "draws",
      filter: `lobby_id=eq.${state.lobby.id}`,
    }, () => loadLobbyState(state.lobby.lobby_code).catch((error) => setStatus(error.message, true)))
    .on("postgres_changes", {
      event: "UPDATE",
      schema: "public",
      table: "lobbies",
      filter: `id=eq.${state.lobby.id}`,
    }, () => loadLobbyState(state.lobby.lobby_code).catch((error) => setStatus(error.message, true)))
    .subscribe((status) => {
      if (status === "SUBSCRIBED") setStatus(state.mode === "host" ? `Lobby activo ${state.lobby.lobby_code}` : "Solo lectura. Esperando nuevo número…");
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

els.drawButton.addEventListener("click", drawNextNumber);
els.resetButton.addEventListener("click", closeAndStartNewDraw);
els.copyButton.addEventListener("click", copyResults);
window.addEventListener("resize", resizeConfettiCanvas);

window.createLobby = createLobby;
window.joinLobby = joinLobby;
window.claimHost = claimHost;
window.drawNextNumber = drawNextNumber;
window.closeAndStartNewDraw = closeAndStartNewDraw;
window.loadLobbyState = loadLobbyState;
window.subscribeToLobby = subscribeToLobby;
window.renderFromCloudState = renderFromCloudState;
window.setMode = setMode;

resizeConfettiCanvas();
setIdleBall("Esperando nuevo número…");
render();

if (!supabaseClient) {
  setStatus("Configura Supabase URL y anon key en supabaseConfig.js para activar lobbies en vivo.", true);
} else {
  setStatus("Listo: crea un lobby o únete con un código.");
  const boot = readHashState();
  if (boot.lobby) {
    joinLobby(boot.lobby).then(() => {
      if (boot.mode === "host" && state.hostToken) startHostLockRenewal();
    }).catch((error) => setStatus(error.message, true));
  }
}
