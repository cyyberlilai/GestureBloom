(function () {
/**
 * stage.js — 多场景帧序列舞台
 *
 * 每个场景 = 一段花开序列帧；挥手在场景之间切换，用「缩放 + 淡入淡出」过渡。
 */

const SCENES = [
  { id: '01-lotus', base: 'assets/frames/01-lotus' },   // 荷花
  { id: '02-peony', base: 'assets/frames/02-peony' },   // 白芍药
  { id: '03-iris', base: 'assets/frames/03-iris' },     // 鸢尾
  { id: '04-dahlia', base: 'assets/frames/04-dahlia' }, // 大丽花
];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const BG_DIV = 4;      // 背景画布按 1/4 分辨率绘制
const MAX_CACHE = 16;  // 单场景缓存帧数
const PRELOAD = 5;
const TRANS_MS = 760;  // 切换过渡时长

/* ---------------- 单个场景 ---------------- */

class Scene {
  constructor({ id, base }) {
    this.id = id;
    this.base = base;
    this.cache = new Map();
    this.pending = new Set();
    this.count = 0;
    this.target = 0;
    this.current = 0;
    this.ready = false;
  }

  async load() {
    // manifest 只是加速用；拿不到（file:// 打开、路径变更、被拦）也要能靠默认值继续跑
    let m = null;
    try {
      const res = await fetch(`${this.base}/manifest.json`, { cache: 'no-store' });
      if (res.ok) m = await res.json();
    } catch (e) {
      console.warn('[stage] manifest 读取失败，使用默认参数', this.id, e);
    }
    this.count = m?.count ?? 80;
    this.pad = m?.pad ?? 4;
    this.ext = m?.ext ?? 'webp';
    this.aspect = m?.width && m?.height ? m.width / m.height : 16 / 9;
    this.imgW = m?.width ?? 1280;
    this.imgH = m?.height ?? 720;
    this.urls = Array.from(
      { length: this.count },
      (_, i) => `${this.base}/${String(i + 1).padStart(this.pad, '0')}.${this.ext}`
    );
    const first = await this.fetch(0);
    this.ready = !!first;
    if (!this.ready) console.warn('[stage] 首帧加载失败', this.urls[0]);
    for (let i = 1; i <= Math.min(8, this.count - 1); i++) this.fetch(i);
  }

  fetch(i) {
    if (i < 0 || i >= this.count) return Promise.resolve(null);
    if (this.cache.has(i)) return Promise.resolve(this.cache.get(i));
    if (this.pending.has(i)) return Promise.resolve(null);
    this.pending.add(i);
    return new Promise((resolve) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        this.cache.set(i, img);
        this.pending.delete(i);
        resolve(img);
      };
      img.onerror = () => {
        this.pending.delete(i);
        resolve(null);
      };
      img.src = this.urls[i];
    });
  }

  getFrame(p) {
    if (!this.count) return null;
    const i = Math.round(clamp01(p) * (this.count - 1));

    if (this.cache.size > MAX_CACHE) {
      for (const k of [...this.cache.keys()]) {
        if (Math.abs(k - i) > 12) this.cache.delete(k);
        if (this.cache.size <= MAX_CACHE) break;
      }
    }
    const hit = this.cache.get(i);
    if (hit) return hit;

    for (let d = 1; d <= PRELOAD; d++) {
      this.fetch(i + d);
      this.fetch(i - d);
    }
    let best = null;
    let bestD = Infinity;
    for (const [k, v] of this.cache) {
      const dd = Math.abs(k - i);
      if (dd < bestD) {
        bestD = dd;
        best = v;
      }
    }
    return best;
  }

  step() {
    const d = this.target - this.current;
    this.current += Math.abs(d) < 0.0004 ? d : d * 0.16;
  }
}

/* ---------------- 舞台 ---------------- */

