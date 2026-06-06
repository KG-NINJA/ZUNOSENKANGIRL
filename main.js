import * as webllm from 'https://esm.run/@mlc-ai/web-llm';
// Minimal 1v1 canvas shooter with distance-based tactics
// Loads a subset of settings from SchemaVersion 1.YAML

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const W = canvas.width;
const H = canvas.height;

const startBtn = document.getElementById('startBtn');
const resetBtn = document.getElementById('resetBtn');
const pHpFill = document.getElementById('pHp');
const eHpFill = document.getElementById('eHp');
const pLabel = document.getElementById('pLabel');
const eLabel = document.getElementById('eLabel');
const pTip = document.getElementById('pTip');
const eTip = document.getElementById('eTip');
const langSpan = document.getElementById('lang');
const titleH1 = document.getElementById('title');
const voiceToggle = document.getElementById('voiceToggle');
const voiceVol = document.getElementById('voiceVol');
const voiceLabel = document.getElementById('voiceLabel');
const aiIndicator = document.getElementById('aiIndicator');
const loadAiBtn = document.getElementById('loadAiBtn');
const webllmToggle = document.getElementById('webllmToggle');
const aiStatus = document.getElementById('aiStatus');

// AI connection layer
// GitHub Pages cannot run a WebSocket server or Ollama server by itself.
// Local WebSocket support is kept only for local development. WebLLM is the Pages-friendly path.
const USE_LOCAL_WS_AI = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
let ws = null;
let enemyAction = null;

if (USE_LOCAL_WS_AI) {
  try {
    ws = new WebSocket('ws://localhost:5173');
    ws.onopen = () => console.log('Connected to local AI server');
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'ai_response') {
        try {
          enemyAction = JSON.parse(data.action);
          if (aiIndicator) aiIndicator.style.display = 'block';
        } catch (e) {
          console.error('Failed to parse AI action:', data.action);
          enemyAction = null;
        }
      }
    };
    ws.onclose = () => console.log('Disconnected from local AI server');
    ws.onerror = (err) => console.warn('Local WebSocket AI unavailable:', err);
  } catch (e) {
    console.warn('Local WebSocket AI disabled:', e);
  }
}

// WebLLM enemy brain: slow tactical layer, not frame-level movement.
const WEBLLM_MODEL = 'Llama-3.2-1B-Instruct-q4f32_1-MLC';
let llmEngine = null;
let llmLoading = false;
let llmBusy = false;
let lastLlmThinkAt = 0;

const playerStats = {
  lastX: null,
  rightMoves: 0,
  leftMoves: 0,
  shots: 0,
  melee: 0,
};

let enemyBrain = {
  mode: 'balanced',
  aggression: 0.55,
  dodge_bias: 'none',
  attack_pattern: 'burst',
};

function setAiStatus(text) {
  if (aiStatus) aiStatus.textContent = text;
}

async function loadWebLLMEnemyBrain() {
  if (llmEngine || llmLoading) return;
  if (!navigator.gpu) {
    setAiStatus('AI: WebGPU unsupported');
    return;
  }
  llmLoading = true;
  setAiStatus('AI: loading model...');
  try {
    llmEngine = await webllm.CreateMLCEngine(WEBLLM_MODEL, {
      initProgressCallback: (p) => {
        const pct = p?.progress ? Math.round(p.progress * 100) : 0;
        setAiStatus(`AI: loading ${pct}%`);
      },
    });
    setAiStatus('AI: ready');
    if (webllmToggle) webllmToggle.checked = true;
  } catch (e) {
    console.error(e);
    setAiStatus('AI: load failed');
  } finally {
    llmLoading = false;
  }
}

function sanitizeBrain(raw) {
  const next = { ...enemyBrain };
  if (['evasive', 'balanced', 'aggressive'].includes(raw.mode)) next.mode = raw.mode;
  if (typeof raw.aggression === 'number') next.aggression = Math.max(0, Math.min(1, raw.aggression));
  if (['left', 'right', 'up', 'down', 'none'].includes(raw.dodge_bias)) next.dodge_bias = raw.dodge_bias;
  if (['burst', 'spread', 'melee', 'bait', 'flank'].includes(raw.attack_pattern)) next.attack_pattern = raw.attack_pattern;
  return next;
}

async function thinkWithWebLLM() {
  if (!llmEngine || llmBusy || !webllmToggle?.checked || !running || !player?.alive || !enemy?.alive) return;
  const now = performance.now();
  if (now - lastLlmThinkAt < 5000) return;
  lastLlmThinkAt = now;
  llmBusy = true;
  if (aiIndicator) aiIndicator.style.display = 'block';
  setAiStatus('AI: thinking');
  try {
    const dx = Math.round(player.x - enemy.x);
    const dy = Math.round(player.y - enemy.y);
    const dist = Math.round(Math.hypot(dx, dy));
    const rightRate = playerStats.rightMoves / Math.max(1, playerStats.rightMoves + playerStats.leftMoves);
    const prompt = `You control the CPU enemy in a 2D 1v1 shooter. Return only JSON. No prose.\n` +
      `Allowed mode: evasive, balanced, aggressive.\n` +
      `Allowed dodge_bias: left, right, up, down, none.\n` +
      `Allowed attack_pattern: burst, spread, melee, bait, flank.\n` +
      `State: player_hp=${player.hp}, enemy_hp=${enemy.hp}, distance=${dist}, dx=${dx}, dy=${dy}, player_right_move_rate=${rightRate.toFixed(2)}, player_shots=${playerStats.shots}, player_melee=${playerStats.melee}.\n` +
      `Choose a counter tactic. JSON schema: {"mode":"balanced","aggression":0.5,"dodge_bias":"none","attack_pattern":"burst"}`;
    const res = await llmEngine.chat.completions.create({
      messages: [
        { role: 'system', content: 'You are a compact tactical game AI. Return strict JSON only.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 80,
    });
    const text = res.choices?.[0]?.message?.content || '';
    const jsonText = text.match(/\{[\s\S]*\}/)?.[0] || text;
    enemyBrain = sanitizeBrain(JSON.parse(jsonText));
    setAiStatus(`AI: ${enemyBrain.mode}/${enemyBrain.attack_pattern}`);
  } catch (e) {
    console.warn('WebLLM tactical decision failed:', e);
    setAiStatus('AI: fallback');
  } finally {
    llmBusy = false;
    if (aiIndicator) aiIndicator.style.display = 'none';
  }
}

// Send game state to optional local AI server for local development only.
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN && player && enemy) {
    ws.send(JSON.stringify({ type: 'game_state', player, enemy }));
  }
}, 1000);

