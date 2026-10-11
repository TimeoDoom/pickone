// ==========================================================
// PickOne - Front connecté à l'API Express (JWT + PostgreSQL)
// ==========================================================

// Servi par Express (http://localhost:5001) -> même origine ; sinon URL absolue.
const IS_LOCAL_HOST = ["localhost", "127.0.0.1"].includes(location.hostname);
const API_URL =
  location.protocol.startsWith("http") && (!IS_LOCAL_HOST || location.port === "5001")
    ? "/api" // production (Vercel) ou front servi par Express
    : "http://localhost:5001/api"; // Live Server / fichier ouvert directement

const TOKEN_KEY = "pickone_token";

function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
function getToken() { return localStorage.getItem(TOKEN_KEY); }
function removeToken() { localStorage.removeItem(TOKEN_KEY); }

// Échappe le texte saisi par les utilisateurs avant de l'injecter dans le HTML
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// Appel API générique : ajoute le JWT, gère les erreurs et l'expiration de session
async function api(path, { method = "GET", body, auth = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth && getToken()) headers.Authorization = `Bearer ${getToken()}`;
  let response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error("Serveur injoignable. Le backend est-il lancé ?");
  }
  let data = {};
  try { data = await response.json(); } catch (e) { /* réponse vide */ }
  if (!response.ok) {
    if (response.status === 403 && data.code === "TERMS_REQUIRED") {
      appState.needsTerms = true;
      syncTermsModal();
    }
    if (response.status === 401 && auth) {
      endSession();
      throw new Error("Session expirée, veuillez vous reconnecter.");
    }
    throw new Error(data.error || `Erreur ${response.status}`);
  }
  return data;
}

// ==========================================================
// État
// ==========================================================
let appState = {
  isLoggedIn: false,
  currentUserId: null,
  currentUser: null,
  userBalance: 0,
  activeTab: "feed",
  activeFilter: "all",
  leaderboard: [],
  social: { friends: [], incoming: [], outgoing: [] },
  groups: [],
  feedAudience: "all",
  leaderboardScope: "global",
  openGroupId: null,
  needsTerms: false,
  bets: [],
  selectedBetForBetting: null,
  selectedOptionForBetting: null,
};

// L'API renvoie { username, balance } ; le rendu utilise { name, coins }
function toViewUser(u) {
  return {
    id: String(u.id),
    name: u.username,
    email: u.email,
    avatar: u.avatar,
    coins: u.balance,
    wins: u.wins,
    bets: u.bets,
    canRecharge: u.canRecharge,
    nextRechargeAt: u.nextRechargeAt,
  };
}

function applyUser(user) {
  appState.currentUser = toViewUser(user);
  appState.currentUserId = String(user.id);
  appState.userBalance = user.balance;
  appState.needsTerms = !!user.needsTerms;
}

function renderAll() {
  syncTermsModal();
  updateBalanceUI();
  if (appState.currentUser) updateUserProfileUI(appState.currentUser);
  renderFeed();
  renderMyBets();
  renderArbitrage();
  renderLeaderboard();
  renderHistory();
  updatePendingBadge();
  renderAudienceOptions();
  renderFriends();
  renderGroups();
  updateFriendsBadge();
  if (appState.openGroupId) renderGroupModal();
  if (appState.activeTab === "account") renderAccountStats();
  lucide.createIcons();
}

function leaderboardUrl() {
  const s = appState.leaderboardScope;
  if (s === "friends") return "/leaderboard?scope=friends";
  if (s.startsWith("group:")) return `/leaderboard?scope=group&groupId=${s.slice(6)}`;
  return "/leaderboard";
}

