// Herald frontend — vanilla JS, hash-based routing, no build step, no framework.
//
// If your backend isn't running on localhost:8000, change API_BASE below —
// nothing else in this file needs to change.
// IMPORTANT: When deploying to Cloudflare Pages, change this to your live backend URL (e.g., "https://hermes-backend.onrender.com")
const API_BASE = "http://localhost:8000";

// ---------------------------------------------------------------------------
// Auth / storage helpers
// ---------------------------------------------------------------------------

const Auth = {
  getToken: () => localStorage.getItem("herald_token"),
  setToken: (token) => localStorage.setItem("herald_token", token),
  clearToken: () => localStorage.removeItem("herald_token"),
  getUser: () => {
    const raw = localStorage.getItem("herald_user");
    return raw ? JSON.parse(raw) : null;
  },
  setUser: (user) => localStorage.setItem("herald_user", JSON.stringify(user)),
  isLoggedIn: () => !!Auth.getToken(),
  logout: () => {
    Auth.clearToken();
    localStorage.removeItem("herald_user");
    location.hash = "#/";
  },
};

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------

async function api(path, { method = "GET", body = null, auth = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth && Auth.getToken()) headers["X-Auth-Token"] = Auth.getToken();

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new ApiError(0, "Could not reach the Herald backend. Is it running?");
  }

  let data = null;
  try {
    data = await response.json();
  } catch (_) {
    // empty body is fine
  }

  if (!response.ok) {
    throw new ApiError(response.status, (data && data.detail) || `Request failed (${response.status})`);
  }

  return data;
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastTimer = null;
function toast(message, { error = false } = {}) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.toggle("is-error", error);
  el.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("is-visible"), 3200);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function mount(html) {
  document.getElementById("app").innerHTML = html;
}

// ---------------------------------------------------------------------------
// Stamped dispatch slip — Herald's signature component.
// Reused on the dashboard's recent-activity rows and the meeting detail page.
// ---------------------------------------------------------------------------

function renderSlip(item, { editable = true, mini = false } = {}) {
  const isDone = item.status === "done";
  const badgeText = isDone ? "SENT" : "PENDING";
  return `
    <div class="slip ${isDone ? "is-done" : ""} ${mini ? "slip-mini" : ""}" data-item-id="${item.id}">
      <div class="slip-badge" data-role="toggle" title="Toggle status">${badgeText}</div>
      <div class="slip-body">
        <div class="slip-text" data-role="text" ${editable ? 'contenteditable="true" data-editable="true"' : ""}>${escapeHtml(item.text)}</div>
        <div class="slip-meta">
          <span class="slip-owner" data-role="owner" ${editable ? 'contenteditable="true" data-editable="true"' : ""}>${item.owner ? escapeHtml(item.owner) : "unassigned"}</span>
          ${item.is_edited ? '<span class="slip-edited-tag">edited</span>' : ""}
        </div>
      </div>
    </div>
  `;
}

