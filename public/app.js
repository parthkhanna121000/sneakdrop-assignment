// Sneaker Drop frontend: plain JS, no build step. It never decides anything itself:
// every number and button state below comes from the backend (GET /drop, GET /status/:userId).

(function () {
  "use strict";

  const API = ""; // same origin: Express serves this page
  const USER_KEY = "sneakerDropUserId";
  const POLL_MS = 1000;
  const MAX_PURCHASES = 2;

  const $ = (id) => document.getElementById(id);

  const el = {
    pairsLeft: $("pairsLeft"),
    counts: $("counts"),
    statusText: $("statusText"),
    countdownRow: $("countdownRow"),
    countdownLabel: $("countdownLabel"),
    countdown: $("countdown"),
    queueRow: $("queueRow"),
    queuePos: $("queuePos"),
    purchased: $("purchased"),

    buyBtn: $("buyBtn"),
    payBtn: $("payBtn"),
    leaveBtn: $("leaveBtn"),

    message: $("message"),
    userId: $("userId"),

    crowdBtn: $("crowdBtn"),
    newUserBtn: $("newUserBtn"),
    demoMessage: $("demoMessage"),
  };

  const state = {
    userId: null,
    drop: null, // { pairsLeft, held, purchased, waitingCount }
    me: null, // response of GET /status/:userId
    polledAt: 0, // performance.now() when `me` arrived
    busy: false,
    offline: false,
  };

  async function api(method, path, body) {
    const res = await fetch(API + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    let data = null;

    try {
      data = await res.json();
    } catch (_) {
      // Empty response body
    }

    if (!res.ok) {
      const err = new Error(
        (data && data.error && data.error.message) ||
          "Request failed (" + res.status + ")",
      );

      err.status = res.status;
      err.code = data && data.error && data.error.code;

      throw err;
    }

    return data;
  }

  async function ensureUser(forceNew) {
    let id = forceNew ? null : localStorage.getItem(USER_KEY);

    if (!id) {
      id = (await api("POST", "/users", {})).userId;
      localStorage.setItem(USER_KEY, id);
    }

    state.userId = id;
    el.userId.textContent = id;
  }

  // ---------- polling ----------

  let pollTimer = null;

  async function poll() {
    clearTimeout(pollTimer);

    try {
      const [drop, me] = await Promise.all([
        api("GET", "/drop"),
        api("GET", "/status/" + state.userId),
      ]);

      state.drop = drop;
      state.me = me;
      state.polledAt = performance.now();
      state.offline = false;
    } catch (err) {
      if (err.code === "USER_NOT_FOUND") {
        // e.g. the database was reset: start over with a fresh user
        await ensureUser(true).catch(() => {});
      } else {
        state.offline = true;
      }
    }

    render();

    pollTimer = setTimeout(poll, POLL_MS);
  }

  // ---------- rendering ----------

  function formatTime(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));

    return (
      String(Math.floor(s / 60)).padStart(2, "0") +
      ":" +
      String(s % 60).padStart(2, "0")
    );
  }

  function remainingSeconds() {
    if (!state.me || state.me.secondsRemaining == null) {
      return null;
    }

    // Server value at poll time minus local time elapsed.
    // This avoids trusting the browser's wall clock.
    return (
      state.me.secondsRemaining - (performance.now() - state.polledAt) / 1000
    );
  }

  function render() {
    const me = state.me;
    const drop = state.drop;

    if (drop) {
      el.pairsLeft.textContent = drop.pairsLeft;

      el.counts.textContent =
        drop.held +
        " on hold · " +
        drop.purchased +
        " sold · " +
        drop.waitingCount +
        " waiting in line";
    }

    if (!me) {
      el.statusText.textContent = state.offline
        ? "Cannot reach the server, retrying…"
        : "Loading…";

      return;
    }

    // ---------- status text ----------

    let text;

    switch (me.status) {
      case "HELD":
        text = "A pair is on hold for you. Pay before the timer runs out!";
        break;

      case "PAYMENT_PENDING":
        text = "Payment received by the provider, waiting for confirmation…";
        break;

      case "WAITING":
        text = "Sold out for now. You are in the waiting line.";
        break;

      case "PURCHASED":
        text =
          me.purchaseCount >= MAX_PURCHASES
            ? "Purchase successful 🎉 You have reached the limit of " +
              MAX_PURCHASES +
              " pairs."
            : "Purchase successful 🎉 You can buy one more pair.";
        break;

      case "REFUND_NEEDED":
        text = "Payment received, but your hold had expired. Refund pending.";
        break;

      default:
        text = "You do not have a pair yet.";
    }

    if (state.offline) {
      text += " (connection problem, retrying…)";
    }

    el.statusText.textContent = text;

    el.purchased.textContent = me.purchaseCount;

    // ---------- countdown ----------

    const showCountdown =
      me.status === "HELD" || me.status === "PAYMENT_PENDING";

    el.countdownRow.hidden = !showCountdown;

    el.countdownLabel.textContent =
      me.status === "PAYMENT_PENDING" ? "Payment window" : "Hold expires in";

    // ---------- queue ----------

    el.queueRow.hidden = me.status !== "WAITING";

    if (me.status === "WAITING") {
      el.queuePos.textContent = me.queuePosition;
    }

    renderTimer();

    // ---------- buttons ----------

    const canBuy =
      ["IDLE", "PURCHASED", "REFUND_NEEDED"].includes(me.status) &&
      me.purchaseCount < MAX_PURCHASES;

    const isSoldOut = drop && drop.pairsLeft === 0;

    // Button text
    el.buyBtn.textContent = isSoldOut ? "Join waiting line" : "Buy";

    // Button enabled/disabled state
    el.buyBtn.disabled = state.busy || !canBuy;

    el.payBtn.disabled = state.busy || me.status !== "HELD";

    el.leaveBtn.disabled = state.busy || me.status !== "WAITING";

    // IMPORTANT:
    // Hide buttons that are irrelevant to the current state.
    el.buyBtn.hidden = !canBuy;
    el.payBtn.hidden = me.status !== "HELD";
    el.leaveBtn.hidden = me.status !== "WAITING";
  }

  function renderTimer() {
    const r = remainingSeconds();

    if (r === null || el.countdownRow.hidden) {
      return;
    }

    el.countdown.textContent = formatTime(r);

    el.countdown.classList.toggle("low", r <= 30);
  }

  setInterval(renderTimer, 250);

  // ---------- actions ----------

  async function act(fn, okMessage) {
    if (state.busy) {
      return;
    }

    state.busy = true;
    el.message.textContent = "";

    render();

    try {
      await fn();

      el.message.textContent = okMessage || "";
    } catch (err) {
      el.message.textContent =
        err.status === 503
          ? "The server is busy, please try again."
          : err.message;
    } finally {
      state.busy = false;
      await poll();
    }
  }

  // ---------- Buy / Join queue ----------

  el.buyBtn.addEventListener("click", () =>
    act(async () => {
      const r = await api("POST", "/buy", {
        userId: state.userId,
      });

      if (r.status === "WAITING") {
        el.message.textContent =
          "Sold out: you joined the line at #" + r.queuePosition + ".";
      }
    }),
  );

  // ---------- Pay ----------

  el.payBtn.addEventListener("click", () =>
    act(async () => {
      const resId = state.me && state.me.reservation && state.me.reservation.id;

      await api("POST", "/pay", {
        userId: state.userId,
        reservationId: resId,
      });
    }, "Payment started. Waiting for confirmation from the payment provider…"),
  );

  // ---------- Leave queue ----------

  el.leaveBtn.addEventListener("click", () =>
    act(
      () =>
        api("POST", "/queue/leave", {
          userId: state.userId,
        }),
      "You left the line.",
    ),
  );

  // ---------- Demo tools ----------

  el.newUserBtn.addEventListener("click", async () => {
    await ensureUser(true);

    state.me = null;
    el.message.textContent = "";

    await poll();
  });

  el.crowdBtn.addEventListener("click", async () => {
    el.crowdBtn.disabled = true;

    const total = 50;

    let done = 0;
    let next = 0;

    async function worker() {
      while (next < total) {
        next++;

        try {
          const { userId } = await api("POST", "/users", {});

          await api("POST", "/buy", {
            userId,
          });
        } catch (_) {
          // Keep going even if an individual simulated buyer fails.
        }

        done++;

        el.demoMessage.textContent =
          "Simulated buyers: " + done + " / " + total;
      }
    }

    await Promise.all(Array.from({ length: 10 }, worker));

    el.demoMessage.textContent =
      "Done: " + total + " simulated buyers clicked Buy.";

    el.crowdBtn.disabled = false;
  });

  // ---------- start ----------

  ensureUser(false)
    .then(poll)
    .catch(() => {
      state.offline = true;
      render();

      setTimeout(() => location.reload(), 3000);
    });
})();