// Recharge paris + amis + rooms + classement + profil depuis le serveur
async function refreshData() {
  if (!appState.isLoggedIn) return;
  try {
    const [events, social, groups, me] = await Promise.all([
      api("/events"),
      api("/friends"),
      api("/rooms"),
      api("/user/me"),
    ]);
    appState.bets = events;
    appState.social = social;
    appState.groups = groups;
    // une room supprimée / quittée ne peut plus servir de filtre
    const ids = groups.map((g) => g.id);
    if (appState.feedAudience !== "all" && appState.feedAudience !== "public" && !ids.includes(appState.feedAudience)) {
      appState.feedAudience = "all";
    }
    if (appState.leaderboardScope.startsWith("group:") && !ids.includes(appState.leaderboardScope.slice(6))) {
      appState.leaderboardScope = "global";
    }
    if (appState.openGroupId && !ids.includes(appState.openGroupId)) {
      appState.openGroupId = null;
      closeModal("modal-group");
    }
    const board = await api(leaderboardUrl());
    appState.leaderboard = board.map(toViewUser);
    applyUser(me);
    renderAll();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ==========================================================
// Session / authentification
// ==========================================================
async function initApp() {
  lucide.createIcons();
  if (!getToken()) return showAuthScreen();
  try {
    const me = await api("/user/me");
    appState.isLoggedIn = true;
    applyUser(me);
    showMainApp();
  } catch (err) {
    removeToken();
    showAuthScreen();
  }
}

function showAuthScreen() {
  document.getElementById("auth-screen").classList.remove("hidden");
  document.getElementById("main-app").classList.add("hidden");
}

function showMainApp() {
  document.getElementById("auth-screen").classList.add("hidden");
  document.getElementById("main-app").classList.remove("hidden");
  switchTab(appState.activeTab || "feed"); // déclenche aussi refreshData()
}

function endSession() {
  removeToken();
  appState.isLoggedIn = false;
  appState.currentUserId = null;
  appState.currentUser = null;
  appState.bets = [];
  appState.leaderboard = [];
  appState.social = { friends: [], incoming: [], outgoing: [] };
  appState.groups = [];
  appState.feedAudience = "all";
  appState.leaderboardScope = "global";
  appState.openGroupId = null;
  appState.needsTerms = false;
  showAuthScreen();
}

async function loginWith(identifier, password) {
  const data = await api("/auth/login", {
    method: "POST",
    auth: false,
    body: { identifier, password },
  });
  setToken(data.token);
  appState.isLoggedIn = true;
  applyUser(data.user);
  showMainApp();
  showToast(`Ravi de vous revoir, ${data.user.username} !`, "success");
}

async function handleLogin(e) {
  e.preventDefault();
  const identifier = document.getElementById("login-identifier").value.trim();
  const password = document.getElementById("login-password").value;
  try {
    await loginWith(identifier, password);
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const username = document.getElementById("reg-username").value.trim();
  const email = document.getElementById("reg-email").value.trim();
  const password = document.getElementById("reg-password").value;
  try {
    const data = await api("/auth/register", {
      method: "POST",
      auth: false,
      body: {
        username,
        email,
        password,
        isAdult: document.getElementById("reg-adult").checked,
        acceptTerms: document.getElementById("reg-terms").checked,
      },
    });
    setToken(data.token);
    appState.isLoggedIn = true;
    applyUser(data.user);
    showMainApp();
    confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
    showToast(`Bienvenue sur Pickone, ${username} ! +1000 PTS offerts`, "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

function confirmLogout() {
  closeModal("modal-logout");
  endSession();
  showToast("Session déconnectée. À bientôt !", "info");
}

async function confirmDeleteAccount() {
  try {
    await api("/user/me", { method: "DELETE" });
    closeModal("modal-delete-account");
    endSession();
    showToast("Compte supprimé.", "info");
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ==========================================================
// Actions métier (toutes passent par l'API)
// ==========================================================
async function handleCreateBet(e) {
  e.preventDefault();
  const optionInputs = document.querySelectorAll(".bet-option-input");
  const oddsInputs = document.querySelectorAll(".bet-odds-input");
  const options = [];
  optionInputs.forEach((input, i) => {
    const text = input.value.trim();
    if (text) options.push({ text, odds: parseFloat(oddsInputs[i].value) || 2.0 });
  });
  if (options.length < 2) {
    return showToast("Veuillez ajouter au moins 2 options au pari.", "error");
  }
  try {
    await api("/events", {
      method: "POST",
      body: {
        title: document.getElementById("bet-title").value.trim(),
        category: document.getElementById("bet-category").value,
        minBet: parseInt(document.getElementById("bet-min-amount").value, 10) || 50,
        durationHours: parseInt(document.getElementById("bet-duration").value, 10) || 24,
        groupId: document.getElementById("bet-audience").value || null,
        options,
      },
    });
    closeModal("modal-create");
    document.getElementById("form-create-bet").reset();
    await refreshData();
    showToast("Nouveau pari publié avec succès !", "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function confirmPlaceBet() {
  const amount = parseInt(document.getElementById("place-bet-amount").value, 10);
  const bet = appState.selectedBetForBetting;
  const opt = appState.selectedOptionForBetting;
  if (!bet || !opt) return;
  if (isNaN(amount) || amount < bet.minBet) {
    return showToast(`La mise minimale est de ${bet.minBet} PTS`, "error");
  }
  if (amount > appState.userBalance) {
    return showToast("Solde de crédits insuffisant !", "error");
  }
  try {
    await api(`/events/${bet.id}/wagers`, {
      method: "POST",
      body: { optionId: opt.id, amount },
    });
    closeModal("modal-place-bet");
    await refreshData();
    showToast(`Pari de ${amount} PTS enregistré sur "${opt.text}" !`, "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function resolveBet(betId, winningOptionId) {
  try {
    const data = await api(`/events/${betId}/resolve`, {
      method: "POST",
      body: { winningOptionId },
    });
    await refreshData();
    const winOpt = data.event.options.find((o) => o.id === data.event.winningOptionId);
    if (data.myGain > 0) {
      confetti({ particleCount: 120, spread: 70, origin: { y: 0.6 } });
      showToast(`Bravo ! Vous avez remporté ${data.myGain} PTS sur ce pari !`, "success");
    } else {
      showToast(`Pari clôturé ! L'issue "${winOpt ? winOpt.text : ""}" a été validée.`, "info");
    }
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function addCredits() {
  try {
    const data = await api("/user/credits", { method: "POST" });
    closeModal("modal-recharge");
    await refreshData();
    showToast(`+${data.added} Crédits ajoutés à votre compte !`, "success");
  } catch (err) {
    showToast(err.message, "error");
    await refreshData();
    updateRechargeModal();
  }
}

// Affiche dans la popup si la recharge est possible ou non
function updateRechargeModal() {
  const u = appState.currentUser;
  const btn = document.getElementById("btn-recharge");
  const status = document.getElementById("recharge-status");
  if (!u || !btn || !status) return;
  btn.disabled = !u.canRecharge;
  if (u.canRecharge) {
    status.className = "text-xs text-emerald-400 font-semibold";
    status.innerText = "Recharge disponible !";
  } else if (u.nextRechargeAt) {
    const h = Math.ceil((u.nextRechargeAt - Date.now()) / 3600000);
    status.className = "text-xs text-amber-400 font-semibold";
    status.innerText = `Prochaine recharge possible dans environ ${h} h.`;
  } else {
    status.className = "text-xs text-amber-400 font-semibold";
    status.innerText = "Indisponible : votre solde est encore supérieur à 100 PTS.";
  }
}

async function claimDailyBonus() {
  try {
    const data = await api("/user/bonus", { method: "POST" });
    await refreshData();
    confetti({ particleCount: 80, spread: 60, origin: { y: 0.7 } });
    showToast(`+${data.added} PTS Bonus Récupérés !`, "success");
  } catch (err) {
    showToast(err.message, "info");
  }
}

async function renderAccountStats() {
  let s;
  try {
    s = await api("/user/stats");
  } catch (err) {
    showToast(err.message, "error");
    return;
  }
  const winRate = s.totalBets > 0 ? Math.round((s.wins / s.totalBets) * 100) : 0;
  const net = s.won - s.wagered;
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.innerText = v;
  };
  set("acc-total-bets", s.totalBets);
  set("acc-wins", s.wins);
  set("acc-win-rate", `${winRate}% de victoires`);
  set("acc-wagered", `${s.wagered.toLocaleString()} PTS`);
  set("acc-won", `${s.won.toLocaleString()} PTS`);
  set("acc-best-win", `${s.bestWin.toLocaleString()} PTS`);
  set("acc-created", s.created);
  const netEl = document.getElementById("acc-net-profit");
  if (netEl) {
    netEl.innerText = `${net >= 0 ? "+" : ""}${net.toLocaleString()} PTS net`;
    netEl.className = `text-[10px] font-bold ${net >= 0 ? "text-emerald-400" : "text-rose-400"}`;
  }
  renderAccountCharts(s);
}

// ---------- Graphiques de la page Compte (Chart.js) ----------
const accountCharts = {};

// Crée le graphique, ou met à jour celui qui existe déjà (renderAccountStats est rappelée souvent)
function upsertChart(id, config, hasData) {
  const canvas = document.getElementById(id);
  const empty = document.getElementById(`${id}-empty`);
  if (!canvas || typeof Chart === "undefined") return;
  canvas.classList.toggle("hidden", !hasData);
  if (empty) empty.classList.toggle("hidden", hasData);
  if (!hasData) {
    if (accountCharts[id]) { accountCharts[id].destroy(); delete accountCharts[id]; }
    return;
  }
  if (accountCharts[id]) {
    accountCharts[id].data = config.data;
    accountCharts[id].update();
  } else {
    accountCharts[id] = new Chart(canvas, config);
  }
}

function renderAccountCharts(s) {
  const c = s.charts;
  if (!c || typeof Chart === "undefined") return;

  Chart.defaults.color = "#9ca3af";
  Chart.defaults.font.family = "Inter, sans-serif";
  Chart.defaults.font.size = 11;
  const grid = { color: "rgba(255,255,255,0.06)" };
  const GREEN = "#34d399", RED = "#fb7185", AMBER = "#fbbf24", CORAL = "#f73863", GRAY = "#6b7280";
  const fmtDay = (d) => new Date(`${d}T12:00:00`).toLocaleDateString("fr-FR", { day: "2-digit", month: "short" });
  const baseOpts = { responsive: true, maintainAspectRatio: false };

  // 1) Profit net cumulé
  let cum = 0;
  const net = c.netByDay.map((d) => ({ x: fmtDay(d.day), y: (cum += d.net) }));
  const last = net.length ? net[net.length - 1].y : 0;
  upsertChart("chart-net", {
    type: "line",
    data: {
      labels: net.map((p) => p.x),
      datasets: [{
        data: net.map((p) => p.y),
        borderColor: last >= 0 ? GREEN : RED,
        backgroundColor: last >= 0 ? "rgba(52,211,153,0.12)" : "rgba(251,113,133,0.12)",
        fill: true, tension: 0.3, pointRadius: 3, borderWidth: 2,
      }],
    },
    options: {
      ...baseOpts,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (i) => `${i.parsed.y >= 0 ? "+" : ""}${i.parsed.y.toLocaleString()} PTS` } } },
      scales: { x: { grid: { display: false } }, y: { grid, ticks: { callback: (v) => v.toLocaleString() } } },
    },
  }, net.length > 0);

  // 2) Résultats (donut)
  const lost = s.totalBets - s.wins - c.pending;
  upsertChart("chart-outcomes", {
    type: "doughnut",
    data: {
      labels: ["Gagnées", "Perdues", "En cours"],
      datasets: [{ data: [s.wins, lost, c.pending], backgroundColor: [GREEN, RED, AMBER], borderColor: "#10111b", borderWidth: 3 }],
    },
    options: { ...baseOpts, cutout: "65%", plugins: { legend: { position: "bottom", labels: { usePointStyle: true, boxWidth: 8 } } } },
  }, s.totalBets > 0);

  // 3) Activité des 14 derniers jours (jours sans mise = 0)
  const byDay = Object.fromEntries(c.activity.map((a) => [a.day, a.wagered]));
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }
  upsertChart("chart-activity", {
    type: "bar",
    data: { labels: days.map(fmtDay), datasets: [{ data: days.map((d) => byDay[d] || 0), backgroundColor: CORAL, borderRadius: 6 }] },
    options: {
      ...baseOpts,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (i) => `${i.parsed.y.toLocaleString()} PTS` } } },
      scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 7 } }, y: { grid, beginAtZero: true } },
    },
  }, c.activity.length > 0);

  // 4) Victoires / défaites par catégorie
  upsertChart("chart-categories", {
    type: "bar",
    data: {
      labels: c.categories.map((x) => x.category),
      datasets: [
        { label: "Victoires", data: c.categories.map((x) => x.wins), backgroundColor: GREEN, borderRadius: 6 },
        { label: "Défaites", data: c.categories.map((x) => x.losses), backgroundColor: RED, borderRadius: 6 },
      ],
    },
    options: {
      ...baseOpts,
      plugins: { legend: { position: "bottom", labels: { usePointStyle: true, boxWidth: 8 } } },
      scales: { x: { grid: { display: false } }, y: { grid, beginAtZero: true, ticks: { precision: 0 } } },
    },
  }, c.categories.length > 0);
}

function renderLeaderboard() {
  const list = document.getElementById("leaderboard-list");
  if (!list) return;
  list.innerHTML = "";

  const sorted = [...appState.leaderboard].sort((a, b) => b.coins - a.coins);
  sorted.forEach((friend, idx) => {
    const rankBadge = idx === 0 ? "1er" : idx === 1 ? "2ème" : idx === 2 ? "3ème" : `#${idx + 1}`;
    const rankColor =
      idx === 0 ? "text-amber-400 font-extrabold"
      : idx === 1 ? "text-gray-300 font-bold"
      : idx === 2 ? "text-amber-600 font-bold"
      : "text-gray-500 font-medium";
    const isMe = friend.id === appState.currentUserId;
    list.insertAdjacentHTML("beforeend", `
      <div class="p-4 flex items-center justify-between ${isMe ? "bg-coral-500/10 border-l-4 border-coral-500" : "hover:bg-white/5"} transition-all">
        <div class="flex items-center gap-3.5">
          <span class="text-xs ${rankColor} w-8">${rankBadge}</span>
          <div class="w-10 h-10 rounded-2xl bg-gray-800 border border-white/10 flex items-center justify-center font-black text-xs text-gray-300">${esc(friend.avatar)}</div>
          <div>
            <h4 class="text-sm font-bold text-white flex items-center gap-1.5">
              ${esc(friend.name)}
              ${isMe ? '<span class="text-[9px] bg-coral-500/20 text-coral-300 font-black px-2 py-0.5 rounded-md">Vous</span>' : ""}
            </h4>
            <p class="text-xs text-gray-400">${friend.wins} victoire${friend.wins > 1 ? "s" : ""} • ${friend.bets} mise${friend.bets > 1 ? "s" : ""} au total</p>
          </div>
        </div>
        <div class="text-right">
          <div class="text-base font-black text-yellow-400">${friend.coins.toLocaleString()} PTS</div>
          <div class="text-[10px] text-gray-400 font-medium">Solde</div>
        </div>
      </div>`);
  });

  const me = appState.leaderboard.find((f) => f.id === appState.currentUserId);
  if (me) {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.innerText = v; };
    set("stat-total-bets", me.bets);
    set("stat-win-rate", `${me.bets > 0 ? Math.round((me.wins / me.bets) * 100) : 0}%`);
    set("stat-total-won", `${me.coins.toLocaleString()} PTS`);
  }
}

// ==========================================================
// Rendu (conservé de la version d'origine, avec échappement HTML)
// ==========================================================
function switchAuthTab(tab) {
  const loginBtn = document.getElementById("auth-tab-login");
  const regBtn = document.getElementById("auth-tab-register");
  const formLogin = document.getElementById("form-login");
  const formReg = document.getElementById("form-register");

  if (tab === "login") {
    loginBtn.className =
      "py-2 rounded-xl text-xs font-bold text-white bg-coral-500 transition-all";
    regBtn.className =
      "py-2 rounded-xl text-xs font-bold text-gray-400 hover:text-white transition-all";
    formLogin.classList.remove("hidden");
    formReg.classList.add("hidden");
  } else {
    regBtn.className =
      "py-2 rounded-xl text-xs font-bold text-white bg-coral-500 transition-all";
    loginBtn.className =
      "py-2 rounded-xl text-xs font-bold text-gray-400 hover:text-white transition-all";
    formReg.classList.remove("hidden");
    formLogin.classList.add("hidden");
  }
  lucide.createIcons();
}

function switchTab(tabName) {
  appState.activeTab = tabName;

  document
    .querySelectorAll(".tab-content")
    .forEach((el) => el.classList.add("hidden"));
  const activeTabEl = document.getElementById(`tab-${tabName}`);
  if (activeTabEl) activeTabEl.classList.remove("hidden");

  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.className =
      "nav-btn relative flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold text-gray-400 hover:text-white transition-all";
  });
  const activeNav = document.getElementById(`nav-${tabName}`);
  if (activeNav) {
    activeNav.className =
      "nav-btn relative flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold text-white bg-coral-500/15 border border-coral-500/40 transition-all";
  }

  document.querySelectorAll(".mob-btn").forEach((btn) => {
    btn.className =
      "mob-btn relative flex flex-col items-center py-1 px-2 rounded-xl text-xs font-medium text-gray-400";
  });
  const activeMob = document.getElementById(`mob-${tabName}`);
  if (activeMob) {
    activeMob.className =
      "mob-btn relative flex flex-col items-center py-1 px-2 rounded-xl text-xs font-medium text-coral-400";
  }

  if (tabName === "feed") renderFeed();
  else if (tabName === "mybets") renderMyBets();
  else if (tabName === "arbitrage") renderArbitrage();
  else if (tabName === "leaderboard") renderLeaderboard();
  else if (tabName === "friends") { renderFriends(); renderGroups(); }
  else if (tabName === "account") renderAccountStats();

  refreshData();
  lucide.createIcons();
}