// Game config (will be partially overridden by YAML)
const CFG = {
  locale: 'ja-JP',
  playerSpeed: 220,
  dashSpeed: 460,
  dashTime: 120,
  dashCooldown: 600,
  accel: 2200,
  friction: 0.86,
  shotCooldown: 220,
  shotDamage: 2,
  meleeRange: 60,
  meleeDamage: 9,
  meleeCooldown: 480,
  // Laser travel speed (px/s)
  laserSpeed: 2000,
  // Laser global cooldown (ms) after each shot
  laserGlobalCooldown: 5000,
  // Hitstop in frames (60fps). Easier to tune by feel.
  hitstopFrames: {
    ranged: 4,   // e.g. lasers
    melee: 10,   // e.g. saber
  },
  // Camera shake (melee-only emphasis)
  cameraShake: {
    meleeMag: 6,        // pixels at peak
    meleeDurMs: 140,    // duration
  },
  // Laser global cooldown (ms) after each shot
  laserGlobalCooldown: 3000,
  // Collision/knockback
  knockbackImpulse: 520,
  knockCooldownMs: 220,
  ai: {
    preferMeleeDist: 80,
    preferShootDist: 180,
    dodgeChance: 0.25,
    strafeSpeed: 140,
    // Intermittent fire settings
    burstMin: 2,
    burstMax: 4,
    burstRestMin: 900,   // ms
    burstRestMax: 1800,  // ms
  },
};

// Radio voice system
const VOICE = {
  enabled: false,
  vol: 0.7,
  ctx: null,
  lastTauntAt: 0,
  cooldownMs: 2500,
  lowHpTaunted: false,
};

function ensureAudio() {
  try {
    if (!VOICE.ctx) VOICE.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (VOICE.ctx.state === 'suspended') VOICE.ctx.resume();
  } catch {}
}

// --- Death explosion + falling wreck ---
const wrecks = [];
function spawnDeathWreck(f) {
  // Central wreck body
  const body = {
    x: f.x,
    y: f.y,
    vx: (Math.random()*2-1) * 40,
    vy: -40 + Math.random()*-30,
    rot: Math.random()*Math.PI*2,
    vr: (Math.random()*2-1) * 1.5,
    r: f.r + 6,
    color: f.color,
    alpha: 1,
    life: 2.2, // seconds before fade out
    max: 2.2,
  };

  // Sparks
  const sparks = [];
  const n = 28;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const spd = 120 + Math.random()*220;
    sparks.push({
      x: f.x,
      y: f.y,
      vx: Math.cos(a)*spd,
      vy: Math.sin(a)*spd - 30,
      life: 0.5 + Math.random()*0.6,
      max: 0.5 + Math.random()*0.6,
      color: f.color,
    });
  }
  wrecks.push({ body, sparks });
  // Shock ring
  spawnCollisionFx(f.x, f.y);
}

function updateWrecks(dt) {
  // gravity for body and sparks
  for (let i = wrecks.length - 1; i >= 0; i--) {
    const w = wrecks[i];
    const b = w.body;
    // body
    b.vy += 240 * dt;
    b.x += b.vx * dt; b.y += b.vy * dt;
    b.rot += b.vr * dt;
    b.life -= dt;
    b.alpha = Math.max(0, b.life / b.max);
    // sparks
    for (let j = w.sparks.length - 1; j >= 0; j--) {
      const s = w.sparks[j];
      s.vy += 260 * dt;
      s.x += s.vx * dt; s.y += s.vy * dt;
      s.life -= dt;
      if (s.life <= 0) w.sparks.splice(j, 1);
    }
    // remove when offscreen and faded
    if (b.y - b.r > H + 60 || (b.alpha <= 0 && w.sparks.length === 0)) {
      wrecks.splice(i, 1);
    }
  }
}

