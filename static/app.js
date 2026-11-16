/* SecureBank front-end behaviour. Talks to Flask via forms + fetch(). */
(() => {
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.documentElement.classList.add("js");

  // Theme toggle (saved in browser; default follows the OS)
  const root = document.documentElement;
  const setTheme = t => { root.dataset.theme = t; try { localStorage.setItem("theme", t); } catch {} };
  $("#theme")?.addEventListener("click", () => setTheme(root.dataset.theme === "dark" ? "light" : "dark"));

  // Mark current page in nav
  $$("nav a").forEach(a => { if (a.pathname === location.pathname) a.setAttribute("aria-current", "page"); });

  // Staggered entrance
  $$("main .card, main .tile, main .msg").forEach((el, i) => { el.classList.add("reveal"); el.style.setProperty("--i", Math.min(i, 8)); });

  // Count-up for money figures (only elements that already show ₹)
  const fmt = (n, d) => "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
  const countUp = el => {
    const txt = el.textContent;
    if (!txt.includes("₹")) return;                       // plain counts stay untouched
    const target = parseFloat(txt.replace(/[^\d.]/g, ""));
    const d = /\.\d/.test(txt) ? 2 : 0;                   // keep the decimals the server sent
    if (isNaN(target) || reduce) return;
    const t0 = performance.now(), dur = 700;
    (function step(t) {
      const p = Math.min((t - t0) / dur, 1), e = 1 - Math.pow(1 - p, 4);   // ease-out quart
      el.textContent = fmt(target * e, d);
      if (p < 1) requestAnimationFrame(step); else el.textContent = fmt(target, d);
    })(t0);
  };
  $$(".big, .tile-bal").forEach(countUp);

  // Flash messages -> toasts
  const stack = document.createElement("div"); stack.id = "toasts"; stack.setAttribute("role", "status"); document.body.append(stack);
  $$("main > .msg").forEach(m => {
    const t = document.createElement("div"); t.className = "toast " + (m.classList.contains("ok") ? "ok" : "error"); t.textContent = m.textContent;
    stack.append(t); m.remove();
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 220); }, 5200);
  });

  // Prevent double-submits (critical for money forms) + loading state
  $$("form").forEach(f => f.addEventListener("submit", () => {
    const b = $("button:not(.sec)", f); if (b) setTimeout(() => b.setAttribute("aria-busy", "true"), 0);
  }));

  // Click-to-copy account numbers
  document.addEventListener("click", async e => {
    const el = e.target.closest("[data-copy]"); if (!el) return;
    try { await navigator.clipboard.writeText(el.dataset.copy); el.classList.add("copied"); const o = el.textContent; el.textContent = "Copied ✓";
      setTimeout(() => { el.textContent = o; el.classList.remove("copied"); }, 1200); } catch {}
  });

  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // Live customer search (staff) – re-fetches the Flask page and swaps the results table
  const q = $("input[name=q]");
  if (q) q.addEventListener("input", debounce(async () => {
    const res = await fetch("/staff?q=" + encodeURIComponent(q.value), { headers: { "X-Requested-With": "fetch" } });
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const fresh = $("#results", doc), old = $("#results"); if (fresh && old) old.innerHTML = fresh.innerHTML;
  }, 220));

  // Beneficiary name check on transfer form -> GET /api/account-lookup
  const to = $("input[name=to_number]"), hint = $("#bene");
  if (to && hint) to.addEventListener("input", debounce(async () => {
    const n = to.value.trim(); if (n.length < 13) { hint.textContent = ""; hint.className = "hint"; return; }
    const d = await (await fetch("/api/account-lookup?number=" + encodeURIComponent(n))).json();
    hint.textContent = d.found ? "✓ " + d.name : "No active account with that number"; hint.className = "hint " + (d.found ? "good" : "bad");
  }, 250));

  // Liquid carve buttons: the "bite" follows the cursor (sets --mx/--my on the hovered button).
  document.addEventListener("DOMContentLoaded", () => {
    // ==========================================
    // 1. WORKFLOW STEP SIMULATOR
    // ==========================================
    const stations = document.querySelectorAll(".station");
    const codeDisplay = document.querySelector(".code-inspector pre code");
    const aliceBalance = document.getElementById("alice-balance");
    const bobBalance = document.getElementById("bob-balance");
    const ledgerTableBody = document.querySelector(".ledger-tbody");
    const nextBtn = document.getElementById("next-btn");
    const prevBtn = document.getElementById("prev-btn");
    const autoplayBtn = document.getElementById("autoplay-btn");

    let currentStep = 0;
    let isPlaying = false;
    let timer = null;

    const steps = [
        {
            code: `@app.route('/transfer', methods=['POST'])\ndef transfer_funds():\n    # Step 1: Verify Session & PIN\n    token = request.headers.get('Authorization')\n    user = verify_jwt_token(token)\n    if not verify_pin(user.id, request.form.get('pin')):\n        return jsonify({"error": "Invalid PIN"}), 401`
        },
        {
            code: `    # Step 2: Check Sufficient Funds\n    sender = Account.query.filter_by(user_id=user.id).first()\n    amount = 1250.75\n    if sender.balance < amount:\n        return jsonify({"error": "Insufficient Funds"}), 400`
        },
        {
            code: `    # Step 3: Initiate Atomic ACID Transaction\n    try:\n        db.session.begin_nested()\n        logger.info("Starting atomic transfer session...")`
        },
        {
            code: `    # Step 4: Execute Double-Entry Ledger Updates\n    # Alice: ₹50,000.00 -> ₹48,749.25\n    sender.balance -= 1250.75\n    # Bob: ₹20,000.00 -> ₹21,250.75\n    receiver.balance += 1250.75\n    db.session.add(LedgerEntry(type='DEBIT', amt=1250.75))`
        },
        {
            code: `    # Step 5: Commit & Notify\n        db.session.commit()\n        send_sms_alert(user.phone, "Transferred ₹1,250.75 successfully.")\n        return jsonify({"status": "SUCCESS", "tx_id": "TXN9842"})`
        }
    ];

    function updateStep(index) {
        currentStep = index;
        stations.forEach((st, i) => {
            if (i === currentStep) st.classList.add("active");
            else st.classList.remove("active");
        });

        if (codeDisplay) codeDisplay.textContent = steps[currentStep].code;

        if (currentStep >= 3) {
            if (aliceBalance) aliceBalance.textContent = "₹48,749.25";
            if (bobBalance) bobBalance.textContent = "₹21,250.75";
            
            if (ledgerTableBody && ledgerTableBody.children.length === 0) {
                const tr = document.createElement("tr");
                tr.innerHTML = `<td>#TX9842</td><td>Alice → Bob</td><td>₹1,250.75</td><td><span class="badge success">Completed</span></td>`;
                ledgerTableBody.appendChild(tr);
            }
        } else {
            if (aliceBalance) aliceBalance.textContent = "₹50,000.00";
            if (bobBalance) bobBalance.textContent = "₹20,000.00";
            if (ledgerTableBody && currentStep === 0) ledgerTableBody.innerHTML = "";
        }
    }

    if (nextBtn) nextBtn.addEventListener("click", () => updateStep((currentStep + 1) % stations.length));
    if (prevBtn) prevBtn.addEventListener("click", () => updateStep((currentStep - 1 + stations.length) % stations.length));
    
    if (autoplayBtn) {
        autoplayBtn.addEventListener("click", () => {
            if (isPlaying) {
                clearInterval(timer);
                autoplayBtn.textContent = "Auto Play Tour";
                isPlaying = false;
            } else {
                autoplayBtn.textContent = "Pause Tour";
                isPlaying = true;
                timer = setInterval(() => {
                    currentStep = (currentStep + 1) % stations.length;
                    updateStep(currentStep);
                }, 2500);
            }
        });
    }

    updateStep(0);

    /* Scan Grid Button: vanilla port of the Originkit component.
   Add class "scan-grid-button" to an <a> or <button> containing
   <span class="sgb-icon"> (optional) and <span class="sgb-label">.
   Brackets are tweened in JS (the path shape changes); the scan band, glow
   and glitch are CSS. Radius and border width are read from the element. */
(() => {
  const NS = "http://www.w3.org/2000/svg";
  const IDLE = 8, HOVER = 65;                       // bracket arm length, % of half the short side
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ease = t => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;   // easeInOut

  const armFor = (pct, w, h) => (pct / 100) * Math.min(w, h) / 2;

  const cornerPaths = (w, h, r, arm) => {
    const o = .75;                                  // half the stroke width
    const R0 = Math.min(r, w / 2, h / 2), R = Math.max(.01, R0 - o);
    const aH = Math.min(arm, Math.max(0, h / 2 - R0)), aW = Math.min(arm, Math.max(0, w / 2 - R0));
    return [
      `M ${o} ${R0 + aH} L ${o} ${R0} A ${R} ${R} 0 0 1 ${R0} ${o} L ${R0 + aW} ${o}`,
      `M ${w - R0 - aW} ${o} L ${w - R0} ${o} A ${R} ${R} 0 0 1 ${w - o} ${R0} L ${w - o} ${R0 + aH}`,
      `M ${w - o} ${h - R0 - aH} L ${w - o} ${h - R0} A ${R} ${R} 0 0 1 ${w - R0} ${h - o} L ${w - R0 - aW} ${h - o}`,
      `M ${R0 + aW} ${h - o} L ${R0} ${h - o} A ${R} ${R} 0 0 1 ${o} ${h - R0} L ${o} ${h - R0 - aH}`
    ];
  };

  function init(el) {
    if (el.dataset.sgb) return;
    el.dataset.sgb = "1";

    // brackets
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "sgb-svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("preserveAspectRatio", "none");
    const paths = [0, 1, 2, 3].map(() => svg.appendChild(document.createElementNS(NS, "path")));

    // scan band
    const scan = document.createElement("div");
    scan.className = "sgb-scan";
    scan.setAttribute("aria-hidden", "true");

    el.prepend(svg, scan);

    // per-letter spans (for the optional glitch)
    const label = el.querySelector(".sgb-label");
    if (label) {
      const text = label.textContent;
      label.setAttribute("aria-hidden", "true");
      el.setAttribute("aria-label", text.trim());
      label.textContent = "";
      [...text].forEach((c, i) => {
        const s = document.createElement("span");
        s.className = "sgb-char"; s.textContent = c; s.style.setProperty("--i", i);
        label.append(s);
      });
    }

    // geometry
    let w = 0, h = 0, cur = IDLE, raf = 0;
    const draw = pct => {
      const cs = getComputedStyle(el);
      const bw = parseFloat(cs.borderTopWidth) || 0;
      const r = Math.max(0, (parseFloat(cs.borderTopLeftRadius) || 0) - bw);
      cornerPaths(w, h, r, armFor(pct, w, h)).forEach((d, i) => paths[i].setAttribute("d", d));
    };
    const measure = () => {
      const nw = el.clientWidth, nh = el.clientHeight;
      if (!nw || !nh || (nw === w && nh === h)) return;
      w = nw; h = nh;
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      draw(cur);
    };
    measure();
    new ResizeObserver(measure).observe(el);

    // hover: brackets grow 8% -> 65% over 0.3s, easeInOut
    const tweenTo = to => {
      cancelAnimationFrame(raf);
      const from = cur, t0 = performance.now(), dur = reduce ? 0 : 300;
      const step = now => {
        const p = dur ? Math.min((now - t0) / dur, 1) : 1;
        cur = from + (to - from) * ease(p);
        draw(cur);
        if (p < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    const on = () => { el.classList.add("is-active"); tweenTo(HOVER); };
    const off = () => { el.classList.remove("is-active"); tweenTo(IDLE); };

    el.addEventListener("pointerenter", on);
    el.addEventListener("pointerleave", off);
    el.addEventListener("focus", () => { if (el.matches(":focus-visible")) on(); });
    el.addEventListener("blur", off);
  }

  const boot = () => document.querySelectorAll(".scan-grid-button").forEach(init);
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", boot) : boot();
})();

    // ==========================================
    // 2. THEME TOGGLE
    // ==========================================
    const themeToggle = document.getElementById("theme-toggle");
    if (themeToggle) {
        themeToggle.addEventListener("click", () => {
            document.body.classList.toggle("dark-theme");
        });
    }
});
  // Works for mouse, pen and touch; with reduced motion it follows instantly instead of easing.
  (() => {
    const SEL = "button, .btn", TAU = 0.07, st = new Map();
    let raf = 0, last = 0;
    const put = (b, x, y) => { b.style.setProperty("--mx", x.toFixed(1) + "px"); b.style.setProperty("--my", y.toFixed(1) + "px"); };
    const local = (e, b) => { const r = b.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const btn = e => (e.target instanceof Element ? e.target.closest(SEL) : null);

    const tick = now => {
      const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
      const k = reduce ? 1 : 1 - Math.exp(-dt / TAU);
      st.forEach((s, b) => { s.x += (s.tx - s.x) * k; s.y += (s.ty - s.y) * k; put(b, s.x, s.y); });
      if (st.size) raf = requestAnimationFrame(tick); else { raf = 0; last = 0; }
    };
    const start = (e, b) => {
      const [x, y] = local(e, b);
      st.set(b, { x, y, tx: x, ty: y }); put(b, x, y);          // the bite begins exactly under the cursor
      if (!raf) raf = requestAnimationFrame(tick);
    };

    document.addEventListener("pointerover", e => { const b = btn(e); if (b && !b.disabled && !st.has(b)) start(e, b); });
    document.addEventListener("pointerdown", e => { const b = btn(e); if (b && !b.disabled) start(e, b); });
    document.addEventListener("pointermove", e => {
      const b = btn(e); if (!b) return;
      if (!st.has(b)) { start(e, b); return; }
      const s = st.get(b); [s.tx, s.ty] = local(e, b);
    });
    document.addEventListener("pointerout", e => { const b = btn(e); if (b && !b.contains(e.relatedTarget)) st.delete(b); });
    ["pointerup", "pointercancel"].forEach(ev => document.addEventListener(ev, e => {
      if (e.pointerType !== "mouse") { const b = btn(e); if (b) st.delete(b); }
    }));
  })();
})();