function filterCategory(category) {
  appState.activeFilter = category;
  document.querySelectorAll(".cat-filter").forEach((btn) => {
    btn.className =
      "cat-filter flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold whitespace-nowrap bg-gray-900/80 text-gray-400 hover:text-white hover:bg-gray-800 transition-all";
  });

  const activeBtn = document.getElementById(`filter-${category}`);
  if (activeBtn) {
    activeBtn.className =
      "cat-filter flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold whitespace-nowrap bg-coral-500 text-white transition-all";
  }

  renderFeed();
}

function updateBalanceUI() {
  const balanceEl = document.getElementById("user-balance");
  if (balanceEl) balanceEl.innerText = appState.userBalance.toLocaleString();
}

function updatePendingBadge() {
  const currentUser = appState.leaderboard.find(
    (f) => f.id === appState.currentUserId,
  );
  const pendingCount = appState.bets.filter(
    (b) => b.creatorId === appState.currentUserId && b.status === "active",
  ).length;
  const badge = document.getElementById("pending-badge");
  const mobBadge = document.getElementById("mob-pending-badge");

  if (badge) {
    badge.innerText = pendingCount;
    badge.classList.toggle("hidden", pendingCount === 0);
  }
  if (mobBadge) {
    mobBadge.innerText = pendingCount;
    mobBadge.classList.toggle("hidden", pendingCount === 0);
  }
}