function drawWrecks() {
  // draw sparks first
  for (const w of wrecks) {
    for (const s of w.sparks) {
      const t = Math.max(0, s.life / s.max);
      ctx.save();
      ctx.strokeStyle = w.body.color;
      ctx.globalAlpha = 0.7 * t;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - s.vx * 0.02, s.y - s.vy * 0.02);
      ctx.stroke();
      ctx.restore();
    }
  }
  // draw bodies
  for (const w of wrecks) {
    const b = w.body;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.rot);
    ctx.globalAlpha = 0.9 * b.alpha;
    // hull
    ctx.fillStyle = b.color;
    circle(0, 0, b.r);
    // cracks
    ctx.strokeStyle = '#0b0f1a';
    ctx.lineWidth = 2;
    for (let k = 0; k < 5; k++) {
      const ang = (k/5) * Math.PI * 2 + 0.2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(ang) * (b.r - 3), Math.sin(ang) * (b.r - 3));
      ctx.stroke();
    }
    ctx.restore();
  }
}

// --- SFX ---
function playLaserSfx(owner) {
  ensureAudio();
  const ctx = VOICE.ctx; if (!ctx) return;
  // Short pitched blip + click
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  const base = owner === 'player' ? 880 : 520; // Hz
  o.type = 'square';
  o.frequency.setValueAtTime(base, ctx.currentTime);
  o.frequency.exponentialRampToValueAtTime(base * 0.6, ctx.currentTime + 0.06);
  g.gain.setValueAtTime(0.18, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.08);
  o.connect(g).connect(ctx.destination);
  o.start();
  o.stop(ctx.currentTime + 0.09);
}

function playHitSfx(mode = 'ranged') {
  ensureAudio();
  const ctx = VOICE.ctx; if (!ctx) return;
  // Low thump + short noise burst
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(160, ctx.currentTime);
  o.frequency.exponentialRampToValueAtTime(90, ctx.currentTime + 0.08);
  // Emphasize melee a bit more
  const baseGain = 0.28;
  const gainMul = mode === 'melee' ? 1.6 : 1.0;
  g.gain.setValueAtTime(baseGain * gainMul, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.1);
  o.connect(g).connect(ctx.destination);
  o.start();
  o.stop(ctx.currentTime + 0.12);

  const dur = 0.04;
  const frames = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = (Math.random()*2-1) * (1 - i/frames);
  const src = ctx.createBufferSource();
  const bp = ctx.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=800; bp.Q.value=1.0;
  const gn = ctx.createGain(); gn.gain.value = (mode === 'melee' ? 0.35 : 0.2);
  src.buffer = buf;
  src.connect(bp).connect(gn).connect(ctx.destination);
  src.start();
}

function playRadioNoise(durationMs = 160, vol = VOICE.vol * 0.5) {
  if (!VOICE.enabled) return;
  ensureAudio();
  const ctx = VOICE.ctx; if (!ctx) return;
  const duration = Math.max(0.05, durationMs / 1000);
  const frames = Math.floor(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    // white noise & slight decay
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames) * 0.6;
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1000;
  bp.Q.value = 1.2;
  const gain = ctx.createGain();
  gain.gain.value = Math.max(0, Math.min(1, vol));
  src.connect(bp).connect(gain).connect(ctx.destination);
  src.start();
}

function speak(text) {
  if (!VOICE.enabled) return;
  // Fallback if no TTS
  const synth = window.speechSynthesis;
  if (!synth) { playRadioNoise(200); return; }
  // pre-chirp
  playRadioNoise(90);
  const u = new SpeechSynthesisUtterance(text);
  u.lang = CFG.locale === 'ja-JP' ? 'ja-JP' : 'en-US';
  u.rate = CFG.locale === 'ja-JP' ? 1.0 : 1.05;
  u.pitch = 0.95;
  u.volume = Math.max(0, Math.min(1, VOICE.vol));
  u.onend = () => playRadioNoise(70);
  // slight delay to let pre-chirp play first
  setTimeout(() => synth.speak(u), 80);
}

function taunt(kind) {
  const now = performance.now();
  if (now - VOICE.lastTauntAt < VOICE.cooldownMs) return;
  VOICE.lastTauntAt = now;
  let pool = [];
  const JA = CFG.locale === 'ja-JP';
  if (JA) {
    if (kind === 'start') pool = ['見える。私にも。', '通常の三倍のゲインだ。始めよう。'];
    else if (kind === 'hit') pool = ['命中。逃がさない。', '当てた。次で沈める。'];
    else if (kind === 'melee') pool = ['近づくとは浅はかな。斬る。', '接近戦、歓迎する。'];
    else if (kind === 'lowhp') pool = ['限界が近いな。認めたくないものだな？', 'そろそろ終わりだ。'];
  } else {
    if (kind === 'start') pool = ['Target locked. Engage.', 'Comms green. Let’s begin.'];
    else if (kind === 'hit') pool = ['Got a hit. You’re mine.', 'Tagged you. One more to end it.'];
    else if (kind === 'melee') pool = ['Switching to close range. Cutting in.', 'Come closer—I insist.'];
    else if (kind === 'lowhp') pool = ['You’re on your last legs. Bail out?', 'This ends now.'];
  }
  if (pool.length) speak(pool[Math.floor(Math.random()*pool.length)]);
}

// Keyboard
const keys = new Set();
window.addEventListener('keydown', (e) => keys.add(e.key.toLowerCase()));
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

// Basic RNG
const rand = (a, b) => a + Math.random() * (b - a);

// Entities
function makeFighter(x, y, color) {
  return {
    x, y,
    vx: 0, vy: 0,
    r: 16,
    color,
    hp: 100,
    alive: true,
    shotTimer: 0,
    laserLock: 0,
    meleeTimer: 0,
    dashTimer: 0,
    dashCooldown: 0,
    facing: 1,
    knockTimer: 0,
    deadFx: false,
  };
}

