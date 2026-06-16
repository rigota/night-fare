const canvas = document.querySelector("#game");
const ctx = canvas.getContext("2d");
const loading = document.querySelector("#loading");
const startButton = document.querySelector("#start");
const muteButton = document.querySelector("#mute");

const W = canvas.width;
const H = canvas.height;
const DPR_LIMIT = 2;
const TOTAL_DISTANCE = 1.8;

const ASSETS = {
  scene: "public/assets/scene-v2-canvas.png",
  driver: "public/assets/driver-seat-sheet.png",
  hands: "public/assets/hands-rope-sheet.png",
  hero: "public/assets/hero-v2.png",
};

const TEXT = {
  title: "НОЧНОЙ РЕЙС",
  subtitle: "Даша садится в такси после смены. Навигатор гаснет, водитель сворачивает к лесу, а двери блокируются.",
  goal: "Дождись приступа, поймай окно захвата и сорви поездку до лесной развилки.",
  controls: "Мышь - цель  |  ЛКМ/Пробел - рывок  |  A/D - уклон  |  C - дыхание  |  P - пауза",
};

const state = {
  mode: "title",
  prevMode: "title",
  time: 0,
  health: 74,
  calm: 66,
  grip: 0,
  stamina: 100,
  distance: TOTAL_DISTANCE,
  aimX: 0.52,
  aimY: 0.45,
  lane: 0,
  pulling: false,
  breathing: false,
  phase: "drive",
  phaseTimer: 0,
  warning: 0,
  shake: 0,
  score: 0,
  combo: 0,
  best: Number(localStorage.getItem("nightFareBest") || 0),
  message: "ВЫЖИТЬ",
  hint: "Жди, пока водитель потеряет контроль.",
  muted: false,
  last: performance.now(),
  weakX: 0.31,
  weakY: 0.32,
  weakVX: 0.06,
  weakVY: 0.03,
  dodgeDir: 0,
  dodged: false,
  gripMilestone: 0,
  heartPhase: 0,
  heartFlash: 0,
  heartRate: 1,
  flash: 0,
  flashColor: "#ff5a3c",
  popups: [],
  _sfx: {},
};

const keys = new Set();
const touch = { left: false, right: false, breathe: false };
const images = {};
window.__nightFareState = state;

/* ----------------------------------------------------------------------------
 * Аудиодвижок: один переиспользуемый AudioContext на всю игру.
 * Раньше new AudioContext() создавался на каждый звук и упирался в лимит
 * браузера (~6), после чего звук молча пропадал. Теперь — общий контекст,
 * атмосферный фон (мотор + дождь), сердцебиение и envelope-генераторы.
 * ------------------------------------------------------------------------- */
const Sound = {
  ctx: null,
  master: null,
  ambient: null,
  noiseBuffer: null,
  ambientSources: [],
  running: false,
  vol: 0.85,

  init() {
    if (this.ctx) return true;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = state.muted ? 0 : this.vol;
    this.master.connect(this.ctx.destination);
    this.ambient = this.ctx.createGain();
    this.ambient.gain.value = 0;
    this.ambient.connect(this.master);
    const len = Math.floor(this.ctx.sampleRate * 2);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;
    return true;
  },

  resume() {
    if (!this.init()) return;
    if (this.ctx.state === "suspended") this.ctx.resume();
  },

  suspend() {
    if (this.ctx && this.ctx.state === "running") this.ctx.suspend();
  },

  setMuted(muted) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.linearRampToValueAtTime(muted ? 0 : this.vol, t + 0.08);
  },

  startAmbient() {
    if (!this.init() || this.running) return;
    this.resume();
    const t = this.ctx.currentTime;
    this.running = true;

    // Тёплый гул двигателя. Гармоники 110/165 Гц специально добавлены, чтобы
    // фон был слышен и на ноутбучных динамиках, а не уходил в неслышимый суб-бас.
    const engineLp = this.ctx.createBiquadFilter();
    engineLp.type = "lowpass";
    engineLp.frequency.value = 230;
    engineLp.connect(this.ambient);
    [
      [55, "sawtooth", 0.08],
      [82.5, "sawtooth", 0.05],
      [110, "triangle", 0.05],
      [165, "triangle", 0.022],
    ].forEach(([freq, type, g]) => {
      const osc = this.ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      const gain = this.ctx.createGain();
      gain.gain.value = g;
      osc.connect(gain);
      gain.connect(engineLp);
      osc.start();
      this.ambientSources.push(osc);
    });

    // Мягкий рокот шин по мокрой дороге — низкочастотный, не «шипение».
    const road = this.ctx.createBufferSource();
    road.buffer = this.noiseBuffer;
    road.loop = true;
    const roadLp = this.ctx.createBiquadFilter();
    roadLp.type = "lowpass";
    roadLp.frequency.value = 360;
    const roadG = this.ctx.createGain();
    roadG.gain.value = 0.03;
    road.connect(roadLp);
    roadLp.connect(roadG);
    roadG.connect(this.ambient);
    road.start();
    this.ambientSources.push(road);

    // Очень тихий шорох дождя — еле на фоне, чтобы не доминировал.
    const rain = this.ctx.createBufferSource();
    rain.buffer = this.noiseBuffer;
    rain.loop = true;
    const rainBp = this.ctx.createBiquadFilter();
    rainBp.type = "bandpass";
    rainBp.frequency.value = 1400;
    rainBp.Q.value = 0.5;
    const rainG = this.ctx.createGain();
    rainG.gain.value = 0.011;
    rain.connect(rainBp);
    rainBp.connect(rainG);
    rainG.connect(this.ambient);
    rain.start();
    this.ambientSources.push(rain);

    this.ambient.gain.cancelScheduledValues(t);
    this.ambient.gain.setValueAtTime(0, t);
    this.ambient.gain.linearRampToValueAtTime(0.85, t + 1.2);
  },

  stopAmbient() {
    if (!this.ctx || !this.running) return;
    const t = this.ctx.currentTime;
    this.ambient.gain.cancelScheduledValues(t);
    this.ambient.gain.linearRampToValueAtTime(0, t + 0.5);
    const sources = this.ambientSources;
    this.ambientSources = [];
    this.running = false;
    setTimeout(() => {
      for (const s of sources) {
        try {
          s.stop();
        } catch (_) {}
      }
    }, 620);
  },

  tone({ freq = 220, type = "square", dur = 0.12, gain = 0.2, slideTo = null, attack = 0.005 }) {
    if (!this.init() || state.muted) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
    osc.onended = () => {
      osc.disconnect();
      g.disconnect();
    };
  },

  noise({ dur = 0.2, gain = 0.2, type = "highpass", freq = 1000 }) {
    if (!this.init() || state.muted) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
    src.onended = () => {
      src.disconnect();
      f.disconnect();
      g.disconnect();
    };
  },

  heartbeat(intensity) {
    const vol = 0.16 + Math.min(1, intensity / 100) * 0.14;
    this.tone({ freq: 70, slideTo: 42, type: "sine", dur: 0.16, gain: vol, attack: 0.004 });
    setTimeout(() => this.tone({ freq: 60, slideTo: 36, type: "sine", dur: 0.2, gain: vol * 0.8, attack: 0.004 }), 150);
  },
};