function getTimeRemaining(expiresAt) {
  const diff = expiresAt - Date.now();
  if (diff <= 0) return "Expiré (À clôturer)";
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  return `Reste ${hours}h ${mins}m`;
}

function renderFeed() {
  const grid = document.getElementById("bets-grid");
  if (!grid) return;
  grid.innerHTML = "";

  const filteredBets = appState.bets.filter((bet) => {
    if (bet.status !== "active") return false;
    const aud = appState.feedAudience;
    if (aud === "public" && bet.groupId) return false;
    if (aud !== "all" && aud !== "public" && bet.groupId !== aud) return false;
    if (appState.activeFilter === "all") return true;
    return bet.category === appState.activeFilter;
  });

  if (filteredBets.length === 0) {
    grid.innerHTML = `
                    <div class="col-span-full text-center py-12 glass-card rounded-3xl border border-white/5 space-y-3">
                        <div class="w-12 h-12 rounded-2xl bg-white/5 text-gray-400 flex items-center justify-center mx-auto">
                            <i data-lucide="target" class="w-6 h-6"></i>
                        </div>
                        <h4 class="text-lg font-bold text-white">Aucun pari actif dans cette catégorie</h4>
                        <p class="text-xs text-gray-400">Soyez le premier à lancer un pari entre potes !</p>
                        <button onclick="openCreateModal()" class="bg-coral-500 text-white font-bold text-xs px-4 py-2.5 rounded-xl hover:bg-coral-400 transition-all inline-flex items-center gap-2">
                            <i data-lucide="plus" class="w-4 h-4"></i> Créer un Pari
                        </button>
                    </div>
                `;
    lucide.createIcons();
    return;
  }

  filteredBets.forEach((bet) => {
    const totalPot = bet.options.reduce((sum, opt) => sum + opt.totalAmount, 0);
    let totalBetters = new Set();
    bet.options.forEach((opt) =>
      opt.bets.forEach((b) => totalBetters.add(b.userId)),
    );

    let optionsHTML = bet.options
      .map((opt) => {
        const percentage =
          totalPot > 0 ? Math.round((opt.totalAmount / totalPot) * 100) : 50;
        return `
                        <div class="group relative overflow-hidden bg-gray-900/70 border border-white/5 hover:border-white/25 p-3 rounded-2xl transition-all cursor-pointer" onclick="openPlaceBetModal('${bet.id}', '${opt.id}')">
                            <div class="absolute left-0 top-0 bottom-0 bg-coral-500/15 transition-all duration-500" style="width: ${percentage}%"></div>
                            <div class="relative z-10 flex items-center justify-between">
                                <div class="flex items-center gap-2">
                                    <span class="text-sm font-semibold text-white hover:text-white transition-colors">${esc(opt.text)}</span>
                                </div>
                                <div class="flex items-center gap-2">
                                    <span class="text-xs text-gray-400 font-medium">${percentage}%</span>
                                    <span class="text-xs font-black text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2.5 py-1 rounded-xl">
                                        x${opt.odds.toFixed(2)}
                                    </span>
                                </div>
                            </div>
                        </div>
                    `;
      })
      .join("");

    const cardHTML = `
                    <div class="glass-card rounded-3xl p-6 flex flex-col justify-between space-y-5 border border-white/5 hover:border-white/25 transition-all hover:shadow-2xl hover:shadow-black/40">
                        <div class="space-y-3">
                            <div class="flex items-center justify-between">
                                <div class="flex items-center gap-1.5 min-w-0">
                                    <span class="text-[10px] uppercase font-extrabold tracking-widest text-gray-300 bg-white/5 border border-white/10 px-3 py-1 rounded-full">
                                        ${esc(bet.category)}
                                    </span>
                                    ${bet.groupName ? `<span class="text-[10px] font-bold text-coral-300 bg-coral-500/10 border border-coral-500/20 px-2 py-1 rounded-full flex items-center gap-1 truncate max-w-[110px]"><i data-lucide="lock" class="w-3 h-3 shrink-0"></i><span class="truncate">${esc(bet.groupName)}</span></span>` : ""}
                                </div>
                                <div class="flex items-center gap-1.5 text-xs text-gray-400">
                                    <i data-lucide="clock" class="w-3.5 h-3.5 text-gray-400"></i>
                                    <span>${getTimeRemaining(bet.expiresAt)}</span>
                                </div>
                            </div>

                            <h3 class="text-base font-bold text-white leading-snug hover:text-white transition-colors">
                                ${esc(bet.title)}
                            </h3>

                            <div class="flex items-center gap-2 text-xs text-gray-400 pt-1">
                                <span class="flex items-center gap-1.5">
                                    <span class="w-5 h-5 rounded-md bg-white/10 text-gray-200 font-black text-[9px] flex items-center justify-center">${esc(bet.creatorAvatar)}</span>
                                    <strong class="text-white">${esc(bet.creator)}</strong>
                                </span>
                                <span>•</span>
                                <span>Mise min: <strong class="text-yellow-400">${bet.minBet} PTS</strong></span>
                            </div>
                        </div>

                        <div class="space-y-2">
                            ${optionsHTML}
                        </div>

                        <div class="flex items-center justify-between pt-3 border-t border-white/5 text-xs text-gray-400">
                            <div class="flex items-center gap-1.5">
                                <i data-lucide="users" class="w-4 h-4 text-gray-300"></i>
                                <span>${totalBetters.size} parieur(s)</span>
                            </div>
                            <div class="flex items-center gap-1.5 font-bold text-white">
                                <span>Pot global :</span>
                                <span class="text-yellow-400 font-extrabold">${totalPot} PTS</span>
                            </div>
                        </div>
                    </div>
                `;
    grid.insertAdjacentHTML("beforeend", cardHTML);
  });

  lucide.createIcons();
}