// Line lasers (one per side on screen)
const lasers = [];
function hasLaser(owner) { return lasers.some(l => l.owner === owner); }
function spawnLaser(x, y, dir, owner, color) {
  // Enforce single laser per owner on screen
  if (hasLaser(owner)) return false;
  const maxLen = 1200; // span across arena
  lasers.push({
    x1: x, y1: y,
    dir,
    len: 0,
    maxLen,
    owner, color,
    width: 4,
    hit: false,
    fade: 0,
  });
  playLaserSfx(owner);
  return true;
}

// World
const arena = { x: 40, y: 40, w: W - 80, h: H - 80 };
let player, enemy, running = false, last = 0;
let hitlagMs = 0; // freeze timer for impactful hits
// Camera shake state (applies a subtle screen offset during draw)
let cameraShakeMs = 0;
let cameraShakeMag = 0;

function reset() {
  player = makeFighter(arena.x + 60, H / 2, '#ffffff');
  enemy = makeFighter(arena.x + arena.w - 60, H / 2, '#ef4444');
  // Initialize enemy burst shooting state
  enemy.aiShootPause = 0;   // ms remaining for rest
  enemy.aiBurstLeft = 0;    // shots left in current burst
  player.knockTimer = 0;
  enemy.knockTimer = 0;
  player.laserLock = 0;
  enemy.laserLock = 0;
  player.deadFx = false;
  enemy.deadFx = false;
  lasers.length = 0;
  wrecks.length = 0;
  playerStats.lastX = null;
  playerStats.rightMoves = 0;
  playerStats.leftMoves = 0;
  playerStats.shots = 0;
  playerStats.melee = 0;
  enemyBrain = { mode: 'balanced', aggression: 0.55, dodge_bias: 'none', attack_pattern: 'burst' };
  running = false;
  updateHUD();
  draw(0);
}

// YAML loader: fetch and extract a few fields
async function loadSchema() {
  try {
    const res = await fetch('/SchemaVersion%201.YAML');
    if (!res.ok) return;
    const text = await res.text();
    // Extract locales line(s)
    const hasJA = /ja-JP/i.test(text);
    const hasEN = /en-US/i.test(text);
    CFG.locale = hasJA ? 'ja-JP' : (hasEN ? 'en-US' : CFG.locale);

    // Set labels using locale
    if (CFG.locale === 'ja-JP') {
      titleH1.textContent = 'リアルタイム・シューティング (1v1)';
      pLabel.textContent = 'プレイヤー';
      eLabel.textContent = 'CPU';
      langSpan.textContent = '言語: 日本語';
      if (voiceLabel) voiceLabel.textContent = '無線ボイス';
    } else {
      titleH1.textContent = 'RealtimeShoot (1v1)';
      pLabel.textContent = 'Player';
      eLabel.textContent = 'CPU';
      langSpan.textContent = 'Lang: English';
      if (voiceLabel) voiceLabel.textContent = 'Radio Voice';
    }
  } catch (e) {
    console.warn('Failed to load YAML', e);
  }
}

// Input handling for Player
function handlePlayer(dt) {
  const p = player;
  if (!p.alive) return;

  let ax = 0, ay = 0;
  const left = keys.has('a') || keys.has('arrowleft');
  const right = keys.has('d') || keys.has('arrowright');
  const up = keys.has('w') || keys.has('arrowup');
  const down = keys.has('s') || keys.has('arrowdown');

  if (playerStats.lastX !== null) {
    const deltaX = p.x - playerStats.lastX;
    if (deltaX > 0.5) playerStats.rightMoves += 1;
    if (deltaX < -0.5) playerStats.leftMoves += 1;
  }
  playerStats.lastX = p.x;

  if (left) ax -= CFG.accel;
  if (right) ax += CFG.accel;
  if (up) ay -= CFG.accel;
  if (down) ay += CFG.accel;

  // Dash (L or C)
  const dashing = (keys.has('l') || keys.has('c')) && p.dashCooldown <= 0 && p.dashTimer <= 0;
  if (dashing) {
    const dir = Math.atan2(p.vy || (down - up), p.vx || (right - left));
    p.vx += Math.cos(dir) * CFG.dashSpeed;
    p.vy += Math.sin(dir) * CFG.dashSpeed;
    p.dashTimer = CFG.dashTime;
    p.dashCooldown = CFG.dashCooldown;
  }

  // Integrate
  p.vx += ax * dt; p.vy += ay * dt;
  p.vx *= CFG.friction; p.vy *= CFG.friction;

  // Cap speed (unless dashing)
  const sp = Math.hypot(p.vx, p.vy);
  const cap = p.dashTimer > 0 ? CFG.dashSpeed : CFG.playerSpeed;
  if (sp > cap) { p.vx = p.vx / sp * cap; p.vy = p.vy / sp * cap; }

  p.x += p.vx * dt; p.y += p.vy * dt;
  clampToArena(p);

  p.facing = (enemy.x >= p.x) ? 1 : -1;

  // Shooting (J or Z)
  if ((keys.has('j') || keys.has('z')) && p.shotTimer <= 0 && p.laserLock <= 0) {
    const dir = Math.atan2(enemy.y - p.y, enemy.x - p.x);
    const fired = spawnLaser(p.x + Math.cos(dir)*p.r, p.y + Math.sin(dir)*p.r, dir, 'player', '#ffffff');
    if (fired) {
      playerStats.shots += 1;
      p.shotTimer = CFG.shotCooldown;
      p.laserLock = CFG.laserGlobalCooldown;
    }
  }

  // Melee (K or X)
  if ((keys.has('k') || keys.has('x')) && p.meleeTimer <= 0) {
    playerStats.melee += 1;
    tryMelee(p, enemy, 'player');
    p.meleeTimer = CFG.meleeCooldown;
  }

  // Timers
  p.shotTimer -= dt*1000;
  p.laserLock -= dt*1000;
  p.meleeTimer -= dt*1000;
  p.dashTimer -= dt*1000;
  p.dashCooldown -= dt*1000;
}