function sfxPullTick() {
  Sound.tone({ freq: 150 + state.combo * 16, type: "square", dur: 0.04, gain: 0.05 });
}
function sfxMilestone(step) {
  Sound.tone({ freq: 300 + step * 70, slideTo: 440 + step * 70, type: "triangle", dur: 0.13, gain: 0.16 });
}
function sfxHit() {
  Sound.noise({ dur: 0.2, gain: 0.22, type: "lowpass", freq: 520 });
  Sound.tone({ freq: 90, slideTo: 48, type: "square", dur: 0.18, gain: 0.12 });
}
function sfxMiss() {
  Sound.tone({ freq: 220, slideTo: 70, type: "sawtooth", dur: 0.22, gain: 0.15 });
}
function sfxDodge() {
  Sound.tone({ freq: 520, slideTo: 780, type: "triangle", dur: 0.13, gain: 0.18 });
}
function sfxWin() {
  [330, 440, 550, 660].forEach((freq, i) => {
    setTimeout(() => Sound.tone({ freq, type: "square", dur: 0.18, gain: 0.14 }), i * 110);
  });
}
function sfxLose() {
  Sound.tone({ freq: 200, slideTo: 48, type: "sawtooth", dur: 1.0, gain: 0.2 });
  Sound.noise({ dur: 0.8, gain: 0.12, type: "lowpass", freq: 300 });
}