function renderMyBets() {
  const grid = document.getElementById("my-bets-grid");
  if (!grid) return;
  grid.innerHTML = "";

  const currentUser = appState.leaderboard.find(
    (f) => f.id === appState.currentUserId,
  );

  const myBets = appState.bets.filter((bet) => {
    const userPlaced = bet.options.some((opt) =>
      opt.bets.some((b) => b.userId === appState.currentUserId),
    );
    const userCreated = bet.creatorId === appState.currentUserId;
    return userPlaced || userCreated;
  });

  if (myBets.length === 0) {
    grid.innerHTML = `
                    <div class="col-span-full text-center py-12 glass-card rounded-3xl border border-white/5 space-y-2">
                        <div class="w-12 h-12 rounded-2xl bg-white/5 text-gray-400 flex items-center justify-center mx-auto mb-2">
                            <i data-lucide="ticket" class="w-6 h-6"></i>
                        </div>
                        <h4 class="text-lg font-bold text-white">Vous n'avez aucun pari engagé</h4>
                        <p class="text-xs text-gray-400">Explorez les paris actifs ou créez-en un nouveau !</p>
                    </div>
                `;
    lucide.createIcons();
    return;
  }

  myBets.forEach((bet) => {
    let userSelectedOptions = [];
    let totalUserBet = 0;

    bet.options.forEach((opt) => {
      const userBet = opt.bets.find((b) => b.userId === appState.currentUserId);
      if (userBet) {
        userSelectedOptions.push({
          optionText: opt.text,
          amount: userBet.amount,
          odds: opt.odds,
        });
        totalUserBet += userBet.amount;
      }
    });

    const myBetDetails = userSelectedOptions
      .map(
        (o) =>
          `<div class="text-xs text-emerald-400 font-bold bg-emerald-500/10 px-2.5 py-1 rounded-lg border border-emerald-500/20 mt-1">
                        Misé: ${o.amount} PTS sur "${esc(o.optionText)}" (Cote x${o.odds})
                    </div>`,
      )
      .join("");

    const isCreator = bet.creatorId === appState.currentUserId;

    const cardHTML = `
                    <div class="glass-card rounded-3xl p-6 flex flex-col justify-between space-y-4 border border-white/5">
                        <div class="space-y-2">
                            <div class="flex items-center justify-between">
                                <span class="text-[10px] font-bold text-gray-300 bg-white/5 px-2.5 py-1 rounded-full">${esc(bet.category)}</span>
                                <span class="text-xs font-bold ${bet.status === "active" ? "text-emerald-400" : "text-gray-400"}">${bet.status === "active" ? "● En cours" : "✓ Terminé"}</span>
                            </div>
                            <h3 class="text-base font-bold text-white">${esc(bet.title)}</h3>
                            ${isCreator ? '<span class="text-[10px] text-amber-400 font-bold flex items-center gap-1"><i data-lucide="shield" class="w-3 h-3"></i> Vous êtes le créateur</span>' : ""}
                        </div>

                        <div>
                            ${myBetDetails || '<div class="text-xs text-gray-500 italic">Vous n\'avez pas encore misé sur ce pari.</div>'}
                        </div>

                        <div class="pt-3 border-t border-white/5 flex justify-between items-center text-xs text-gray-400">
                            <span>Mise totale perso: <strong class="text-white">${totalUserBet} PTS</strong></span>
                            ${
                              bet.status === "active" && isCreator
                                ? `
                                <button onclick="switchTab('arbitrage')" class="bg-amber-500/20 text-amber-300 font-bold px-3 py-1.5 rounded-xl hover:bg-amber-500/30 transition-all flex items-center gap-1.5">
                                    <i data-lucide="gavel" class="w-3.5 h-3.5"></i> Arbitrer
                                </button>
                            `
                                : ""
                            }
                        </div>
                    </div>
                `;
    grid.insertAdjacentHTML("beforeend", cardHTML);
  });
  lucide.createIcons();
}

function renderArbitrage() {
  const grid = document.getElementById("arbitrage-grid");
  if (!grid) return;
  grid.innerHTML = "";

  const currentUser = appState.leaderboard.find(
    (f) => f.id === appState.currentUserId,
  );

  const pendingBets = appState.bets.filter(
    (bet) => bet.creatorId === appState.currentUserId && bet.status === "active",
  );

  if (pendingBets.length === 0) {
    grid.innerHTML = `
                    <div class="col-span-full text-center py-12 glass-card rounded-3xl border border-white/5 space-y-2">
                        <div class="w-12 h-12 rounded-2xl bg-amber-500/10 text-amber-400 flex items-center justify-center mx-auto mb-2">
                            <i data-lucide="scale" class="w-6 h-6"></i>
                        </div>
                        <h4 class="text-lg font-bold text-white">Aucun pari en attente de validation</h4>
                        <p class="text-xs text-gray-400">Tous vos paris créés sont validés ou vous n'en avez pas encore créés.</p>
                    </div>
                `;
    lucide.createIcons();
    return;
  }

  pendingBets.forEach((bet) => {
    const optionsButtons = bet.options
      .map(
        (opt) => `
                    <button onclick="resolveBet('${bet.id}', '${opt.id}')" class="w-full text-left p-3 rounded-2xl bg-gray-900/80 hover:bg-emerald-500/20 border border-white/10 hover:border-emerald-500/50 transition-all flex items-center justify-between group">
                        <span class="text-sm font-bold text-white group-hover:text-emerald-300">${esc(opt.text)}</span>
                        <span class="text-xs font-bold text-emerald-400 bg-emerald-500/10 px-3 py-1 rounded-xl flex items-center gap-1">
                            <i data-lucide="award" class="w-3.5 h-3.5"></i> Désigner Gagnant
                        </span>
                    </button>
                `,
      )
      .join("");

    const cardHTML = `
                    <div class="glass-card rounded-3xl p-6 space-y-4 border border-amber-500/30">
                        <div>
                            <span class="text-[10px] font-bold text-amber-400 bg-amber-500/10 px-2.5 py-1 rounded-full border border-amber-500/20">Clôture Requise</span>
                            <h3 class="text-base font-bold text-white mt-2">${esc(bet.title)}</h3>
                        </div>

                        <p class="text-xs text-gray-400">Sélectionnez l'issue réelle de cet événement :</p>

                        <div class="space-y-2">
                            ${optionsButtons}
                        </div>
                    </div>
                `;
    grid.insertAdjacentHTML("beforeend", cardHTML);
  });
  lucide.createIcons();
}

function renderHistory() {
  const container = document.getElementById("closed-bets-history");
  if (!container) return;
  container.innerHTML = "";

  const closedBets = appState.bets.filter((b) => b.status === "closed");
  if (closedBets.length === 0) {
    container.innerHTML = `<p class="text-xs text-gray-500 italic">Aucun pari clôturé pour l'instant.</p>`;
    return;
  }

  closedBets.forEach((b) => {
    const winOpt = b.options.find((o) => o.id === b.winningOptionId);
    const itemHTML = `
                    <div class="bg-gray-900/60 p-3 rounded-2xl border border-white/5 space-y-1">
                        <div class="text-xs font-bold text-white">${esc(b.title)}</div>
                        <div class="text-[11px] text-emerald-400 flex items-center gap-1 font-semibold">
                            <i data-lucide="check-circle" class="w-3 h-3"></i> Vainqueur : ${winOpt ? esc(winOpt.text) : "N/A"}
                        </div>
                    </div>
                `;
    container.insertAdjacentHTML("beforeend", itemHTML);
  });
  lucide.createIcons();
}