function clampToArena(o) {
  o.x = Math.max(arena.x + o.r, Math.min(arena.x + arena.w - o.r, o.x));
  o.y = Math.max(arena.y + o.r, Math.min(arena.y + arena.h - o.r, o.y));
}

function tryMelee(attacker, target, owner) {
  const d = Math.hypot(target.x - attacker.x, target.y - attacker.y);
  // Visualize melee swing regardless of hit/whiff
  spawnSaberSwing(attacker, owner);
  if (d <= CFG.meleeRange) {
    hitTarget(target, CFG.meleeDamage, owner, 'melee');
    hint(owner, CFG.locale === 'ja-JP' ? '近接ヒット!' : 'Melee hit!');
  } else {
    hint(owner, CFG.locale === 'ja-JP' ? '空振り' : 'Whiff');
  }
}

function hint(owner, text) {
  const el = owner === 'player' ? pTip : eTip;
  el.textContent = text;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.textContent = '', 800);
}

function hitTarget(t, dmg, by = undefined, mode = undefined) {
  t.hp -= dmg;
  if (t.hp <= 0) {
    t.hp = 0; t.alive = false; running = false;
    if (!t.deadFx) { t.deadFx = true; spawnDeathWreck(t); }
  }
  updateHUD();
  // Add hitstop based on attack type (frames -> ms)
  const frameMs = 1000 / 60;
  if (mode === 'melee') {
    hitlagMs = Math.max(hitlagMs, (CFG.hitstopFrames.melee || 10) * frameMs);
    // Melee-only camera shake & emphasized SFX
    cameraShakeMs = Math.max(cameraShakeMs, CFG.cameraShake.meleeDurMs);
    cameraShakeMag = CFG.cameraShake.meleeMag;
    playHitSfx('melee');
  } else if (mode === 'shot') {
    hitlagMs = Math.max(hitlagMs, (CFG.hitstopFrames.ranged || 4) * frameMs);
    // Keep ranged subtle; no extra shake/SE emphasis
  } else {
    // Fallback to a light hitstop if mode unspecified
    hitlagMs = Math.max(hitlagMs, (CFG.hitstopFrames.ranged || 4) * frameMs);
  }
  // Triggers for enemy taunts
  if (by === 'enemy') {
    if (mode === 'melee') taunt('melee');
    else taunt('hit');
  }
  // Player low HP
  if (!VOICE.lowHpTaunted && player && player.hp <= 25) {
    VOICE.lowHpTaunted = true;
    taunt('lowhp');
  }
}

function updateHUD() {
  pHpFill.style.width = `${Math.max(0, player.hp)}%`;
  eHpFill.style.width = `${Math.max(0, enemy.hp)}%`;
}

