/* Particle Drift (OriginKit) - vanilla JS port of the React/WebGL component.
   Draws drifting dots + proximity lines on a fixed canvas behind the page.
   Colours come from the CSS variables, so light/dark themes work automatically. */
(() => {
  const canvas = document.getElementById("bg");
  if (!canvas) return;
  const gl = canvas.getContext("webgl", { alpha: true, antialias: false, depth: false, premultipliedAlpha: true });
  if (!gl) return;

  // ---- tweak these ----
  const OPT = { density: innerWidth < 700 ? 55 : 130, dotSize: 3.5, speed: 0.5, direction: 0,
                hoverReach: 190, linkDistance: 150, linkThickness: 1, restAlpha: 0.45 };
  const MAX_LINES = 8000, EDGE = 20, MAX_DPR = 2;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const LINE_VERT = `precision highp float;
attribute vec2 a_p0; attribute vec2 a_p1; attribute vec2 a_corner; attribute vec3 a_shade;
uniform vec2 uSize; varying float v_alpha; varying float v_mix; varying float v_off; varying float v_half;
void main(){
  vec2 d=a_p1-a_p0; float len=max(length(d),1e-5); vec2 nrm=vec2(-d.y,d.x)/len;
  float half_=max(a_shade.z*0.5,0.35); float ext=half_+0.75;
  vec2 p=mix(a_p0,a_p1,a_corner.x); p+=nrm*a_corner.y*ext;
  v_alpha=a_shade.x; v_mix=a_shade.y; v_off=a_corner.y*ext; v_half=half_;
  gl_Position=vec4(p.x/uSize.x*2.0-1.0,1.0-p.y/uSize.y*2.0,0.0,1.0);}`;
  const LINE_FRAG = `precision mediump float;
uniform vec3 uBase,uAccent; varying float v_alpha; varying float v_mix; varying float v_off; varying float v_half;
void main(){ float cov=clamp((v_half-abs(v_off))/0.75+0.5,0.0,1.0); float a=v_alpha*cov;
  vec3 col=mix(uBase,uAccent,v_mix); gl_FragColor=vec4(col*a,a);}`;
  const DOT_VERT = `precision highp float;
attribute vec2 a_pos; attribute float a_lit; uniform vec2 uSize; uniform float uDpr,uDot; varying float v_lit;
void main(){ gl_PointSize=max(1.0,uDot*uDpr); v_lit=a_lit;
  gl_Position=vec4(a_pos.x/uSize.x*2.0-1.0,1.0-a_pos.y/uSize.y*2.0,0.0,1.0);}`;
  const DOT_FRAG = `precision mediump float;
uniform vec3 uBase,uAccent; uniform float uRestAlpha; varying float v_lit;
void main(){ float d=length(gl_PointCoord-0.5)*2.0; float disc=1.0-smoothstep(0.72,1.0,d);
  vec3 col=mix(uBase,uAccent,v_lit); float a=disc*mix(uRestAlpha,1.0,v_lit);
  if(a<=0.004) discard; gl_FragColor=vec4(col*a,a);}`;

  const compile = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.error(gl.getShaderInfoLog(s)); return null; } return s; };
  const link = (v, f) => { const vs = compile(gl.VERTEX_SHADER, v), fs = compile(gl.FRAGMENT_SHADER, f); if (!vs || !fs) return null;
    const p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
    return gl.getProgramParameter(p, gl.LINK_STATUS) ? p : null; };
  const lineProg = link(LINE_VERT, LINE_FRAG), dotProg = link(DOT_VERT, DOT_FRAG);
  if (!lineProg || !dotProg) return;

  // ---- theme colours from CSS variables ----
  const hex = s => { s = s.trim().replace("#", ""); if (s.length === 3) s = [...s].map(c => c + c).join("");
    const n = parseInt(s, 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
  let cBase = [.4, .44, .4], cAccent = [.05, .36, .24];
  const readColors = () => { const cs = getComputedStyle(document.documentElement);
    cBase = hex(cs.getPropertyValue("--mut")); cAccent = hex(cs.getPropertyValue("--accent")); };
  readColors();
  new MutationObserver(readColors).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // ---- buffers ----
  const CORNERS = [[0,-1],[1,-1],[1,1],[0,-1],[1,1],[0,1]];
  const lP0 = new Float32Array(MAX_LINES * 12), lP1 = new Float32Array(MAX_LINES * 12),
        lCorner = new Float32Array(MAX_LINES * 12), lShade = new Float32Array(MAX_LINES * 18);
  for (let e = 0; e < MAX_LINES; e++) for (let c = 0; c < 6; c++) { const k = (e * 6 + c) * 2; lCorner[k] = CORNERS[c][0]; lCorner[k + 1] = CORNERS[c][1]; }
  const mk = (data, size, usage) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data || size, usage); return b; };
  const bP0 = mk(null, lP0.byteLength, gl.DYNAMIC_DRAW), bP1 = mk(null, lP1.byteLength, gl.DYNAMIC_DRAW),
        bCorner = mk(lCorner, 0, gl.STATIC_DRAW), bShade = mk(null, lShade.byteLength, gl.DYNAMIC_DRAW);

  const N = OPT.density;
  const nx = new Float32Array(N), ny = new Float32Array(N), nSpd = new Float32Array(N),
        gPos = new Float32Array(N * 2), gLit = new Float32Array(N);
  const bGPos = mk(null, gPos.byteLength, gl.DYNAMIC_DRAW), bGLit = mk(null, gLit.byteLength, gl.DYNAMIC_DRAW);

  let cw = innerWidth, ch = innerHeight, dpr = 1;
  const resize = () => { const ow = cw, oh = ch; cw = innerWidth; ch = innerHeight;
    dpr = Math.min(devicePixelRatio || 1, MAX_DPR);
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    for (let i = 0; i < N; i++) { nx[i] *= cw / ow; ny[i] *= ch / oh; } };
  for (let i = 0; i < N; i++) { nx[i] = Math.random() * cw; ny[i] = Math.random() * ch; nSpd[i] = (Math.random() * .4 + .1) * 60; }
  resize(); addEventListener("resize", resize);

  const ptr = { x: -1e4, y: -1e4 };
  addEventListener("pointermove", e => { ptr.x = e.clientX; ptr.y = e.clientY; }, { passive: true });
  document.addEventListener("pointerleave", () => { ptr.x = ptr.y = -1e4; });

  const th = OPT.direction * Math.PI / 180, dirX = Math.sin(th), dirY = Math.cos(th);
  const attr = (prog, name, buf, size) => { const l = gl.getAttribLocation(prog, name); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0); return l; };
  const uni = (prog, n) => gl.getUniformLocation(prog, n);

  let last = performance.now(), lines = 0;
  const pushLine = (x0, y0, x1, y1, a0, a1, mix, w) => {
    if (lines >= MAX_LINES) return;
    for (let c = 0; c < 6; c++) { const k = (lines * 6 + c) * 2, s = (lines * 6 + c) * 3;
      lP0[k] = x0; lP0[k + 1] = y0; lP1[k] = x1; lP1[k + 1] = y1;
      lShade[s] = CORNERS[c][0] === 0 ? a0 : a1; lShade[s + 1] = mix; lShade[s + 2] = w; }
    lines++; };

  const frame = now => {
    const dt = Math.min(.05, (now - last) / 1000); last = now; lines = 0;
    const sp = reduce ? 0 : OPT.speed, reach = OPT.hoverReach, L = OPT.linkDistance;
    for (let i = 0; i < N; i++) {
      nx[i] += nSpd[i] * dirX * dt * sp; ny[i] += nSpd[i] * dirY * dt * sp;
      if (nx[i] < -EDGE) { nx[i] = cw + EDGE; ny[i] = Math.random() * ch; } else if (nx[i] > cw + EDGE) { nx[i] = -EDGE; ny[i] = Math.random() * ch; }
      if (ny[i] < -EDGE) { ny[i] = ch + EDGE; nx[i] = Math.random() * cw; } else if (ny[i] > ch + EDGE) { ny[i] = -EDGE; nx[i] = Math.random() * cw; }
      const dx = ptr.x - nx[i], dy = ptr.y - ny[i], d = Math.hypot(dx, dy), lit = d < reach ? 1 : 0;
      if (lit) { const a = .5 * (1 - d / reach); pushLine(nx[i], ny[i], ptr.x, ptr.y, a, a, 1, OPT.linkThickness); }
      gPos[i * 2] = nx[i]; gPos[i * 2 + 1] = ny[i]; gLit[i] = lit;
    }
    const l2 = L * L;
    for (let i = 0; i < N && lines < MAX_LINES; i++) for (let j = i + 1; j < N && lines < MAX_LINES; j++) {
      const dx = nx[i] - nx[j], dy = ny[i] - ny[j], dd = dx * dx + dy * dy; if (dd >= l2) continue;
      const a = .16 * (1 - Math.sqrt(dd) / L); pushLine(nx[i], ny[i], nx[j], ny[j], a, a, 0, OPT.linkThickness); }

    gl.viewport(0, 0, canvas.width, canvas.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    if (lines) { const v = lines * 6; gl.useProgram(lineProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, bP0); gl.bufferSubData(gl.ARRAY_BUFFER, 0, lP0.subarray(0, v * 2));
      gl.bindBuffer(gl.ARRAY_BUFFER, bP1); gl.bufferSubData(gl.ARRAY_BUFFER, 0, lP1.subarray(0, v * 2));
      gl.bindBuffer(gl.ARRAY_BUFFER, bShade); gl.bufferSubData(gl.ARRAY_BUFFER, 0, lShade.subarray(0, v * 3));
      const a = [attr(lineProg, "a_p0", bP0, 2), attr(lineProg, "a_p1", bP1, 2), attr(lineProg, "a_corner", bCorner, 2), attr(lineProg, "a_shade", bShade, 3)];
      gl.uniform2f(uni(lineProg, "uSize"), cw, ch); gl.uniform3f(uni(lineProg, "uBase"), ...cBase); gl.uniform3f(uni(lineProg, "uAccent"), ...cAccent);
      gl.drawArrays(gl.TRIANGLES, 0, v); a.forEach(l => gl.disableVertexAttribArray(l)); }

    gl.useProgram(dotProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, bGPos); gl.bufferSubData(gl.ARRAY_BUFFER, 0, gPos);
    gl.bindBuffer(gl.ARRAY_BUFFER, bGLit); gl.bufferSubData(gl.ARRAY_BUFFER, 0, gLit);
    const b = [attr(dotProg, "a_pos", bGPos, 2), attr(dotProg, "a_lit", bGLit, 1)];
    gl.uniform2f(uni(dotProg, "uSize"), cw, ch); gl.uniform1f(uni(dotProg, "uDpr"), dpr); gl.uniform1f(uni(dotProg, "uDot"), OPT.dotSize);
    gl.uniform1f(uni(dotProg, "uRestAlpha"), OPT.restAlpha); gl.uniform3f(uni(dotProg, "uBase"), ...cBase); gl.uniform3f(uni(dotProg, "uAccent"), ...cAccent);
    gl.drawArrays(gl.POINTS, 0, N); b.forEach(l => gl.disableVertexAttribArray(l));

    if (!reduce) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
})();