function wireSlipEvents(container, onUpdate) {
  container.querySelectorAll(".slip").forEach((slipEl) => {
    const itemId = slipEl.dataset.itemId;

    const toggleEl = slipEl.querySelector('[data-role="toggle"]');
    toggleEl.addEventListener("click", async () => {
      const isDone = slipEl.classList.contains("is-done");
      try {
        await api(`/api/action-items/${itemId}`, {
          method: "PATCH",
          body: { status: isDone ? "pending" : "done" },
        });
        slipEl.classList.toggle("is-done");
        toggleEl.textContent = slipEl.classList.contains("is-done") ? "SENT" : "PENDING";
        onUpdate && onUpdate();
      } catch (err) {
        toast(err.message, { error: true });
      }
    });

    slipEl.querySelectorAll('[data-editable="true"]').forEach((editEl) => {
      editEl.addEventListener("blur", async () => {
        const field = editEl.dataset.role === "owner" ? "owner" : "text";
        const value = editEl.textContent.trim();
        try {
          await api(`/api/action-items/${itemId}`, {
            method: "PATCH",
            body: { [field]: value },
          });
        } catch (err) {
          toast(err.message, { error: true });
        }
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const routes = [
  { pattern: /^#\/?$/, view: viewLanding },
  { pattern: /^#\/signup$/, view: viewSignup },
  { pattern: /^#\/login$/, view: viewLogin },
  { pattern: /^#\/admin$/, view: viewAdmin, private: true },
  { pattern: /^#\/dashboard$/, view: viewDashboard, private: true },
  { pattern: /^#\/meeting\/([^/]+)$/, view: viewMeetingDetail, private: true },
  { pattern: /^#\/checkout$/, view: viewCheckoutPlans, private: true },
  { pattern: /^#\/checkout-simulated$/, view: viewCheckoutPayment, private: true },
];

function router() {
  const hash = location.hash || "#/";
  for (const route of routes) {
    const match = hash.match(route.pattern);
    if (match) {
      if (route.private && !Auth.isLoggedIn()) {
        location.hash = "#/signup";
        return;
      }
      route.view(...match.slice(1));
      return;
    }
  }
  mount(`<div class="empty-state"><h2>Page not found</h2><a href="#/" class="btn btn-ghost">Back home</a></div>`);
}

window.addEventListener("hashchange", router);
window.addEventListener("DOMContentLoaded", router);

// ---------------------------------------------------------------------------
// View: Landing
// ---------------------------------------------------------------------------

function viewLanding() {
  mount(`
    <div class="app-shell">
      <nav class="nav">
        <div class="nav-inner">
          <a href="#/" class="logo"><span class="logo-mark">H</span>Herald</a>
          <div class="nav-links">
            <a href="#how" class="nav-anchor">How it works</a>
            <a href="#pricing" class="nav-anchor">Pricing</a>
          </div>
          <div class="nav-actions">
            <a href="#/signup" class="btn btn-ghost btn-sm">Log in</a>
            <a href="#/signup" class="btn btn-primary btn-sm">Try it free</a>
          </div>
        </div>
      </nav>

      <header class="container hero">
        <div>
          <div class="eyebrow">Meeting follow-through, automated</div>
          <h1>Your meetings end.<br>The follow-through doesn't have to.</h1>
          <p class="subhead">Notes get taken, action items quietly die somewhere between the call and the calendar — nobody's fault, just entropy. Herald catches it.</p>
          <div class="hero-ctas">
            <form id="waitlist-form" style="display:flex; gap:8px; width:100%;">
              <input type="email" id="wl-email" required placeholder="Enter your email" style="padding:12px 14px; border-radius:var(--radius); border:1px solid rgba(255,255,255,0.1); background:rgba(0,0,0,0.4); color:#fff; flex:1;" />
              <button type="submit" class="btn btn-primary" id="wl-btn">Join Waitlist</button>
            </form>
            <p style="margin-top:10px; font-size:13px;" class="muted">Or <a href="#/login" style="color:var(--signal-teal);">log in</a> if you have an account.</p>
          </div>
        </div>
        <div class="resolve-anim">
          <div class="scramble-text">
            asked abt the roadmap thing?? sara said maybe. dave: metrics due... someone check w/ legal on the contract??? next wk sync tuesday i think. procurement waiting on approval from??? need to loop in finance before eow probably
          </div>
          <div class="resolve-card">
            ${renderSlip({ id: "preview", text: "Send the vendor contract to legal for review", owner: "Sara", status: "pending", is_edited: false }, { editable: false })}
          </div>
        </div>
      </header>

      <section class="container section-tight" id="how">
        <h2>How it works</h2>
        <div class="steps-grid">
          <div class="step">
            <div class="step-number">01</div>
            <h3>Paste your notes or transcript</h3>
            <p>However messy. Herald doesn't need clean formatting.</p>
          </div>
          <div class="step">
            <div class="step-number">02</div>
            <h3>Herald extracts the summary, owners, and a drafted follow-up in seconds</h3>
            <p>Powered by Hermes, running end to end on your own agent stack.</p>
          </div>
          <div class="step">
            <div class="step-number">03</div>
            <h3>Chase what's still pending — Herald tracks it so you don't have to</h3>
            ${renderSlip({ id: "preview2", text: "Confirm Q3 budget owner", owner: "Dave", status: "done", is_edited: false }, { editable: false, mini: true })}
          </div>
        </div>
      </section>

      <section class="container section-tight">
        <h2>What it looks like</h2>
        <div class="preview-frame">
          <div class="preview-toolbar"><span class="preview-dot"></span><span class="preview-dot"></span><span class="preview-dot"></span></div>
          <div class="grid-2">
            <div>
              <div class="section-label">Summary</div>
              <p class="muted">Team aligned on the Q3 roadmap; budget sign-off is the remaining blocker before kickoff.</p>
              <div class="section-label" style="margin-top:20px;">Members</div>
              <span class="member-chip">Sara</span><span class="member-chip">Dave</span><span class="member-chip">Priya</span>
            </div>
            <div class="action-items-list">
              ${renderSlip({ id: "p3", text: "Send the vendor contract to legal", owner: "Sara", status: "pending", is_edited: false }, { editable: false })}
              ${renderSlip({ id: "p4", text: "Confirm Q3 budget owner", owner: "Dave", status: "done", is_edited: false }, { editable: false })}
            </div>
          </div>
        </div>
      </section>

      <section class="container section-tight">
        <h2>Not another summarizer</h2>
        <p class="muted">Otter and Fireflies stop at the transcript. Herald follows through.</p>
        <div class="compare-grid">
          <div class="compare-col">
            <h4>Summary</h4>
            <p class="muted">Table stakes — every tool has this now.</p>
          </div>
          <div class="compare-col">
            <h4>Owned action items</h4>
            <p class="muted">Extracted, assigned, and tracked per meeting.</p>
          </div>
          <div class="compare-col is-differentiator">
            <h4>Actually chased</h4>
            <p class="muted">Herald keeps status on every item until it's done — this is the part everyone else skips.</p>
          </div>
        </div>
      </section>

      <section class="container section-tight" id="pricing">
        <h2>Pricing</h2>
        <div class="pricing-grid">
          <div class="price-card">
            <div class="section-label">Free</div>
            <div class="price-tag">$0</div>
            <ul>
              <li>3 meetings</li>
              <li>All core features</li>
              <li>No card required</li>
            </ul>
            <a href="#/signup" class="btn btn-ghost btn-block">Start free</a>
          </div>
          <div class="price-card is-paid">
            <div class="section-label" style="color:var(--signal-teal);">Paid</div>
            <div class="price-tag">$5<span class="muted" style="font-size:15px;">/mo</span></div>
            <ul>
              <li>Unlimited meetings</li>
              <li>All core features</li>
              <li>Priority follow-up chat</li>
            </ul>
            <a href="#/signup" class="btn btn-primary btn-block">Go unlimited</a>
          </div>
        </div>
      </section>

      <section class="footer-cta">
        <h2>Ready to stop losing action items?</h2>
        <a href="#/signup" class="btn btn-primary">Try it free</a>
      </section>

      <footer class="site-footer">
        <span class="logo"><span class="logo-mark">H</span>Herald</span>
        <span>© 2026 Herald. Built for the GrowthX Hermes Buildathon.</span>
      </footer>
    </div>
  `);

  setTimeout(() => {
    const wlForm = document.getElementById("waitlist-form");
    if (wlForm) {
      wlForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const email = document.getElementById("wl-email").value.trim();
        const btn = document.getElementById("wl-btn");
        btn.disabled = true;
        btn.textContent = "Joining...";
        try {
          await api("/api/waitlist", { method: "POST", body: { email }, auth: false });
          toast("You're on the waitlist!");
          document.getElementById("wl-email").value = "";
        } catch (err) {
          toast(err.message, { error: true });
        } finally {
          btn.disabled = false;
          btn.textContent = "Join Waitlist";
        }
      });
    }
  }, 0);
}

// ---------------------------------------------------------------------------
// View: Signup & Login
// ---------------------------------------------------------------------------

function viewSignup() {
  mount(`
    <div class="auth-shell">
      <div class="auth-card">
        <a href="#/" class="logo" style="margin-bottom:24px; display:inline-flex;"><span class="logo-mark">H</span>Herald</a>
        <h2>Get started</h2>
        <span class="muted">Create a secure account to continue.</span>
        <form id="signup-form">
          <div class="field">
            <label for="su-name">Name</label>
            <input id="su-name" type="text" required autocomplete="name" />
          </div>
          <div class="field">
            <label for="su-email">Email</label>
            <input id="su-email" type="email" required autocomplete="email" />
          </div>
          <div class="field">
            <label for="su-password">Password</label>
            <input id="su-password" type="password" required />
          </div>
          <button type="submit" class="btn btn-primary btn-block">Create account</button>
          <p style="margin-top:16px;font-size:14px;" class="muted">Already have an account? <a href="#/login" style="color:var(--signal-teal);">Log in</a></p>
          <div id="signup-error" class="form-error"></div>
        </form>
      </div>
    </div>
  `);

  document.getElementById("signup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("su-name").value.trim();
    const email = document.getElementById("su-email").value.trim();
    const password = document.getElementById("su-password").value.trim();
    const errorEl = document.getElementById("signup-error");
    errorEl.textContent = "";

    try {
      await api("/api/signup", { method: "POST", body: { name, email, password }, auth: false });
      toast("Account created! Please log in.");
      location.hash = "#/login";
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
}

function viewLogin() {
  mount(`
    <div class="auth-shell">
      <div class="auth-card">
        <a href="#/" class="logo" style="margin-bottom:24px; display:inline-flex;"><span class="logo-mark">H</span>Herald</a>
        <h2>Welcome back</h2>
        <span class="muted">Log in to your account.</span>
        <form id="login-form">
          <div class="field">
            <label for="li-email">Email</label>
            <input id="li-email" type="email" required autocomplete="email" />
          </div>
          <div class="field">
            <label for="li-password">Password</label>
            <input id="li-password" type="password" required />
          </div>
          <button type="submit" class="btn btn-primary btn-block">Log in</button>
          <p style="margin-top:16px;font-size:14px;" class="muted">Don't have an account? <a href="#/signup" style="color:var(--signal-teal);">Sign up</a></p>
          <div id="login-error" class="form-error"></div>
        </form>
      </div>
    </div>
  `);

  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("li-email").value.trim();
    const password = document.getElementById("li-password").value.trim();
    const errorEl = document.getElementById("login-error");
    errorEl.textContent = "";

    try {
      const data = await api("/api/login", { method: "POST", body: { email, password }, auth: false });
      Auth.setToken(data.token);
      Auth.setUser(data.user);
      if (data.user.role === 'admin') {
        location.hash = "#/admin";
      } else {
        location.hash = "#/dashboard";
      }
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
}

// ---------------------------------------------------------------------------
// View: Dashboard
// ---------------------------------------------------------------------------

async function viewDashboard() {
  mount(`
    <div class="app-shell">
      ${renderTopbar()}
      <div class="dash-main" id="dash-main">
        <div class="loading-shell" style="min-height:200px;"><div class="stamp-spinner"></div></div>
      </div>
    </div>
  `);
  wireTopbar();

  try {
    const [analytics, meetings] = await Promise.all([api("/api/analytics"), api("/api/meetings")]);
    renderDashboardBody(analytics, meetings);
  } catch (err) {
    document.getElementById("dash-main").innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
  }
}

function renderDashboardBody(analytics, meetings) {
  const gated = analytics.tier === "free" && analytics.meetings_used >= 3;

  document.getElementById("dash-main").innerHTML = `
    <div class="stats-strip">
      <div class="stat-tile"><div class="stat-value">${analytics.total_meetings}</div><div class="stat-label">Total meetings</div></div>
      <div class="stat-tile"><div class="stat-value">${analytics.total_action_items}</div><div class="stat-label">Action items</div></div>
      <div class="stat-tile"><div class="stat-value">${Math.round(analytics.completion_rate * 100)}%</div><div class="stat-label">Completion rate</div></div>
      <div class="stat-tile"><div class="stat-value">${analytics.tier === "paid" ? "Unlimited" : `${analytics.meetings_used}/3`}</div><div class="stat-label">${analytics.tier === "paid" ? "Paid plan" : "Free meetings used"}</div></div>
    </div>

    <div class="new-meeting-panel">
      <div class="dash-header-row">
        <h3>New meeting</h3>
        <span class="disabled-pill" title="Coming soon">Teams / Meet import — coming soon</span>
      </div>
      ${
        gated
          ? `<p class="muted">You've used all 3 free meetings. <a href="#/checkout" style="color:var(--signal-teal);">Upgrade to keep going.</a></p>`
          : `
        <form id="new-meeting-form">
          <div class="field">
            <label for="nm-title">Title</label>
            <input id="nm-title" type="text" placeholder="e.g. Weekly sync — Jul 12" required />
          </div>
          <div class="field">
            <label for="nm-transcript">Paste your notes or transcript</label>
            <textarea id="nm-transcript" required placeholder="Paste anything — messy notes are fine."></textarea>
          </div>
          <button type="submit" class="btn btn-primary" id="nm-submit">Process meeting</button>
          <div id="nm-error" class="form-error"></div>
        </form>
      `
      }
    </div>

    <h3>Recent activity</h3>
    <div class="meeting-list">
      ${
        meetings.length === 0
          ? `<div class="empty-state">No meetings yet. Paste your first one above.</div>`
          : meetings
              .map(
                (m) => `
        <a href="#/meeting/${m.id}" class="meeting-row">
          <div>
            <div class="meeting-row-title">${escapeHtml(m.title)}</div>
            <div class="meeting-row-meta mono">${formatDate(m.created_at)} · ${m.action_items_done}/${m.action_item_count} done</div>
          </div>
          <div class="slip-badge" style="border-color:${m.action_item_count > 0 && m.action_items_done === m.action_item_count ? "var(--signal-teal)" : "var(--stamp-amber)"}; color:${m.action_item_count > 0 && m.action_items_done === m.action_item_count ? "var(--signal-teal)" : "var(--stamp-amber)"}; width:38px; height:38px; font-size:8px;">
            ${m.action_item_count > 0 && m.action_items_done === m.action_item_count ? "SENT" : "PENDING"}
          </div>
        </a>
      `
              )
              .join("")
      }
    </div>
  `;

  const form = document.getElementById("new-meeting-form");
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const title = document.getElementById("nm-title").value.trim();
      const transcript = document.getElementById("nm-transcript").value.trim();
      const errorEl = document.getElementById("nm-error");
      const submitBtn = document.getElementById("nm-submit");
      errorEl.textContent = "";
      submitBtn.disabled = true;
      submitBtn.textContent = "Processing…";

      try {
        const meeting = await api("/api/meetings", { method: "POST", body: { title, transcript } });
        location.hash = `#/meeting/${meeting.id}`;
      } catch (err) {
        if (err.status === 402) {
          errorEl.innerHTML = `Free tier limit reached. <a href="#/checkout" style="color:var(--signal-teal);">Upgrade to continue.</a>`;
        } else {
          errorEl.textContent = err.message;
        }
        submitBtn.disabled = false;
        submitBtn.textContent = "Process meeting";
      }
    });
  }
}

function renderTopbar() {
  const user = Auth.getUser();
  return `
    <div class="topbar">
      <a href="#/dashboard" class="logo"><span class="logo-mark">H</span>Herald</a>
      <div class="nav-actions">
        <span class="muted mono" style="font-size:13px;">${user ? escapeHtml(user.name) : ""}</span>
        ${user && user.role === 'admin' ? '<a href="#/admin" class="btn btn-ghost btn-sm">Admin</a>' : ''}
        <button class="btn btn-ghost btn-sm" id="logout-btn">Log out</button>
      </div>
    </div>
  `;
}

function wireTopbar() {
  const btn = document.getElementById("logout-btn");
  if (btn) btn.addEventListener("click", Auth.logout);
}

// ---------------------------------------------------------------------------
// View: Meeting detail
// ---------------------------------------------------------------------------

async function viewMeetingDetail(meetingId) {
  mount(`
    <div class="app-shell">
      ${renderTopbar()}
      <div class="dash-main" id="detail-main">
        <div class="loading-shell" style="min-height:200px;"><div class="stamp-spinner"></div></div>
      </div>
    </div>
  `);
  wireTopbar();

  let meeting, chatHistory;
  try {
    [meeting, chatHistory] = await Promise.all([
      api(`/api/meetings/${meetingId}`),
      api(`/api/chat/${meetingId}`).catch(() => []),
    ]);
  } catch (err) {
    document.getElementById("detail-main").innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
    return;
  }

  renderMeetingDetailBody(meeting, chatHistory);
}

function renderMeetingDetailBody(meeting, chatHistory) {
  document.getElementById("detail-main").innerHTML = `
    <a href="#/dashboard" class="btn-text">&larr; Back to dashboard</a>
    <div class="dash-header-row" style="margin-top:10px;">
      <h2>${escapeHtml(meeting.title)}</h2>
      <span class="muted mono" style="font-size:12px;">${formatDate(meeting.created_at)}</span>
    </div>

    <div class="meeting-detail-grid">
      <div class="detail-col">
        <div class="card">
          <div class="section-label">Summary</div>
          <p>${escapeHtml(meeting.summary) || '<span class="muted">No summary generated.</span>'}</p>
          <div class="section-label" style="margin-top:20px;">Members</div>
          <div>${
            meeting.members.length
              ? meeting.members.map((m) => `<span class="member-chip">${escapeHtml(m)}</span>`).join("")
              : '<span class="muted">None detected.</span>'
          }</div>
        </div>

        <div class="card">
          <div class="section-label">Action items</div>
          <div class="action-items-list" id="action-items-list">
            ${
              meeting.action_items.length
                ? meeting.action_items.map((item) => renderSlip(item)).join("")
                : '<span class="muted">No action items extracted.</span>'
            }
          </div>
        </div>

        <div class="card">
          <div class="dash-header-row">
            <div class="section-label" style="margin-bottom:0;">Follow-up email</div>
            <button class="btn btn-ghost btn-sm" id="copy-email-btn">Copy to clipboard</button>
          </div>
          <div class="email-box">${escapeHtml(meeting.follow_up_email) || "No email drafted."}</div>
        </div>
      </div>

      <div class="detail-col">
        <div class="card">
          <div class="section-label">Ask Herald about this meeting</div>
          <div class="chat-panel">
            <div class="chat-messages" id="chat-messages">
              ${chatHistory.map((m) => renderChatMsg(m)).join("")}
            </div>
            <form class="chat-input-row" id="chat-form">
              <input type="text" id="chat-input" placeholder="e.g. did we decide who owns the budget doc?" autocomplete="off" />
              <button type="submit" class="btn btn-primary btn-sm">Ask</button>
            </form>
          </div>
        </div>
      </div>
    </div>
  `;

  wireSlipEvents(document.getElementById("action-items-list"));

  document.getElementById("copy-email-btn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(meeting.follow_up_email || "");
      toast("Email copied to clipboard");
    } catch (_) {
      toast("Couldn't copy — select the text manually", { error: true });
    }
  });

  const chatForm = document.getElementById("chat-form");
  chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("chat-input");
    const message = input.value.trim();
    if (!message) return;

    const messagesEl = document.getElementById("chat-messages");
    messagesEl.insertAdjacentHTML("beforeend", renderChatMsg({ role: "user", content: message }));
    input.value = "";
    messagesEl.scrollTop = messagesEl.scrollHeight;

    try {
      const reply = await api("/api/chat", { method: "POST", body: { meeting_id: meeting.id, message } });
      messagesEl.insertAdjacentHTML("beforeend", renderChatMsg(reply));
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
}

function renderChatMsg(msg) {
  return `<div class="chat-msg role-${msg.role}">${escapeHtml(msg.content)}</div>`;
}

// ---------------------------------------------------------------------------
// View: Admin Dashboard
// ---------------------------------------------------------------------------

async function viewAdmin() {
  mount(`
    <div class="app-shell">
      ${renderTopbar()}
      <div class="dash-main" id="admin-main">
        <div class="loading-shell" style="min-height:200px;"><div class="stamp-spinner"></div></div>
      </div>
    </div>
  `);
  wireTopbar();

  try {
    const data = await api("/api/admin/stats");
    let usersHtml = data.users.map(u => `
      <div class="meeting-row" style="margin-bottom:10px;">
        <div>
          <div class="meeting-row-title">${escapeHtml(u.name)} <span class="muted" style="font-size:12px;">(${escapeHtml(u.email)})</span></div>
          <div class="meeting-row-meta mono">Role: ${u.role} | Tier: ${u.tier} | Meetings: ${u.meetings_used}</div>
        </div>
        <div style="font-weight:bold;color:var(--signal-teal);">Logins: ${u.login_count}</div>
      </div>
    `).join("");

    let waitlistHtml = data.waitlist.map(w => `
      <div class="meeting-row" style="margin-bottom:10px;">
        <div>
          <div class="meeting-row-title">${escapeHtml(w.email)}</div>
          <div class="meeting-row-meta mono">Joined: ${formatDate(w.created_at)}</div>
        </div>
      </div>
    `).join("");

    document.getElementById("admin-main").innerHTML = `
      <h2>Admin Dashboard</h2>
      <div style="margin-top:32px;">
        <h3>Users</h3>
        ${usersHtml || '<p class="muted">No users found.</p>'}
      </div>
      <div style="margin-top:32px;">
        <h3>Waitlist</h3>
        ${waitlistHtml || '<p class="muted">No waitlist entries.</p>'}
      </div>
    `;
  } catch (err) {
    document.getElementById("admin-main").innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
  }
}

// ---------------------------------------------------------------------------
// View: Checkout (simulated) — see backend main.py for the create/confirm
// checkout seam. This page never talks to a real payment rail.
// ---------------------------------------------------------------------------

function viewCheckoutPlans() {
  mount(`
    <div class="app-shell">
      ${renderTopbar()}
      <div class="dash-main">
        <a href="#/dashboard" class="btn-text">&larr; Back to dashboard</a>
        <h2 style="margin-top:10px;">Upgrade to Herald Paid</h2>
        <p class="muted">Unlimited meetings, same Herald, one flat price.</p>
        <div class="pricing-grid">
          <div class="price-card">
            <div class="section-label">Free</div>
            <div class="price-tag">$0</div>
            <ul><li>3 meetings</li><li>All core features</li></ul>
          </div>
          <div class="price-card is-paid">
            <div class="section-label" style="color:var(--signal-teal);">Paid</div>
            <div class="price-tag">$5<span class="muted" style="font-size:15px;">/mo</span></div>
            <ul><li>Unlimited meetings</li><li>All core features</li><li>Priority follow-up chat</li></ul>
            <button class="btn btn-primary btn-block" id="start-checkout-btn">Upgrade now</button>
          </div>
        </div>
      </div>
    </div>
  `);
  wireTopbar();

  document.getElementById("start-checkout-btn").addEventListener("click", async () => {
    try {
      const session = await api("/api/checkout", { method: "POST" });
      location.hash = session.checkout_url;
    } catch (err) {
      toast(err.message, { error: true });
    }
  });
}

function viewCheckoutPayment() {
  mount(`
    <div class="checkout-shell">
      <div class="checkout-card">
        <div class="checkout-stamp">SIMULATED CHECKOUT</div>
        <h2>Pay $5.00 / mo</h2>
        <span class="muted" style="display:block; margin-bottom:24px;">This is a mock payment screen — no real card rail is connected. See the project README for details.</span>
        <form id="pay-form">
          <div class="checkout-field">
            <label>Card number</label>
            <input type="text" value="4242 4242 4242 4242" maxlength="19" required />
          </div>
          <div class="checkout-row">
            <div class="checkout-field">
              <label>Expiry</label>
              <input type="text" value="12/29" required />
            </div>
            <div class="checkout-field">
              <label>CVC</label>
              <input type="text" value="123" required />
            </div>
          </div>
          <div class="checkout-field">
            <label>Name on card</label>
            <input type="text" value="${escapeHtml((Auth.getUser() || {}).name || "")}" required />
          </div>
          <button type="submit" class="btn btn-amber btn-block" id="pay-btn">Pay $5</button>
        </form>
      </div>
    </div>
  `);

  document.getElementById("pay-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("pay-btn");
    btn.disabled = true;
    btn.textContent = "Processing…";

    try {
      await api("/api/checkout/confirm", { method: "POST" });
      const user = Auth.getUser();
      if (user) {
        user.tier = "paid";
        Auth.setUser(user);
      }
      toast("You're upgraded — unlimited meetings unlocked");
      location.hash = "#/dashboard";
    } catch (err) {
      toast(err.message, { error: true });
      btn.disabled = false;
      btn.textContent = "Pay $5";
    }
  });
}
