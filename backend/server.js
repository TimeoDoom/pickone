const path = require("path");
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
require("dotenv").config();
const db = require("./db");
const authenticateToken = require("./middleware/auth");
const fs = require("fs");

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET manquant dans le fichier .env");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

const CATEGORIES = ["Quotidien", "Gaming", "Défi", "Soirée", "Sport"];
// Recharge de dépannage : un seul pack, uniquement si le solde est presque épuisé,
// et au maximum une fois toutes les 24 h.
const RECHARGE_AMOUNT = 500;
const RECHARGE_MAX_BALANCE = 100; // le solde doit être strictement inférieur
const RECHARGE_COOLDOWN_HOURS = 24;
const DAILY_BONUS = 200;

// Version des CGU / politique de confidentialité : à changer dès qu'un de ces textes
// évolue de manière substantielle (les utilisateurs devront alors les accepter à nouveau).
// Doit correspondre à termsVersion dans frontend/legal/config.js
const TERMS_VERSION = "2026-10-09";

// ---------- Helpers ----------
const avatarOf = (username) => username.substring(0, 2).toUpperCase();

async function getUserWithStats(userId, client = db) {
  const r = await client.query(
    `SELECT u.id, u.username, u.email, u.balance, u.last_recharge_at, u.terms_version,
            COUNT(w.id)::int AS bets,
            (COUNT(w.id) FILTER (WHERE w.status = 'won'))::int AS wins
     FROM users u
     LEFT JOIN wagers w ON w.user_id = u.id
     WHERE u.id = $1
     GROUP BY u.id`,
    [userId],
  );
  if (r.rows.length === 0) return null;
  const user = formatUser(r.rows[0]);
  user.needsTerms = r.rows[0].terms_version !== TERMS_VERSION;
  return user;
}

function formatUser(row) {
  let nextRechargeAt = null;
  if (row.last_recharge_at) {
    const t = new Date(row.last_recharge_at).getTime() + RECHARGE_COOLDOWN_HOURS * 3600 * 1000;
    if (t > Date.now()) nextRechargeAt = t;
  }
  return {
    canRecharge: row.balance < RECHARGE_MAX_BALANCE && nextRechargeAt === null,
    nextRechargeAt,
    rechargeAmount: RECHARGE_AMOUNT,
    rechargeMaxBalance: RECHARGE_MAX_BALANCE,
    id: String(row.id),
    username: row.username,
    email: row.email,
    balance: row.balance,
    avatar: avatarOf(row.username),
    bets: row.bets ?? 0,
    wins: row.wins ?? 0,
  };
}

function signToken(user) {
  return jwt.sign(
    { id: Number(user.id), username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: "24h" },
  );
}

// Assemble les événements au format attendu par le front.
// Un pari de room n'est visible que par les membres de la room.
// extraWhere utilise les paramètres à partir de $2 ($1 = viewerId).
async function loadEvents(viewerId, extraWhere = "", params = [], client = db) {
  const eventsRes = await client.query(
    `SELECT e.*, u.username AS creator_name, g.name AS group_name
     FROM events e
     JOIN users u ON u.id = e.creator_id
     LEFT JOIN friend_groups g ON g.id = e.group_id
     WHERE (e.group_id IS NULL OR EXISTS (
             SELECT 1 FROM friend_group_members gm
             WHERE gm.group_id = e.group_id AND gm.user_id = $1))
       ${extraWhere ? "AND " + extraWhere : ""}
     ORDER BY e.created_at DESC`,
    [viewerId, ...params],
  );
  if (eventsRes.rows.length === 0) return [];
  const ids = eventsRes.rows.map((e) => e.id);

  const optsRes = await client.query(
    "SELECT * FROM event_options WHERE event_id = ANY($1) ORDER BY id",
    [ids],
  );
  const wagersRes = await client.query(
    "SELECT option_id, user_id, amount FROM wagers WHERE event_id = ANY($1) ORDER BY id",
    [ids],
  );

  const wagersByOption = {};
  wagersRes.rows.forEach((w) => {
    (wagersByOption[w.option_id] ||= []).push({
      userId: String(w.user_id),
      amount: w.amount,
    });
  });
  const optionsByEvent = {};
  optsRes.rows.forEach((o) => {
    const bets = wagersByOption[o.id] || [];
    (optionsByEvent[o.event_id] ||= []).push({
      id: String(o.id),
      text: o.text,
      odds: o.odds,
      totalAmount: bets.reduce((s, b) => s + b.amount, 0),
      bets,
    });
  });

  return eventsRes.rows.map((e) => ({
    id: String(e.id),
    title: e.title,
    category: e.category,
    creator: e.creator_name,
    creatorId: String(e.creator_id),
    creatorAvatar: avatarOf(e.creator_name),
    createdAt: new Date(e.created_at).getTime(),
    expiresAt: new Date(e.expires_at).getTime(),
    minBet: e.min_bet,
    status: e.status,
    groupId: e.group_id !== null ? String(e.group_id) : null,
    groupName: e.group_name || null,
    winningOptionId:
      e.winning_option_id !== null ? String(e.winning_option_id) : null,
    options: optionsByEvent[e.id] || [],
  }));
}