function throttledSfx(key, cooldown, fn) {
  if (state.time - (state._sfx[key] || -99) >= cooldown) {
    state._sfx[key] = state.time;
    fn();
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function boot() {
  const entries = await Promise.all(
    Object.entries(ASSETS).map(async ([name, src]) => [name, await loadImage(src)]),
  );
  for (const [name, img] of entries) images[name] = img;
  loading.classList.add("hidden");
  resizeCanvas();
  requestAnimationFrame(loop);
}

function resizeCanvas() {
  const ratio = Math.min(window.devicePixelRatio || 1, DPR_LIMIT);
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.width = Math.round(W * ratio);
  canvas.height = Math.round(H * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.imageSmoothingEnabled = false;
}

function resetGame() {
  Object.assign(state, {
    mode: "play",
    prevMode: "play",
    time: 0,
    health: 74,
    calm: 66,
    grip: 0,
    stamina: 100,
    distance: TOTAL_DISTANCE,
    lane: 0,
    pulling: false,
    breathing: false,
    phase: "drive",
    phaseTimer: 0.9,
    warning: 0,
    shake: 0,
    score: 0,
    combo: 0,
    message: "ВЫЖИТЬ",
    hint: "Следи за плечами водителя. Рывок заранее выдаёт Дашу.",
    last: performance.now(),
    weakX: 0.31,
    weakY: 0.32,
    weakVX: 0.06,
    weakVY: 0.03,
    dodgeDir: 0,
    dodged: false,
    gripMilestone: 0,
    heartPhase: 0,
    heartFlash: 0,
    heartRate: 1,
    flash: 0,
    popups: [],
    _sfx: {},
  });
  Sound.resume();
  Sound.startAmbient();
}

function loop(now) {
  const dt = Math.min(0.05, (now - state.last) / 1000 || 0);
  state.last = now;
  update(dt);
  draw();
  requestAnimationFrame(loop);
}

function update(dt) {
  state.warning = Math.max(0, state.warning - dt);
  state.shake = Math.max(0, state.shake - dt * 2.3);
  state.flash = Math.max(0, state.flash - dt * 1.7);
  state.heartFlash = Math.max(0, state.heartFlash - dt * 2.6);
  updatePopups(dt);

  if (state.mode === "paused") return;

  state.time += dt;
  if (state.mode !== "play") return;

  const panic = 1 + state.time * 0.016 + (TOTAL_DISTANCE - state.distance) * 0.2;
  state.phaseTimer -= dt;
  state.distance = clamp(state.distance - (0.018 + state.time * 0.0013) * dt, 0, TOTAL_DISTANCE);

  const leftHeld = keys.has("KeyA") || keys.has("ArrowLeft") || touch.left;
  const rightHeld = keys.has("KeyD") || keys.has("ArrowRight") || touch.right;
  if (leftHeld) state.lane = clamp(state.lane - 4.2 * dt, -1, 1);
  if (rightHeld) state.lane = clamp(state.lane + 4.2 * dt, -1, 1);
  state.lane *= 1 - Math.min(1, 2.4 * dt);

  updateHeartbeat(dt);
  updatePhase(dt, panic);
  updateDodge(dt);
  updatePlayer(dt, panic);
  updateEndState(dt);
}

function updateHeartbeat(dt) {
  const panicPct = 100 - state.calm;
  state.heartRate = 0.85 + (panicPct / 100) * 1.8;
  state.heartPhase += dt * state.heartRate;
  if (state.heartPhase >= 1) {
    state.heartPhase -= 1;
    state.heartFlash = 0.3 + (panicPct / 100) * 0.7;
    if (panicPct > 30) Sound.heartbeat(panicPct);
  }
}

function updatePhase(dt, panic) {
  if (state.phase === "drive" && state.phaseTimer <= 0) {
    setPhase("tell", Math.max(0.46, 0.78 - panic * 0.09));
    state.message = "ПОВОРОТ";
    state.hint = "Он тянется к блокировке. Уклонись в подсвеченную сторону.";
    state.warning = 0.6;
    state.dodgeDir = Math.random() < 0.5 ? -1 : 1;
    state.dodged = false;
    throttledSfx("tell", 0.3, () => Sound.tone({ freq: 300, type: "square", dur: 0.06, gain: 0.1 }));
  }

  if (state.phase === "tell" && state.phaseTimer <= 0) {
    setPhase("open", Math.max(0.52, 0.98 - panic * 0.1));
    state.message = "ОКНО";
    state.hint = "Целься в петлю у шеи и тяни только в этом окне.";
    state.weakX = 0.31 + (Math.random() - 0.5) * 0.03;
    state.weakY = 0.3 + Math.random() * 0.035;
    state.warning = 0.4;
    state.shake = 0.45;
  }

  if (state.phase === "open" && state.phaseTimer <= 0) {
    punishMiss("ОКНО УШЛО");
    setPhase("recover", 0.55);
  }

  if (state.phase === "struggle" && state.phaseTimer <= 0) {
    setPhase("recover", 0.48);
    state.message = "ОТПУСТИ";
    state.hint = "Восстанови дыхание, иначе сорвёшь следующий рывок.";
  }

  if (state.phase === "recover" && state.phaseTimer <= 0) {
    setPhase("drive", Math.max(0.6, 1.2 - panic * 0.12));
    state.message = "ВЫЖИТЬ";
    state.hint = "Жди следующий сбой. Ранние рывки ломают комбо.";
  }

  if (state.phase === "open" || state.phase === "struggle") {
    state.weakX = clamp(state.weakX + Math.sin(state.time * 5.4) * state.weakVX * 1.5 * dt, 0.27, 0.36);
    state.weakY = clamp(state.weakY + Math.cos(state.time * 4.6) * state.weakVY * 1.5 * dt, 0.27, 0.37);
  }
}

function updateDodge(dt) {
  if (state.phase !== "tell") return;
  const correct = state.dodgeDir !== 0 && Math.sign(state.lane) === state.dodgeDir && Math.abs(state.lane) > 0.32;

  if (correct && !state.dodged) {
    state.dodged = true;
    state.calm = clamp(state.calm + 9, 0, 100);
    state.score += 60;
    state.message = "УКЛОН";
    state.hint = "Чисто ушла. Теперь жди окно захвата.";
    spawnPopup("УКЛОН!", W * 0.5, 246, "#63e05c");
    addFlash("#3fae4a", 0.22);
    sfxDodge();
    return;
  }

  if (!state.dodged) {
    state.health -= 4.2 * dt;
    state.calm -= 7 * dt;
    state.shake = Math.max(state.shake, 0.4);
    addFlash("#ff5a3c", dt * 0.9);
    throttledSfx("dodgeHit", 0.45, sfxHit);
  }
}

function updatePlayer(dt, panic) {
  const breathing = (keys.has("KeyC") || touch.breathe) && !state.pulling;
  state.breathing = breathing;
  if (breathing && state.calm < 100) {
    throttledSfx("breathe", 1.4, () => {
      Sound.noise({ dur: 0.55, gain: 0.07, type: "bandpass", freq: 520 });
      spawnPopup("вдох…", state.aimX * W, state.aimY * H - 18, "#79e3ff");
    });
  }
  state.calm = clamp(state.calm + (breathing ? 15 : 1.6) * dt, 0, 100);
  state.stamina = clamp(state.stamina + (state.pulling ? -27 : breathing ? 18 : 10) * dt, 0, 100);

  const aimScore = 1 - Math.min(1, Math.hypot(state.aimX - state.weakX, state.aimY - state.weakY) * 6.2);
  const canPull = state.phase === "open" || state.phase === "struggle";

  if (!state.pulling) {
    state.grip = clamp(state.grip - (3.4 + panic * 1.0) * dt, 0, 100);
    state.gripMilestone = Math.min(state.gripMilestone, Math.floor(state.grip / 20) * 20);
    return;
  }

  if (state.stamina <= 5) {
    state.health -= 7 * dt;
    state.calm -= 18 * dt;
    state.message = "НЕТ СИЛ";
    state.hint = "Отпусти и нажми C, чтобы восстановить дыхание.";
    state.combo = 0;
    throttledSfx("nostamina", 0.5, sfxMiss);
    return;
  }

  if (!canPull) {
    state.health -= 5.5 * dt;
    state.calm -= 22 * dt;
    state.score = Math.max(0, state.score - 35 * dt);
    state.combo = 0;
    state.message = "РАНО";
    state.hint = "Таксист чувствует рывок до приступа. Жди окно.";
    addFlash("#ff5a3c", dt * 0.7);
    throttledSfx("early", 0.45, () => {
      sfxMiss();
      spawnPopup("РАНО", state.aimX * W, state.aimY * H - 18, "#ff654d");
    });
    return;
  }

  if (aimScore < 0.42) {
    state.grip = clamp(state.grip - 9 * dt, 0, 100);
    state.calm -= 18 * dt;
    state.message = "МИМО";
    state.hint = "Держи прицел на подсвеченной точке у петли.";
    state.combo = 0;
    throttledSfx("miss", 0.4, () => spawnPopup("МИМО", state.aimX * W, state.aimY * H - 18, "#ff654d"));
    return;
  }

  if (state.phase === "open") setPhase("struggle", 0.78);
  const gain = (10 + 16 * aimScore + state.combo * 1.0) * dt;
  state.grip = clamp(state.grip + gain, 0, 100);
  state.calm = clamp(state.calm - (5 + 7 * (1 - aimScore)) * dt, 0, 100);
  state.score += (90 + 120 * aimScore + state.combo * 18) * dt;
  state.combo = clamp(state.combo + 12 * dt, 0, 9);
  state.message = "ДЕРЖИ";
  state.hint = `Комбо x${Math.max(1, Math.round(state.combo))}. Не сорви выносливость.`;

  const milestone = Math.floor(state.grip / 20) * 20;
  if (milestone > state.gripMilestone && milestone >= 20 && milestone < 100) {
    state.gripMilestone = milestone;
    spawnPopup(`ЗАХВАТ ${milestone}%`, state.weakX * W, state.weakY * H - 22, "#f2a733");
    addFlash("#f2a733", 0.14);
    sfxMilestone(milestone / 20);
  }
  throttledSfx("tick", 0.09, sfxPullTick);
}

function updateEndState(dt) {
  if (state.calm <= 0) {
    state.health -= 12 * dt;
    state.message = "ПАНИКА";
  }

  if (state.grip >= 100) {
    state.mode = "win";
    const timeBonus = Math.max(0, 4200 - state.time * 80);
    const healthBonus = state.health * 24;
    state.score = Math.round(state.score + timeBonus + healthBonus);
    state.best = Math.max(state.best, state.score);
    localStorage.setItem("nightFareBest", String(state.best));
    Sound.stopAmbient();
    sfxWin();
  } else if (state.health <= 0 || state.distance <= 0) {
    state.mode = "lose";
    state.message = state.distance <= 0 ? "ЛЕС" : "СРЫВ";
    state.best = Math.max(state.best, Math.round(state.score));
    localStorage.setItem("nightFareBest", String(state.best));
    Sound.stopAmbient();
    sfxLose();
  }
}

function setPhase(phase, timer) {
  state.phase = phase;
  state.phaseTimer = timer;
}

function punishMiss(message) {
  state.health -= 7;
  state.calm -= 14;
  state.combo = 0;
  state.message = message;
  state.hint = "Водитель снова уходит от петли.";
  state.shake = 0.8;
  addFlash("#ff5a3c", 0.3);
  spawnPopup(message, W * 0.5, 232, "#ff654d");
  sfxHit();
}

function spawnPopup(text, x, y, color) {
  state.popups.push({ text, x, y, color, life: 1, vy: -26 });
  if (state.popups.length > 24) state.popups.shift();
}

function addFlash(color, amount) {
  state.flash = clamp(state.flash + amount, 0, 1);
  state.flashColor = color;
}

function updatePopups(dt) {
  for (const p of state.popups) {
    p.life -= dt * 1.2;
    p.y += p.vy * dt;
  }
  if (state.popups.some((p) => p.life <= 0)) {
    state.popups = state.popups.filter((p) => p.life > 0);
  }
}

function draw() {
  ctx.save();
  ctx.clearRect(0, 0, W, H);

  const jitter = state.shake > 0 ? (Math.random() - 0.5) * state.shake * 9 : 0;
  ctx.translate(jitter, jitter * 0.45);
  drawScene();
  ctx.restore();

  drawFlash();
  drawPopups();
  drawHud();
  if (state.mode === "paused") drawPause();
  else if (state.mode !== "play") drawOverlay();
  syncDebugState();
}

function drawScene() {
  ctx.drawImage(images.scene, 0, 0, W, 420);

  drawDriver();
  drawHandsAndRope();
  drawRoadThreat();
  drawDodgeCue();
  drawWeakPoint();
  drawReticle();
  drawRain();
  drawVignette();
}

function drawRoadThreat() {
  const progress = 1 - state.distance / TOTAL_DISTANCE;
  ctx.globalAlpha = 0.06 + progress * 0.16;
  ctx.fillStyle = "#05080a";
  ctx.fillRect(0, 0, W, 420);
  ctx.globalAlpha = 1;
}

function driverFrame() {
  if (state.phase === "struggle" && state.pulling) return 4;
  if (state.phase === "open") return 3;
  if (state.phase === "tell") return 2;
  const idleBeat = Math.floor(state.time / 1.7) % 3;
  return idleBeat === 1 ? 1 : 0;
}

function handsFrame() {
  if (state.phase === "struggle" && state.pulling) return 3;
  if (state.phase === "open" || state.pulling) return 2;
  if (state.phase === "tell") return 1;
  return 0;
}

function drawDriver() {
  const sheet = images.driver;
  const frameW = sheet.width / 5;
  const frameH = sheet.height;
  const index = driverFrame();
  const scale = 0.56;
  const dw = frameW * scale;
  const dh = frameH * scale;
  const x = 118 + state.lane * -8 + (index === 4 ? 16 : 0);
  const y = 38 + (index === 3 ? 4 * Math.sin(state.time * 18) : 0);

  ctx.save();
  ctx.filter = "drop-shadow(0 12px 10px rgba(0,0,0,.72)) saturate(.95) contrast(1.05)";
  ctx.drawImage(sheet, frameW * index, 0, frameW, frameH, x, y, dw, dh);
  ctx.filter = "none";
  ctx.restore();
}

function drawHandsAndRope() {
  const sheet = images.hands;
  const frameW = sheet.width / 4;
  const frameH = sheet.height;
  const index = handsFrame();
  const scale = index === 0 ? 0.57 : index === 1 ? 0.6 : 0.68;
  const dw = frameW * scale;
  const dh = frameH * scale;
  const x = index === 3 ? 20 : index === 2 ? 38 : index === 1 ? 22 : 18;
  const y = index === 0 ? 257 : index === 1 ? 205 : index === 2 ? 176 : 158;

  ctx.save();
  ctx.globalAlpha = index === 0 && state.mode === "title" ? 0.72 : 1;
  ctx.filter = "drop-shadow(0 9px 8px rgba(0,0,0,.58))";
  ctx.drawImage(sheet, frameW * index, 0, frameW, frameH, x, y, dw, dh);
  ctx.filter = "none";
  ctx.restore();
}

function drawDodgeCue() {
  if (state.mode !== "play" || state.phase !== "tell" || state.dodged) return;
  const dir = state.dodgeDir;
  if (dir === 0) return;
  const cx = dir < 0 ? 132 : W - 132;
  const y = 250;
  const pulse = 0.5 + 0.5 * Math.sin(state.time * 14);

  ctx.save();
  ctx.textAlign = "center";
  ctx.globalAlpha = 0.45 + pulse * 0.5;
  ctx.fillStyle = "#ff5a3c";
  ctx.font = "900 70px Courier New";
  ctx.fillText(dir < 0 ? "◄" : "►", cx, y);
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = "#f6d987";
  ctx.font = "900 18px Courier New";
  ctx.fillText(dir < 0 ? "ВЛЕВО" : "ВПРАВО", cx, y + 30);
  ctx.restore();
  ctx.textAlign = "left";
  ctx.globalAlpha = 1;
}

function drawWeakPoint() {
  if (state.mode !== "play" || (state.phase !== "open" && state.phase !== "struggle")) return;
  const x = state.weakX * W;
  const y = state.weakY * H;
  const radius = state.phase === "open" ? 18 : 14;
  ctx.save();
  ctx.strokeStyle = state.phase === "open" ? "#f2a733" : "#63e05c";
  ctx.fillStyle = "rgba(242,167,51,0.14)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, radius + Math.sin(state.time * 16) * 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#f6d987";
  ctx.fillRect(x - 3, y - 3, 6, 6);
  ctx.restore();
}

function drawReticle() {
  const x = state.aimX * W;
  const y = state.aimY * H;
  ctx.strokeStyle = state.pulling ? "#f2a733" : "#79e3ff";
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.84;
  ctx.beginPath();
  ctx.arc(x, y, 14, 0, Math.PI * 2);
  ctx.moveTo(x - 24, y);
  ctx.lineTo(x - 8, y);
  ctx.moveTo(x + 8, y);
  ctx.lineTo(x + 24, y);
  ctx.moveTo(x, y - 24);
  ctx.lineTo(x, y - 8);
  ctx.moveTo(x, y + 8);
  ctx.lineTo(x, y + 24);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawRain() {
  ctx.strokeStyle = "rgba(124, 178, 216, 0.28)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 84; i++) {
    const x = (i * 83 + state.time * 118) % W;
    const y = (i * 47 + state.time * 340) % H;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - 8, y + 20);
    ctx.stroke();
  }
}

function drawFlash() {
  if (state.flash <= 0.001) return;
  ctx.save();
  ctx.globalAlpha = Math.min(0.45, state.flash * 0.45);
  ctx.fillStyle = state.flashColor;
  ctx.fillRect(0, 0, W, 420);
  ctx.restore();
  ctx.globalAlpha = 1;
}

function drawPopups() {
  if (!state.popups.length) return;
  ctx.save();
  ctx.textAlign = "center";
  ctx.font = "900 20px Courier New";
  for (const p of state.popups) {
    ctx.globalAlpha = clamp(p.life, 0, 1);
    ctx.fillStyle = "#0a0704";
    ctx.fillText(p.text, p.x + 1, p.y + 1);
    ctx.fillStyle = p.color;
    ctx.fillText(p.text, p.x, p.y);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";
}

/* --- DOOM-стиль статус-бар: клёпаная сталь + красные 7-сегментные числа --- */

const SEG_MAP = {
  "0": "abcdef",
  "1": "bc",
  "2": "abged",
  "3": "abgcd",
  "4": "fgbc",
  "5": "afgcd",
  "6": "afgedc",
  "7": "abc",
  "8": "abcdefg",
  "9": "abcdfg",
};

function drawRivet(x, y) {
  ctx.beginPath();
  ctx.arc(x, y, 3.2, 0, Math.PI * 2);
  ctx.fillStyle = "#0a0805";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x - 0.7, y - 0.8, 1.5, 0, Math.PI * 2);
  ctx.fillStyle = "#9c8c6e";
  ctx.fill();
}

function drawSubPlate(x, y, w, h) {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, "#4c4234");
  g.addColorStop(0.5, "#332b20");
  g.addColorStop(1, "#221c14");
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "rgba(162,144,110,.55)";
  ctx.fillRect(x, y, w, 2);
  ctx.fillRect(x, y, 2, h);
  ctx.fillStyle = "rgba(0,0,0,.65)";
  ctx.fillRect(x, y + h - 2, w, 2);
  ctx.fillRect(x + w - 2, y, 2, h);
  drawRivet(x + 8, y + 8);
  drawRivet(x + w - 8, y + 8);
  drawRivet(x + 8, y + h - 8);
  drawRivet(x + w - 8, y + h - 8);
}

function drawWell(x, y, w, h) {
  ctx.fillStyle = "#080605";
  ctx.fillRect(x, y, w, h);
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, "rgba(0,0,0,.7)");
  g.addColorStop(0.5, "rgba(40,32,22,0)");
  g.addColorStop(1, "rgba(120,100,70,.14)");
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "rgba(0,0,0,.8)";
  ctx.fillRect(x, y, w, 2);
  ctx.fillRect(x, y, 2, h);
  ctx.fillStyle = "rgba(150,130,95,.25)";
  ctx.fillRect(x, y + h - 1, w, 1);
  ctx.fillRect(x + w - 1, y, 1, h);
}