function updateUserProfileUI(user) {
  const avatarBadge = document.getElementById("account-avatar-badge");
  const usernameDisplay = document.getElementById("account-username-display");
  const emailDisplay = document.getElementById("account-email-display");

  if (avatarBadge) avatarBadge.innerText = user.avatar;
  if (usernameDisplay) usernameDisplay.innerText = user.name;
  if (emailDisplay)
    emailDisplay.innerText = `${user.email || "membre@pickone.fr"} • Saison 1`;
}

function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove("hidden");
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add("hidden");
}

function openCreateModal(groupId) {
  renderAudienceOptions();
  const sel = document.getElementById("bet-audience");
  const wanted = groupId || (appState.groups.some((g) => g.id === appState.feedAudience) ? appState.feedAudience : "");
  if (sel) sel.value = wanted;
  openModal("modal-create");
}

async function openRechargeModal() {
  openModal("modal-recharge");
  await refreshData();
  updateRechargeModal();
}

function addOptionField() {
  const container = document.getElementById("options-container");
  if (!container) return;
  const count = container.children.length + 1;
  const row = document.createElement("div");
  row.className = "flex items-center gap-2";
  row.innerHTML = `
                <input type="text" required placeholder="Option ${count}" class="bet-option-input w-full bg-gray-900/80 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-coral-500">
                <input type="number" step="0.1" min="1.1" value="2.0" title="Cote" class="bet-odds-input w-24 bg-gray-900/80 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-amber-400 font-bold text-center focus:outline-none focus:border-amber-500" placeholder="Cote">
            `;
  container.appendChild(row);
}

function openPlaceBetModal(betId, optionId) {
  const bet = appState.bets.find((b) => b.id === betId);
  if (!bet) return;
  const opt = bet.options.find((o) => o.id === optionId);
  if (!opt) return;

  appState.selectedBetForBetting = bet;
  appState.selectedOptionForBetting = opt;

  document.getElementById("place-bet-cat").innerText = bet.category;
  document.getElementById("place-bet-title").innerText = bet.title;
  document.getElementById("place-bet-selected-option").innerText = opt.text;
  document.getElementById("place-bet-selected-odds").innerText =
    `Cote ${opt.odds.toFixed(2)}`;

  const amountInput = document.getElementById("place-bet-amount");
  amountInput.value = bet.minBet;

  calculatePotentialGain();
  openModal("modal-place-bet");
}

function calculatePotentialGain() {
  const amount =
    parseInt(document.getElementById("place-bet-amount").value) || 0;
  const odds = appState.selectedOptionForBetting
    ? appState.selectedOptionForBetting.odds
    : 1;
  const potential = Math.round(amount * odds);
  document.getElementById("place-bet-potential").innerText =
    `${potential.toLocaleString()} PTS`;
}

function setBetQuickAmount(extra) {
  const input = document.getElementById("place-bet-amount");
  input.value = (parseInt(input.value) || 0) + extra;
  calculatePotentialGain();
}

function setBetQuickMax() {
  const input = document.getElementById("place-bet-amount");
  input.value = appState.userBalance;
  calculatePotentialGain();
}

function showToast(message, type = "info") {
  const toast = document.getElementById("toast");
  const toastMsg = document.getElementById("toast-message");
  const toastWrapper = document.getElementById("toast-icon-wrapper");

  if (!toast || !toastMsg || !toastWrapper) return;

  toastMsg.innerText = message;

  if (type === "success") {
    toastWrapper.className =
      "w-8 h-8 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center";
    toastWrapper.innerHTML = `<i data-lucide="check-circle" class="w-4 h-4"></i>`;
  } else if (type === "error") {
    toastWrapper.className =
      "w-8 h-8 rounded-xl bg-rose-500/20 text-rose-400 flex items-center justify-center";
    toastWrapper.innerHTML = `<i data-lucide="alert-triangle" class="w-4 h-4"></i>`;
  } else {
    toastWrapper.className =
      "w-8 h-8 rounded-xl bg-white/10 text-gray-300 flex items-center justify-center";
    toastWrapper.innerHTML = `<i data-lucide="info" class="w-4 h-4"></i>`;
  }

  lucide.createIcons();

  toast.classList.remove("translate-y-20", "opacity-0");

  setTimeout(() => {
    toast.classList.add("translate-y-20", "opacity-0");
  }, 3500);
}

window.addEventListener("DOMContentLoaded", () => {
  initApp();
  showBetaNotice();
});

// ---------- Popup bêta : affichée une seule fois par navigateur ----------
const BETA_SEEN_KEY = "pickone_beta_seen";

function showBetaNotice() {
  let seen = false;
  try { seen = localStorage.getItem(BETA_SEEN_KEY) === "1"; } catch (e) { /* stockage bloqué */ }
  if (seen) return;
  openModal("modal-beta");
  if (typeof lucide !== "undefined") lucide.createIcons();
}

function closeBetaModal() {
  try { localStorage.setItem(BETA_SEEN_KEY, "1"); } catch (e) { /* stockage bloqué */ }
  closeModal("modal-beta");
}

// ==========================================================
// Amis & rooms
// ==========================================================
function avatarBubble(avatar, size = "w-9 h-9", text = "text-xs") {
  return `<div class="${size} rounded-xl bg-gray-800 border border-white/10 flex items-center justify-center font-black ${text} text-gray-200 shrink-0">${esc(avatar)}</div>`;
}

function updateFriendsBadge() {
  const n = appState.social.incoming.length;
  ["friends-badge", "mob-friends-badge"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerText = n;
    el.classList.toggle("hidden", n === 0);
  });
}

// Remplit les listes déroulantes qui dépendent des rooms
function renderAudienceOptions() {
  const groups = appState.groups;

  const feed = document.getElementById("feed-audience");
  if (feed) {
    feed.innerHTML =
      '<option value="all">Tous les paris</option><option value="public">Public uniquement</option>' +
      groups.map((g) => `<option value="${esc(g.id)}">🔒 ${esc(g.name)}</option>`).join("");
    feed.value = appState.feedAudience;
  }

  const bet = document.getElementById("bet-audience");
  if (bet) {
    const prev = bet.value;
    bet.innerHTML =
      '<option value="">Tous les joueurs (public)</option>' +
      groups.map((g) => `<option value="${esc(g.id)}">🔒 Room : ${esc(g.name)}</option>`).join("");
    bet.value = groups.some((g) => g.id === prev) ? prev : "";
  }

  const lb = document.getElementById("lb-scope");
  if (lb) {
    lb.innerHTML =
      '<option value="global">Tous les joueurs</option><option value="friends">Mes amis</option>' +
      groups.map((g) => `<option value="group:${esc(g.id)}">🔒 ${esc(g.name)}</option>`).join("");
    lb.value = appState.leaderboardScope;
  }
}

function setFeedAudience(value) {
  appState.feedAudience = value;
  renderFeed();
  lucide.createIcons();
}

function setLeaderboardScope(value) {
  appState.leaderboardScope = value;
  refreshData();
}

