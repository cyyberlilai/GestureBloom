(async function () {

console.log('%c[flower-scenes] build 2026-11-09-4 · 4 scenes', 'color:#4C9A3F;font-weight:500');

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stage = new Stage({ fg: $('#fg'), bg: $('#bg'), frame: $('#frame') });
const dotsEl = $('#dots');

// 懒加载场景时，切换会晚于点击发生，让指示点跟着 stage 的真实状态走
stage.onChange = () => syncDots();

let gestureOn = true;
let gesture = null;
let modelReady = false;   // 识别模型是否已就绪（摄像头就绪 ≠ 可识别）
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
      if (stage.goTo(i)) afterSwitch();
    });
    dotsEl.appendChild(d);
  });
  syncDots();
}

function syncDots() {
  [...dotsEl.children].forEach((d, i) => d.classList.toggle('on', i === stage.active));
}

/* ---------------- 切换 ---------------- */
function afterSwitch() {
  lockUntil = performance.now() + 820;
  gesture?.resetSmooth(0);
  syncDots();
}

function switchScene(dir) {
  if (stage.go(dir)) afterSwitch();
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

/* ---------------- 状态条 ---------------- */
const CAM_STATE = {
  loading: { text: '正在开启摄像头…', tone: 'wait' },
  camera: { text: '摄像头已就绪', tone: 'ok' },
  model: { text: '正在加载手势模型…', tone: 'wait' },
  ready: { text: '手势已就绪', tone: 'ok' },
  error: { text: '摄像头不可用', tone: 'err' },
  off: { text: '手势已关闭', tone: 'off' },
};

function setCamState(key, extra) {
  const st = CAM_STATE[key] || CAM_STATE.loading;
  const el = $('#camState');
  if (!el) return;
  el.dataset.tone = st.tone;
  el.querySelector('.cam-state-text').textContent = extra || st.text;
}

function setGestureBtnLoading(on) {
  const b = $('#btnGesture');
  b.classList.toggle('is-loading', on);
  b.classList.toggle('is-on', !on && gestureOn);
  b.classList.toggle('is-off', on || !gestureOn);
}

/* ---------------- 手势 ---------------- */
async function startGesture() {
  if (gesture) {
    // 已有实例：只恢复摄像头与推理
    setCamState('loading');
    setGestureBtnLoading(true);
    try {
      await gesture.start();
      return true;
    } catch (e) {
      console.warn('[gesture]', e);
      setGestureBtnLoading(false);
      setCamState('error');
      return false;
    }
  }

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
    onCameraReady: () => {
      // 摄像头已出画面：立刻把预览面板打开，用户马上能看到自己
      if ($('#debug').dataset.hidden === 'true') setPanel(true);
      if (modelReady) {
        setCamState('ready');
        setGestureBtnLoading(false);
      } else {
        setCamState('model');
        toast('摄像头已开启，正在加载手势模型…', 2600);
      }
    },
    onModelReady: () => {
      modelReady = true;
      setCamState('ready');
      setGestureBtnLoading(false);
      toast('手势已就绪：捏合控制花开 · 挥掌切换', 3200);
      // 模型下载完，带宽空出来了：把其余三幅花的帧补上
      stage.warmRest(0);
    },
    onModelError: () => {
      modelReady = false;
      setCamState('error', '手势模型加载失败');
      setGestureBtnLoading(false);
      toast('手势模型加载失败，请检查网络后重试', 4200);
    },
  });

  setCamState('loading');
  setGestureBtnLoading(true);

  try {
    await gesture.start();
    return true;
  } catch (e) {
    console.warn('[gesture]', e);
    gestureOn = false;
    $('#btnGesture').classList.remove('is-on');
    $('#btnGesture').classList.add('is-off');
    setGestureBtnLoading(false);
    setCamState('error');
    toast('摄像头不可用：用滚轮 / 方向键控制');
    return false;
  }
}

/* ---------------- 按钮 ---------------- */
$('#btnGesture').addEventListener('click', (e) => {
  gestureOn = !gestureOn;
  if (gestureOn) {
    e.currentTarget.classList.remove('is-off');
    setGestureBtnLoading(true);
    gesture?.start()
      .then((ok) => {
        if (!ok) {
          gestureOn = false;
          e.currentTarget.classList.add('is-off');
          setGestureBtnLoading(false);
        }
      })
      .catch(() => {
        gestureOn = false;
        e.currentTarget.classList.add('is-off');
        setGestureBtnLoading(false);
        setCamState('error');
      });
    toast('正在开启摄像头…', 2000);
  } else {
    e.currentTarget.classList.add('is-off');
    setGestureBtnLoading(false);
    gesture?.stop();
    setCamState('off');
    toast('已关闭手势 · 方向键可切换');
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
  if (!modelReady) return toast('手势模型还在加载，请稍候');
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
    // 摄像头已开但识别模型还没就绪时，滚轮依然可用（此时手势不可能在驱动画面）
    if (gestureOn && modelReady) return;
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

// 摄像头权限请求尽早发出：权限弹窗和素材下载、模型下载三者并行，
// 用户点完「允许」就能立刻看到画面，而不是等 17MB 模型下完。
const gestureBoot = startGesture();

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
  // 深链直达：该场景可能还没加载（首屏只加载当前场景），先补上首帧
  const idx = Number(params.get('s')) % stage.scenes.length;
  if (idx !== stage.active) {
    if (!stage.scenes[idx].count) await stage.scenes[idx].load().catch(() => {});
    stage.active = idx;
    syncDots();
  }
}
if (params.has('p')) {
  stage.scene.target = stage.scene.current = Math.min(1, Math.max(0, Number(params.get('p'))));
}
if (params.get('cam') === '1') setPanel(true);

await gestureBoot;


})();