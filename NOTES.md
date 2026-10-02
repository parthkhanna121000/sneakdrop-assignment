# Sneaker Drop

**Oversell-proof system for a 20-pair limited sneaker sale.**

The goal of this project is to make sure that exactly 20 sneakers can be sold even when many users attempt to buy at the same time.

The system supports:

- 5-minute sneaker holds
- Maximum 1 active hold per user
- Maximum 2 completed purchases per user
- FIFO waiting line
- Automatic queue promotion when a hold expires
- Fake payment provider
- Duplicate, delayed and out-of-order payment webhooks
- Late payment success handling
- Idempotent webhook processing
- Database-level invariants
- Concurrent buyer testing

---

# 1. Tech Stack

### Backend

- Node.js
- TypeScript
- Express
- PostgreSQL
- `pg` for PostgreSQL access
- Raw SQL
- Vitest

### Frontend

- Plain HTML
- Plain CSS
- Plain JavaScript

### Infrastructure

- PostgreSQL

There is intentionally **no ORM, Redis, Kafka, RabbitMQ, WebSocket layer, Docker, or frontend framework**.

The system is small enough that PostgreSQL can provide the required correctness guarantees without introducing additional infrastructure.

---

# 2. Requirements

Install:

- Node.js 18+
- npm
- PostgreSQL 13+

Node.js 18+ is required because the project uses the built-in `fetch` API.

PostgreSQL must be installed and running locally before starting the application.

The project uses separate PostgreSQL databases for development and testing.

---

# 3. Project Structure

The important parts of the project are organized approximately as follows:

```text
sneaker-drop/
├── src/
│   ├── config/
│   ├── db/
│   │   ├── migrations/
│   │   └── client.ts
│   ├── modules/
│   │   ├── reservations/
│   │   ├── payments/
│   │   ├── queue/
│   │   └── users/
│   ├── routes/
│   ├── workers/
│   └── utils/
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── tests/
├── .env.example
├── NOTES.md
├── package.json
└── tsconfig.json
```

The exact filenames may vary slightly, but the main separation is:

- database layer
- reservation/inventory logic
- payment logic
- queue logic
- expiry worker
- HTTP API
- frontend
- tests

---

# 4. Environment Setup

Copy the example environment file.

### Linux/macOS

```bash
cp .env.example .env
```

### Windows

```cmd
copy .env.example .env
```

The `.env` file contains the PostgreSQL connection strings and application configuration.

At minimum, the project requires:

```text
DATABASE_URL
TEST_DATABASE_URL
```

It also uses configuration for values such as:

```text
HOLD_SECONDS
PENDING_SECONDS
WEBHOOK_SECRET
FAKE_PAYMENT_URL
CHAOS
```

The exact values should be taken from `.env.example`.

---

# 5. PostgreSQL Setup

Make sure PostgreSQL is installed and running locally.

Create the development and test databases if they do not already exist:

```text
sneaker_drop
sneaker_drop_test
```

The database names and connection details should match the values configured in `.env`.

For example:

```text
DATABASE_URL=postgresql://postgres:password@localhost:5432/sneaker_drop

TEST_DATABASE_URL=postgresql://postgres:password@localhost:5432/sneaker_drop_test
```

Use the actual PostgreSQL username, password, host, port and database names configured on your machine.

---

# 6. Install Dependencies

From the project directory:

```bash
npm install
```

---

# 7. Start the Sneaker Drop API

Make sure PostgreSQL is running, then start the application:

```bash
npm start
```

The API runs on:

```text
http://localhost:3000
```

The server automatically:

1. Connects to PostgreSQL
2. Runs pending migrations
3. Starts the expiry worker
4. Serves the frontend

---

# 8. Start the Fake Payment Provider

Open another terminal.

Run:

```bash
npm run fake-payment
```

The fake provider runs on:

```text
http://localhost:4000
```

The normal payment flow is:

```text
Browser
   |
   | POST /pay
   v
Sneaker Drop API
   |
   | payment request
   v
Fake Payment Provider
   |
   | signed webhook
   v
Sneaker Drop API
   |
   v
PostgreSQL
```

The fake provider simulates the behaviour of a real external payment service.

---

# 9. Payment Provider Troubleshooting

If the frontend displays:

```text
Could not reach payment provider
```

make sure the fake payment provider is running in a second terminal:

```bash
npm run fake-payment
```

Also verify that the payment provider URL in `.env` matches the port used by the fake payment provider.

The Sneaker Drop API and fake payment provider are separate processes.

Example:

```text
Terminal 1

npm start
```

```text
Terminal 2

npm run fake-payment
```

Then open:

```text
http://localhost:3000
```