function renderFriends() {
  const { friends, incoming, outgoing } = appState.social;
  const empty = (msg) => `<p class="text-xs text-gray-500 italic">${msg}</p>`;

  const inc = document.getElementById("friend-incoming");
  if (inc) {
    inc.innerHTML = incoming.length
      ? incoming.map((u) => `
        <div class="flex items-center justify-between gap-3 bg-gray-900/60 border border-white/5 rounded-2xl p-3">
          <div class="flex items-center gap-3 min-w-0">
            ${avatarBubble(u.avatar)}
            <span class="text-sm font-bold text-white truncate">${esc(u.username)}</span>
          </div>
          <div class="flex gap-2 shrink-0">
            <button onclick="acceptFriend('${esc(u.requestId)}')" class="bg-coral-500 hover:bg-coral-400 text-white text-xs font-bold px-3 py-1.5 rounded-lg transition-all">Accepter</button>
            <button onclick="cancelFriendRequest('${esc(u.requestId)}')" class="text-xs font-bold text-gray-300 bg-white/5 hover:bg-white/10 border border-white/10 px-3 py-1.5 rounded-lg transition-all">Refuser</button>
          </div>
        </div>`).join("")
      : empty("Aucune demande en attente.");
  }

  const list = document.getElementById("friend-list");
  if (list) {
    list.innerHTML = friends.length
      ? friends.map((u) => `
        <div class="flex items-center justify-between gap-3 bg-gray-900/60 border border-white/5 rounded-2xl p-3">
          <div class="flex items-center gap-3 min-w-0">
            ${avatarBubble(u.avatar)}
            <span class="text-sm font-bold text-white truncate">${esc(u.username)}</span>
          </div>
          <button onclick="removeFriend('${esc(u.id)}', '${esc(u.username).replace(/'/g, "&#39;")}')" title="Retirer cet ami" class="text-gray-500 hover:text-rose-400 p-2 rounded-lg hover:bg-rose-500/10 transition-all">
            <i data-lucide="user-minus" class="w-4 h-4"></i>
          </button>
        </div>`).join("")
      : empty("Vous n'avez pas encore d'amis. Invitez-les avec leur pseudo !");
  }
  const count = document.getElementById("friend-count");
  if (count) count.innerText = friends.length ? `(${friends.length})` : "";

  const out = document.getElementById("friend-outgoing");
  if (out) {
    out.innerHTML = outgoing.length
      ? outgoing.map((u) => `
        <div class="flex items-center justify-between gap-3 bg-gray-900/60 border border-white/5 rounded-2xl p-3">
          <div class="flex items-center gap-3 min-w-0">
            ${avatarBubble(u.avatar)}
            <span class="text-sm font-semibold text-gray-300 truncate">${esc(u.username)}</span>
            <span class="text-[10px] text-gray-500 font-semibold">En attente</span>
          </div>
          <button onclick="cancelFriendRequest('${esc(u.requestId)}')" class="text-xs font-bold text-gray-400 hover:text-white px-2 py-1 rounded-lg hover:bg-white/5 transition-all">Annuler</button>
        </div>`).join("")
      : empty("Aucune demande envoyée.");
  }
  lucide.createIcons();
}

