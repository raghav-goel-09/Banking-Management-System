/* Liquid Carve: cursor tracking for buttons (frontend only, no backend/form changes).
   Paste this at the very END of static/app.js, after the final `})();`.
   It is its own self-contained function, so it does not touch anything else. */
(() => {
  if (!matchMedia("(hover: hover) and (pointer: fine)").matches ||
      matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const SEL = "button, .btn", TAU = 0.07;   // TAU = how "liquid" the bite lags behind the cursor (seconds)
  const st = new Map();                      // hovered button -> { x, y, tx, ty }
  let raf = 0, last = 0;

  const tick = now => {
    const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
    const k = 1 - Math.exp(-dt / TAU);
    st.forEach((s, b) => {
      s.x += (s.tx - s.x) * k;
      s.y += (s.ty - s.y) * k;
      b.style.setProperty("--mx", s.x.toFixed(1) + "px");
      b.style.setProperty("--my", s.y.toFixed(1) + "px");
    });
    if (st.size) raf = requestAnimationFrame(tick); else { raf = 0; last = 0; }
  };

  const local = (e, b) => {
    const r = b.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  document.addEventListener("pointerover", e => {
    const b = e.target.closest?.(SEL);
    if (!b || b.disabled || st.has(b)) return;
    const [x, y] = local(e, b);                       // bite starts exactly where the cursor enters
    st.set(b, { x, y, tx: x, ty: y });
    b.style.setProperty("--mx", x + "px");
    b.style.setProperty("--my", y + "px");
    if (!raf) raf = requestAnimationFrame(tick);
  });

  document.addEventListener("pointermove", e => {
    const b = e.target.closest?.(SEL), s = b && st.get(b);
    if (s) [s.tx, s.ty] = local(e, b);
  });

  document.addEventListener("pointerout", e => {
    const b = e.target.closest?.(SEL);
    if (b && !b.contains(e.relatedTarget)) st.delete(b);   // bite shrinks where the cursor left
  });
})();