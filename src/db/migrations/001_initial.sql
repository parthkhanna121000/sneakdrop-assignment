-- Sneaker Drop initial schema. PostgreSQL 13+ (gen_random_uuid is built in).

CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_count INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- DB-level backstop for "max 2 pairs per user"
  CONSTRAINT users_purchase_count_range CHECK (purchase_count BETWEEN 0 AND 2)
);

CREATE TABLE sneakers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status     TEXT NOT NULL DEFAULT 'AVAILABLE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT sneakers_status_valid CHECK (status IN ('AVAILABLE', 'HELD', 'PURCHASED'))
);

-- The migration itself establishes the inventory: exactly 20 pairs.
INSERT INTO sneakers (status) SELECT 'AVAILABLE' FROM generate_series(1, 20);

CREATE TABLE reservations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id),
  sneaker_id       UUID NOT NULL REFERENCES sneakers(id),
  status           TEXT NOT NULL DEFAULT 'HELD',
  expires_at       TIMESTAMPTZ NOT NULL,
  pending_deadline TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT reservations_status_valid CHECK (status IN ('HELD', 'PAYMENT_PENDING', 'PURCHASED', 'EXPIRED'))
);

-- One active reservation per user
CREATE UNIQUE INDEX reservations_one_active_per_user
  ON reservations (user_id) WHERE status IN ('HELD', 'PAYMENT_PENDING');

-- One active reservation per sneaker
CREATE UNIQUE INDEX reservations_one_active_per_sneaker
  ON reservations (sneaker_id) WHERE status IN ('HELD', 'PAYMENT_PENDING');

CREATE INDEX reservations_user_idx ON reservations (user_id);

CREATE TABLE payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id      UUID NOT NULL REFERENCES reservations(id),
  provider_payment_id TEXT,
  status              TEXT NOT NULL DEFAULT 'PENDING',
  amount              INTEGER NOT NULL,
  paid_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT payments_status_valid CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUND_NEEDED'))
);

-- A reservation cannot have two simultaneous pending payments
CREATE UNIQUE INDEX payments_one_pending_per_reservation
  ON payments (reservation_id) WHERE status = 'PENDING';

CREATE TABLE payment_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_event_id TEXT NOT NULL UNIQUE,   -- webhook idempotency key
  payment_id        UUID NOT NULL REFERENCES payments(id),
  event_type        TEXT NOT NULL,
  occurred_at       TIMESTAMPTZ,
  payload           JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  processed_at      TIMESTAMPTZ
);

CREATE TABLE queue_entries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq            BIGSERIAL NOT NULL UNIQUE,  -- strict FIFO ordering (no timestamp ties)
  user_id        UUID NOT NULL REFERENCES users(id),
  status         TEXT NOT NULL DEFAULT 'WAITING',
  reservation_id UUID REFERENCES reservations(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT queue_status_valid CHECK (status IN ('WAITING', 'PROMOTED', 'CANCELLED', 'SKIPPED'))
);

-- A user can wait in line only once
CREATE UNIQUE INDEX queue_one_waiting_per_user
  ON queue_entries (user_id) WHERE status = 'WAITING';

CREATE INDEX queue_waiting_order_idx ON queue_entries (seq) WHERE status = 'WAITING';

CREATE TABLE purchases (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id),
  reservation_id UUID NOT NULL UNIQUE REFERENCES reservations(id),
  payment_id     UUID NOT NULL UNIQUE REFERENCES payments(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
