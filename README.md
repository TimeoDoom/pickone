# PickOne

Application de paris entre amis avec points virtuels (aucun argent réel).

- **Backend** : Node.js + Express + PostgreSQL + JWT (`backend/`)
- **Frontend** : HTML / JS / Tailwind (CDN), servi directement par le backend (`frontend/`)

Toutes les données (comptes, paris, mises, classement) sont stockées dans PostgreSQL.
Le front ne garde que le jeton de connexion dans le `localStorage`.

> Mise en ligne (Vercel + Neon) : voir [`Publish.md`](./Publish.md).

---

## 1. Prérequis

- [Node.js](https://nodejs.org) 18 ou plus récent
- [PostgreSQL](https://www.postgresql.org/download/) 13 ou plus récent, démarré en local
- Une connexion Internet (le front charge Tailwind, Lucide et confetti depuis des CDN)

## 2. Installation

```bash
# 1) Créer la base de données (une seule fois)
createdb pickone_db
#   ou : psql -U postgres -c "CREATE DATABASE pickone_db;"

# 2) Installer le backend
cd backend
npm install
```

## 3. Configuration

Le fichier `backend/.env` doit contenir (voir `backend/.env.example`) :

```env
PORT=5001
DATABASE_URL=postgres://UTILISATEUR:MOTDEPASSE@localhost:5432/pickone_db
JWT_SECRET=une-longue-chaine-aleatoire-et-secrete
NODE_ENV=development

# E-mail de vérification (SMTP : Brevo, Resend, Gmail avec mot de passe d'application, etc.)
SMTP_HOST=smtp.exemple.com
SMTP_PORT=587
SMTP_USER=votre-identifiant-smtp
SMTP_PASS=votre-mot-de-passe-smtp
MAIL_FROM="Pickone <no-reply@votredomaine.fr>"
```

> `JWT_SECRET` est **obligatoire** : le serveur refuse de démarrer sans lui.
> Adaptez `DATABASE_URL` à votre installation PostgreSQL.
> **Vérification d'e-mail** : à l'inscription, un code à 6 chiffres (valable 10 min, 5 essais, renvoi toutes les 60 s) est envoyé par e-mail.
> En développement, si `SMTP_*` est absent, le code s'affiche simplement dans la console du serveur. En production, SMTP est obligatoire.
> Les comptes créés avant cette fonctionnalité sont considérés comme déjà vérifiés.

## 4. Tables (automatique)

Au démarrage, le serveur **crée / met à jour tout seul les tables** (`shema.sql`, idempotent, ça migre aussi une ancienne base).
Il n'y a rien à faire à la main. La commande `npm run init-db` reste disponible si besoin.

Il n'y a **aucun compte pré-créé** : créez le vôtre depuis l'onglet « Créer un compte » (1000 PTS offerts).
Les anciens comptes de démo (`alex`, `thomas`, …) sont supprimés automatiquement au démarrage s'ils existent encore.

## 5. Lancer l'application

```bash
cd backend
npm start        # ou : npm run dev (rechargement automatique avec nodemon)
```

Ouvrez ensuite **http://localhost:5001** : le backend sert aussi le front, il n'y a rien d'autre à lancer.

> Alternative : ouvrir `frontend/index.html` directement (ou via Live Server). Le front appellera alors
> l'API sur `http://localhost:5001/api` (CORS activé). Le backend doit rester lancé.

---

## 6. Scénario de test manuel

1. **Créer un compte** (onglet « Créer un compte ») → connecté automatiquement, 1000 PTS offerts.
2. **Créer un pari** (bouton « + ») : titre, catégorie, durée, au moins 2 options avec leur cote → il apparaît dans le fil.
3. **Multi-utilisateurs** : ouvrez une fenêtre de navigation privée, créez un 2ᵉ compte et misez sur le pari du 1ᵉʳ
   (clic sur une option, mise ≥ mise minimale) → le solde diminue et la barre de répartition se met à jour.
4. **Arbitrage** : depuis le compte créateur, choisissez l'issue gagnante → les gagnants reçoivent `mise × cote`, le pari passe en « clôturé ».
5. **Mes paris / historique** : suivez vos mises en cours et les résultats.
6. **Classement** : trié par solde, avec victoires et nombre de mises.
7. **Compte** : bonus quotidien (+200 PTS, une fois par jour), statistiques, déconnexion, suppression du compte.
8. **Amis** (onglet « Social ») : invitez un joueur par son **pseudo exact** ; il voit la demande (pastille sur l'onglet) et l'accepte ou la refuse.
9. **Rooms** : « Créer une room » → un nom (et, si vous le souhaitez, des amis à inviter directement). Un **code à 6 caractères** est généré : il s'affiche à la création, sur la carte de la room (clic pour copier) et dans « Gérer ».
10. **Rejoindre une room** : un autre joueur saisit le code dans « Rejoindre une room » (majuscules/minuscules et tirets indifférents). Il n'a pas besoin d'être ami avec le créateur.
11. **Gérer une room** : ajouter un ami, retirer un membre (créateur), quitter ou supprimer la room, **générer un nouveau code** (créateur : l'ancien code cesse de fonctionner), voir le classement de la room.
12. **Paris privés** : à la création d'un pari, choisissez l'audience (« Tous les joueurs » ou une de vos rooms). Un pari de room n'est visible, jouable et clôturable que par ses membres ; une pastille 🔒 indique la room. Le filtre au-dessus du fil permet de n'afficher qu'une room ou que le public.
13. **Classement** : menu déroulant « Tous les joueurs / Mes amis / une room ».
14. **Conformité** : à l'inscription, les cases « 18 ans ou plus » et « j'accepte les CGU et la politique de confidentialité » sont obligatoires. Dans « Mon compte » : « télécharger mes données » (export JSON) et « Supprimer mon compte ». Les pages légales sont sous `/legal/…` (liens en pied de page).
15. **Recharge de dépannage** (popup « crédits ») : +500 PTS, uniquement si le solde est **inférieur à 100 PTS** et **une fois toutes les 24 h**.
   Sinon le bouton est désactivé et le serveur refuse la demande (HTTP 403).

Pour tester la confidentialité : créez 2 comptes (2 fenêtres, dont une navigation privée). Le compte A crée une room et un pari pour cette room ; le compte B ne voit rien tant qu'il n'a pas saisi le code,
puis voit le pari et peut miser. Avant d'avoir rejoint la room, le serveur refuse toute mise de B (404).

Règles appliquées côté serveur : mise minimale, solde suffisant, pari non expiré et non clôturé, une seule option par pari et par joueur (on peut en revanche remiser sur la même), seul le créateur peut clôturer.

## 7. Tester l'API avec curl

```bash
API=http://localhost:5001/api

# Créer un compte -> renvoie le token
curl -s -X POST $API/auth/register -H 'Content-Type: application/json' \
  -d '{"username":"test","email":"test@exemple.fr","password":"secret12","isAdult":true,"acceptTerms":true}'

# Se connecter -> récupère le token
TOKEN=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"identifier":"test","password":"secret12"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

# Profil, paris, classement
curl -s $API/user/me      -H "Authorization: Bearer $TOKEN"
curl -s $API/events       -H "Authorization: Bearer $TOKEN"
curl -s $API/leaderboard  -H "Authorization: Bearer $TOKEN"
```

## 8. Référence de l'API

Confidentialité : un pari de room est invisible pour les non-membres et répond 404 à toute tentative de mise.
Le code d'invitation n'est visible que par les membres de la room (6 caractères parmi 31, sans 0/O/1/I/L). Les tentatives de codes faux sont limitées.
Un membre ne peut pas quitter une room tant qu'il a des mises ou des paris en cours dedans, et une room ne peut pas être supprimée tant qu'elle a des paris actifs.
Si le créateur d'une room supprime son compte, la room et ses paris disparaissent aussi.

Toutes les routes sauf `register` et `login` demandent l'en-tête `Authorization: Bearer <token>`.

| Méthode | Route | Description |
|---|---|---|
| POST | `/api/auth/register` | `{username, email, password, isAdult: true, acceptTerms: true}` → crée le compte (la majorité et l'acceptation des CGU sont obligatoires et horodatées) + renvoie un token |
| POST | `/api/auth/login` | `{identifier, password}` (pseudo ou email) → token + profil |
| GET | `/api/user/me` | Profil, solde, victoires, nombre de mises |
| POST | `/api/user/accept-terms` | `{isAdult: true, acceptTerms: true}` (ré)accepte les CGU en vigueur |
| GET | `/api/user/export` | Export JSON de toutes les données du compte (droits d'accès et de portabilité RGPD) |
| GET | `/api/user/stats` | Statistiques détaillées du compte |
| POST | `/api/user/bonus` | Bonus quotidien (+200 PTS, 1×/jour) |
| POST | `/api/user/credits` | Recharge de dépannage : +500 PTS si solde < 100 PTS, 1× / 24 h (sinon 403) |
| DELETE | `/api/user/me` | Supprime le compte et ses données (les mises en cours des autres joueurs sur les paris supprimés sont remboursées) |
| GET | `/api/leaderboard` | Classement par solde. `?scope=friends` (moi + amis) ou `?scope=group&groupId=ID_ROOM` (membres de la room) |
| GET | `/api/friends` | `{friends, incoming, outgoing}` |
| POST | `/api/friends/requests` | `{username}` envoie une demande (acceptée directement si l'autre vous avait déjà invité) |
| POST | `/api/friends/requests/:id/accept` | Accepter une demande reçue |
| DELETE | `/api/friends/requests/:id` | Refuser / annuler une demande en attente |
| DELETE | `/api/friends/:userId` | Retirer un ami |
| GET | `/api/rooms` | Mes rooms, avec code, membres et nombre de paris actifs |
| POST | `/api/rooms` | `{name, memberIds?}` crée une room et son code (membres invités = amis uniquement) |
| POST | `/api/rooms/join` | `{code}` rejoint la room (10 codes faux / 10 min max, puis 429) |
| POST | `/api/rooms/:id/code` | Génère un nouveau code (créateur) ; l'ancien est invalidé |
| POST | `/api/rooms/:id/members` | `{userId}` ajoute un de **vos** amis (il faut être membre de la room) |
| DELETE | `/api/rooms/:id/members/:userId` | Retirer un membre (créateur) ou quitter (soi-même) |
| DELETE | `/api/rooms/:id` | Supprimer la room (créateur, sans paris actifs) |
| GET | `/api/events` | Paris visibles par l'utilisateur (publics + ceux de ses rooms) |
| POST | `/api/events` | `{title, category, minBet, durationHours, groupId?, options:[{text, odds}]}` (sans `groupId` = public) |
| POST | `/api/events/:id/wagers` | `{optionId, amount}` place une mise |
| POST | `/api/events/:id/resolve` | `{winningOptionId}` clôture et verse les gains (créateur uniquement) |

## 9. Mentions légales, CGU, CGV et RGPD (France)

Les pages sont dans `frontend/legal/` : `mentions-legales.html`, `cgu.html`, `cgv.html`, `confidentialite.html` (politique de confidentialité **et** cookies).

**Ce que le site fait déjà**
- Acceptation des CGU + confirmation de majorité (18 ans) à l'inscription, preuve conservée (date et version) en base.
- Ré-acceptation obligatoire (modale bloquante + refus côté serveur des actions d'écriture) quand la version des CGU change.
- Droits RGPD en libre-service : export des données (JSON) et suppression du compte dans « Mon compte ».
- Aucun cookie : seul un jeton de session est stocké en `localStorage` (strictement nécessaire, donc pas de bandeau de consentement).
- L'e-mail n'est jamais visible des autres joueurs ; mots de passe hachés (bcrypt).

**À faire avant la mise en ligne**
1. **Renseigner `frontend/legal/config.js`** (éditeur, adresse, e-mail de contact, hébergeur, médiateur…). Tant que des champs sont vides, les pages affichent « [À COMPLÉTER] » en surbrillance et un bandeau d'alerte.
2. Faire relire ces textes par un juriste : ce sont des modèles rédigés pour le fonctionnement actuel de l'application, pas un avis juridique.
3. Si vous modifiez substantiellement les CGU ou la politique de confidentialité : changer `termsVersion` dans `frontend/legal/config.js` **et** `TERMS_VERSION` dans `backend/server.js` (même valeur) ; tous les utilisateurs devront alors réaccepter.
4. Servir le site en **HTTPS** et utiliser un `JWT_SECRET` long et aléatoire.
5. Les polices et bibliothèques (Google Fonts, Tailwind, Lucide, canvas-confetti) sont chargées depuis des CDN : leur éditeur reçoit l'adresse IP des visiteurs (c'est indiqué dans la politique de confidentialité). Pour éviter ces transferts, hébergez-les vous-même et mettez le texte à jour.
6. La politique de confidentialité prévoit la suppression possible des comptes inactifs depuis 3 ans et la conservation des journaux 12 mois : mettez en place ces purges (ou ajustez les durées) selon votre hébergeur.
7. Si vous vendez un jour quoi que ce soit (points, abonnement…) : rédigez de vraies CGV et revoyez le statut du service (jeux d'argent, ANJ). Tant que les points restent gratuits, non convertibles et sans lot, la page CGV indique qu'il n'y a pas d'offre payante.

## 10. Structure

```
pickone/
├── backend/
│   ├── server.js          # API Express + service du front
│   ├── db.js              # pool PostgreSQL + helper de transaction
│   ├── shema.sql          # schéma (users, events, event_options, wagers)
│   ├── init-db.js         # npm run init-db
│   ├── middleware/auth.js # vérification du JWT
│   └── .env(.example)
└── frontend/
    ├── index.html
    ├── script.js          # appels API + rendu
    ├── style.css
    ├── logo.svg           # logo (jeton corail #F73863)
    └── legal/             # mentions légales, CGU, CGV, confidentialité (+ config.js à compléter)
```

## 11. Dépannage

- **« Serveur injoignable »** : le backend n'est pas lancé, ou le port n'est pas 5001.
- **`ECONNREFUSED 5432`** : PostgreSQL n'est pas démarré.
- **Erreur 500 / « Erreur serveur »** : regardez le terminal où tourne `npm start`, l'erreur exacte y est affichée.
- **`database "pickone_db" does not exist`** : relancez `createdb pickone_db`.
- **`password authentication failed`** : corrigez l'utilisateur / mot de passe dans `DATABASE_URL`.
- **« Session expirée »** : le jeton dure 24 h, reconnectez-vous.
- Une ancienne table `bets` du premier schéma peut rester dans la base : elle n'est plus utilisée et peut être supprimée (`DROP TABLE bets;`).
