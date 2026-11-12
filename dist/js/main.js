(async function () {

console.log('%c[flower-scenes] build 2026-11-09-4 · 4 scenes', 'color:#4C9A3F;font-weight:500');

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stage = new Stage({ fg: $('#fg'), bg: $('#bg'), frame: $('#frame') });
const dotsEl = $('#dots');

let gestureOn = true;
let gesture = null;
let autoplayRaf = 0;
let lockUntil = 0; // 切换后的短暂锁定，避免挥手瞬间把新画面刷开

window.__lotus = { stage, get gesture() { return gesture; } };

/* ---------------- 场景指示点 ---------------- */
function buildDots() {
  dotsEl.innerHTML = '';
  stage.scenes.forEach((_, i) => {
    const d = document.createElement('i');
    d.addEventListener('click', () => {
      if (i === stage.active) return;
      switchScene(i > stage.active ? 1 : -1);
    });
    dotsEl.appendChild(d);
  });
  syncDots();
}

function syncDots() {
  [...dotsEl.children].forEach((d, i) => d.classList.toggle('on', i === stage.active));
}

/* ---------------- 切换 ---------------- */
function switchScene(dir) {
  if (stage.go(dir)) {
    lockUntil = performance.now() + 820;
    gesture?.resetSmooth(0);
    syncDots();
  }
}

/* ---------------- toast ---------------- */
let toastTimer = 0;
function toast(text, ms = 2800) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/* ---------------- 摄像头预览 ---------------- */
function setPanel(show) {
  $('#debug').dataset.hidden = String(!show);
  $('#btnCam').setAttribute('aria-pressed', String(show));
}

/* ---------------- 手势 ---------------- */
async function startGesture() {
  gesture = new GestureController({
    video: $('#cam'),
    overlay: $('#skeleton'),
    switchable: true,
    onProgress: (p) => {
      if (!gestureOn || performance.now() < lockUntil) return;
      stage.setProgress(p);
    },
    onPercent: (p) => ($('#pct').textContent = p + '%'),
    onSecond: () => {},
    onSwipe: (dir) => {
      if (gestureOn) switchScene(dir);
    },
    onState: () => {},
  });

  try {
    await gesture.start();
    return true;
  } catch (e) {
    console.warn('[gesture]', e);
    gestureOn = false;
    $('#btnGesture').classList.remove('is-on');
    $('#btnGesture').classList.add('is-off');
    toast('摄像头不可用：用滚轮 / 方向键控制');
    return false;
  }
}

/* ---------------- 按钮 ---------------- */
$('#btnGesture').addEventListener('click', (e) => {
  gestureOn = !gestureOn;
  e.currentTarget.classList.toggle('is-on', gestureOn);
  e.currentTarget.classList.toggle('is-off', !gestureOn);
  if (!gestureOn) {
    gesture?.stop();
    toast('已关闭手势 · 方向键可切换');
  } else {
    gesture?.start().catch(() => {});
  }
});

$('#btnPrev').addEventListener('click', () => switchScene(-1));
$('#btnNext').addEventListener('click', () => switchScene(1));

$('#btnPlay').addEventListener('click', () => {
  cancelAnimationFrame(autoplayRaf);
  const scene = stage.scene;
  const t0 = performance.now();
  const dur = 2600;
  const from = scene.target;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    if (!stage.busy) scene.target = from + (1 - from) * e;
    if (k < 1) autoplayRaf = requestAnimationFrame(step);
  };
  autoplayRaf = requestAnimationFrame(step);
});

$('#btnCalibrate').addEventListener('click', async () => {
  if (!gesture || !gestureOn) return toast('手势未启用，无法校准');
  toast('张开五指保持 1.5 秒，再捏合拇指食指', 4200);
  const ok = await gesture.calibrate();
  toast(ok ? '校准完成' : '校准失败，请再试一次');
});

$('#btnCam').addEventListener('click', () => {
  setPanel($('#debug').dataset.hidden === 'true');
});

/* ---------------- 降级输入 ---------------- */
window.addEventListener(
  'wheel',
  (e) => {
    if (gestureOn) return;
    const s = stage.scene;
    s.target = Math.min(1, Math.max(0, s.target - e.deltaY * 0.0012));
  },
  { passive: true }
);

window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') switchScene(1);
  if (e.key === 'ArrowLeft') switchScene(-1);
  if (e.key === 'ArrowUp') stage.scene.target = Math.min(1, stage.scene.target + 0.1);
  if (e.key === 'ArrowDown') stage.scene.target = Math.max(0, stage.scene.target - 0.1);
});

/* ---------------- 启动 ---------------- */
const params = new URLSearchParams(location.hash.replace(/^#/, ''));
let ok = await stage.load();
if (!ok) {
  // 再等一拍重试一次（首帧偶发超时）
  await sleep(800);
  ok = await stage.load();
}
buildDots();
if (!ok) {
  $('#err').hidden = false;
  console.warn('[stage] 素材加载失败', stage.scenes.map((s) => s.urls && s.urls[0]));
}
if (params.has('s')) {
  stage.active = Number(params.get('s')) % stage.scenes.length;
  syncDots();
}
if (params.has('p')) {
  stage.scene.target = stage.scene.current = Math.min(1, Math.max(0, Number(params.get('p'))));
}
if (params.get('cam') === '1') setPanel(true);

await sleep(500);
const started = await startGesture();
if (started && params.get('cam') !== '1') {
  setTimeout(() => toast('捏合控制花开 · 张开手掌左右挥动切换', 4200), 900);
}


})();