// CPU AI
function handleEnemy(dt) {
  const e = enemy; const p = player;
  if (!e.alive) return;

  if (enemyAction) {
    // AI-based action
    if (enemyAction.action === 'move') {
      const dir = enemyAction.direction;
      let ax = 0, ay = 0;
      if (dir === 'left') ax = -CFG.accel * 0.6;
      else if (dir === 'right') ax = CFG.accel * 0.6;
      else if (dir === 'up') ay = -CFG.accel * 0.6;
      else if (dir === 'down') ay = CFG.accel * 0.6;
      e.vx += ax * dt;
      e.vy += ay * dt;
    } else if (enemyAction.action === 'shoot') {
      const dir = Math.atan2(p.y - e.y, p.x - e.x);
      const fired = spawnLaser(e.x + Math.cos(dir)*e.r, e.y + Math.sin(dir)*e.r, dir, 'enemy', '#ef4444');
      if (fired) {
        e.shotTimer = CFG.shotCooldown * rand(0.9, 1.2);
        e.laserLock = CFG.laserGlobalCooldown;
      }
    } else if (enemyAction.action === 'melee') {
      tryMelee(e, p, 'enemy');
      e.meleeTimer = CFG.meleeCooldown * rand(0.8, 1.2);
    }
    enemyAction = null; // Reset after action
    aiIndicator.style.display = 'none'; // AI動作終了
  } else {
    // Fallback to static AI
    // Vector to player
    const dx = p.x - e.x; const dy = p.y - e.y; const dist = Math.hypot(dx, dy) || 1;
    const toPdx = dx / dist, toPdy = dy / dist;

    // Basic strategy, modulated by WebLLM tactical brain.
    // LLM changes intent; deterministic code still performs the fast movement.
    let ax = 0, ay = 0;
    const aggression = enemyBrain.aggression ?? 0.55;
    const preferShoot = CFG.ai.preferShootDist * (enemyBrain.mode === 'evasive' ? 1.25 : enemyBrain.mode === 'aggressive' ? 0.85 : 1.0);
    const preferMelee = CFG.ai.preferMeleeDist * (enemyBrain.attack_pattern === 'melee' ? 1.4 : 1.0);

    if (dist > preferShoot) {
      ax += toPdx * CFG.accel * (0.35 + aggression * 0.45);
      ay += toPdy * CFG.accel * (0.35 + aggression * 0.45);
    } else if (dist > preferMelee) {
      let perp = Math.sign(Math.sin(Date.now()/600)) || 1;
      if (enemyBrain.dodge_bias === 'left') perp = -1;
      if (enemyBrain.dodge_bias === 'right') perp = 1;
      ax += (-toPdy * perp) * CFG.accel * (0.35 + (1 - aggression) * 0.35);
      ay += (toPdx * perp) * CFG.accel * (0.35 + (1 - aggression) * 0.35);
    } else {
      const push = enemyBrain.mode === 'evasive' ? -0.25 : 0.35 + aggression * 0.35;
      ax += toPdx * CFG.accel * push;
      ay += toPdy * CFG.accel * push;
    }

    if (enemyBrain.dodge_bias === 'up') ay -= CFG.accel * 0.25;
    if (enemyBrain.dodge_bias === 'down') ay += CFG.accel * 0.25;

    // (Lasers are instantaneous; keep movement logic focused on range/strafe)

    e.vx += ax * dt; e.vy += ay * dt;
    e.vx *= CFG.friction; e.vy *= CFG.friction;

    // Cap
    const sp = Math.hypot(e.vx, e.vy);
    const cap = CFG.ai.strafeSpeed;
    if (sp > cap) { e.vx = e.vx / sp * cap; e.vy = e.vy / sp * cap; }

    e.x += e.vx * dt; e.y += e.vy * dt;
    clampToArena(e);
    e.facing = (p.x >= e.x) ? 1 : -1;

    // Attack logic
    if (dist <= (enemyBrain.attack_pattern === 'melee' ? CFG.ai.preferMeleeDist * 1.45 : CFG.ai.preferMeleeDist) && e.meleeTimer <= 0) {
      tryMelee(e, p, 'enemy');
      e.meleeTimer = CFG.meleeCooldown * rand(0.8, 1.2);
    } else {
      // Intermittent fire: bursts with rest pauses
      if (e.aiShootPause > 0) {
        e.aiShootPause -= dt * 1000;
      } else if (e.shotTimer <= 0 && e.laserLock <= 0) {
        if (!e.aiBurstLeft || e.aiBurstLeft <= 0) {
          e.aiBurstLeft = Math.floor(rand(CFG.ai.burstMin, CFG.ai.burstMax + 1));
        }
        const spreadAmount = enemyBrain.attack_pattern === 'spread' ? 0.22 : 0.06;
        const spread = rand(-spreadAmount, spreadAmount);
        const dir = Math.atan2(dy, dx) + spread;
        const fired = spawnLaser(e.x + Math.cos(dir)*e.r, e.y + Math.sin(dir)*e.r, dir, 'enemy', '#ef4444');
        if (fired) {
          e.shotTimer = CFG.shotCooldown * rand(0.9, 1.2);
          e.laserLock = CFG.laserGlobalCooldown;
          e.aiBurstLeft -= 1;
          if (e.aiBurstLeft <= 0) {
            e.aiShootPause = rand(CFG.ai.burstRestMin, CFG.ai.burstRestMax);
          }
        } else {
          // laser already on screen; retry shortly
          e.shotTimer = 80;
        }
      }
    }

    e.shotTimer -= dt*1000;
    e.laserLock -= dt*1000;
    e.meleeTimer -= dt*1000;
  }

  // Common logic for both AI and static
  // No need to duplicate movement and timer updates if already handled above
}

// Collision resolution between player and enemy: mutual knockback
function resolveKnockback(dt) {
  if (!player.alive || !enemy.alive) return;
  const dx = enemy.x - player.x;
  const dy = enemy.y - player.y;
  let dist = Math.hypot(dx, dy);
  const minDist = player.r + enemy.r;
  if (dist === 0) {
    // Prevent NaN; random small offset
    dist = 0.0001;
  }
  if (dist < minDist) {
    const nx = dx / dist;
    const ny = dy / dist;
    const penetration = (minDist - dist);
    // Separate equally
    const push = penetration / 2 + 0.5;
    player.x -= nx * push;
    player.y -= ny * push;
    enemy.x += nx * push;
    enemy.y += ny * push;
    clampToArena(player);
    clampToArena(enemy);

    // Apply knockback impulse if not on cooldown
    if (player.knockTimer <= 0) {
      player.vx -= nx * CFG.knockbackImpulse;
      player.vy -= ny * CFG.knockbackImpulse;
      player.knockTimer = CFG.knockCooldownMs;
      // SFX & FX on first application
      spawnCollisionFx(player.x + nx * player.r, player.y + ny * player.r);
      playHitSfx();
    }
    if (enemy.knockTimer <= 0) {
      enemy.vx += nx * CFG.knockbackImpulse;
      enemy.vy += ny * CFG.knockbackImpulse;
      enemy.knockTimer = CFG.knockCooldownMs;
      spawnCollisionFx(enemy.x - nx * enemy.r, enemy.y - ny * enemy.r);
      // only one SFX is enough; keep it light
    }
  }
  // timers decay
  player.knockTimer -= dt * 1000;
  enemy.knockTimer -= dt * 1000;
}