class Stage {
  constructor({ fg, bg, frame }) {
    this.canvas = fg;
    this.ctx = fg.getContext('2d', { alpha: true });
    this.bg = bg;
    this.bctx = bg.getContext('2d');
    this.frame = frame;

    this.scenes = SCENES.map((s) => new Scene(s));
    this.active = 0;
    this.trans = null;
    this.aspect = 9 / 16;

    this.resize = this.resize.bind(this);
    window.addEventListener('resize', this.resize);
    new ResizeObserver(this.resize).observe(frame);
    this.resize();

    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  get scene() {
    return this.scenes[this.active];
  }

  get busy() {
    return !!this.trans;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // 画面按 contain 等比铺满视口
    const iw = this.imgW || 16;
    const ih = this.imgH || 9;
    const scale = Math.min(vw / iw, vh / ih);
    this.fw = Math.round(iw * scale);
    this.fh = Math.round(ih * scale);
    this.fx0 = Math.round((vw - this.fw) / 2);
    this.fy0 = Math.round((vh - this.fh) / 2);
    this.frame.style.width = `${this.fw}px`;
    this.frame.style.height = `${this.fh}px`;
    this.frame.style.left = `${this.fx0}px`;
    this.frame.style.top = `${this.fy0}px`;

    const r = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingQuality = 'high';

    this.bw = Math.max(1, Math.round(vw / BG_DIV));
    this.bh = Math.max(1, Math.round(vh / BG_DIV));
    this.bg.width = this.bw;
    this.bg.height = this.bh;
  }

  async load() {
    await Promise.all(this.scenes.map((s) => s.load().catch((e) => console.warn(e))));
    this.aspect = this.scenes[0].aspect || 9 / 16;
    this.imgW = this.scenes[0].imgW;
    this.imgH = this.scenes[0].imgH;
    this.resize();
    return this.scenes.every((s) => s.ready);
  }

  /** 当前场景的开合度 0..1（切换过程中不接受更新） */
  setProgress(p) {
    if (this.trans) return;
    this.scene.target = clamp01(p);
  }

  /** 切换场景：dir=1 下一个，-1 上一个 */
  go(dir) {
    const n = this.scenes.length;
    return this.goTo((this.active + dir + n) % n);
  }

  /** 直达指定场景（指示点点击） */
  goTo(next) {
    if (this.trans || this.scenes.length < 2) return false;
    if (next === this.active || next < 0 || next >= this.scenes.length) return false;

    const s = this.scenes[next];
    s.current = 0;
    s.target = 0;

    this.trans = { from: this.active, to: next, t0: performance.now(), dur: TRANS_MS };
    this.active = next;
    this.onChange?.(next);
    return true;
  }

  loop(now) {
    const t = now || performance.now();
    this.scenes.forEach((s) => s.step());
    this.render(t);
    requestAnimationFrame(this.loop);
  }

  render(now) {
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    this.bctx.clearRect(0, 0, this.bw, this.bh);

    if (this.trans) {
      const p = clamp01((now - this.trans.t0) / this.trans.dur);
      const e = easeInOut(p);
      const a = this.scenes[this.trans.from];
      const b = this.scenes[this.trans.to];

      // 背景先画（不透明，后画的盖住先画的）
      this.drawBg(a, 1 - e);
      this.drawBg(b, e);

      // 前景：旧的放大淡出，新的从略大回到原位
      this.drawFg(a, 1 - e, 1 + 0.06 * e);
      this.drawFg(b, e, 1.06 - 0.06 * e);

      if (p >= 1) this.trans = null;
    } else {
      this.drawBg(this.scene, 1);
      this.drawFg(this.scene, 1, 1);
    }
  }

  drawFg(scene, alpha, scale) {
    if (alpha <= 0.002) return;
    const img = scene.getFrame(scene.current);
    if (!img) return;
    const { ctx, w, h } = this;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (scale !== 1) {
      ctx.translate(w / 2, h / 2);
      ctx.scale(scale, scale);
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
    } else {
      ctx.drawImage(img, 0, 0, w, h);
    }
    ctx.restore();
  }

  /**
   * 四周背景：把画面四条边「向外拉伸」（clamp-to-edge），
   * 这样任何比例的屏幕上，画面外的颜色都等于最近的画面边缘颜色，接缝不可见。
   */
  drawBg(scene, alpha) {
    if (alpha <= 0.002) return;
    const img = scene.getFrame(scene.current);
    if (!img) return;
    const { bctx: c, bw, bh } = this;
    const s = bw / window.innerWidth;
    const x0 = this.fx0 * s;
    const x1 = (this.fx0 + this.fw) * s;
    const y0 = this.fy0 * s;
    const y1 = (this.fy0 + this.fh) * s;
    const iw = img.width;
    const ih = img.height;
    const sx = Math.max(2, Math.round(iw * 0.004));
    const sy = Math.max(2, Math.round(ih * 0.006));
    const PAD = 6;

    c.save();
    c.globalAlpha = alpha;
    c.filter = 'blur(6px)';

    // 底：整幅画面铺在画面区（被前景盖住，只在羽化边缘露出，保证边缘不露白）
    c.drawImage(img, x0, y0, x1 - x0, y1 - y0);

    // 左 / 右
    if (x0 > 0) c.drawImage(img, 0, 0, sx, ih, -PAD, y0 - PAD, x0 + PAD, y1 - y0 + PAD * 2);
    if (x1 < bw) c.drawImage(img, iw - sx, 0, sx, ih, x1, y0 - PAD, bw - x1 + PAD, y1 - y0 + PAD * 2);
    // 上 / 下
    if (y0 > 0) c.drawImage(img, 0, 0, iw, sy, x0 - PAD, -PAD, x1 - x0 + PAD * 2, y0 + PAD);
    if (y1 < bh) c.drawImage(img, 0, ih - sy, iw, sy, x0 - PAD, y1, x1 - x0 + PAD * 2, bh - y1 + PAD);
    // 四角
    if (x0 > 0 && y0 > 0) c.drawImage(img, 0, 0, sx, sy, -PAD, -PAD, x0 + PAD, y0 + PAD);
    if (x1 < bw && y0 > 0) c.drawImage(img, iw - sx, 0, sx, sy, x1, -PAD, bw - x1 + PAD, y0 + PAD);
    if (x0 > 0 && y1 < bh) c.drawImage(img, 0, ih - sy, sx, sy, -PAD, y1, x0 + PAD, bh - y1 + PAD);
    if (x1 < bw && y1 < bh) c.drawImage(img, iw - sx, ih - sy, sx, sy, x1, y1, bw - x1 + PAD, bh - y1 + PAD);

    c.filter = 'none';
    c.restore();

    // 8 块拼出来的边缘会有硬边界（四个角比中间暗），整体再柔化一次把它们抹平
    const tmp = this._tmp || (this._tmp = document.createElement('canvas'));
    if (tmp.width !== bw || tmp.height !== bh) {
      tmp.width = bw;
      tmp.height = bh;
    }
    const tc = tmp.getContext('2d');
    tc.clearRect(0, 0, bw, bh);
    tc.drawImage(this.bg, 0, 0);

    c.save();
    c.clearRect(0, 0, bw, bh);
    c.filter = 'blur(10px)';
    c.drawImage(tmp, -16, -16, bw + 32, bh + 32);
    c.filter = 'none';
    c.restore();
  }
}

window.Stage = Stage;
window.SCENES = SCENES;
})();