---

# 10. Chaos Mode

The fake payment provider can simulate unreliable provider behaviour.

Enable chaos mode:

```bash
CHAOS=true npm run fake-payment
```

Or set:

```text
CHAOS=true
```

in `.env`.

Chaos mode can produce:

- delayed webhooks
- duplicate webhooks
- out-of-order events

This is used to verify that the backend does not blindly trust event ordering.

A payment failure can also be simulated using the fake provider's failure outcome:

```json
{
  "outcome": "failed"
}
```

---

# 11. Frontend

Open:

```text
http://localhost:3000
```

The Express server serves:

```text
public/index.html
public/style.css
public/app.js
```

There is no frontend build step.

The frontend polls:

```text
GET /drop
GET /status/:userId
```

approximately once per second.

The UI displays:

- pairs remaining
- pairs currently on hold
- sold pairs
- waiting-line size
- user's current state
- hold/payment countdown
- queue position
- purchase count

The browser stores only a `userId` in `localStorage`.

The browser does **not** decide inventory allocation.

All important inventory and queue decisions come from the backend/database.

---

# 12. Demo Tools

The frontend contains two demo tools.

### Simulate 50 other buyers

This creates 50 users and makes each user attempt to buy.

Starting from an empty drop, the expected result is approximately:

```text
20 on hold
30 waiting
```

If the current user already holds one pair, the numbers will differ accordingly.

### Become a new user

Creates a fresh user and stores the new user ID in `localStorage`.

This is useful for demonstrating different queue and reservation states.

---

# 13. Main User Flow

A normal purchase works like this:

```text
User clicks Buy
       |
       v
Is a sneaker available?
       |
    +--+--+
    |     |
   YES    NO
    |     |
    v     v
Create   Add user
5-min    to FIFO
hold     queue
    |
    v
User clicks Pay
    |
    v
Payment provider
    |
    v
Webhook
    |
    v
Purchase completed
```

---

# 14. Reservation States

A reservation can be in these states:

```text
HELD
PAYMENT_PENDING
PURCHASED
EXPIRED
```

Normal successful flow:

```text
HELD
  |
  | payment started
  v
PAYMENT_PENDING
  |
  | payment succeeded
  v
PURCHASED
```

If the hold expires:

```text
HELD
  |
  v
EXPIRED
```

When a held sneaker expires, the system attempts to promote the first eligible waiting user.

---

# 15. Sneaker States

A sneaker itself has only three states:

```text
AVAILABLE
HELD
PURCHASED
```

The sneaker state is separate from payment state.

For example:

```text
Sneaker: HELD
Reservation: PAYMENT_PENDING
Payment: PENDING
```

This separation makes it possible to reason about inventory independently from external payment processing.

---

# 16. Queue Behaviour

The waiting line is FIFO.

Each queue entry receives a database-generated sequence number:

```text
seq
```

The smallest waiting sequence number is promoted first.

Example:

```text
User A → #1
User B → #2
User C → #3
```

If a sneaker becomes available:

```text
User A → HELD
User B → WAITING
User C → WAITING
```

A queue position is derived from the database rather than stored as a mutable number.

---

# 17. How Overselling Is Prevented

This is the most important part of the project.

## 17.1 PostgreSQL is the source of truth

The browser never decides:

- whether stock exists
- which sneaker is allocated
- who gets promoted
- whether a payment can complete

Those decisions happen on the backend using PostgreSQL.

---

## 17.2 Transaction-scoped advisory lock

Every critical inventory mutation runs through:

```text
withDropLock()
```

Conceptually:

```text
BEGIN

    SET LOCAL lock_timeout = 5s

    pg_advisory_xact_lock(1)

    perform inventory operation

COMMIT
```

The advisory lock serializes critical drop mutations.

Therefore, if many users click Buy at approximately the same time:

```text
1000 requests
      |
      v
1000 transactions
      |
      v
one critical inventory mutation at a time
      |
      v
database remains consistent
```

The lock is transaction-scoped, so it is automatically released when the transaction commits or rolls back.

If the lock cannot be acquired within the configured timeout, the API returns HTTP `503` instead of waiting indefinitely.

---

# 18. Database Constraints

The application does not rely only on JavaScript logic.

The database also enforces important invariants.

Examples:

### One active reservation per user

A user cannot simultaneously have multiple active:

```text
HELD
PAYMENT_PENDING
```

reservations.

### One active reservation per sneaker

A sneaker cannot simultaneously belong to two active reservations.

### Maximum two purchases

The user's purchase count is constrained to:

```text
0 <= purchase_count <= 2
```

### One purchase per reservation

A reservation cannot produce multiple purchases.