function hudLabel(text, cx, y) {
  ctx.save();
  ctx.textAlign = "center";
  ctx.font = "700 12px Courier New";
  ctx.fillStyle = "#000";
  ctx.fillText(text, cx, y + 1);
  ctx.fillStyle = "#caa45f";
  ctx.fillText(text, cx, y);
  ctx.restore();
  ctx.textAlign = "left";
}

function drawSegDigit(ch, x, y, w, h, t, on, off) {
  const lit = SEG_MAP[ch] || "";
  const vh = (h - 3 * t) / 2;
  const segs = {
    a: [x + t, y, w - 2 * t, t],
    g: [x + t, y + t + vh, w - 2 * t, t],
    d: [x + t, y + h - t, w - 2 * t, t],
    f: [x, y + t, t, vh],
    b: [x + w - t, y + t, t, vh],
    e: [x, y + 2 * t + vh, t, vh],
    c: [x + w - t, y + 2 * t + vh, t, vh],
  };
  ctx.fillStyle = off;
  for (const key of "abcdefg") {
    if (lit.includes(key)) continue;
    const r = segs[key];
    ctx.fillRect(r[0], r[1], r[2], r[3]);
  }
  ctx.save();
  ctx.shadowColor = on;
  ctx.shadowBlur = 7;
  ctx.fillStyle = on;
  for (const key of "abcdefg") {
    if (!lit.includes(key)) continue;
    const r = segs[key];
    ctx.fillRect(r[0], r[1], r[2], r[3]);
  }
  ctx.restore();
}