// --- Simple visual effects ---
const fx = [];
function spawnCollisionFx(x, y) {
  fx.push({ x, y, r: 4, life: 0.22, max: 0.22 });
}
function updateFx(dt) {
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i];
    f.life -= dt;
    f.r += 220 * dt; // expand ring
    if (f.life <= 0) fx.splice(i, 1);
  }
}

// --- Melee (saber) swing visuals ---
const swings = [];
function spawnSaberSwing(attacker, owner) {
  const dur = 0.18; // seconds
  const sweep = Math.PI * 1.0; // total sweep angle
  // Base angle from velocity if moving, else facing
  let base = Math.hypot(attacker.vx, attacker.vy) > 10
    ? Math.atan2(attacker.vy, attacker.vx)
    : (attacker.facing >= 0 ? 0 : Math.PI);
  const start = base - sweep * 0.5;
  const end = base + sweep * 0.5;
  swings.push({
    x: attacker.x,
    y: attacker.y,
    r: Math.max(CFG.meleeRange, attacker.r + 10),
    t: 0,
    dur,
    start,
    end,
    owner,
  });
}
function updateMeleeSwings(dt) {
  for (let i = swings.length - 1; i >= 0; i--) {
    const s = swings[i];
    s.t += dt;
    if (s.t >= s.dur) swings.splice(i, 1);
  }
}

function updateLasers(dt) {
  for (let i = lasers.length - 1; i >= 0; i--) {
    const L = lasers[i];
    if (!L.hit) {
      // advance beam length
      L.len += CFG.laserSpeed * dt;
      if (L.len > L.maxLen) L.len = L.maxLen;
      // collision along current segment
      const x2 = L.x1 + Math.cos(L.dir) * L.len;
      const y2 = L.y1 + Math.sin(L.dir) * L.len;
      const target = L.owner === 'player' ? enemy : player;
      if (target.alive && segmentHitsCircle(L.x1, L.y1, x2, y2, target.x, target.y, target.r + (L.width||3)/2)) {
        hitTarget(target, CFG.shotDamage, L.owner, 'shot');
        L.hit = true;
        L.fade = 0.12; // short persistence after hit
      }
      // if reached max without hit, start brief fade
      if (!L.hit && L.len >= L.maxLen) {
        L.hit = true; // use fade path for removal
        L.fade = 0.08;
      }
    } else {
      L.fade -= dt;
      if (L.fade <= 0) {
        lasers.splice(i, 1);
        continue;
      }
    }
  }
}

