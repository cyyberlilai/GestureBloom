(function () {
/**
 * gesture.js — 手部识别 + 手势数学 + 状态机
 *
 * 依赖 MediaPipe Tasks Vision（HandLandmarker，21 关键点，浏览器本地推理）。
 * 核心只有三件事：
 *   1) 用「手掌尺度」归一化，消掉手离摄像头远近的影响
 *   2) 一阶平滑 + 死区，消掉抖动
 *   3) 每只手各自校准 MIN/MAX，消掉个体差异
 */

const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];
const TIPS = [8, 12, 16, 20];

/* ---- 挥手判定参数 ----
 * 觉得太灵敏（没挥手也切换）→ 调大 SWIPE_DIST / SWIPE_VELOCITY
 * 觉得不灵敏（挥了没反应）→ 调小这两个值
 */
const SWIPE_WINDOW = 260;    // 采样窗口（ms）：只在这个时间窗内算位移
const SWIPE_OPEN = 1.34;     // 张掌阈值（1.3 左右为半张，1.6 为全张）
const SWIPE_DIST = 0.20;     // 位移阈值（占画面宽度）
const SWIPE_VELOCITY = 1.05; // 速度阈值（画面宽度/秒）
const SWIPE_COOLDOWN = 650;  // 两次切换的最小间隔（ms）
const SWIPE_REARM_MS = 220;  // 触发后手要停稳多久才接受下一次
const SWIPE_MIN_SPAN = 140;  // 采样至少要覆盖这么久，避免两帧抖动就触发

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

async function loadVision() {
  const urls = [
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs',
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14?module',
  ];
  let lastErr;
  for (const u of urls) {
    try {
      const m = await import(/* @vite-ignore */ u);
      if (m && m.HandLandmarker && m.FilesetResolver) return m;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('MediaPipe 加载失败');
}

/* ---------------- 几何 ---------------- */

function toVec(lm, aspect) {
  // 归一化坐标 → 等比空间（否则 16:9 的 x/y 尺度不一致，距离全错）
  return { x: lm.x * aspect, y: lm.y, z: (lm.z || 0) * aspect };
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function palmScale(lm, aspect) {
  return Math.max(1e-4, dist(toVec(lm[0], aspect), toVec(lm[5], aspect)));
}

/** 拇指尖(4) ↔ 食指尖(8)，用 手腕(0)↔食指根(5) 归一化 */
function pinchRatio(lm, aspect) {
  return dist(toVec(lm[4], aspect), toVec(lm[8], aspect)) / palmScale(lm, aspect);
}

/** 张掌程度：四个指尖到手腕的平均距离 / 手掌尺度。握拳≈0.9，张开≈1.6 */
function openness(lm, aspect) {
  const w = toVec(lm[0], aspect);
  const s = palmScale(lm, aspect);
  const sum = TIPS.reduce((acc, i) => acc + dist(toVec(lm[i], aspect), w), 0);
  return sum / TIPS.length / s;
}

/* ---------------- 控制器 ---------------- */

class GestureController {
  /**
   * @param {object} o
   * @param {HTMLVideoElement} o.video
   * @param {HTMLCanvasElement} [o.overlay]  骨架叠加层
   * @param {(p:number)=>void} o.onProgress   0..1
   * @param {(dir:number)=>void} o.onSwipe    -1 / +1
   * @param {(s:string,msg:string)=>void} o.onState
   * @param {(p:number)=>void} o.onPercent
   * @param {(txt:string)=>void} o.onSecond
   */
  constructor(o) {
    Object.assign(this, o);
    this.switchable = o.switchable !== false;
    this.state = 'idle';
    this.running = false;
    this.smooth = 0;
    this.lastT = -1;
    this.controlWrist = null;
    this.min = Number(localStorage.getItem('flora.pinchMin')) || 0.12;
    this.max = Number(localStorage.getItem('flora.pinchMax')) || 1.10;
    this.swipe = { hist: [], who: null, armed: true, last: 0, stillSince: 0 };
    this.calib = null;
  }

  async start() {
    if (!this.landmarker) {
      const { FilesetResolver, HandLandmarker } = await loadVision();
      const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
      this.landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.6,
        minTrackingConfidence: 0.6,
      });
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false,
    });
    this.video.srcObject = stream;
    // 某些环境 play() 可能长时间不 resolve，别把整个启动流程卡住
    await Promise.race([
      this.video.play().catch(() => {}),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
    if (!this.video.videoWidth) {
      await new Promise((r) => {
        const done = () => r();
        this.video.addEventListener('loadedmetadata', done, { once: true });
        setTimeout(done, 1500);
      });
    }
    this.aspect = (this.video.videoWidth || 640) / (this.video.videoHeight || 480);
    this.running = true;
    this.setState('idle', '等待手部进入画面');
    this.tick();
  }

  stop() {
    this.running = false;
    const s = this.video.srcObject;
    if (s) s.getTracks().forEach((t) => t.stop());
    this.video.srcObject = null;
    this.setState('off', '手势互动已关闭');
  }

  setState(state, msg) {
    if (this.state !== state || this._msg !== msg) {
      this.state = state;
      this._msg = msg;
      this.onState?.(state, msg);
    }
  }

  /* -------- 主循环：推理与渲染同帧，避免骨架和花不同步 -------- */
  tick = () => {
    if (!this.running) return;
    const v = this.video;
    if (v.readyState >= 2 && v.currentTime !== this.lastT) {
      this.lastT = v.currentTime;
      let res = null;
      try {
        res = this.landmarker.detectForVideo(v, performance.now());
      } catch {
        /* 单帧失败忽略 */
      }
      if (res) this.process(res);
    }
    requestAnimationFrame(this.tick);
  };

  process(res) {
    const hands = res.landmarks || [];
    const aspect = this.aspect || 1;

    // 用「与上一帧手腕最近」的规则保持控制手身份稳定，避免 01/02 来回跳
    let control = null;
    let second = null;
    if (hands.length === 1) {
      control = hands[0];
    } else if (hands.length >= 2) {
      const c = this.controlWrist;
      if (c) {
        const sorted = [...hands].sort(
          (a, b) =>
            Math.hypot(a[0].x - c.x, a[0].y - c.y) - Math.hypot(b[0].x - c.x, b[0].y - c.y)
        );
        control = sorted[0];
        second = sorted[1];
      } else {
        control = hands[0];
        second = hands[1];
      }
    }

    if (control) this.controlWrist = { x: control[0].x, y: control[0].y };

    this.drawOverlay(control, second);

    /* ---- 无手 ---- */
    if (!control) {
      this.swipe.hist.length = 0;
      this.swipe.who = null;
      this.swipe.armed = true;
      this.onSecond?.('等待第二只手');
      if (this.calib) return;
      this.setState('idle', '等待手部进入画面');
      return;
    }

    /* ---- 校准 ---- */
    const raw = pinchRatio(control, aspect);
    if (this.calib) {
      this.pushCalib(raw);
      this.onPercent?.(0);
      return;
    }

    /* ---- 挥手：必须是一次「张开手掌 + 快速划过」，慢速漂移不触发 ---- */
    const now = performance.now();
    const swipeHand = second || control;
    const who = second ? 'second' : 'control';
    let swiping = false;

    if (!swipeHand) {
      this.swipe.hist.length = 0;
      this.swipe.who = null;
      this.swipe.armed = true;
    } else {
      // 换了一只手 → 重新采样，避免两只手的坐标差被当成一次挥手
      if (this.swipe.who !== who) {
        this.swipe.who = who;
        this.swipe.hist.length = 0;
        this.swipe.armed = true;
      }

      const x = 1 - swipeHand[9].x; // 与镜像画面一致的视觉方向
      const op = openness(swipeHand, aspect);
      const h = this.swipe.hist;

      h.push({ t: now, x, op });
      while (h.length && now - h[0].t > SWIPE_WINDOW) h.shift();

      const first = h[0];
      const dt = Math.max(0.001, (now - first.t) / 1000);
      const dist = x - first.x;      // 窗口内总位移
      const v = dist / dt;           // 速度（画面宽度/秒）
      const openCount = h.reduce((n, s) => n + (s.op > SWIPE_OPEN ? 1 : 0), 0);
      const span = now - first.t;
      const palmOk =
        h.length >= 4 &&
        span >= SWIPE_MIN_SPAN &&
        openCount >= h.length * 0.7; // 窗口内 70% 时间是张掌
      const fast = Math.abs(v) > SWIPE_VELOCITY;

      // 张掌且快速移动 → 冻结花开，避免张开手掌时花开满
      if (palmOk && fast) swiping = true;

      // 触发：整段张掌 + 位移够大 + 速度够快 + 已重新武装
      if (
        this.swipe.armed &&
        palmOk &&
        fast &&
        Math.abs(dist) > SWIPE_DIST &&
        now - this.swipe.last > SWIPE_COOLDOWN
      ) {
        this.onSwipe?.(dist > 0 ? 1 : -1);
        this.swipe.last = now;
        this.swipe.armed = false;
        h.length = 0;               // 清空，必须重新起手才算下一次
        this.onSecond?.('已挥手');
      }

      // 触发后必须「停稳」一小会儿才重新武装，
      // 否则挥手结束后手回摆会被当成反向挥手，画面又切回去
      if (!this.swipe.armed) {
        if (Math.abs(v) < SWIPE_VELOCITY * 0.3) {
          if (!this.swipe.stillSince) this.swipe.stillSince = now;
          if (now - this.swipe.stillSince > SWIPE_REARM_MS) {
            this.swipe.armed = true;
            this.swipe.stillSince = 0;
          }
        } else {
          this.swipe.stillSince = 0;
        }
      }
    }

    /* ---- 01 控制手：捏合 → 花开 ---- */
    if (!swiping) {
      const t = clamp((raw - this.min) / Math.max(1e-3, this.max - this.min), 0, 1);
      // 死区：微小变化不更新，静止时画面不抖
      if (Math.abs(t - this.smooth) > 0.002) {
        this.smooth += (t - this.smooth) * 0.18;
      }
      this.onProgress?.(clamp(this.smooth, 0, 1));
      this.onPercent?.(Math.round(clamp(this.smooth, 0, 1) * 100));
    }

    this.onSecond?.(second ? '已识别' : '等待第二只手');
    this.setState(second ? 'dual' : 'single', second ? '可切换花朵' : '控制手已识别');
  }

  /* ---------------- 切换场景后重置开合基线 ---------------- */
  resetSmooth(v = 0) {
    this.smooth = v;
    this.swipe.hist.length = 0;
    this.swipe.armed = true;
    this.swipe.stillSince = 0;
  }

  /* ---------------- 校准：张开记 MAX，捏合记 MIN ---------------- */
  async calibrate() {
    if (this.calib) return false;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    this.setState('calibrating', '校准 · 请张开五指，保持 1.5 秒');
    await sleep(400);
    const hi = await this.sample(1500);
    this.setState('calibrating', '校准 · 请捏合拇指与食指，保持 1.5 秒');
    await sleep(400);
    const lo = await this.sample(1500);

    if (hi && lo && hi.p90 > lo.p10 + 0.08) {
      this.max = hi.p90 * 0.95;
      this.min = lo.p10 + (hi.p90 - lo.p10) * 0.03;
      localStorage.setItem('flora.pinchMax', String(this.max));
      localStorage.setItem('flora.pinchMin', String(this.min));
      this.smooth = 0;
      this.setState('single', '校准完成');
      return true;
    }
    this.setState('single', '校准失败，请再试一次');
    return false;
  }

  sample(ms) {
    return new Promise((resolve) => {
      // 手始终不在画面里时 pushCalib 不会被调用，必须有超时兜底，否则校准永久挂起
      let timer = 0;
      const finish = (out) => {
        clearTimeout(timer);
        this.calib = null;
        resolve(out);
      };
      timer = setTimeout(() => finish(null), ms + 1500);
      this.calib = { buf: [], until: performance.now() + ms, resolve: finish };
    });
  }

  pushCalib(raw) {
    const c = this.calib;
    c.buf.push(raw);
    if (performance.now() < c.until) return;
    const s = [...c.buf].sort((a, b) => a - b);
    const pick = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? null;
    const out = { p10: pick(0.1), p90: pick(0.9) };
    this.calib = null;
    c.resolve(out);
  }

  /* ---------------- 骨架绘制 ---------------- */
  drawOverlay(control, second) {
    const cv = this.overlay;
    if (!cv) return;
    const w = (cv.width = cv.clientWidth * (window.devicePixelRatio || 1));
    const h = (cv.height = cv.clientHeight * (window.devicePixelRatio || 1));
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    if (!control) return;

    const dpr = window.devicePixelRatio || 1;
    const P = (lm) => ({ x: (1 - lm.x) * w, y: lm.y * h }); // 视频镜像，坐标同步镜像

    const drawHand = (lm, badge) => {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // 骨骼
      ctx.strokeStyle = 'rgba(30, 210, 90, .95)';
      ctx.lineWidth = 2.4 * dpr;
      ctx.beginPath();
      for (const [a, b] of CONNECTIONS) {
        const p1 = P(lm[a]), p2 = P(lm[b]);
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
      }
      ctx.stroke();
      // 关节点
      for (let i = 0; i < lm.length; i++) {
        const p = P(lm[i]);
        ctx.fillStyle = '#FF5A3C';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.2 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
      // 测量点：拇指尖 / 食指尖
      ctx.strokeStyle = '#FFD54A';
      ctx.lineWidth = 1.8 * dpr;
      for (const i of [4, 8]) {
        const p = P(lm[i]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 7 * dpr, 0, Math.PI * 2);
        ctx.stroke();
      }
      // 张合参考线
      const a4 = P(lm[4]), a8 = P(lm[8]);
      ctx.strokeStyle = 'rgba(255,213,74,.55)';
      ctx.setLineDash([3 * dpr, 3 * dpr]);
      ctx.beginPath();
      ctx.moveTo(a4.x, a4.y);
      ctx.lineTo(a8.x, a8.y);
      ctx.stroke();
      ctx.setLineDash([]);
      // 编号徽标
      const wr = P(lm[0]);
      const r = 10 * dpr;
      ctx.fillStyle = '#0E0D0B';
      ctx.beginPath();
      ctx.arc(wr.x, wr.y + r * 1.5, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#F4F3EE';
      ctx.font = `${8.5 * dpr}px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(badge, wr.x, wr.y + r * 1.5);
    };

    if (second) drawHand(second, '02');
    drawHand(control, '01');
  }
}

window.GestureController = GestureController;
})();