async function sendFriendRequest(e) {
  e.preventDefault();
  const input = document.getElementById("friend-username");
  try {
    const data = await api("/friends/requests", {
      method: "POST",
      body: { username: input.value.trim() },
    });
    input.value = "";
    await refreshData();
    showToast(data.message, "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function acceptFriend(requestId) {
  try {
    await api(`/friends/requests/${requestId}/accept`, { method: "POST" });
    await refreshData();
    showToast("Ami ajouté !", "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function cancelFriendRequest(requestId) {
  try {
    await api(`/friends/requests/${requestId}`, { method: "DELETE" });
    await refreshData();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function removeFriend(userId, username) {
  if (!confirm(`Retirer ${username} de vos amis ?`)) return;
  try {
    await api(`/friends/${userId}`, { method: "DELETE" });
    await refreshData();
    showToast(`${username} retiré de vos amis.`, "info");
  } catch (err) {
    showToast(err.message, "error");
  }
}

function renderGroups() {
  const list = document.getElementById("group-list");
  if (!list) return;
  if (appState.groups.length === 0) {
    list.innerHTML = `
      <div class="glass-card rounded-3xl p-8 text-center border border-white/5 space-y-2">
        <div class="w-12 h-12 rounded-2xl bg-white/5 text-gray-400 flex items-center justify-center mx-auto"><i data-lucide="shield" class="w-6 h-6"></i></div>
        <h4 class="text-base font-bold text-white">Aucune room pour l'instant</h4>
        <p class="text-xs text-gray-400">Créez une room ou rejoignez-en une avec un code pour parier en privé.</p>
      </div>`;
    lucide.createIcons();
    return;
  }
  list.innerHTML = appState.groups.map((g) => {
    const shown = g.members.slice(0, 5).map((m) => avatarBubble(m.avatar, "w-8 h-8", "text-[10px]")).join("");
    const more = g.members.length > 5 ? `<div class="w-8 h-8 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-[10px] font-bold text-gray-300">+${g.members.length - 5}</div>` : "";
    return `
      <div class="glass-card rounded-3xl p-5 space-y-4 border border-white/5">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h3 class="text-base font-bold text-white truncate flex items-center gap-2">
              <i data-lucide="lock" class="w-4 h-4 text-gray-400 shrink-0"></i>${esc(g.name)}
            </h3>
            <p class="text-xs text-gray-400 mt-0.5">
              ${g.members.length} membre${g.members.length > 1 ? "s" : ""} • ${g.activeEvents} pari${g.activeEvents > 1 ? "s" : ""} actif${g.activeEvents > 1 ? "s" : ""}${g.isOwner ? " • Vous êtes le créateur" : ""}
            </p>
          </div>
        </div>
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <div class="flex items-center gap-1.5 flex-wrap">${shown}${more}</div>
          <button onclick="copyRoomCode('${esc(g.id)}')" title="Copier le code" class="font-mono text-xs font-black tracking-[0.25em] text-gray-100 bg-white/5 hover:bg-white/10 border border-white/10 px-3 py-1.5 rounded-lg flex items-center gap-2 transition-all">
            ${esc(g.code || "")} <i data-lucide="copy" class="w-3.5 h-3.5 text-gray-400"></i>
          </button>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <button onclick="openCreateModal('${esc(g.id)}')" class="bg-coral-500 hover:bg-coral-400 text-white text-xs font-bold py-2.5 rounded-xl flex items-center justify-center gap-1.5 transition-all">
            <i data-lucide="plus" class="w-4 h-4"></i> Nouveau pari
          </button>
          <button onclick="openGroupModal('${esc(g.id)}')" class="text-xs font-bold text-gray-200 bg-gray-900/80 hover:bg-gray-800 border border-white/10 py-2.5 rounded-xl flex items-center justify-center gap-1.5 transition-all">
            <i data-lucide="settings" class="w-4 h-4"></i> Gérer
          </button>
        </div>
      </div>`;
  }).join("");
  lucide.createIcons();
}

function openCreateGroupModal() {
  document.getElementById("group-name").value = "";
  const picker = document.getElementById("group-friend-picker");
  const friends = appState.social.friends;
  picker.innerHTML = friends.length
    ? friends.map((u) => `
      <label class="flex items-center gap-3 bg-gray-900/60 border border-white/5 rounded-xl p-2.5 cursor-pointer hover:bg-gray-800/70 transition-all">
        <input type="checkbox" value="${esc(u.id)}" class="group-friend-check w-4 h-4 accent-[#f73863]" />
        ${avatarBubble(u.avatar, "w-8 h-8", "text-[10px]")}
        <span class="text-sm font-semibold text-white truncate">${esc(u.username)}</span>
      </label>`).join("")
    : '<p class="text-xs text-gray-500 italic">Vous n\'avez pas encore d\'amis : vous pourrez les ajouter à la room plus tard, ou partager son code.</p>';
  openModal("modal-create-group");
}

async function submitCreateGroup(e) {
  e.preventDefault();
  const memberIds = [...document.querySelectorAll(".group-friend-check:checked")].map((c) => c.value);
  try {
    const g = await api("/rooms", {
      method: "POST",
      body: { name: document.getElementById("group-name").value.trim(), memberIds },
    });
    closeModal("modal-create-group");
    await refreshData();
    showToast(`Room "${g.name}" créée ! Code : ${g.code}`, "success");
    openGroupModal(g.id);
  } catch (err) {
    showToast(err.message, "error");
  }
}

function openGroupModal(groupId) {
  appState.openGroupId = groupId;
  renderGroupModal();
  openModal("modal-group");
}

function closeGroupModal() {
  appState.openGroupId = null;
  closeModal("modal-group");
}

function renderGroupModal() {
  const g = appState.groups.find((x) => x.id === appState.openGroupId);
  if (!g) return;
  document.getElementById("group-modal-title").innerText = g.name;
  document.getElementById("group-modal-sub").innerText =
    `${g.members.length} membre${g.members.length > 1 ? "s" : ""} • ${g.activeEvents} pari${g.activeEvents > 1 ? "s" : ""} actif${g.activeEvents > 1 ? "s" : ""}`;

  document.getElementById("group-modal-members").innerHTML = g.members.map((m) => {
    const isOwnerRow = m.id === g.ownerId;
    const canRemove = g.isOwner && !isOwnerRow;
    return `
      <div class="flex items-center justify-between gap-3 bg-gray-900/60 border border-white/5 rounded-2xl p-2.5">
        <div class="flex items-center gap-3 min-w-0">
          ${avatarBubble(m.avatar, "w-8 h-8", "text-[10px]")}
          <span class="text-sm font-bold text-white truncate">${esc(m.username)}${m.id === appState.currentUserId ? ' <span class="text-[10px] text-gray-400 font-semibold">(vous)</span>' : ""}</span>
          ${isOwnerRow ? '<span class="text-[9px] font-black text-coral-300 bg-coral-500/15 px-2 py-0.5 rounded-md">Créateur</span>' : ""}
        </div>
        ${canRemove ? `<button onclick="removeGroupMember('${esc(m.id)}')" title="Retirer de la room" class="text-gray-500 hover:text-rose-400 p-2 rounded-lg hover:bg-rose-500/10 transition-all"><i data-lucide="user-minus" class="w-4 h-4"></i></button>` : ""}
      </div>`;
  }).join("");

  // amis pas encore dans la room
  const memberIds = g.members.map((m) => m.id);
  const candidates = appState.social.friends.filter((f) => !memberIds.includes(f.id));
  const addBox = document.getElementById("group-modal-add");
  const sel = document.getElementById("group-add-select");
  if (candidates.length) {
    sel.innerHTML = candidates.map((f) => `<option value="${esc(f.id)}">${esc(f.username)}</option>`).join("");
    addBox.classList.remove("hidden");
  } else {
    addBox.classList.add("hidden");
  }

  document.getElementById("group-modal-code").innerText = g.code || "";
  document.getElementById("group-regen-btn").classList.toggle("hidden", !g.isOwner);
  document.getElementById("group-leave-btn").innerText = g.isOwner ? "Supprimer la room" : "Quitter la room";
  lucide.createIcons();
}

async function addMemberToGroup() {
  const userId = document.getElementById("group-add-select").value;
  if (!userId || !appState.openGroupId) return;
  try {
    await api(`/rooms/${appState.openGroupId}/members`, { method: "POST", body: { userId } });
    await refreshData();
    showToast("Membre ajouté à la room.", "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function removeGroupMember(userId) {
  if (!confirm("Retirer ce membre de la room ?")) return;
  try {
    await api(`/rooms/${appState.openGroupId}/members/${userId}`, { method: "DELETE" });
    await refreshData();
    showToast("Membre retiré.", "info");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function leaveOrDeleteGroup() {
  const g = appState.groups.find((x) => x.id === appState.openGroupId);
  if (!g) return;
  const msg = g.isOwner
    ? `Supprimer la room "${g.name}" ? Ses paris terminés seront aussi supprimés.`
    : `Quitter la room "${g.name}" ?`;
  if (!confirm(msg)) return;
  try {
    if (g.isOwner) await api(`/rooms/${g.id}`, { method: "DELETE" });
    else await api(`/rooms/${g.id}/members/${appState.currentUserId}`, { method: "DELETE" });
    closeGroupModal();
    await refreshData();
    showToast(g.isOwner ? "Room supprimée." : "Vous avez quitté la room.", "info");
  } catch (err) {
    showToast(err.message, "error");
  }
}

function showGroupLeaderboard() {
  const id = appState.openGroupId;
  if (!id) return;
  appState.leaderboardScope = `group:${id}`;
  closeGroupModal();
  switchTab("leaderboard");
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    return false;
  }
}

async function copyRoomCode(roomId) {
  const g = appState.groups.find((x) => x.id === (roomId || appState.openGroupId));
  if (!g) return;
  const ok = await copyText(g.code);
  showToast(ok ? `Code ${g.code} copié !` : `Code de la room : ${g.code}`, ok ? "success" : "info");
}

async function joinRoom(e) {
  e.preventDefault();
  const input = document.getElementById("room-code");
  try {
    const room = await api("/rooms/join", { method: "POST", body: { code: input.value.trim() } });
    input.value = "";
    await refreshData();
    showToast(`Vous avez rejoint la room "${room.name}" !`, "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function regenerateRoomCode() {
  const g = appState.groups.find((x) => x.id === appState.openGroupId);
  if (!g) return;
  if (!confirm("Générer un nouveau code ? L'ancien code ne fonctionnera plus pour rejoindre la room.")) return;
  try {
    const data = await api(`/rooms/${g.id}/code`, { method: "POST" });
    await refreshData();
    showToast(`Nouveau code : ${data.code}`, "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ==========================================================
// Conformité : CGU, export des données (RGPD)
// ==========================================================
function syncTermsModal() {
  const modal = document.getElementById("modal-terms");
  if (!modal) return;
  const show = appState.isLoggedIn && appState.needsTerms;
  modal.classList.toggle("hidden", !show);
}

async function acceptTerms() {
  const adult = document.getElementById("terms-adult").checked;
  const accept = document.getElementById("terms-accept").checked;
  if (!adult || !accept) {
    return showToast("Cochez les deux cases pour continuer.", "error");
  }
  try {
    const me = await api("/user/accept-terms", {
      method: "POST",
      body: { isAdult: true, acceptTerms: true },
    });
    applyUser(me);
    syncTermsModal();
    await refreshData();
    showToast("Merci ! Conditions acceptées.", "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

// Droit d'accès / portabilité : télécharge toutes les données du compte en JSON
async function exportMyData() {
  try {
    const data = await api("/user/export");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "pickone-mes-donnees.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("Vos données ont été téléchargées.", "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

window.addEventListener("DOMContentLoaded", initApp);