function drawPercent(x, y, s, on) {
  const r = s * 0.17;
  ctx.save();
  ctx.shadowColor = on;
  ctx.shadowBlur = 4;
  ctx.strokeStyle = on;
  ctx.fillStyle = on;
  ctx.lineWidth = Math.max(2, s * 0.13);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x + s * 0.8, y + s * 0.12);
  ctx.lineTo(x + s * 0.2, y + s * 0.88);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + s * 0.22, y + s * 0.22, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + s * 0.78, y + s * 0.78, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawDigits(str, rightX, topY, dh, on, off) {
  const dw = Math.round(dh * 0.54);
  const t = Math.max(4, Math.round(dw * 0.26));
  const gap = Math.round(dw * 0.34);
  let x = rightX - dw;
  for (let i = str.length - 1; i >= 0; i--) {
    drawSegDigit(str[i], x, topY, dw, dh, t, on, off);
    x -= dw + gap;
  }
}

function drawUnderGauge(x, y, w, value, color) {
  ctx.fillStyle = "#000";
  ctx.fillRect(x, y, w, 5);
  ctx.fillStyle = color;
  ctx.fillRect(x + 1, y + 1, (w - 2) * (clamp(value, 0, 100) / 100), 3);
}

function drawStatZone(x, w, label, value) {
  drawSubPlate(x, 428, w, 104);
  hudLabel(label, x + w / 2, 446);
  const wx = x + 10;
  const wy = 452;
  const ww = w - 20;
  const wh = 58;
  drawWell(wx, wy, ww, wh);

  const v = Math.round(clamp(value, 0, 100));
  let on = "#ff2a18";
  let off = "#1d0604";
  const critical =
    (label === "ЖИЗНЬ" && v < 25) || (label === "СИЛЫ" && v < 20) || (label === "ПАНИКА" && v > 75);
  if (critical) {
    const blink = Math.sin(state.time * 14) > 0;
    on = blink ? "#ff7a4a" : "#5e0f06";
    off = "#180504";
  }
  if (label === "ЗАХВАТ" && v >= 80) {
    on = "#ffd23c";
    off = "#231805";
  }

  const dh = 40;
  const topY = wy + (wh - dh) / 2;
  const ps = dh * 0.46;
  const rightX = wx + ww - 12;
  drawPercent(rightX - ps, topY + (dh - ps), ps, on);
  drawDigits(String(v), rightX - ps - 6, topY, dh, on, off);
  drawUnderGauge(wx, 518, ww, v, on);
}