### One purchase per payment

A payment cannot produce multiple purchases.

### Unique webhook event IDs

The same external payment event cannot be inserted twice.

These constraints provide a second line of defence if application code makes a mistake.

---

# 19. Inventory Invariant

The fundamental inventory invariant is:

```text
AVAILABLE + HELD + PURCHASED = 20
```

At all times after a transaction completes, the system must account for all 20 sneakers.

The system must never reach:

```text
PURCHASED > 20
```

or allocate the same sneaker to two active reservations.

---

# 20. Expiry Worker

The expiry worker runs approximately once per second.

Its job is to:

- find expired reservations
- release expired holds
- promote waiting users
- perform reconciliation/self-healing

The worker is **not the source of truth**.

This is important because a worker could temporarily stop or be delayed.

The API itself checks expiry when processing relevant operations.

Therefore:

```text
Worker running

    ≠

Correctness depends on worker
```

The database timestamps determine whether a hold has expired.

---

# 21. `releaseAndPromote()`

There is one central function responsible for handling a released sneaker:

```text
releaseAndPromote(sneakerId)
```

It does one of two things.

### If a valid waiting user exists

```text
expired reservation
        |
        v
find first waiting user
        |
        v
create new 5-minute hold
        |
        v
sneaker → HELD
```

### If nobody is waiting

```text
expired reservation
        |
        v
sneaker → AVAILABLE
```

Keeping this behaviour in one function prevents different expiry paths from implementing queue promotion differently.

---

# 22. Payment Design

The payment provider is intentionally outside the database transaction.

The backend does **not** hold the PostgreSQL drop lock while making an external network request.

The flow is:

```text
POST /pay
    |
    v
DB transaction
    |
    | mark payment pending
    | commit
    v
external fake payment provider
    |
    v
webhook
    |
    v
DB transaction
    |
    v
final payment/inventory state
```

This avoids holding a database lock while waiting for an external service.

---

# 23. Webhook Security

Payment webhooks are authenticated using HMAC-SHA256.

The provider sends:

```text
x-webhook-timestamp
x-webhook-signature
```

The signature is calculated over:

```text
<timestamp>.<raw request body>
```

using:

```text
WEBHOOK_SECRET
```

Conceptually:

```text
HMAC_SHA256(
    WEBHOOK_SECRET,
    timestamp + "." + rawBody
)
```

The server validates the timestamp and signature before processing the event.

---

# 24. Webhook Idempotency

Payment providers can send the same event more than once.

Each external event has a unique:

```text
external_event_id
```

The database enforces uniqueness on this value.

Therefore:

```text
payment.succeeded
payment.succeeded
payment.succeeded
```

does not create three purchases.

The first event is processed.

The duplicates are safely ignored.

---

# 25. Out-of-order Events

Events may arrive in an unexpected order.

For example:

```text
payment.succeeded
payment.pending
```

A terminal payment state must not be reverted by an older/later duplicate event.

The webhook handler evaluates the current database state before applying a transition.

---

# 26. Late Payment Success

A particularly important case is:

```text
User receives a 5-minute hold
        |
        v
Hold expires
        |
        v
Sneaker is given to another waiting user
        |
        v
Original payment succeeds late
```

The original payment must **not steal the sneaker from the new holder**.

Instead:

```text
payment → REFUND_NEEDED
```

The UI reports:

```text
Payment received, but your hold had expired.

Refund pending.
```

The assignment implementation flags the refund rather than actually transferring money.

---

# 27. Payment Failure

If payment fails while the reservation is still valid:

```text
PAYMENT_PENDING
        |
        v
payment failed
        |
        v
reservation returns to HELD
```

The user can retry while the hold remains valid.

If the hold has already expired:

```text
payment failed
        |
        v
reservation expires
        |
        v
releaseAndPromote()
```

The next eligible waiting user receives the sneaker.

---

# 28. API

| Method | Path                | Purpose                          |
| ------ | ------------------- | -------------------------------- |
| `POST` | `/users`            | Create a user                    |
| `GET`  | `/drop`             | Get current drop inventory       |
| `POST` | `/buy`              | Hold a sneaker or join the queue |
| `POST` | `/pay`              | Start payment                    |
| `POST` | `/queue`            | Join waiting line                |
| `POST` | `/queue/leave`      | Leave waiting line               |
| `GET`  | `/status/:userId`   | Get user's current state         |
| `POST` | `/payments/webhook` | Process signed payment events    |
| `GET`  | `/debug/invariants` | Check database invariants        |

---

# 29. Important API Responses

## `/buy`

Successful hold:

```json
{
  "status": "HELD"
}
```

