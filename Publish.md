# Publier PickOne sur Vercel + Neon

- **Neon** héberge la base PostgreSQL (gratuit pour démarrer).
- **Vercel** héberge le front (`frontend/`) et l'API Express (`api/index.js` → `backend/server.js`) sur le même domaine.

Durée : environ 15 minutes.

---

## Ce qui a été préparé dans le projet

| Fichier | Rôle |
|---|---|
| `vercel.json` | Sert `frontend/` en statique et redirige `/api/*` vers la fonction serverless |
| `api/index.js` | Point d'entrée Vercel : importe l'app Express |
| `package.json` (racine) | Dépendances installées par Vercel (identiques à `backend/package.json`) |
| `backend/server.js` | Exporte l'app, et ne lance `listen` + migration qu'en local (`node server.js`) |
| `backend/db.js` | Peu de connexions par instance (`max: 3` sur Vercel) |
| `frontend/script.js` | Appelle `/api` sur le domaine de production (plus `localhost:5001`) |

Le fonctionnement en local ne change pas : `cd backend && npm start`.

---

## 1. Créer la base sur Neon

1. Créez un compte sur <https://neon.tech> puis **New Project** (nom : `pickone`, région : **Europe (Frankfurt)** ou la plus proche de vos joueurs).
2. Sur le tableau de bord, cliquez sur **Connect**.
3. Activez l'option **Connection pooling** et copiez la chaîne de connexion. Elle ressemble à :

   ```
   postgresql://utilisateur:motdepasse@ep-xxxx-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require
   ```

   Gardez bien l'hôte avec **`-pooler`** : c'est indispensable en serverless (beaucoup de petites connexions).
4. Si la chaîne contient `&channel_binding=require`, supprimez cette partie (le driver `pg` utilisé ici ne la gère pas toujours).

> Cette chaîne est un secret : ne la mettez jamais dans Git ni dans le front.

## 2. Créer les tables (une seule fois)

En production, les tables ne sont **pas** créées au démarrage (ce serait lent et risqué en serverless). On applique `shema.sql` depuis votre ordinateur :

```bash
cd backend
npm install

# macOS / Linux
DATABASE_URL="postgresql://...neon.tech/neondb?sslmode=require" NODE_ENV=production npm run init-db

# Windows (PowerShell)
$env:DATABASE_URL="postgresql://...neon.tech/neondb?sslmode=require"; $env:NODE_ENV="production"; npm run init-db
```

Vous devez voir `✔ Tables créées / à jour.`. Vous pouvez le vérifier dans Neon → **Tables**.

> **À refaire à chaque mise à jour qui modifie `shema.sql`** (par exemple après l'ajout de la colonne `resolved_at` pour les graphiques). Le script est idempotent : le relancer ne casse rien.

## 3. Mettre le code sur GitHub

À la racine du projet (le dossier qui contient `api/`, `backend/`, `frontend/`, `vercel.json`) :

```bash
npm install            # génère package-lock.json à la racine (à committer)
git init
git add .
git commit -m "PickOne"
git branch -M main
git remote add origin https://github.com/VOTRE_COMPTE/pickone.git
git push -u origin main
```

Vérifiez avant le premier push que **`backend/.env` n'est pas dans le commit** (`git status` ne doit pas le lister ; il est dans `.gitignore`). Si un mot de passe a déjà été publié par erreur, changez-le.

## 4. Déployer sur Vercel

1. <https://vercel.com> → **Add New… → Project** → importez le dépôt GitHub.
2. Laissez **Root Directory** à la racine (`./`) et **Framework Preset** sur `Other`. Ne renseignez ni *Build Command* ni *Output Directory* : `vercel.json` s'en charge.
3. Dans **Environment Variables**, ajoutez :

   | Nom | Valeur |
   |---|---|
   | `DATABASE_URL` | la chaîne **pooler** de Neon (étape 1) |
   | `JWT_SECRET` | une longue chaîne aléatoire, **différente de celle de votre `.env` local** |

   Pour générer le secret :

   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

   `NODE_ENV` est mis à `production` automatiquement par Vercel (ce qui active SSL vers Neon).
4. Cliquez sur **Deploy**. Vous obtenez une URL du type `https://pickone-xxxx.vercel.app`.

## 5. Vérifier

1. Ouvrez l'URL : la popup bêta s'affiche, puis l'écran de connexion.
2. Créez un compte → vous arrivez connecté avec 1000 PTS.
3. Créez un pari, misez avec un second compte (navigation privée), regardez l'onglet **Compte** et ses graphiques.
4. En cas de problème : Vercel → **Deployments → (dernier déploiement) → Functions / Logs**.

## 6. Domaine personnalisé (facultatif)

Vercel → **Settings → Domains** → ajoutez `pickone.fr` et suivez les enregistrements DNS indiqués. Le HTTPS est automatique.
Si vous changez de domaine, mettez aussi à jour `siteUrl` (et `email`) dans `frontend/legal/config.js`.

## 7. Mises à jour

```bash
git add . && git commit -m "..." && git push
```

Chaque `push` sur `main` redéploie automatiquement. Si `shema.sql` a changé, relancez d'abord l'étape 2.

---

## Limites à connaître

- **Limitation des codes de room (anti-force-brute)** : elle est gardée en mémoire (`joinAttempts`). Sur Vercel chaque instance a sa propre mémoire, donc la limite n'est qu'**approximative**. Pour une protection stricte, il faudrait la stocker en base.
- **Premier appel un peu lent** : après inactivité, la fonction Vercel et la base Neon (offre gratuite, mise en veille après ~5 min) se réveillent. Comptez 1 à 3 secondes sur la première requête.
- **Pas de tâches de fond** : tout se fait à la demande, ce qui convient à l'app actuelle.
- **Pages légales** : avant l'ouverture au public, relisez `frontend/legal/config.js` (nom, e-mail, hébergeur). L'hébergeur y est déjà indiqué comme Vercel Inc. ; vous pouvez ajouter Neon comme sous-traitant (hébergement de la base) dans la politique de confidentialité.
- **Version des CGU** : `termsVersion` dans `frontend/legal/config.js` doit rester identique à `TERMS_VERSION` dans `backend/server.js`.

## Dépannage

| Symptôme | Cause probable |
|---|---|
| `Serveur injoignable` dans le front | Le front appelle une mauvaise URL : videz le cache, vérifiez que `frontend/script.js` est bien la version à jour |
| Erreur 500 sur toutes les routes `/api` | `JWT_SECRET` ou `DATABASE_URL` manquant : ajoutez-les dans Vercel puis **Redeploy** |
| `relation "users" does not exist` | L'étape 2 n'a pas été faite sur la base Neon utilisée |
| `column "resolved_at" does not exist` | Relancez `npm run init-db` (étape 2) |
| `SSL/TLS required` ou erreur de connexion | Gardez `?sslmode=require` dans l'URL et `NODE_ENV=production` lors de `init-db` |
| `too many connections` | Utilisez bien l'hôte Neon avec `-pooler` |
| Erreur `channel_binding` | Retirez `&channel_binding=require` de l'URL |