function drawTargetZone() {
  const x = 290;
  const w = 143;
  drawSubPlate(x, 428, w, 104);
  hudLabel("ЦЕЛЬ", x + w / 2, 446);

  const breathing = state.breathing && state.mode === "play";
  const msg = breathing ? "ВДОХ" : state.message;
  const msgColor = breathing ? "#79e3ff" : state.warning > 0 ? "#ff5a3c" : "#ffb43a";
  ctx.save();
  ctx.textAlign = "center";
  let f = 22;
  ctx.font = `900 ${f}px Courier New`;
  while (ctx.measureText(msg).width > w - 24 && f > 11) {
    f -= 1;
    ctx.font = `900 ${f}px Courier New`;
  }
  ctx.fillStyle = "#000";
  ctx.fillText(msg, x + w / 2 + 1, 481);
  ctx.shadowColor = msgColor;
  ctx.shadowBlur = 8;
  ctx.fillStyle = msgColor;
  ctx.fillText(msg, x + w / 2, 480);
  ctx.restore();
  ctx.textAlign = "left";

  drawMiniMap(x + 10, 498, w - 20, 16);
}

function drawStatList(x, w) {
  drawSubPlate(x, 428, w, 104);
  const rows = [
    ["СЧЁТ", String(Math.round(state.score))],
    ["КОМБО", "x" + Math.max(1, Math.round(state.combo))],
    ["РЕКОРД", String(state.best)],
  ];
  rows.forEach((r, i) => {
    const yy = 450 + i * 27;
    drawWell(x + 8, yy, w - 16, 21);
    ctx.textAlign = "left";
    ctx.fillStyle = "#caa45f";
    ctx.font = "700 11px Courier New";
    ctx.fillText(r[0], x + 14, yy + 15);
    ctx.save();
    ctx.shadowColor = "#ff2a18";
    ctx.shadowBlur = 5;
    ctx.fillStyle = "#ff5a3c";
    ctx.font = "900 14px Courier New";
    ctx.textAlign = "right";
    ctx.fillText(r[1], x + w - 14, yy + 16);
    ctx.restore();
  });
  ctx.textAlign = "left";
}