Sold out:

```json
{
  "status": "WAITING",
  "queuePosition": 1
}
```

---

## `/status/:userId`

The response contains information such as:

```text
status
secondsRemaining
queuePosition
purchaseCount
serverNow
reservation
```

The frontend uses the server's time information to display the countdown.

---

# 30. Tests

Run:

```bash
npm test
```

The tests use a separate PostgreSQL database:

```text
sneaker_drop_test
```

The test database may be truncated/reset during testing.

Run type checking:

```bash
npm run typecheck
```

The test suite covers important correctness scenarios including:

- 20 successful holds
- FIFO queue behaviour
- 1000 concurrent buyers
- duplicate/double-click Buy requests
- hold expiry
- automatic queue promotion
- maximum 2 purchases per user
- HMAC validation
- duplicate webhooks
- concurrent duplicate webhooks
- out-of-order payment events
- late payment success
- refund-needed state
- payment failure
- database invariant checks

The most important concurrency property is:

```text
1000 concurrent buyers
        ↓
maximum 20 successful allocations
        ↓
0 overselling
```

---

# 31. Demo Checklist

For a quick demonstration:

### Step 1 — Start PostgreSQL

Make sure the local PostgreSQL service is running.

### Step 2 — Start API

```bash
npm start
```

### Step 3 — Start payment provider

In another terminal:

```bash
npm run fake-payment
```

### Step 4 — Open frontend

```text
http://localhost:3000
```

### Step 5 — Demonstrate a normal purchase

```text
20 available
    ↓
Buy
    ↓
19 available
1 held
    ↓
Pay now
    ↓
Payment succeeds
    ↓
1 sold
```

### Step 6 — Demonstrate the queue

Use:

```text
Simulate 50 other buyers
```

to fill the inventory and create waiting users.

Then allow a hold to expire.

The first eligible waiting user should automatically receive the released sneaker.

### Step 7 — Demonstrate concurrency

Run:

```bash
npm test
```

and show the 1000-concurrent-buyer test.

### Step 8 — Show invariants

Open:

```text
GET /debug/invariants
```

An empty violation list means the checked invariants are currently healthy.

---

# 32. What I Would Explain During the Recording

The project can be explained in five main ideas.

### 1. The problem

> "The main problem is overselling when many users click Buy simultaneously. There are only 20 physical sneakers, so the database must remain the source of truth."

### 2. Concurrency solution

> "Every inventory-changing operation runs inside a PostgreSQL transaction protected by a transaction-scoped advisory lock. This serializes the critical section and prevents two requests from allocating the same inventory."

### 3. Reservation solution

> "A sneaker is held for five minutes. If the payment does not complete, the reservation expires and the sneaker is either promoted to the first waiting user or returned to available stock."

### 4. Payment solution

> "Payment is handled asynchronously. I commit the payment-pending state before calling the external provider, and the provider later sends a signed webhook. The webhook is idempotent and handles duplicate, delayed and out-of-order events."

### 5. Correctness

> "The application also uses PostgreSQL constraints and invariant checks as a second line of defence. The key invariant is that available, held and purchased sneakers always account for exactly 20 pairs."

---

# 33. Known Simplifications

This is a small assignment implementation, so some production features are intentionally simplified.

- `GET /drop` can lag by approximately one worker tick after an expiry.
- The frontend uses polling instead of WebSockets, so UI updates can be approximately one second behind.
- Refunds are represented by `REFUND_NEEDED`; an actual payment/refund service is not implemented.
- There is no authentication system.
- The demo identifies users using a generated `userId`.
- The fake payment provider replaces a real payment gateway.
- PostgreSQL is intentionally used as the central consistency mechanism rather than introducing Redis/Kafka/etc.

These simplifications do not change the core inventory correctness model.

---

# 34. Design Summary

The core design is:

```text
                 ┌──────────────────┐
                 │     Frontend     │
                 │ HTML/CSS/JS      │
                 └────────┬─────────┘
                          │
                          ▼
                 ┌──────────────────┐
                 │   Express API    │
                 │ Node + TypeScript│
                 └────────┬─────────┘
                          │
                Critical │ mutations
                          ▼
                 ┌──────────────────┐
                 │   PostgreSQL     │
                 │ Source of Truth  │
                 └────────┬─────────┘
                          │
             ┌────────────┴────────────┐
             │                         │
             ▼                         ▼
      Expiry Worker          Fake Payment Provider
                                      │
                                      │ Webhook
                                      ▼
                               Express API
```

The key principle is:

> **The browser is not trusted with inventory decisions. PostgreSQL owns the state, transactions protect mutations, and payment events are treated as unreliable external input.**
