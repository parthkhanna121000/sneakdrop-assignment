# Sneaker Drop

**Oversell-proof system for a 20-pair limited sneaker sale.**

The system is designed to ensure that exactly 20 sneakers can be allocated safely even when many users attempt to buy concurrently.

## 🎥 Demo

**Project walkthrough:** https://drive.google.com/file/d/1XcM9ozRb_-5nSHxKNIQARSDZvo0ZmHXQ/view?usp=sharing

## Tech Stack

- **Backend:** Node.js, TypeScript, Express
- **Database:** PostgreSQL using `pg` and raw SQL
- **Frontend:** Vanilla HTML, CSS, JavaScript
- **Testing:** Vitest
- **Payments:** Local fake payment provider with signed webhooks
- **Concurrency:** PostgreSQL transaction-scoped advisory lock

No ORM, Redis, Kafka, RabbitMQ, Docker, or frontend framework is required.

---

## Requirements

- Node.js 18+
- npm
- PostgreSQL 13+

PostgreSQL must be running locally.

Create two databases:

```text
sneaker_drop
sneaker_drop_test
```

Configure their connection strings and other settings in `.env`.

Use `.env.example` as the template.

---

## Run Locally

### 1. Install dependencies

```bash
npm install
```

### 2. Start PostgreSQL

Make sure the local PostgreSQL server is running.

### 3. Start the Sneaker Drop API

```bash
npm run dev
```

The API and frontend run at:

```text
http://localhost:3000
```

### 4. Start the Fake Payment Provider

Open another terminal:

```bash
npx tsx fake-payment/src/server.ts
```

The fake provider runs at:

```text
http://localhost:4000
```

The `WEBHOOK_SECRET` used by the fake provider must match the API's `.env`.

---

## Main User Flow

```text
Buy
 ↓
5-minute hold
 ↓
Pay Now
 ↓
Fake Payment Provider
 ↓
Signed Webhook
 ↓
Payment processed
 ↓
Purchase completed
```

If no sneaker is available, the user can join the FIFO waiting line.

When a hold expires, the released sneaker is automatically offered to the first eligible waiting user.

---

## Inventory & Reservations

Each sneaker has one of three states:

```text
AVAILABLE
HELD
PURCHASED
```

Reservations can be:

```text
HELD
PAYMENT_PENDING
PURCHASED
EXPIRED
```

Rules:

- Exactly 20 sneakers exist.
- A user can have at most **1 active hold**.
- A user can complete at most **2 purchases**.
- A hold lasts **5 minutes**.
- Expired holds release the sneaker or trigger queue promotion.

The main inventory invariant is:

```text
AVAILABLE + HELD + PURCHASED = 20
```

---

## Concurrency / Overselling Prevention

PostgreSQL is the source of truth for inventory.

Critical state-changing operations run inside a transaction protected by a transaction-scoped advisory lock:

```text
BEGIN
 ↓
Acquire PostgreSQL advisory lock
 ↓
Read/update inventory
 ↓
Commit
```

This serializes the critical inventory mutation so concurrent buyers cannot allocate the same sneaker.

The application also uses database constraints to protect important invariants, including:

- One active reservation per user
- One active reservation per sneaker
- Maximum two purchases per user
- One purchase per reservation
- One purchase per payment
- Unique payment event IDs

---

## FIFO Queue

When all sneakers are unavailable, users can join the waiting line.

Each queue entry receives a database-generated sequence number.

Example:

```text
User A → #1
User B → #2
User C → #3
```

When inventory becomes available, the first eligible user is promoted.

Queue promotion is centralized through:

```text
releaseAndPromote(sneakerId)
```

This is used when a hold expires or inventory is otherwise released.

---

## Payment Handling

The payment provider is treated as an unreliable external system.

The API first commits the payment-pending state and only then calls the provider.

```text
DB transaction
 ↓
PAYMENT_PENDING
 ↓
Commit
 ↓
External payment provider
 ↓
Webhook
 ↓
DB transaction
 ↓
Final state
```

The database transaction is therefore never held open while waiting for an external network request.

### Webhook Security

Payment webhooks use **HMAC-SHA256** signatures.

The server validates:

- Webhook timestamp
- Webhook signature
- Request body

### Idempotency

Every external payment event has a unique event ID.

Duplicate events are ignored safely, preventing duplicate purchases.

The system also handles:

- Delayed events
- Duplicate events
- Out-of-order events
- Payment failures
- Late payment success

If payment succeeds after the user's reservation has already expired and the sneaker has been allocated elsewhere, the payment is marked:

```text
REFUND_NEEDED
```

The implementation does not perform a real refund; it records the required refund state.

---

## Expiry Worker

A background worker checks for expired reservations approximately once per second.

It:

1. Finds expired reservations
2. Releases the held sneaker
3. Promotes the next eligible waiting user
4. Reconciles queue/inventory state

The worker is not the source of truth. Database timestamps determine whether a reservation has actually expired, and relevant API operations also check expiry.

---

## Frontend

The frontend is intentionally simple and has no build step.

It displays:

- Available sneakers
- Held sneakers
- Sold sneakers
- Waiting users
- Current user's state
- Hold/payment countdown
- Queue position
- Purchase count

The browser stores a generated `userId` in `localStorage`.

Inventory allocation and queue decisions are always made by the backend/database rather than the browser.

---

## Testing

Run:

```bash
npm test
```

Type checking:

```bash
npm run typecheck
```

The test suite covers important scenarios including:

- Concurrent buyers
- 20 successful allocations
- FIFO queue behaviour
- Hold expiry
- Automatic queue promotion
- Duplicate Buy requests
- Maximum two purchases
- HMAC validation
- Duplicate webhooks
- Concurrent duplicate webhooks
- Out-of-order payment events
- Late payment success
- Payment failure
- Database invariant checks

The main concurrency requirement is:

```text
Many concurrent buyers
        ↓
Maximum 20 successful allocations
        ↓
No overselling
```

---

## Demo

A basic successful purchase can be demonstrated as:

```text
20 available
    ↓
Buy
    ↓
19 available / 1 held
    ↓
Pay Now
    ↓
Payment webhook
    ↓
19 available / 1 purchased
```

The database can be verified with:

```sql
SELECT status, COUNT(*)
FROM sneakers
GROUP BY status
ORDER BY status;
```

Expected after one successful purchase:

```text
AVAILABLE   19
PURCHASED    1
```

---

## API

| Method | Endpoint            | Purpose                    |
| ------ | ------------------- | -------------------------- |
| POST   | `/users`            | Create user                |
| GET    | `/drop`             | Get inventory              |
| POST   | `/buy`              | Hold sneaker / enter queue |
| POST   | `/pay`              | Start payment              |
| POST   | `/queue`            | Join queue                 |
| POST   | `/queue/leave`      | Leave queue                |
| GET    | `/status/:userId`   | Get user status            |
| POST   | `/payments/webhook` | Process payment webhook    |
| GET    | `/debug/invariants` | Check invariants           |

---

## Design Summary

The core design principle is:

> **The browser is not trusted with inventory decisions. PostgreSQL owns the state, transactions protect critical mutations, and payment webhooks are treated as unreliable external input.**