function drawMiniMap(x, y, w, h) {
  drawWell(x, y, w, h);
  const progress = 1 - state.distance / TOTAL_DISTANCE;
  ctx.fillStyle = "#243029";
  ctx.fillRect(x + 4, y + h / 2 - 1, w - 8, 2);
  ctx.fillStyle = "#5a4a2a";
  ctx.fillRect(x + w - 7, y + 4, 3, h - 8);
  const mx = x + 4 + progress * (w - 12);
  ctx.save();
  ctx.shadowColor = "#ffb43a";
  ctx.shadowBlur = 6;
  ctx.fillStyle = "#ffb43a";
  ctx.fillRect(mx, y + 3, 6, h - 6);
  ctx.restore();
  ctx.fillStyle = "#6a5a3a";
  ctx.font = "700 9px Courier New";
  ctx.textAlign = "right";
  ctx.fillText("ЛЕС", x + w - 3, y + h - 4);
  ctx.textAlign = "left";
}

function drawFaceZone() {
  // Чистый портрет Даши по центру панели (центр = 480), без рамки и без
  // тонировки — просто лицо в слоте, как в DOOM.
  const x = 437;
  const w = 86;
  const y = 422;
  const h = 116;
  ctx.fillStyle = "#0a0806";
  ctx.fillRect(x, y, w, h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  // cover-fit: заполняем слот без искажения пропорций.
  ctx.drawImage(images.hero, 211, 43, 830, 1120, x, y, w, h);
  ctx.restore();
  // Тонкие тёмные кромки по бокам — отделить от соседних блоков.
  ctx.fillStyle = "#000";
  ctx.fillRect(x - 1, y, 1, h);
  ctx.fillRect(x + w, y, 1, h);
  // Лёгкая интеграция со стальной панелью сверху/снизу.
  ctx.fillStyle = "rgba(110,97,81,.45)";
  ctx.fillRect(x, y, w, 2);
  ctx.fillStyle = "#000";
  ctx.fillRect(x, y + h - 2, w, 2);
}

function drawSteelBar() {
  const y = 420;
  const h = 120;
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, "#574b3c");
  g.addColorStop(0.1, "#3c3327");
  g.addColorStop(0.5, "#2b2419");
  g.addColorStop(1, "#141009");
  ctx.fillStyle = g;
  ctx.fillRect(0, y, W, h);
  ctx.fillStyle = "#6e6151";
  ctx.fillRect(0, y, W, 2);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, y + h - 2, W, 2);
}

function drawTicker() {
  ctx.fillStyle = "rgba(6,5,3,.72)";
  ctx.fillRect(0, 398, W, 22);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 398, W, 1);
  ctx.fillRect(0, 419, W, 1);
  fitText("▸ " + state.hint, 12, 413, W - 24, 12, "#caa45f");
}

function drawHud() {
  drawTicker();
  drawSteelBar();
  // Лицо строго по центру панели (центр = 480), 3 зоны слева, 3 справа.
  drawStatZone(6, 138, "ЗАХВАТ", state.grip);
  drawStatZone(148, 138, "ЖИЗНЬ", state.health);
  drawTargetZone();
  drawFaceZone();
  drawStatZone(527, 138, "ПАНИКА", 100 - state.calm);
  drawStatZone(669, 138, "СИЛЫ", state.stamina);
  drawStatList(811, 143);
}

function drawVignette() {
  const panicPct = 100 - state.calm;
  const pulse = state.heartFlash * 0.22;
  const outer = Math.min(0.9, 0.72 + pulse);
  const gradient = ctx.createRadialGradient(W / 2, H / 2, Math.max(40, 120 - pulse * 70), W / 2, H / 2, 520);
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  if (panicPct > 55) {
    const r = (panicPct - 55) / 45;
    gradient.addColorStop(0.55, `rgba(120,12,8,${(0.05 * r + pulse * 0.3).toFixed(3)})`);
  }
  gradient.addColorStop(1, `rgba(0,0,0,${outer.toFixed(3)})`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, W, H);
}

function drawPause() {
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = "center";
  ctx.fillStyle = "#f2a733";
  ctx.font = "900 48px Courier New";
  ctx.fillText("ПАУЗА", W / 2, H / 2 - 6);
  ctx.fillStyle = "#9f8d68";
  ctx.font = "700 15px Courier New";
  ctx.fillText("Esc или P - продолжить", W / 2, H / 2 + 28);
  ctx.textAlign = "left";
}