function segmentHitsCircle(x1,y1,x2,y2,cx,cy,r){
  // distance from circle center to segment
  const dx = x2 - x1, dy = y2 - y1;
  const lx = cx - x1, ly = cy - y1;
  const len2 = dx*dx + dy*dy || 1;
  let t = (lx*dx + ly*dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = x1 + dx*t, py = y1 + dy*t;
  const d = Math.hypot(cx - px, cy - py);
  return d <= r;
}

function draw(dt) {
  // Clear
  ctx.clearRect(0, 0, W, H);

  // Apply camera shake (melee-only trigger). Decays over configured duration.
  ctx.save();
  if (cameraShakeMs > 0) {
    const t = Math.max(0, Math.min(1, cameraShakeMs / (CFG.cameraShake.meleeDurMs || 1)));
    const mag = cameraShakeMag * t;
    const sx = (Math.random() * 2 - 1) * mag;
    const sy = (Math.random() * 2 - 1) * mag;
    ctx.translate(sx, sy);
  }

  // Arena
  ctx.strokeStyle = '#1f2a44';
  ctx.lineWidth = 2;
  roundRect(ctx, arena.x, arena.y, arena.w, arena.h, 12);
  ctx.stroke();

  // Grid subtle
  ctx.strokeStyle = '#0f1a2e';
  ctx.lineWidth = 1;
  for (let x = arena.x + 20; x < arena.x + arena.w; x += 40) {
    line(x, arena.y + 4, x, arena.y + arena.h - 4);
  }
  for (let y = arena.y + 20; y < arena.y + arena.h; y += 40) {
    line(arena.x + 4, y, arena.x + arena.w - 4, y);
  }

  // Lasers (growing beams)
  for (const L of lasers) {
    const x2 = L.x1 + Math.cos(L.dir) * L.len;
    const y2 = L.y1 + Math.sin(L.dir) * L.len;
    ctx.save();
    ctx.strokeStyle = L.color;
    const alpha = L.hit ? Math.max(0, Math.min(1, (L.fade || 0) / 0.12)) : 1;
    ctx.globalAlpha = 0.9 * alpha;
    ctx.lineWidth = L.width || 4;
    ctx.shadowColor = L.color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(L.x1, L.y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }

  // Collision FX
  for (const f of fx) {
    const t = Math.max(0, f.life / f.max);
    ctx.save();
    ctx.strokeStyle = `rgba(255,255,255,${0.35 * t})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Saber swings (visualize melee)
  for (const s of swings) {
    const t = Math.min(1, s.t / s.dur);
    const ang = s.start + (s.end - s.start) * t;
    ctx.save();
    ctx.strokeStyle = s.owner === 'player' ? 'rgba(255,255,255,0.85)' : 'rgba(239,68,68,0.85)';
    ctx.lineWidth = 6;
    ctx.shadowColor = ctx.strokeStyle;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, ang - 0.45, ang + 0.05);
    ctx.stroke();
    ctx.restore();
  }

  // Fighters
  drawFighter(player);
  drawFighter(enemy);

  // Death wrecks drawn above
  drawWrecks();

  if (!running && wrecks.length === 0) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0,0,W,H);
    ctx.fillStyle = '#e6edf3';
    ctx.textAlign = 'center';
    ctx.font = '24px system-ui, sans-serif';
    ctx.fillText(CFG.locale === 'ja-JP' ? 'Startを押してください' : 'Press Start', W/2, H/2);
  }
  // End camera shake transform
  ctx.restore();
}

function drawFighter(f) {
  if (!f.alive) return; // hide original when dead; death is drawn by death FX
  ctx.save();
  ctx.translate(f.x, f.y);

  // Time-based rotation for polygon effect
  const baseRotation = performance.now() * 0.001;
  const pulse = 0.3 + 0.2 * Math.sin(performance.now() * 0.003);

  // Simple polygon rendering with basic lighting
  const sides = 6;
  const radius = f.r;
  const centerRadius = radius * 0.3;

  // Outer glow ring
  ctx.save();
  ctx.strokeStyle = f.color;
  ctx.shadowColor = f.color;
  ctx.shadowBlur = 8 + pulse * 3;
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.6 + pulse * 0.2;
  ctx.beginPath();
  for (let i = 0; i <= sides; i++) {
    const angle = (i / sides) * Math.PI * 2 + baseRotation;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.restore();

  // Main polygon body with lighting
  ctx.beginPath();
  for (let i = 0; i <= sides; i++) {
    const angle = (i / sides) * Math.PI * 2 + baseRotation;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();

  // Create gradient based on light direction
  const lightAngle = Math.PI * 0.3; // Light coming from top-right
  const lightIntensity = Math.max(0, Math.cos(lightAngle));
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);

  const baseColor = f.color;
  gradient.addColorStop(0, baseColor);
  gradient.addColorStop(0.7, adjustColorBrightness(baseColor, 0.7 + lightIntensity * 0.3));
  gradient.addColorStop(1, adjustColorBrightness(baseColor, 0.4 + lightIntensity * 0.2));

  ctx.fillStyle = gradient;
  ctx.globalAlpha = 0.9 + pulse * 0.1;
  ctx.fill();

  // Inner detail lines
  ctx.strokeStyle = adjustColorBrightness(baseColor, 1.3);
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.7;
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2 + baseRotation;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(angle) * centerRadius, Math.sin(angle) * centerRadius);
    ctx.stroke();
  }

  // Center core
  ctx.fillStyle = baseColor;
  ctx.globalAlpha = 0.8 + pulse * 0.3;
  ctx.beginPath();
  ctx.arc(0, 0, centerRadius * 0.6, 0, Math.PI * 2);
  ctx.fill();

  // Enhanced facing indicator
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(f.facing * (radius - 8), 0, 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#ffffff';
  ctx.shadowColor = '#ffffff';
  ctx.shadowBlur = 6;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(f.facing * (radius - 8), 0, 3, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();
}


function adjustColorBrightness(color, factor) {
  // Simple color adjustment - in a real implementation you'd parse RGB values
  if (color === '#ffffff') {
    const val = Math.min(255, Math.floor(255 * factor));
    return `rgb(${val},${val},${val})`;
  } else if (color === '#ef4444') {
    const val = Math.min(255, Math.floor(180 * factor));
    return `rgb(${val},${Math.floor(68 * factor)},${Math.floor(68 * factor)})`;
  }
  return color;
}

function circle(x, y, r) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}
function line(x1, y1, x2, y2) {
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function step(ts) {
  if (!last) last = ts; const ms = ts - last; const dt = Math.min(0.033, ms / 1000); last = ts;
  const inHitlag = hitlagMs > 0;
  if (inHitlag) {
    hitlagMs -= ms;
  }
  // Camera shake ticks regardless of hitlag/running so it shows during freeze
  if (cameraShakeMs > 0) {
    cameraShakeMs -= ms;
    if (cameraShakeMs < 0) cameraShakeMs = 0;
  }
  if (running && !inHitlag) {
    handlePlayer(dt);
    handleEnemy(dt);
    thinkWithWebLLM();
    resolveKnockback(dt);
    updateLasers(dt);
    updateFx(dt);
    updateMeleeSwings(dt);
  }
  // Death animation continues even when paused/hitlag
  updateWrecks(dt);
  draw(dt);
  requestAnimationFrame(step);
}

startBtn.addEventListener('click', () => {
  ensureAudio();
  if (!player.alive || !enemy.alive) reset();
  running = true;
  // Opening taunt
  setTimeout(() => taunt('start'), 200);
});
resetBtn.addEventListener('click', reset);

// Initialize
await loadSchema();
// Voice controls
if (voiceToggle) {
  voiceToggle.addEventListener('change', () => { VOICE.enabled = voiceToggle.checked; });
  // Default OFF per request (other than SFX is silent)
  voiceToggle.checked = false;
  VOICE.enabled = false;
}
if (loadAiBtn) {
  loadAiBtn.addEventListener('click', loadWebLLMEnemyBrain);
}
if (webllmToggle) {
  webllmToggle.addEventListener('change', () => {
    if (webllmToggle.checked && !llmEngine) loadWebLLMEnemyBrain();
    else setAiStatus(webllmToggle.checked ? 'AI: ready' : 'AI: off');
  });
}
if (voiceVol) {
  voiceVol.addEventListener('input', () => { VOICE.vol = parseFloat(voiceVol.value || '0.7'); });
  VOICE.vol = parseFloat(voiceVol.value || '0.7');
}
reset();
requestAnimationFrame(step);
