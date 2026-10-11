-- Schéma PickOne (idempotent : peut être relancé sans risque)

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    balance NUMERIC(10, 2) DEFAULT 1000,
    last_bonus_date DATE,
    last_recharge_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Migration si la table users existait déjà avec l'ancien schéma
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_bonus_date DATE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_recharge_at TIMESTAMP WITH TIME ZONE;
-- Preuve de l'acceptation des CGU / confirmation de majorité (RGPD : obligation de pouvoir démontrer)
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version VARCHAR(20);
ALTER TABLE users ALTER COLUMN balance SET DEFAULT 1000;

-- Amitiés : une ligne par paire (demande envoyée puis acceptée)
CREATE TABLE IF NOT EXISTS friendships (
    id SERIAL PRIMARY KEY,
    requester_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending' | 'accepted'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CHECK (requester_id <> addressee_id)
);
-- Une seule relation par paire, quel que soit le sens
CREATE UNIQUE INDEX IF NOT EXISTS uniq_friend_pair
    ON friendships (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id));

-- Rooms (groupes) : un code permet de les rejoindre, les amis peuvent aussi y être invités
CREATE TABLE IF NOT EXISTS friend_groups (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    owner_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
-- Code d'invitation de la room (ajouté après coup : migration idempotente)
ALTER TABLE friend_groups ADD COLUMN IF NOT EXISTS join_code VARCHAR(8);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_room_join_code ON friend_groups(join_code);

CREATE TABLE IF NOT EXISTS friend_group_members (
    group_id INT NOT NULL REFERENCES friend_groups(id) ON DELETE CASCADE,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON friend_group_members(user_id);

-- Un "pari" (événement) créé par un utilisateur
CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    creator_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    category VARCHAR(50) NOT NULL DEFAULT 'Quotidien',
    min_bet INT NOT NULL DEFAULT 50 CHECK (min_bet > 0),
    status VARCHAR(20) NOT NULL DEFAULT 'active', -- 'active' | 'closed'
    winning_option_id INT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

-- Les options d'un pari, avec leur cote
CREATE TABLE IF NOT EXISTS event_options (
    id SERIAL PRIMARY KEY,
    event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    text VARCHAR(100) NOT NULL,
    odds NUMERIC(5, 2) NOT NULL CHECK (odds >= 1.1)
);

-- Les mises des utilisateurs (une ligne par utilisateur et par option, cumulée)
CREATE TABLE IF NOT EXISTS wagers (
    id SERIAL PRIMARY KEY,
    event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    option_id INT NOT NULL REFERENCES event_options(id) ON DELETE CASCADE,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount INT NOT NULL CHECK (amount > 0),
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending' | 'won' | 'lost'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (event_id, user_id, option_id)
);

-- Audience d'un pari : NULL = public, sinon réservé aux membres du groupe
ALTER TABLE events ADD COLUMN IF NOT EXISTS group_id INT REFERENCES friend_groups(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_events_group ON events(group_id);

CREATE INDEX IF NOT EXISTS idx_wagers_user ON wagers(user_id);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);

-- Date de clôture d'un pari (sert aux graphiques de stats du compte)
ALTER TABLE events ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP WITH TIME ZONE;