function drawOverlay() {
  ctx.fillStyle = "rgba(0,0,0,0.64)";
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = "center";
  const title = state.mode === "win" ? "МАШИНА ОСТАНОВИЛАСЬ" : state.mode === "lose" ? "ЛЕСНАЯ РАЗВИЛКА" : TEXT.title;
  ctx.save();
  ctx.font = "900 48px Courier New";
  ctx.fillStyle = "#000";
  ctx.fillText(title, W / 2 + 2, 152);
  ctx.shadowColor = "#ff2a18";
  ctx.shadowBlur = 20;
  ctx.fillStyle = state.mode === "win" ? "#ffd23c" : "#ff2a18";
  ctx.fillText(title, W / 2, 150);
  ctx.restore();

  const lines =
    state.mode === "win"
      ? [
          "Даша дёргает петлю в последний момент. Такси влетает в обочину и глохнет.",
          "Фары выхватывают указатель на лес. Водитель теряет ключи, двери разблокированы.",
          `Развязка: она выбирается на дорогу и вызывает помощь. Счёт: ${Math.round(state.score)}. Рекорд: ${state.best}.`,
        ]
      : state.mode === "lose"
        ? [
            "Такси доезжает до тёмной развилки. Связь пропадает, а впереди только просека.",
            "Развязка: шанс был в коротких приступах водителя. Ранние рывки и паника отдали ему контроль.",
            `Счёт побега: ${Math.round(state.score)}. Рекорд: ${state.best}.`,
          ]
        : [TEXT.subtitle, TEXT.goal, TEXT.controls];

  ctx.textAlign = "left";
  drawWrapped(lines, 145, 204, 670, 23, "#f6d987", "700 18px Courier New");
  ctx.textAlign = "center";
  ctx.fillStyle = "#9f8d68";
  ctx.font = "700 15px Courier New";
  ctx.fillText("Нажми ИГРАТЬ или Enter", W / 2, 346);
  ctx.textAlign = "left";
}

function drawWrapped(lines, x, y, maxWidth, lineHeight, color, font) {
  ctx.fillStyle = color;
  ctx.font = font;
  let cursorY = y;
  for (const paragraph of lines) {
    const words = paragraph.split(" ");
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > maxWidth && line) {
        ctx.fillText(line, x, cursorY);
        cursorY += lineHeight;
        line = word;
      } else {
        line = next;
      }
    }
    if (line) {
      ctx.fillText(line, x, cursorY);
      cursorY += lineHeight;
    }
    cursorY += 8;
  }
}

function fitText(text, x, y, maxWidth, size, color) {
  ctx.fillStyle = color;
  ctx.font = `700 ${size}px Courier New`;
  let out = text;
  while (ctx.measureText(out).width > maxWidth && out.length > 6) out = `${out.slice(0, -5)}...`;
  ctx.fillText(out, x, y);
}

function syncDebugState() {
  canvas.dataset.mode = state.mode;
  canvas.dataset.phase = state.phase;
  canvas.dataset.message = state.message;
  canvas.dataset.health = String(Math.round(state.health));
  canvas.dataset.calm = String(Math.round(state.calm));
  canvas.dataset.stamina = String(Math.round(state.stamina));
  canvas.dataset.grip = String(Math.round(state.grip));
  canvas.dataset.score = String(Math.round(state.score));
  canvas.dataset.combo = String(Math.round(state.combo));
  canvas.dataset.pulling = String(state.pulling);
  canvas.dataset.weakX = String(state.weakX);
  canvas.dataset.weakY = String(state.weakY);
  canvas.dataset.dodgeDir = String(state.dodgeDir);
}

function pointerToAim(event) {
  const rect = canvas.getBoundingClientRect();
  const touchPoint = event.touches?.[0] || event.changedTouches?.[0];
  const cx = touchPoint ? touchPoint.clientX : event.clientX;
  const cy = touchPoint ? touchPoint.clientY : event.clientY;
  state.aimX = clamp((cx - rect.left) / rect.width, 0.08, 0.92);
  state.aimY = clamp((cy - rect.top) / rect.height, 0.12, 0.78);
}

function togglePause() {
  if (state.mode === "play") {
    state.mode = "paused";
    Sound.suspend();
  } else if (state.mode === "paused") {
    state.mode = "play";
    state.last = performance.now();
    Sound.resume();
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

startButton.addEventListener("click", resetGame);
muteButton.addEventListener("click", () => {
  state.muted = !state.muted;
  muteButton.setAttribute("aria-pressed", String(state.muted));
  muteButton.textContent = state.muted ? "ТИХО" : "ЗВУК";
  Sound.setMuted(state.muted);
});

window.addEventListener("resize", resizeCanvas);
window.addEventListener("keydown", (event) => {
  keys.add(event.code);
  if (event.code === "Space") {
    event.preventDefault();
    if (state.mode === "play") state.pulling = true;
  }
  if (event.code === "Enter" && state.mode !== "play" && state.mode !== "paused") resetGame();
  if (event.code === "Escape" || event.code === "KeyP") {
    if (state.mode === "play" || state.mode === "paused") {
      event.preventDefault();
      togglePause();
    }
  }
});
window.addEventListener("keyup", (event) => {
  keys.delete(event.code);
  if (event.code === "Space") state.pulling = false;
});

canvas.addEventListener("pointermove", pointerToAim);
canvas.addEventListener("pointerdown", (event) => {
  pointerToAim(event);
  if (state.mode === "paused") {
    togglePause();
    return;
  }
  if (state.mode !== "play") {
    resetGame();
    return;
  }
  state.pulling = true;
  canvas.setPointerCapture?.(event.pointerId);
});
canvas.addEventListener("pointerup", () => {
  state.pulling = false;
});
canvas.addEventListener("pointercancel", () => {
  state.pulling = false;
});

document.querySelectorAll(".tc").forEach((btn) => {
  const act = btn.dataset.act;
  const set = (value) => {
    if (act === "left") touch.left = value;
    if (act === "right") touch.right = value;
    if (act === "breathe") touch.breathe = value;
  };
  btn.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    Sound.resume();
    set(true);
  });
  const release = () => set(false);
  btn.addEventListener("pointerup", release);
  btn.addEventListener("pointercancel", release);
  btn.addEventListener("pointerleave", release);
});

boot().catch((error) => {
  loading.textContent = "ОШИБКА";
  console.error(error);
});
