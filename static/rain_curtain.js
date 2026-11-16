/* Digital Rain Curtain: vanilla port of Originkit "ArgentCloudburst" (no React needed).
   Drop <script src="/static/rain-curtain.js" defer></script> on a page and it mounts a
   fixed full-viewport WebGL2 canvas behind everything (z-index:-1, pointer-events:none).

   - Hover parts the rain around the pointer; sweeping the pointer is wind.
   - Click / tap = lightning down the nearest strands. Hold = downpour.
   - Dark page  -> the original look (silver rain, green light bar).
   - Light page -> same rain drawn as forest-green ink on the paper colour.
   - Theme is detected from the page's real background colour, so it follows both
     data-theme and body.dark-theme toggles.
   - Paused when the tab is hidden, pixel-budgeted, adapts resolution if the GPU is slow,
     respects prefers-reduced-motion, survives a lost GL context.
   Options: set window.RAIN_OPTIONS = {...} before this script, or call RainCurtain.mount({...}). */
(() => {
  "use strict";
  if (window.RainCurtain) return;

  /* ---------- tuning (the original's numbers) ---------- */
  const DEFAULTS = {
    density: 100, bandPosition: 0, zoom: 100, speed: 41,
    hover: 50, wind: 5, downpour: 5, tap: 50, tapEffect: "lightning", // or "splash"
    accent: "#06733f",      // light-bar colour on dark pages
    ink: "#024b31",         // rain colour on light pages
    opacity: 1              // canvas opacity (lower it if text sits directly on the rain)
  };
  const ADV = {
    laneCount: 10, lineFill: 23, dashCell: 175, dashMin: 25, dashMax: 100, fallSpeed: 214, laneJitter: 25,
    twinkleRate: 48, twinkleMin: 55, bandWidth: 28, bandGlow: 33, fringe: 35, endCenter: 80, endSide: 66,
    endJitter: 6, edgeBright: 60, glow: 20, cyanShare: 18, hazeDepth: 60, rimY: 18, rimCurve: 2,
    rimStrength: 55, seed: 0, grain: 0, vignette: 6
  };
  const MAX_DPR = 2, MAX_PIXELS = 2.2e6, LADDER = [1, 0.85, 0.72, 0.6], TIME_WRAP = 3600;
  const WIND_GAIN = 0.17, LEAN_MAX = 0.5, LEAN_W = 7, LEAN_Z = 0.45;
  const POUR_FALL = 1.6, POUR_FLOOR = 0.35, POUR_IN = 0.22, POUR_OUT = 0.8;
  const TAP_SLOTS = 4, TAP_LIFE = 1.6;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);

  /* ---------- shader ----------
     Identical to the original except: the additive light is gathered in `add`, and on a light page
     it is applied as ink (mix toward uInk) instead of being added to the colour. */
  const FRAG = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform vec2 uCenter;
uniform float uSpx;
uniform vec4 uPlace;
uniform float uPxCss;
uniform float uGrainPx;
uniform float uTime;
uniform float uFallT;
uniform vec2 uMouse;
uniform float uHover;
uniform float uLean;
uniform float uPour;
uniform vec4 uTaps[4];
uniform vec3 uBg;
uniform vec3 uBase;
uniform vec3 uAccent;
uniform float uSc;
uniform float uDensity;
uniform float uBandY;
uniform float uPitch;
uniform float uLineW;
uniform float uCell;
uniform float uDashMin;
uniform float uDashMax;
uniform float uFall;
uniform float uJit;
uniform float uTwRate;
uniform float uTwMin;
uniform float uBandW;
uniform float uBandGlow;
uniform float uFringe;
uniform float uEndCenter;
uniform float uEndSide;
uniform float uEndJit;
uniform float uEdge;
uniform float uGlow;
uniform vec3 uTip;
uniform vec3 uCyan;
uniform float uCyanShare;
uniform vec3 uHazeC;
uniform float uHazeDepth;
uniform vec3 uRimC;
uniform float uRimY;
uniform float uRimCurve;
uniform float uRimAmt;
uniform float uSeed;
uniform float uGrain;
uniform float uVig;
uniform float uHoverAmt;
uniform float uTapMode;
uniform float uLight;
uniform vec3 uInk;
out vec4 outColor;

const float PERSP = 2.2;
const float REF_HALF_W = 0.75;
const float TW_SCALE = 0.1667;
const float FADE = 0.06;
const float POUR_DENS = 0.22;
const float POUR_STRETCH = 0.6;
const float POUR_BRIGHT = 0.45;
const float POUR_BAND = 0.9;
const float PART_R = 0.14;
const float RIP_LIFE = 1.6;
const float RIP_REACH = 0.85;
const float RIP_PUSH = 0.012;
const float BOLT_W = 0.03;
const float BOLT_RUN = 5.0;
const float BOLT_DECAY = 6.0;
const float BOLT_FLICK = 55.0;

uint hu(uint x) {
    x ^= x >> 16u; x *= 0x7feb352du;
    x ^= x >> 15u; x *= 0x846ca68bu;
    x ^= x >> 16u;
    return x;
}
float hf(float a, float b, float c) {
    uint h = uint(int(a)) * 0x8da6b343u ^ uint(int(b)) * 0xd8163841u ^ uint(int(c)) * 0xcb1ab31fu ^ uint(uSeed) * 0x9e3779b9u;
    return float(hu(h)) * (1.0 / 4294967295.0);
}

vec2 worldOf(vec2 frag, out bool ok) {
    vec2 p = vec2(frag.x - uCenter.x, uCenter.y - frag.y);
    float D = PERSP * uSpx;
    float den = D * uPlace.z + p.y * uPlace.w;
    ok = den > 1e-3 * D;
    float v = p.y * D / max(den, 1e-3 * D);
    float u = p.x * (D - v * uPlace.w) / D;
    vec2 q = vec2(u * uPlace.x + v * uPlace.y, -u * uPlace.y + v * uPlace.x);
    return q / uSpx;
}

float cover(float f, float a, float s0, float s1) {
    return clamp((min(f + 0.5 * a, s1) - max(f - 0.5 * a, s0)) / a, 0.0, 1.0);
}

void main() {
    bool ok;
    vec2 w = worldOf(gl_FragCoord.xy, ok);
    float pw = max(max(length(dFdx(w)), length(dFdy(w))), 1e-6);
    vec2 fuv = gl_FragCoord.xy / max(uRes, vec2(1.0));
    float fy = 1.0 - fuv.y;
    float env = 0.0;
    float band = 0.0;
    vec3 col = uBg;
    vec3 add = vec3(0.0);

    if (ok) {
        float y = w.y + 0.5;
        float xn = clamp(w.x / REF_HALF_W, -1.0, 1.0);
        float bY = uBandY;
        float sc = max(uSc, 0.05);

        bool mok;
        vec2 dm = w - worldOf(uMouse, mok);
        float hk = mok ? uHover * uHoverAmt : 0.0;
        float g = exp(-dot(dm, dm) / (PART_R * PART_R));
        float part = dm.x * g * min(0.45 * hk, 0.9);
        float shelter = g * g * min(hk, 1.0);
        float near = hk * 4.0 * g * (1.0 - g);

        float push = 0.0;
        float splash = 0.0;
        if (uTapMode < 0.5) {
            for (int i = 0; i < 4; i++) {
                vec4 T = uTaps[i];
                if (T.w <= 0.0) continue;
                bool tok;
                vec2 dv = w - worldOf(T.xy, tok);
                if (!tok) continue;
                float r = length(dv);
                float life = clamp(T.z / RIP_LIFE, 0.0, 1.0);
                float k = 1.0 - life;
                float R = RIP_REACH * (1.0 - k * k * k);
                float wd = 0.03 + 0.08 * life;
                float z = (r - R) / wd;
                float ring = exp(-z * z) * k * k;
                push += dv.x / max(r, 1e-3) * ring * min(T.w, 1.0);
                splash += T.w * (ring + exp(-r * r * 300.0) * exp(-T.z * 6.0));
            }
        }

        float sx = w.x - part - push * RIP_PUSH - uLean * (y - bY);
        float P = sc * uPitch;
        float lane = floor(sx / P);
        float cx = (lane + 0.5 + (hf(lane, 3.0, 7.0) - 0.5) * 0.3) * P;
        float d = abs(sx - cx) * inversesqrt(1.0 + uLean * uLean);
        float hw = max(0.6 * pw * uPxCss, P * uLineW * 0.5);
        float shape = exp(-(d * d) / (hw * hw)) + uGlow * 0.5 * exp(-d / max(P * 0.4, 1e-6));

        float laneX = clamp(cx / (2.0 * REF_HALF_W) + 0.5, 0.0, 1.0);
        float xl = laneX * 2.0 - 1.0;
        float endY = mix(uEndSide, uEndCenter, 1.0 - xl * xl) + (hf(lane, 11.0, 5.0) - 0.5) * 2.0 * uEndJit;
        endY = max(endY, bY + 0.05);
        float top = smoothstep(0.01, 0.06, fy);
        float up = top * mix(uFringe, 1.0, smoothstep(bY - 0.12, bY, y));
        float t = clamp((y - bY) / (endY - bY), 0.0, 1.0);
        float down = pow(1.0 - t, 1.4);
        env = y < bY ? up : down;
        band = exp(-pow((y - bY) / max(uBandW, 1e-3), 2.0));
        float sideF = mix(uEdge, 1.0, 1.0 - pow(abs(xl), 4.0));

        float strike = 0.0;
        float flash = 0.0;
        if (uTapMode > 0.5) {
            for (int i = 0; i < 4; i++) {
                vec4 T = uTaps[i];
                if (T.w <= 0.0) continue;
                bool tok;
                vec2 tw = worldOf(T.xy, tok);
                if (!tok) continue;
                float a = T.z;
                float fl = exp(-a * BOLT_DECAY) * (0.6 + 0.4 * cos(a * BOLT_FLICK));
                float lx = (cx - tw.x) / BOLT_W;
                float takes = step(hf(lane, 71.0, float(i) + floor(T.x)), 0.75);
                float front = bY - 0.06 + a * BOLT_RUN;
                float mask = (1.0 - smoothstep(front - 0.04, front, y)) * smoothstep(bY - 0.08, bY - 0.03, y) * (1.0 - smoothstep(endY, endY + 0.08, y));
                strike = max(strike, exp(-lx * lx) * takes * mask * fl * min(T.w, 1.5));
                flash += T.w * fl * (0.35 + exp(-abs(w.x - tw.x) * 5.0));
            }
        }

        float cellH = max(uCell * sc * mix(0.75, 1.3, hf(lane, 19.0, 4.0)), 1e-5);
        float v = uFall * (1.0 + (hf(lane, 13.0, 1.0) * 2.0 - 1.0) * uJit);
        float yy = y - uFallT * v + hf(lane, 17.0, 9.0) * 10.0;
        float cy = yy / cellH;
        float cl = floor(cy);
        float fr = cy - cl;
        float dens = 0.4 + uDensity;
        float pOn = clamp((0.12 + 0.88 * pow(env, 0.55)) * dens + near * 0.3 + splash * 0.35 - shelter * 0.3 + uPour * POUR_DENS, 0.0, 0.98);
        float on = smoothstep(-FADE, FADE, pOn - hf(lane, cl, 21.0));
        float len = min(1.0, mix(uDashMin, uDashMax, hf(lane, cl, 23.0)) * mix(0.45, 1.0, env) * (1.0 + uPour * POUR_STRETCH));
        float st = hf(lane, cl, 29.0) * max(1.0 - len, 0.0);
        float lit = on * cover(fr, pw / cellH, st, st + len);

        float cellS = max(cellH * 0.22, 1e-5);
        float cs = (y - uFallT * v * 0.6 + hf(lane, 53.0, 3.0) * 10.0) / cellS;
        float cf = floor(cs);
        float spk = step(hf(lane, cf, 57.0), 0.55 * dens) * cover(cs - cf, pw / cellS, 0.05, 0.95);
        float headMix = 1.0 - smoothstep(bY - 0.09, bY - 0.02, y);
        lit = mix(lit, max(lit * 0.5, spk), headMix);

        float ft = uTime * uTwRate * TW_SCALE + hf(lane, cl, 33.0) * 8.0;
        float fi = floor(ft);
        float ff = ft - fi;
        ff = ff * ff * (3.0 - 2.0 * ff);
        float tw = mix(uTwMin, 1.0, mix(hf(lane, cl, fi + 31.0), hf(lane, cl, fi + 32.0), ff));

        float cb = mix(0.5, 1.0, hf(lane, cl, 43.0));
        float lb = mix(0.6, 1.0, hf(lane, 37.0, 2.0));
        float bright = lit * shape * lb * cb * tw * (0.2 + env) * (1.0 + band * 0.8) * sideF * (1.0 + near * 0.9 + splash * 1.6 + flash * 1.2) * (1.0 - 0.75 * shelter) * (1.0 + uPour * POUR_BRIGHT);

        vec3 dc = mix(uTip, uBase, smoothstep(0.08, 0.55, env));
        dc = mix(dc, uAccent, clamp(band * 0.95 + smoothstep(0.75, 1.0, env) * 0.25, 0.0, 1.0));
        float cyan = step(hf(lane, cl, 41.0), uCyanShare) * (1.0 - band);
        dc = mix(dc, uCyan, cyan * 0.55);

        float hz = smoothstep(0.0, 0.08, fy) * (y < bY ? 1.0 : 1.0 - smoothstep(bY, max(uHazeDepth, bY + 0.01), y));
        col = mix(uBg, uHazeC, hz * 0.9 * mix(0.75, 1.0, 1.0 - xn * xn));
        float rimY = uRimY + uRimCurve * xn * xn;
        float rim = exp(-pow((y - rimY) / 0.04, 2.0)) * mix(0.3, 1.0, xn * xn);
        add += uRimC * rim * uRimAmt;
        add += uAccent * band * uBandGlow * 0.35 * sideF * (1.0 + uPour * POUR_BAND);
        add += dc * bright;
        add += uAccent * (hk * g * 0.035 + splash * 0.05 + flash * 0.03) * (0.3 + env);
        add += uAccent * band * uBandGlow * flash * 0.8;
        add += mix(uTip, uAccent, 0.3) * shape * strike * 1.4;
    }

    // Dark page: light is added. Light page: the same light becomes ink laid on the paper.
    if (uLight > 0.5) col = mix(col, uInk, clamp(max(add.r, max(add.g, add.b)) * 1.6, 0.0, 0.92));
    else col += add;

    float vd = length((fuv - 0.5) * 2.0) / 1.4142;
    col *= 1.0 - uVig * smoothstep(0.35, 1.0, vd);
    vec2 gp = floor(gl_FragCoord.xy / uGrainPx);
    float gr = hf(gp.x, gp.y, floor(uTime * 24.0) + 51.0) - 0.5;
    col += gr * uGrain * 0.12 * (0.4 + 0.6 * clamp(env + band, 0.0, 1.0));

    outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

  const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

  const UNIFORMS = [
    "uRes", "uCenter", "uSpx", "uPlace", "uPxCss", "uGrainPx", "uTime", "uFallT", "uMouse", "uHover", "uLean",
    "uPour", "uTaps", "uBg", "uBase", "uAccent", "uSc", "uDensity", "uBandY", "uPitch", "uLineW", "uCell",
    "uDashMin", "uDashMax", "uFall", "uJit", "uTwRate", "uTwMin", "uBandW", "uBandGlow", "uFringe", "uEndCenter",
    "uEndSide", "uEndJit", "uEdge", "uGlow", "uTip", "uCyan", "uCyanShare", "uHazeC", "uHazeDepth", "uRimC",
    "uRimY", "uRimCurve", "uRimAmt", "uSeed", "uGrain", "uVig", "uHoverAmt", "uTapMode", "uLight", "uInk"
  ];

  function buildGL(gl) {
    const sh = (type, src) => {
      const s = gl.createShader(type);
      if (!s) return null;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        if (!gl.isContextLost()) console.error("RainCurtain shader:", gl.getShaderInfoLog(s));
        gl.deleteShader(s);
        return null;
      }
      return s;
    };
    const vs = sh(gl.VERTEX_SHADER, VERT), fs = sh(gl.FRAGMENT_SHADER, FRAG), prog = gl.createProgram();
    if (!vs || !fs || !prog) return null;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, "aPos");
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      if (!gl.isContextLost()) console.error("RainCurtain link:", gl.getProgramInfoLog(prog));
      return null;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const u = {};
    UNIFORMS.forEach(n => { u[n] = gl.getUniformLocation(prog, n); });
    return { gl, prog, u };
  }

  /* median of the first n values, sorted into a reused scratch array */
  function median(src, n, scratch) {
    for (let i = 0; i < n; i++) {
      const v = src[i];
      let j = i - 1;
      while (j >= 0 && scratch[j] > v) { scratch[j + 1] = scratch[j]; j--; }
      scratch[j + 1] = v;
    }
    return scratch[n >> 1];
  }

  /* any CSS colour -> [r,g,b,a] in 0..1, resolved by the browser */
  let probe = null;
  function rgba(css, fallback) {
    if (!probe) { probe = document.createElement("span"); probe.style.display = "none"; document.documentElement.appendChild(probe); }
    probe.style.color = "";
    probe.style.color = css;
    const s = getComputedStyle(probe).color || "";
    const m = s.match(/-?[\d.]+/g);
    if (!m || m.length < 3) return fallback || [0, 0, 0, 1];
    const k = s.startsWith("color(") ? 1 : 1 / 255;       // color(srgb 0.1 0.2 0.3) is already 0..1
    return [m[0] * k, m[1] * k, m[2] * k, m[3] != null ? +m[3] : 1];
  }

  /* light or dark, from the page's real background colour */
  function readTheme() {
    let c = rgba(getComputedStyle(document.body).backgroundColor, [0, 0, 0, 0]);
    if (c[3] < 0.5) c = rgba(getComputedStyle(document.documentElement).backgroundColor, [0, 0, 0, 0]);
    if (c[3] < 0.5) c = [1, 1, 1, 1];
    const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    return { light: lum > 0.5, bg: c };
  }

  function mount(userOpts) {
    const o = Object.assign({}, DEFAULTS, window.RAIN_OPTIONS || {}, userOpts || {});
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const motionK = reduced ? 0.25 : 1;

    const canvas = document.createElement("canvas");
    canvas.id = "rain";
    canvas.setAttribute("aria-hidden", "true");
    Object.assign(canvas.style, {
      position: "fixed", inset: "0", width: "100%", height: "100%", zIndex: "-1",
      pointerEvents: "none", display: "block", opacity: "0",
      transition: "opacity 1.2s cubic-bezier(.23,1,.32,1)"
    });
    document.body.prepend(canvas);
    void canvas.offsetWidth;
    canvas.style.opacity = String(o.opacity);

    // size, buffer, clocks
    let W = 0, H = 0, level = 0, dirty = true, rate = 0, clock = 0, fallT = 0, Sz = 1;
    // pointer (0..1 of the viewport, v runs down)
    let cx = 0, cy = 0, moved = false, inside = false, held = false;
    let tu = 0.5, tv = 0.5, mx = 0.5, my = 0.5, hov = 0, pu = 0.5, pv = 0.5, hadPrev = false;
    let gust = 0, lean = 0, leanV = 0, pour = 0;
    // taps: u, v, age, strength (0 = free slot)
    const taps = new Float64Array(TAP_SLOTS * 4), tapBuf = new Float32Array(TAP_SLOTS * 4);
    let tapNext = 0, tapDirty = true, tapAlive = false;
    // last uploaded per-frame uniforms
    let lTime = NaN, lFall = NaN, lMx = NaN, lMy = NaN, lHov = NaN, lLean = NaN, lPour = NaN;
    // pacing
    const gaps = new Float64Array(15), draws = new Float64Array(9), scratch = new Float64Array(15);
    let gapN = 0, drawN = 0, period = 1000 / 60, basePeriod = 1000, tick = 0, lastTick = -1, lastDraw = -1, drawn = 0, slowSince = -1;
    let running = false, raf = 0, G = null;
    let theme = readTheme();

    const init = () => {
      const gl = canvas.getContext("webgl2", {
        alpha: false, antialias: false, depth: false, stencil: false,
        powerPreference: "low-power", preserveDrawingBuffer: false
      });
      G = gl && !gl.isContextLost() ? buildGL(gl) : null;
      canvas.style.visibility = G ? "visible" : "hidden";   // no WebGL: the page's own background shows
      lTime = lFall = lMx = lMy = lHov = lLean = lPour = NaN;
      tapDirty = true;
      dirty = true;
    };

    /* props + theme -> uniforms. Runs on resize, theme change or context restore, never per frame. */
    const upload = () => {
      const gl = G.gl, u = G.u, f = (n, v) => gl.uniform1f(u[n], v);
      const c3 = (n, c) => gl.uniform3f(u[n], c[0], c[1], c[2]);
      const white = [1, 1, 1], black = [0, 0, 0];
      rate = (clamp(num(o.speed, 41), 0, 100) / 50) * motionK;
      const bw = canvas.width, bh = canvas.height;
      gl.useProgram(G.prog);
      gl.uniform2f(u.uRes, bw, bh);

      const light = theme.light;
      c3("uBg", theme.bg);
      c3("uBase", white);
      c3("uTip", white);
      c3("uCyan", white);
      c3("uRimC", black);
      if (light) {            // light carries intensity only; uInk is the visible colour
        c3("uAccent", white);
        c3("uHazeC", theme.bg);
        c3("uInk", rgba(o.ink, [0.05, 0.36, 0.24, 1]));
      } else {
        c3("uAccent", rgba(o.accent, [0.32, 0.68, 0.19, 1]));
        c3("uHazeC", black);
        c3("uInk", black);
      }
      f("uLight", light ? 1 : 0);

      // The curtain is as tall as the viewport, centred, with the light bar on the top edge.
      const z = clamp(num(o.zoom, 100), 30, 100) / 100;
      f("uSpx", bh * z);
      Sz = Math.max(1, H * z);
      gl.uniform2f(u.uCenter, bw / 2, bh / 2);
      gl.uniform4f(u.uPlace, 1, 0, 1, 0);
      const pxCss = W > 0 ? bw / W : 1;
      f("uPxCss", pxCss);
      f("uGrainPx", Math.max(1, Math.round(pxCss)));

      f("uSc", 0.1);
      f("uDensity", clamp(num(o.density, 100), 0, 100) / 100);
      f("uBandY", clamp(num(o.bandPosition, 0), 0, 80) / 100);
      f("uPitch", 1 / clamp(ADV.laneCount, 10, 400));
      f("uLineW", clamp(ADV.lineFill, 5, 90) / 100);
      f("uCell", clamp(ADV.dashCell, 2, 200) / 1000);
      const dMin = clamp(ADV.dashMin, 1, 100) / 100;
      f("uDashMin", dMin);
      f("uDashMax", Math.max(dMin, clamp(ADV.dashMax, 1, 100) / 100));
      f("uFall", (0.092 * clamp(ADV.fallSpeed, 0, 500)) / 100);
      f("uJit", clamp(ADV.laneJitter, 0, 100) / 100);
      f("uTwRate", clamp(ADV.twinkleRate, 0, 120));
      f("uTwMin", clamp(ADV.twinkleMin, 0, 100) / 100);
      f("uBandW", Math.max(0.005, clamp(ADV.bandWidth, 1, 50) / 100));
      f("uBandGlow", clamp(ADV.bandGlow, 0, 100) / 100);
      f("uFringe", clamp(ADV.fringe, 0, 100) / 100);
      f("uEndCenter", clamp(ADV.endCenter, 5, 100) / 100);
      f("uEndSide", clamp(ADV.endSide, 5, 100) / 100);
      f("uEndJit", clamp(ADV.endJitter, 0, 50) / 100);
      f("uEdge", clamp(ADV.edgeBright, 0, 100) / 100);
      f("uGlow", clamp(ADV.glow, 0, 100) / 100);
      f("uCyanShare", clamp(ADV.cyanShare, 0, 100) / 100);
      f("uHazeDepth", clamp(ADV.hazeDepth, 5, 100) / 100);
      f("uRimY", clamp(ADV.rimY, 0, 100) / 100);
      f("uRimCurve", clamp(ADV.rimCurve, 0, 50) / 100);
      f("uRimAmt", clamp(ADV.rimStrength, 0, 100) / 100);
      f("uSeed", Math.round(clamp(ADV.seed, 0, 9999)));
      f("uGrain", clamp(ADV.grain, 0, 100) / 100);
      f("uVig", light ? 0 : clamp(ADV.vignette, 0, 100) / 100);
      f("uHoverAmt", clamp(num(o.hover, 50), 0, 100) / 50);
      f("uTapMode", o.tapEffect === "splash" ? 0 : 1);
      lTime = lFall = lMx = lMy = lHov = lLean = lPour = NaN;
      tapDirty = true;
    };

    const draw = () => {
      const gl = G.gl, u = G.u;
      const mxb = mx * canvas.width, myb = (1 - my) * canvas.height;
      if (clock !== lTime) gl.uniform1f(u.uTime, (lTime = clock));
      if (fallT !== lFall) gl.uniform1f(u.uFallT, (lFall = fallT));
      if (mxb !== lMx || myb !== lMy) gl.uniform2f(u.uMouse, (lMx = mxb), (lMy = myb));
      if (hov !== lHov) gl.uniform1f(u.uHover, (lHov = hov));
      if (lean !== lLean) gl.uniform1f(u.uLean, (lLean = lean));
      const pourAmt = pour * (clamp(num(o.downpour, 5), 0, 10) / 5);
      if (pourAmt !== lPour) gl.uniform1f(u.uPour, (lPour = pourAmt));
      if (tapDirty || tapAlive) {
        const bw = canvas.width, bh = canvas.height;
        for (let i = 0; i < TAP_SLOTS; i++) {
          const k = i * 4;
          tapBuf[k] = taps[k] * bw;
          tapBuf[k + 1] = (1 - taps[k + 1]) * bh;
          tapBuf[k + 2] = taps[k + 2];
          tapBuf[k + 3] = taps[k + 3];
        }
        gl.uniform4fv(u.uTaps, tapBuf);
        tapDirty = false;
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      drawn++;
    };

    const sizeCanvas = () => {
      if (!G || W <= 0 || H <= 0) return;
      let k = Math.min(MAX_DPR, window.devicePixelRatio || 1) * LADDER[level];
      const px = W * H * k * k;
      if (px > MAX_PIXELS) k *= Math.sqrt(MAX_PIXELS / px);
      k = Math.max(1, k);
      const bw = Math.max(1, Math.round(W * k)), bh = Math.max(1, Math.round(H * k));
      if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
      G.gl.viewport(0, 0, bw, bh);
      dirty = true;
      if (running) { upload(); dirty = false; draw(); }   // resizing wiped the buffer: redraw now
    };

    /* If draws keep arriving late, step the resolution down (never back up: no ping-pong). */
    const adapt = (now, N) => {
      if (!G || drawn < 30 || drawN < draws.length) return;
      const med = median(draws, draws.length, scratch);
      if (med > N * basePeriod * 1.4) {
        if (slowSince < 0) slowSince = now;
        if (now - slowSince > 500 && level < LADDER.length - 1) { level++; slowSince = -1; drawN = 0; sizeCanvas(); }
      } else slowSince = -1;
    };

    const frame = now => {
      raf = 0;
      if (!running || !G) return;
      raf = requestAnimationFrame(frame);
      if (lastTick >= 0) {
        const gap = now - lastTick;
        if (gap > 0 && gap < 200) {
          gaps[gapN++ % gaps.length] = gap;
          if (gapN >= gaps.length && gapN % 15 === 0) {
            period = median(gaps, gaps.length, scratch);
            basePeriod = Math.min(basePeriod, period);
          }
        }
      }
      lastTick = now;
      tick++;
      // Pace by vsync count: a steady ~60 fps on 60/90/120/144 Hz screens alike.
      const N = Math.max(1, Math.floor(1000 / 60 / Math.max(period, 4) + 0.1));

      if (moved && inside && W > 0 && H > 0) { tu = cx / W; tv = cy / H; }
      moved = false;
      if (tick % N !== 0 && !dirty) return;

      const dt = lastDraw < 0 ? 0 : Math.min((now - lastDraw) / 1000, 0.05);
      if (lastDraw >= 0) draws[drawN++ % draws.length] = now - lastDraw;
      lastDraw = now;
      if (dirty) { upload(); dirty = false; }

      // The light follows the cursor in ~40 ms; its strength fades more gently.
      const hovTarget = inside ? 1 : 0, kp = 1 - Math.exp(-dt / 0.04);
      if (hov < 0.01 && inside) { mx = tu; my = tv; }
      else { mx += (tu - mx) * kp; my += (tv - my) * kp; }
      hov += (hovTarget - hov) * (1 - Math.exp(-dt * 6));
      if (hov < 1e-3 && !inside) hov = 0;

      // Wind: pointer sweep speed along x, in curtain heights per second.
      let sweep = 0;
      if (inside && hadPrev && dt > 0) sweep = ((tu - pu) * W) / Sz / dt;
      pu = tu; pv = tv; hadPrev = inside;
      gust += (clamp(sweep, -12, 12) - gust) * (1 - Math.exp(-dt / 0.08));
      if (Math.abs(gust) < 1e-4) gust = 0;
      const windAmt = (clamp(num(o.wind, 5), 0, 10) / 10) * (reduced ? 0.5 : 1);
      const leanTarget = clamp(gust * WIND_GAIN * windAmt, -LEAN_MAX, LEAN_MAX);
      // Damped spring: the curtain swings with the gust and sways once as it settles.
      leanV += (LEAN_W * LEAN_W * (leanTarget - lean) - 2 * LEAN_Z * LEAN_W * leanV) * dt;
      lean += leanV * dt;
      if (leanTarget === 0 && Math.abs(lean) < 2e-4 && Math.abs(leanV) < 2e-3) lean = leanV = 0;

      // Downpour: bursts in while pressed, eases out after.
      pour += ((held ? 1 : 0) - pour) * (1 - Math.exp(-dt / (held ? POUR_IN : POUR_OUT)));
      if (!held && pour < 1e-3) pour = 0;
      const pourAmt = pour * (clamp(num(o.downpour, 5), 0, 10) / 5);

      // Taps age in real time; the frame after the last one dies uploads it cleared.
      tapAlive = false;
      for (let i = 0; i < TAP_SLOTS; i++) {
        const k = i * 4;
        if (taps[k + 3] <= 0) continue;
        taps[k + 2] += dt;
        if (taps[k + 2] >= TAP_LIFE) taps[k + 3] = 0; else tapAlive = true;
        tapDirty = true;
      }

      clock = (clock + dt * rate) % TIME_WRAP;
      fallT = (fallT + dt * (rate * (1 + POUR_FALL * pourAmt) + POUR_FLOOR * pourAmt * motionK)) % TIME_WRAP;

      draw();
      adapt(now, N);

      const settled = Math.abs(hovTarget - hov) < 0.003 && Math.abs(tu - mx) < 1e-3 && Math.abs(tv - my) < 1e-3 &&
        gust === 0 && lean === 0 && pour === 0 && !held && !tapAlive && !tapDirty;
      if (rate <= 0 && settled && !dirty) stop();
    };

    const start = () => {
      if (running || document.hidden || !G) return;
      running = true; lastTick = -1; lastDraw = -1;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    /* ---------- events ---------- */
    init();
    const ro = new ResizeObserver(entries => {
      const cr = entries[entries.length - 1].contentRect;
      if (cr.width === W && cr.height === H) return;
      W = cr.width; H = cr.height;
      sizeCanvas();
      start();
    });
    ro.observe(canvas);

    const onVis = () => { if (document.hidden) stop(); else start(); };
    document.addEventListener("visibilitychange", onVis);

    // Re-read the theme after a toggle (once now, and again after the page's colour transition).
    let themeTimers = [];
    const retheme = () => {
      themeTimers.forEach(clearTimeout);
      themeTimers = [0, 150, 450].map(ms => setTimeout(() => { theme = readTheme(); dirty = true; start(); }, ms));
    };
    const mo = new MutationObserver(retheme);
    const attrs = { attributes: true, attributeFilter: ["class", "data-theme", "style"] };
    mo.observe(document.documentElement, attrs);
    mo.observe(document.body, attrs);

    const interactive = t => t instanceof Element && !!t.closest("a,button,input,select,textarea,summary,label,[role=button]");
    const onMove = e => {
      // Chrome re-sends moves at the same spot after layout; a resting cursor must not keep the loop awake.
      if (inside && e.clientX === cx && e.clientY === cy) return;
      cx = e.clientX; cy = e.clientY; moved = true;
      if (!inside) hadPrev = false;
      inside = true;
      start();
    };
    const onDown = e => {
      onMove(e);
      moved = true;
      if (interactive(e.target)) return;               // pressing a control is not a lightning strike
      held = true;
      if (e.button <= 0) {
        const amt = (clamp(num(o.tap, 50), 0, 100) / 50) * (reduced ? 0.5 : 1);
        if (amt > 0 && W > 0 && H > 0) {
          const k = (tapNext++ % TAP_SLOTS) * 4;
          taps[k] = e.clientX / W;
          taps[k + 1] = e.clientY / H;
          taps[k + 2] = 0;
          taps[k + 3] = amt;
          tapAlive = true; tapDirty = true;
        }
      }
      start();
    };
    const onLeave = () => { inside = false; held = false; start(); };
    const onUp = e => {
      held = false;
      if (e.pointerType !== "mouse") onLeave();        // on touch, lifting the finger ends the hover too
      start();
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onDown, { passive: true });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onLeave);
    window.addEventListener("blur", onLeave);
    document.documentElement.addEventListener("mouseleave", onLeave);

    // Survive a lost GPU context: pause, then rebuild on restore.
    canvas.addEventListener("webglcontextlost", e => { e.preventDefault(); stop(); G = null; });
    canvas.addEventListener("webglcontextrestored", () => { init(); sizeCanvas(); start(); });

    start();

    return {
      canvas,
      destroy() {
        stop(); ro.disconnect(); mo.disconnect();
        themeTimers.forEach(clearTimeout);
        document.removeEventListener("visibilitychange", onVis);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerdown", onDown);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onLeave);
        window.removeEventListener("blur", onLeave);
        document.documentElement.removeEventListener("mouseleave", onLeave);
        canvas.remove();
      }
    };
  }

  window.RainCurtain = { mount };
  if (!window.RAIN_NO_AUTO) {
    const go = () => { window.RainCurtain.instance = mount(); };
    document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", go) : go();
  }
})();