// Refuse les actions d'écriture tant que l'utilisateur n'a pas accepté la version courante des CGU
async function requireTerms(req, res, next) {
  try {
    const r = await db.query("SELECT terms_version FROM users WHERE id = $1", [req.user.id]);
    if (r.rows.length === 0) return res.status(401).json({ error: "Utilisateur introuvable." });
    if (r.rows[0].terms_version !== TERMS_VERSION) {
      return res.status(403).json({
        error: "Veuillez accepter les conditions d'utilisation à jour pour continuer.",
        code: "TERMS_REQUIRED",
      });
    }
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
}

// ---------- 1. Création de compte ----------
app.post("/api/auth/register", async (req, res) => {
  const username = (req.body.username || "").trim();
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";

  if (!username || !email || !password) {
    return res.status(400).json({ error: "Tous les champs sont requis." });
  }
  if (req.body.isAdult !== true) {
    return res.status(400).json({ error: "Pickone est réservé aux personnes de 18 ans et plus." });
  }
  if (req.body.acceptTerms !== true) {
    return res
      .status(400)
      .json({ error: "Vous devez accepter les CGU et la politique de confidentialité." });
  }
  if (username.length > 50) {
    return res.status(400).json({ error: "Pseudo trop long (50 max)." });
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: "Adresse e-mail invalide." });
  }
  if (password.length < 6) {
    return res
      .status(400)
      .json({ error: "Le mot de passe doit faire au moins 6 caractères." });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const created = await db.query(
      `INSERT INTO users (username, email, password_hash, terms_accepted_at, terms_version)
       VALUES ($1, $2, $3, NOW(), $4) RETURNING id, username, email, balance`,
      [username, email, hashedPassword, TERMS_VERSION],
    );
    const user = await getUserWithStats(created.rows[0].id);
    res.status(201).json({
      message: "Compte créé avec succès",
      token: signToken({ id: user.id, username: user.username }),
      user,
    });
  } catch (err) {
    if (err.code === "23505") {
      return res
        .status(400)
        .json({ error: "Nom d'utilisateur ou email déjà utilisé." });
    }
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// ---------- 2. Connexion (pseudo OU email) ----------
app.post("/api/auth/login", async (req, res) => {
  const identifier = (req.body.identifier || req.body.email || "").trim();
  const password = req.body.password || "";
  if (!identifier || !password) {
    return res.status(400).json({ error: "Identifiant et mot de passe requis." });
  }

  try {
    const r = await db.query(
      "SELECT id, username, password_hash FROM users WHERE lower(email) = lower($1) OR lower(username) = lower($1)",
      [identifier],
    );
    if (r.rows.length === 0) {
      return res.status(400).json({ error: "Identifiants invalides." });
    }
    const row = r.rows[0];
    const valid = await bcrypt.compare(password, row.password_hash);
    if (!valid) {
      return res.status(400).json({ error: "Identifiants invalides." });
    }
    const user = await getUserWithStats(row.id);
    res.json({ token: signToken({ id: user.id, username: user.username }), user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// ---------- 3. Profil, stats, bonus, crédits ----------
app.get("/api/user/me", authenticateToken, async (req, res) => {
  try {
    const user = await getUserWithStats(req.user.id);
    if (!user) return res.status(404).json({ error: "Utilisateur non trouvé." });
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// Acceptation (ou ré-acceptation) des CGU et confirmation de majorité
app.post("/api/user/accept-terms", authenticateToken, async (req, res) => {
  if (req.body.isAdult !== true)
    return res.status(400).json({ error: "Pickone est réservé aux personnes de 18 ans et plus." });
  if (req.body.acceptTerms !== true)
    return res.status(400).json({ error: "Vous devez accepter les CGU et la politique de confidentialité." });
  try {
    await db.query(
      "UPDATE users SET terms_accepted_at = NOW(), terms_version = $2 WHERE id = $1",
      [req.user.id, TERMS_VERSION],
    );
    res.json(await getUserWithStats(req.user.id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// Droit d'accès et à la portabilité (RGPD art. 15 et 20) : export de toutes les données du compte
app.get("/api/user/export", authenticateToken, async (req, res) => {
  try {
    const id = req.user.id;
    const [u, events, wagers, friends, rooms] = await Promise.all([
      db.query(
        `SELECT id, username, email, balance, created_at, last_bonus_date, last_recharge_at,
                terms_accepted_at, terms_version FROM users WHERE id = $1`,
        [id],
      ),
      db.query(
        `SELECT e.id, e.title, e.category, e.min_bet, e.status, e.created_at, e.expires_at,
                g.name AS room,
                (SELECT json_agg(json_build_object('text', o.text, 'odds', o.odds) ORDER BY o.id)
                   FROM event_options o WHERE o.event_id = e.id) AS options
         FROM events e LEFT JOIN friend_groups g ON g.id = e.group_id
         WHERE e.creator_id = $1 ORDER BY e.created_at`,
        [id],
      ),
      db.query(
        `SELECT e.title AS event, o.text AS option, w.amount, w.status, w.created_at
         FROM wagers w JOIN events e ON e.id = w.event_id JOIN event_options o ON o.id = w.option_id
         WHERE w.user_id = $1 ORDER BY w.created_at`,
        [id],
      ),
      db.query(
        `SELECT u.username, f.status, f.created_at,
                CASE WHEN f.requester_id = $1 THEN 'envoyée' ELSE 'reçue' END AS direction
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
         WHERE f.requester_id = $1 OR f.addressee_id = $1`,
        [id],
      ),
      db.query(
        `SELECT g.name, m.joined_at, (g.owner_id = $1) AS creator
         FROM friend_group_members m JOIN friend_groups g ON g.id = m.group_id
         WHERE m.user_id = $1 ORDER BY m.joined_at`,
        [id],
      ),
    ]);
    if (u.rows.length === 0) return res.status(404).json({ error: "Utilisateur non trouvé." });
    const a = u.rows[0];
    res.setHeader("Content-Disposition", 'attachment; filename="pickone-mes-donnees.json"');
    res.json({
      exportedAt: new Date().toISOString(),
      account: {
        username: a.username,
        email: a.email,
        balance: a.balance,
        createdAt: a.created_at,
        lastDailyBonusDate: a.last_bonus_date,
        lastRechargeAt: a.last_recharge_at,
        termsAcceptedAt: a.terms_accepted_at,
        termsVersion: a.terms_version,
      },
      betsCreated: events.rows,
      wagers: wagers.rows,
      friends: friends.rows,
      rooms: rooms.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

app.get("/api/user/stats", authenticateToken, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT
         COUNT(w.id)::int AS total_bets,
         (COUNT(w.id) FILTER (WHERE w.status = 'won'))::int AS wins,
         COALESCE(SUM(w.amount), 0)::int AS wagered,
         COALESCE(SUM(ROUND(w.amount * o.odds)) FILTER (WHERE w.status = 'won'), 0)::int AS won,
         COALESCE(MAX(ROUND(w.amount * o.odds)) FILTER (WHERE w.status = 'won'), 0)::int AS best_win
       FROM wagers w JOIN event_options o ON o.id = w.option_id
       WHERE w.user_id = $1`,
      [req.user.id],
    );
    const created = await db.query(
      "SELECT COUNT(*)::int AS n FROM events WHERE creator_id = $1",
      [req.user.id],
    );
    const s = r.rows[0];

    // ---- Données pour les graphiques du compte ----
    // Résultat net par jour (mises clôturées) : gain - mise si gagné, -mise si perdu.
    // Les paris clôturés avant l'ajout de resolved_at retombent sur leur date d'expiration.
    const [daily, cats, pending, activity] = await Promise.all([
      db.query(
        `SELECT to_char(COALESCE(e.resolved_at, e.expires_at), 'YYYY-MM-DD') AS day,
                (SUM(CASE WHEN w.status = 'won' THEN ROUND(w.amount * o.odds) - w.amount
                          ELSE -w.amount END))::int AS net
         FROM wagers w
         JOIN events e ON e.id = w.event_id
         JOIN event_options o ON o.id = w.option_id
         WHERE w.user_id = $1 AND w.status IN ('won', 'lost')
         GROUP BY 1 ORDER BY 1`,
        [req.user.id],
      ),
      db.query(
        `SELECT e.category,
                (COUNT(*) FILTER (WHERE w.status = 'won'))::int AS wins,
                (COUNT(*) FILTER (WHERE w.status = 'lost'))::int AS losses,
                COUNT(*)::int AS total
         FROM wagers w JOIN events e ON e.id = w.event_id
         WHERE w.user_id = $1
         GROUP BY e.category ORDER BY total DESC LIMIT 8`,
        [req.user.id],
      ),
      db.query(
        "SELECT COUNT(*)::int AS n FROM wagers WHERE user_id = $1 AND status = 'pending'",
        [req.user.id],
      ),
      db.query(
        `SELECT to_char(created_at, 'YYYY-MM-DD') AS day, SUM(amount)::int AS wagered
         FROM wagers
         WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '14 days'
         GROUP BY 1 ORDER BY 1`,
        [req.user.id],
      ),
    ]);

    res.json({
      totalBets: s.total_bets,
      wins: s.wins,
      wagered: s.wagered,
      won: s.won,
      bestWin: s.best_win,
      created: created.rows[0].n,
      charts: {
        netByDay: daily.rows,
        categories: cats.rows,
        pending: pending.rows[0].n,
        activity: activity.rows,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

app.post("/api/user/bonus", authenticateToken, requireTerms, async (req, res) => {
  try {
    const r = await db.query(
      `UPDATE users SET balance = balance + $2, last_bonus_date = CURRENT_DATE
       WHERE id = $1 AND (last_bonus_date IS NULL OR last_bonus_date < CURRENT_DATE)
       RETURNING balance`,
      [req.user.id, DAILY_BONUS],
    );
    if (r.rows.length === 0) {
      return res
        .status(409)
        .json({ error: "Bonus quotidien déjà récupéré aujourd'hui." });
    }
    res.json({ added: DAILY_BONUS, newBalance: r.rows[0].balance });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

app.post("/api/user/credits", authenticateToken, requireTerms, async (req, res) => {
  try {
    // Condition vérifiée dans la requête elle-même : impossible de la contourner
    // avec des appels simultanés.
    const r = await db.query(
      `UPDATE users
       SET balance = balance + $2, last_recharge_at = NOW()
       WHERE id = $1
         AND balance < $3
         AND (last_recharge_at IS NULL
              OR last_recharge_at <= NOW() - ($4 || ' hours')::interval)
       RETURNING balance`,
      [req.user.id, RECHARGE_AMOUNT, RECHARGE_MAX_BALANCE, String(RECHARGE_COOLDOWN_HOURS)],
    );
    if (r.rows.length === 0) {
      const u = await getUserWithStats(req.user.id);
      if (u && u.balance >= RECHARGE_MAX_BALANCE) {
        return res.status(403).json({
          error: `Recharge possible uniquement si votre solde est inférieur à ${RECHARGE_MAX_BALANCE} PTS.`,
        });
      }
      return res.status(403).json({
        error: `Une recharge n'est possible qu'une fois toutes les ${RECHARGE_COOLDOWN_HOURS} h.`,
      });
    }
    res.json({ added: RECHARGE_AMOUNT, newBalance: r.rows[0].balance });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

app.delete("/api/user/me", authenticateToken, async (req, res) => {
  try {
    await db.withTransaction(async (client) => {
      // Les paris créés par l'utilisateur ou situés dans ses rooms disparaîtront avec lui :
      // les mises encore en cours des autres joueurs leur sont remboursées.
      const refunds = await client.query(
        `SELECT w.user_id, SUM(w.amount)::int AS total
         FROM wagers w JOIN events e ON e.id = w.event_id
         WHERE w.status = 'pending' AND w.user_id <> $1 AND e.status = 'active'
           AND (e.creator_id = $1
                OR e.group_id IN (SELECT id FROM friend_groups WHERE owner_id = $1))
         GROUP BY w.user_id`,
        [req.user.id],
      );
      for (const row of refunds.rows) {
        await client.query("UPDATE users SET balance = balance + $1 WHERE id = $2", [row.total, row.user_id]);
      }
      await client.query("DELETE FROM users WHERE id = $1", [req.user.id]);
    });
    res.json({ message: "Compte supprimé." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// ---------- 4. Classement (global, amis ou room) ----------
app.get("/api/leaderboard", authenticateToken, async (req, res) => {
  const scope = req.query.scope || "global";
  let filter = "";
  let params = [];
  try {
    if (scope === "friends") {
      filter = `WHERE u.id = $1 OR u.id IN (
        SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END
        FROM friendships
        WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1))`;
      params = [req.user.id];
    } else if (scope === "group") {
      const groupId = parseInt(req.query.groupId, 10);
      if (isNaN(groupId)) return res.status(400).json({ error: "Room invalide." });
      const m = await db.query(
        "SELECT 1 FROM friend_group_members WHERE group_id = $1 AND user_id = $2",
        [groupId, req.user.id],
      );
      if (m.rows.length === 0)
        return res.status(403).json({ error: "Vous ne faites pas partie de cette room." });
      filter = "WHERE u.id IN (SELECT user_id FROM friend_group_members WHERE group_id = $1)";
      params = [groupId];
    } else if (scope !== "global") {
      return res.status(400).json({ error: "Portée invalide." });
    }
    const r = await db.query(
      `SELECT u.id, u.username, u.email, u.balance,
              COUNT(w.id)::int AS bets,
              (COUNT(w.id) FILTER (WHERE w.status = 'won'))::int AS wins
       FROM users u LEFT JOIN wagers w ON w.user_id = u.id
       ${filter}
       GROUP BY u.id
       ORDER BY u.balance DESC, u.id ASC
       LIMIT 100`,
      params,
    );
    // l'e-mail des autres joueurs n'est jamais exposé
    res.json(
      r.rows.map((row) => {
        const u = formatUser(row);
        return { id: u.id, username: u.username, avatar: u.avatar, balance: u.balance, wins: u.wins, bets: u.bets };
      }),
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// ---------- 4b. Amis ----------
const publicUser = (row) => ({
  id: String(row.id),
  username: row.username,
  avatar: avatarOf(row.username),
});

app.get("/api/friends", authenticateToken, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT f.id AS request_id, f.status, f.requester_id,
              u.id, u.username
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
       WHERE f.requester_id = $1 OR f.addressee_id = $1
       ORDER BY u.username`,
      [req.user.id],
    );
    const out = { friends: [], incoming: [], outgoing: [] };
    r.rows.forEach((row) => {
      const u = { ...publicUser(row), requestId: String(row.request_id) };
      if (row.status === "accepted") out.friends.push(u);
      else if (row.requester_id === req.user.id) out.outgoing.push(u);
      else out.incoming.push(u);
    });
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// Envoyer une demande d'ami (par pseudo exact)
app.post("/api/friends/requests", authenticateToken, requireTerms, async (req, res) => {
  const username = (req.body.username || "").trim();
  if (!username) return res.status(400).json({ error: "Entrez un pseudo." });
  try {
    const t = await db.query(
      "SELECT id, username FROM users WHERE lower(username) = lower($1)",
      [username],
    );
    if (t.rows.length === 0)
      return res.status(404).json({ error: "Aucun joueur avec ce pseudo." });
    const target = t.rows[0];
    if (target.id === req.user.id)
      return res.status(400).json({ error: "Vous ne pouvez pas vous ajouter vous-même." });

    const ex = await db.query(
      `SELECT id, status, requester_id FROM friendships
       WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
      [req.user.id, target.id],
    );
    if (ex.rows.length > 0) {
      const f = ex.rows[0];
      if (f.status === "accepted")
        return res.status(400).json({ error: `Vous êtes déjà amis avec ${target.username}.` });
      if (f.requester_id === req.user.id)
        return res.status(400).json({ error: "Demande déjà envoyée." });
      // Il nous avait déjà invité : on accepte directement
      await db.query("UPDATE friendships SET status = 'accepted' WHERE id = $1", [f.id]);
      return res.json({ message: `Vous êtes maintenant ami avec ${target.username} !`, accepted: true });
    }
    await db.query(
      "INSERT INTO friendships (requester_id, addressee_id) VALUES ($1, $2)",
      [req.user.id, target.id],
    );
    res.status(201).json({ message: `Demande envoyée à ${target.username}.`, accepted: false });
  } catch (err) {
    if (err.code === "23505")
      return res.status(400).json({ error: "Demande déjà existante." });
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// Accepter une demande reçue
app.post("/api/friends/requests/:id/accept", authenticateToken, async (req, res) => {
  try {
    const r = await db.query(
      `UPDATE friendships SET status = 'accepted'
       WHERE id = $1 AND addressee_id = $2 AND status = 'pending' RETURNING id`,
      [parseInt(req.params.id, 10), req.user.id],
    );
    if (r.rows.length === 0)
      return res.status(404).json({ error: "Demande introuvable." });
    res.json({ message: "Ami ajouté !" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// Refuser (reçue) ou annuler (envoyée) une demande en attente
app.delete("/api/friends/requests/:id", authenticateToken, async (req, res) => {
  try {
    const r = await db.query(
      `DELETE FROM friendships
       WHERE id = $1 AND status = 'pending' AND (requester_id = $2 OR addressee_id = $2)
       RETURNING id`,
      [parseInt(req.params.id, 10), req.user.id],
    );
    if (r.rows.length === 0)
      return res.status(404).json({ error: "Demande introuvable." });
    res.json({ message: "Demande supprimée." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// Retirer un ami
app.delete("/api/friends/:userId", authenticateToken, async (req, res) => {
  try {
    const other = parseInt(req.params.userId, 10);
    const r = await db.query(
      `DELETE FROM friendships
       WHERE status = 'accepted'
         AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))
       RETURNING id`,
      [req.user.id, other],
    );
    if (r.rows.length === 0) return res.status(404).json({ error: "Ami introuvable." });
    res.json({ message: "Ami retiré." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// ---------- 4c. Rooms (groupes à code d'invitation) ----------
const MAX_GROUP_MEMBERS = 30;

// Code d'invitation : 6 caractères sans ambiguïtés (ni 0/O ni 1/I/L)
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
async function generateUniqueCode(client = db) {
  for (let i = 0; i < 20; i++) {
    let code = "";
    for (let k = 0; k < 6; k++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    const r = await client.query("SELECT 1 FROM friend_groups WHERE join_code = $1", [code]);
    if (r.rows.length === 0) return code;
  }
  throw new Error("Impossible de générer un code unique.");
}

// Anti force-brute : 10 codes invalides max par 10 minutes et par utilisateur
const joinAttempts = new Map();
function tooManyAttempts(userId) {
  const e = joinAttempts.get(userId);
  return !!e && e.resetAt > Date.now() && e.count >= 10;
}
function recordFailedAttempt(userId) {
  const e = joinAttempts.get(userId);
  if (!e || e.resetAt <= Date.now()) joinAttempts.set(userId, { count: 1, resetAt: Date.now() + 10 * 60 * 1000 });
  else e.count++;
}

async function areFriends(client, a, b) {
  const r = await client.query(
    `SELECT 1 FROM friendships
     WHERE status = 'accepted'
       AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))`,
    [a, b],
  );
  return r.rows.length > 0;
}

async function loadGroups(userId, client = db) {
  const g = await client.query(
    `SELECT g.id, g.name, g.owner_id, g.join_code,
            (SELECT COUNT(*) FROM events e WHERE e.group_id = g.id AND e.status = 'active')::int AS active_events
     FROM friend_groups g
     JOIN friend_group_members me ON me.group_id = g.id AND me.user_id = $1
     ORDER BY g.created_at DESC`,
    [userId],
  );
  if (g.rows.length === 0) return [];
  const m = await client.query(
    `SELECT gm.group_id, u.id, u.username
     FROM friend_group_members gm JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = ANY($1) ORDER BY gm.joined_at, u.username`,
    [g.rows.map((x) => x.id)],
  );
  return g.rows.map((row) => ({
    id: String(row.id),
    name: row.name,
    code: row.join_code,
    ownerId: String(row.owner_id),
    isOwner: row.owner_id === userId,
    activeEvents: row.active_events,
    members: m.rows.filter((x) => x.group_id === row.id).map(publicUser),
  }));
}

app.get("/api/rooms", authenticateToken, async (req, res) => {
  try {
    res.json(await loadGroups(req.user.id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

app.post("/api/rooms", authenticateToken, requireTerms, async (req, res) => {
  const name = (req.body.name || "").trim();
  const memberIds = [
    ...new Set((Array.isArray(req.body.memberIds) ? req.body.memberIds : []).map((x) => parseInt(x, 10))),
  ].filter((x) => !isNaN(x) && x !== req.user.id);
  if (!name || name.length > 50)
    return res.status(400).json({ error: "Nom de room invalide (1 à 50 caractères)." });
  if (memberIds.length + 1 > MAX_GROUP_MEMBERS)
    return res.status(400).json({ error: `Une room ne peut pas dépasser ${MAX_GROUP_MEMBERS} membres.` });

  try {
    const id = await db.withTransaction(async (client) => {
      for (const uid of memberIds) {
        if (!(await areFriends(client, req.user.id, uid)))
          throw { status: 400, msg: "Vous ne pouvez inviter que vos amis." };
      }
      const code = await generateUniqueCode(client);
      const g = await client.query(
        "INSERT INTO friend_groups (name, owner_id, join_code) VALUES ($1, $2, $3) RETURNING id",
        [name, req.user.id, code],
      );
      for (const uid of [req.user.id, ...memberIds]) {
        await client.query(
          "INSERT INTO friend_group_members (group_id, user_id) VALUES ($1, $2)",
          [g.rows[0].id, uid],
        );
      }
      return g.rows[0].id;
    });
    const groups = await loadGroups(req.user.id);
    res.status(201).json(groups.find((x) => x.id === String(id)));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.msg });
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// Rejoindre une room avec son code d'invitation
app.post("/api/rooms/join", authenticateToken, requireTerms, async (req, res) => {
  const code = String(req.body.code || "").trim().toUpperCase().replace(/[\s-]/g, "");
  if (!/^[A-Z0-9]{4,8}$/.test(code))
    return res.status(400).json({ error: "Code invalide : il contient 6 caractères (lettres et chiffres)." });
  if (tooManyAttempts(req.user.id))
    return res.status(429).json({ error: "Trop de codes invalides. Réessayez dans quelques minutes." });
  try {
    const roomId = await db.withTransaction(async (client) => {
      const g = await client.query("SELECT id FROM friend_groups WHERE join_code = $1 FOR UPDATE", [code]);
      if (g.rows.length === 0) {
        recordFailedAttempt(req.user.id);
        throw { status: 404, msg: "Aucune room avec ce code." };
      }
      const id = g.rows[0].id;
      const count = await client.query(
        "SELECT COUNT(*)::int AS n, BOOL_OR(user_id = $2) AS already FROM friend_group_members WHERE group_id = $1",
        [id, req.user.id],
      );
      if (count.rows[0].already) throw { status: 400, msg: "Vous êtes déjà dans cette room." };
      if (count.rows[0].n >= MAX_GROUP_MEMBERS)
        throw { status: 400, msg: `Cette room est complète (${MAX_GROUP_MEMBERS} membres max).` };
      await client.query("INSERT INTO friend_group_members (group_id, user_id) VALUES ($1, $2)", [id, req.user.id]);
      return id;
    });
    joinAttempts.delete(req.user.id);
    const rooms = await loadGroups(req.user.id);
    res.status(201).json(rooms.find((x) => x.id === String(roomId)));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.msg });
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// Générer un nouveau code (créateur) : l'ancien code ne fonctionne plus
app.post("/api/rooms/:id/code", authenticateToken, async (req, res) => {
  const roomId = parseInt(req.params.id, 10);
  try {
    const code = await db.withTransaction(async (client) => {
      const g = await client.query("SELECT owner_id FROM friend_groups WHERE id = $1 FOR UPDATE", [roomId]);
      if (g.rows.length === 0) throw { status: 404, msg: "Room introuvable." };
      if (g.rows[0].owner_id !== req.user.id)
        throw { status: 403, msg: "Seul le créateur peut changer le code." };
      const c = await generateUniqueCode(client);
      await client.query("UPDATE friend_groups SET join_code = $1 WHERE id = $2", [c, roomId]);
      return c;
    });
    res.json({ code });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.msg });
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// Ajouter un de ses amis à une room dont on est membre
app.post("/api/rooms/:id/members", authenticateToken, requireTerms, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  const userId = parseInt(req.body.userId, 10);
  if (isNaN(groupId) || isNaN(userId))
    return res.status(400).json({ error: "Requête invalide." });
  try {
    await db.withTransaction(async (client) => {
      const me = await client.query(
        "SELECT 1 FROM friend_group_members WHERE group_id = $1 AND user_id = $2",
        [groupId, req.user.id],
      );
      if (me.rows.length === 0) throw { status: 404, msg: "Room introuvable." };
      if (!(await areFriends(client, req.user.id, userId)))
        throw { status: 400, msg: "Vous ne pouvez ajouter que vos amis." };
      const count = await client.query(
        "SELECT COUNT(*)::int AS n FROM friend_group_members WHERE group_id = $1",
        [groupId],
      );
      if (count.rows[0].n >= MAX_GROUP_MEMBERS)
        throw { status: 400, msg: `Une room ne peut pas dépasser ${MAX_GROUP_MEMBERS} membres.` };
      const ins = await client.query(
        `INSERT INTO friend_group_members (group_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING RETURNING user_id`,
        [groupId, userId],
      );
      if (ins.rows.length === 0) throw { status: 400, msg: "Vous êtes déjà dans cette room." };
    });
    res.status(201).json({ message: "Membre ajouté." });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.msg });
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// Retirer un membre (le créateur) ou quitter la room (soi-même)
app.delete("/api/rooms/:id/members/:userId", authenticateToken, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  const userId = parseInt(req.params.userId, 10);
  try {
    await db.withTransaction(async (client) => {
      const g = await client.query("SELECT owner_id FROM friend_groups WHERE id = $1 FOR UPDATE", [groupId]);
      if (g.rows.length === 0) throw { status: 404, msg: "Room introuvable." };
      const ownerId = g.rows[0].owner_id;
      const isSelf = userId === req.user.id;
      if (!isSelf && ownerId !== req.user.id)
        throw { status: 403, msg: "Seul le créateur peut retirer un membre." };
      if (userId === ownerId)
        throw { status: 400, msg: "Le créateur ne peut pas quitter sa room : supprimez-la à la place." };

      // Pas de départ tant qu'il reste des mises ou des paris à clôturer dans le groupe
      const pend = await client.query(
        `SELECT
           (SELECT COUNT(*) FROM wagers w JOIN events e ON e.id = w.event_id
             WHERE e.group_id = $1 AND e.status = 'active' AND w.user_id = $2)::int AS wagers,
           (SELECT COUNT(*) FROM events e
             WHERE e.group_id = $1 AND e.status = 'active' AND e.creator_id = $2)::int AS created`,
        [groupId, userId],
      );
      if (pend.rows[0].wagers > 0 || pend.rows[0].created > 0)
        throw {
          status: 400,
          msg: "Ce membre a des mises ou des paris en cours dans cette room : attendez leur clôture.",
        };
      const r = await client.query(
        "DELETE FROM friend_group_members WHERE group_id = $1 AND user_id = $2 RETURNING user_id",
        [groupId, userId],
      );
      if (r.rows.length === 0) throw { status: 404, msg: "Membre introuvable." };
    });
    res.json({ message: "Membre retiré." });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.msg });
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// Supprimer une room (créateur uniquement, sans paris actifs)
app.delete("/api/rooms/:id", authenticateToken, async (req, res) => {
  const groupId = parseInt(req.params.id, 10);
  try {
    await db.withTransaction(async (client) => {
      const g = await client.query("SELECT owner_id FROM friend_groups WHERE id = $1 FOR UPDATE", [groupId]);
      if (g.rows.length === 0) throw { status: 404, msg: "Room introuvable." };
      if (g.rows[0].owner_id !== req.user.id)
        throw { status: 403, msg: "Seul le créateur peut supprimer la room." };
      const active = await client.query(
        "SELECT COUNT(*)::int AS n FROM events WHERE group_id = $1 AND status = 'active'",
        [groupId],
      );
      if (active.rows[0].n > 0)
        throw { status: 400, msg: "Clôturez d'abord les paris actifs de cette room." };
      await client.query("DELETE FROM friend_groups WHERE id = $1", [groupId]);
    });
    res.json({ message: "Room supprimée." });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.msg });
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

// ---------- 5. Paris (événements) ----------
app.get("/api/events", authenticateToken, async (req, res) => {
  try {
    res.json(await loadEvents(req.user.id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

app.post("/api/events", authenticateToken, requireTerms, async (req, res) => {
  const title = (req.body.title || "").trim();
  const category = req.body.category;
  const minBet = parseInt(req.body.minBet, 10) || 50;
  const durationHours = parseInt(req.body.durationHours, 10) || 24;
  const options = Array.isArray(req.body.options) ? req.body.options : [];
  const groupId =
    req.body.groupId === null || req.body.groupId === undefined || req.body.groupId === ""
      ? null
      : parseInt(req.body.groupId, 10);
  if (groupId !== null && isNaN(groupId)) {
    return res.status(400).json({ error: "Room invalide." });
  }

  if (!title || title.length > 255) {
    return res.status(400).json({ error: "Titre invalide (1 à 255 caractères)." });
  }
  if (!CATEGORIES.includes(category)) {
    return res.status(400).json({ error: "Catégorie invalide." });
  }
  if (minBet < 1) {
    return res.status(400).json({ error: "Mise minimale invalide." });
  }
  if (durationHours < 1 || durationHours > 24 * 30) {
    return res.status(400).json({ error: "Durée invalide." });
  }
  const cleanOptions = options
    .map((o) => ({
      text: String(o.text || "").trim(),
      odds: parseFloat(o.odds),
    }))
    .filter((o) => o.text);
  if (cleanOptions.length < 2 || cleanOptions.length > 6) {
    return res.status(400).json({ error: "Il faut entre 2 et 6 options." });
  }
  if (
    cleanOptions.some(
      (o) => o.text.length > 100 || isNaN(o.odds) || o.odds < 1.1 || o.odds > 100,
    )
  ) {
    return res
      .status(400)
      .json({ error: "Option invalide (texte ≤ 100 car., cote entre 1.1 et 100)." });
  }

  try {
    const eventId = await db.withTransaction(async (client) => {
      if (groupId !== null) {
        const m = await client.query(
          "SELECT 1 FROM friend_group_members WHERE group_id = $1 AND user_id = $2",
          [groupId, req.user.id],
        );
        if (m.rows.length === 0)
          throw { status: 403, msg: "Vous ne faites pas partie de cette room." };
      }
      const ev = await client.query(
        `INSERT INTO events (creator_id, title, category, min_bet, expires_at, group_id)
         VALUES ($1, $2, $3, $4, NOW() + ($5 || ' hours')::interval, $6)
         RETURNING id`,
        [req.user.id, title, category, minBet, String(durationHours), groupId],
      );
      for (const o of cleanOptions) {
        await client.query(
          "INSERT INTO event_options (event_id, text, odds) VALUES ($1, $2, $3)",
          [ev.rows[0].id, o.text, o.odds],
        );
      }
      return ev.rows[0].id;
    });
    const [event] = await loadEvents(req.user.id, "e.id = $2", [eventId]);
    res.status(201).json(event);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.msg });
    console.error(err);
    res.status(500).json({ error: "Erreur lors de la création du pari." });
  }
});

// Placer une mise
app.post("/api/events/:id/wagers", authenticateToken, requireTerms, async (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  const optionId = parseInt(req.body.optionId, 10);
  const amount = parseInt(req.body.amount, 10);
  if (isNaN(eventId) || isNaN(optionId) || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: "Option ou montant invalide." });
  }

  try {
    const newBalance = await db.withTransaction(async (client) => {
      const evRes = await client.query(
        "SELECT status, min_bet, expires_at, group_id FROM events WHERE id = $1 FOR UPDATE",
        [eventId],
      );
      if (evRes.rows.length === 0) throw { status: 404, msg: "Pari introuvable." };
      const ev = evRes.rows[0];
      if (ev.group_id !== null) {
        const m = await client.query(
          "SELECT 1 FROM friend_group_members WHERE group_id = $1 AND user_id = $2",
          [ev.group_id, req.user.id],
        );
        // même réponse qu'un pari inexistant : on ne révèle pas son existence
        if (m.rows.length === 0) throw { status: 404, msg: "Pari introuvable." };
      }
      if (ev.status !== "active")
        throw { status: 400, msg: "Ce pari est clôturé." };
      if (new Date(ev.expires_at) <= new Date())
        throw { status: 400, msg: "Ce pari a expiré." };
      if (amount < ev.min_bet)
        throw { status: 400, msg: `La mise minimale est de ${ev.min_bet} PTS.` };

      const opt = await client.query(
        "SELECT id FROM event_options WHERE id = $1 AND event_id = $2",
        [optionId, eventId],
      );
      if (opt.rows.length === 0)
        throw { status: 400, msg: "Option inexistante pour ce pari." };

      const u = await client.query(
        "SELECT balance FROM users WHERE id = $1 FOR UPDATE",
        [req.user.id],
      );
      if (u.rows.length === 0)
        throw { status: 401, msg: "Utilisateur introuvable." };
      if (u.rows[0].balance < amount)
        throw { status: 400, msg: "Solde de crédits insuffisant." };

      // Un utilisateur ne peut pas miser sur deux options du même pari
      const other = await client.query(
        "SELECT 1 FROM wagers WHERE event_id = $1 AND user_id = $2 AND option_id <> $3",
        [eventId, req.user.id, optionId],
      );
      if (other.rows.length > 0)
        throw { status: 400, msg: "Vous avez déjà misé sur une autre option de ce pari." };

      await client.query(
        `INSERT INTO wagers (event_id, option_id, user_id, amount)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (event_id, user_id, option_id)
         DO UPDATE SET amount = wagers.amount + EXCLUDED.amount`,
        [eventId, optionId, req.user.id, amount],
      );
      const upd = await client.query(
        "UPDATE users SET balance = balance - $1 WHERE id = $2 RETURNING balance",
        [amount, req.user.id],
      );
      return upd.rows[0].balance;
    });

    const [event] = await loadEvents(req.user.id, "e.id = $2", [eventId]);
    res.status(201).json({ message: "Pari enregistré", newBalance, event });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.msg });
    console.error(err);
    res.status(500).json({ error: "Erreur lors du traitement de la mise." });
  }
});

// Clôturer un pari et verser les gains (créateur uniquement)
app.post("/api/events/:id/resolve", authenticateToken, requireTerms, async (req, res) => {
  const eventId = parseInt(req.params.id, 10);
  const winningOptionId = parseInt(req.body.winningOptionId, 10);
  if (isNaN(eventId) || isNaN(winningOptionId)) {
    return res.status(400).json({ error: "Requête invalide." });
  }

  try {
    const result = await db.withTransaction(async (client) => {
      const evRes = await client.query(
        "SELECT creator_id, status FROM events WHERE id = $1 FOR UPDATE",
        [eventId],
      );
      if (evRes.rows.length === 0) throw { status: 404, msg: "Pari introuvable." };
      const ev = evRes.rows[0];
      if (ev.creator_id !== req.user.id)
        throw { status: 403, msg: "Seul le créateur peut clôturer ce pari." };
      if (ev.status !== "active")
        throw { status: 400, msg: "Ce pari est déjà clôturé." };

      const opt = await client.query(
        "SELECT id, odds FROM event_options WHERE id = $1 AND event_id = $2",
        [winningOptionId, eventId],
      );
      if (opt.rows.length === 0)
        throw { status: 400, msg: "Option gagnante invalide." };
      const odds = opt.rows[0].odds;

      const winners = await client.query(
        "SELECT id, user_id, amount FROM wagers WHERE event_id = $1 AND option_id = $2",
        [eventId, winningOptionId],
      );
      let myGain = 0;
      for (const w of winners.rows) {
        const gain = Math.round(w.amount * odds);
        await client.query(
          "UPDATE users SET balance = balance + $1 WHERE id = $2",
          [gain, w.user_id],
        );
        if (w.user_id === req.user.id) myGain += gain;
      }
      await client.query(
        "UPDATE wagers SET status = CASE WHEN option_id = $2 THEN 'won' ELSE 'lost' END WHERE event_id = $1",
        [eventId, winningOptionId],
      );
      await client.query(
        "UPDATE events SET status = 'closed', winning_option_id = $2, resolved_at = NOW() WHERE id = $1",
        [eventId, winningOptionId],
      );
      return myGain;
    });

    const [event] = await loadEvents(req.user.id, "e.id = $2", [eventId]);
    const user = await getUserWithStats(req.user.id);
    res.json({ message: "Pari clôturé", myGain: result, event, user });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.msg });
    console.error(err);
    res.status(500).json({ error: "Erreur lors de la clôture du pari." });
  }
});

// ---------- Front statique : http://localhost:PORT ----------
app.use(express.static(path.join(__dirname, "..", "frontend")));

// Toute erreur non gérée (ex : JSON invalide) renvoie du JSON, jamais du HTML
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Requête JSON invalide." });
  }
  console.error(err);
  res.status(500).json({ error: "Erreur serveur." });
});

// Supprime les anciens comptes de démo (alex, thomas, ...) s'ils ont encore
// le mot de passe de démo. Un compte réel portant ce pseudo n'est pas touché.
async function removeDemoAccounts() {
  const demo = ["alex", "thomas", "sarah", "maxime", "lea"];
  const r = await db.query(
    "SELECT id, username, password_hash FROM users WHERE username = ANY($1) AND email LIKE '%@pickone.fr'",
    [demo],
  );
  for (const u of r.rows) {
    if (await bcrypt.compare("password123", u.password_hash)) {
      await db.query("DELETE FROM users WHERE id = $1", [u.id]);
      console.log(`Compte de démo supprimé : ${u.username}`);
    }
  }
}

// Crée / met à jour les tables automatiquement, puis démarre
async function start() {
  try {
    const sql = fs.readFileSync(path.join(__dirname, "shema.sql"), "utf8");
    await db.query(sql);
    await removeDemoAccounts();
    // anciennes rooms créées avant les codes d'invitation
    const noCode = await db.query("SELECT id FROM friend_groups WHERE join_code IS NULL");
    for (const row of noCode.rows) {
      await db.query("UPDATE friend_groups SET join_code = $1 WHERE id = $2", [await generateUniqueCode(), row.id]);
    }
  } catch (err) {
    console.error("\n✘ Impossible d'initialiser la base de données :", err.message);
    console.error("  Vérifiez que PostgreSQL est démarré, que la base existe (createdb pickone_db)");
    console.error("  et que DATABASE_URL est correcte dans backend/.env\n");
    process.exit(1);
  }
  const PORT = process.env.PORT || 5001;
  app.listen(PORT, () => {
    console.log(`Serveur PickOne lancé : http://localhost:${PORT}`);
  });
}

// En local : `node server.js` crée les tables puis écoute sur PORT.
// Sur Vercel : api/index.js importe simplement l'app (pas de listen, pas de migration au démarrage ;
// le schéma est appliqué une fois avec `npm run init-db`, voir Publish.md).
if (require.main === module) start();

module.exports = app;
