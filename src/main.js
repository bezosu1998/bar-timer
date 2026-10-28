// KING JIM ビジュアルバータイマー VBT10 の挙動を再現したタイマー本体。
//
// 実機仕様（公式製品ページ / 取材記事より）:
//   - モード1 通常計測: カウントダウン(最大99分50秒) / カウントアップ(最大99分59秒)
//     * 00:00 のままスタートするとカウントアップ
//   - モード2 リピート計測: 作業→休憩→作業…を繰り返し、最後は作業で終わる
//     * 作業は最大99回、休憩は最大98回（= 作業回数 - 1）
//     * 設定順: 作業時間 → 決定 → 休憩時間(コップマーク) → 決定 → リピート数 → 決定(開始)
//   - 目盛り 20 本: カウントダウンは設定時間÷20 ごとに 1 本消える、カウントアップは約5分で 1 本増える
//   - アラーム: 通常計測 約10秒 / リピート切替時 約3秒 / リピート完了時 約10秒
//   - 消音スイッチ / リセット（実機は 1分+10秒 同時押し）
'use strict';

const MAX_DOWN = 99 * 60 + 50;   // 99:50
const MAX_UP = 99 * 60 + 59;     // 99:59
const BAR_SEGS = 20;
const UP_SEG_SEC = 300;          // カウントアップ時 1目盛り≒5分
const ALARM_FINAL = 10;          // 秒
const ALARM_SWITCH = 3;          // 秒
const STORE_KEY = 'vbt10.settings.v1';

// ---------------------------------------------------------------- 設定（永続化）
const defaults = {
  mode: 1,
  muted: false,
  alwaysOnTop: false,
  compact: false,       // ボタン類を隠して液晶だけ表示
  m1: { set: 0 },
  m2: { work: 0, rest: 0, count: 1 },
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return structuredClone(defaults);
    const s = JSON.parse(raw);
    return {
      ...structuredClone(defaults),
      ...s,
      m1: { ...defaults.m1, ...(s.m1 || {}) },
      m2: { ...defaults.m2, ...(s.m2 || {}) },
    };
  } catch {
    return structuredClone(defaults);
  }
}

function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch { /* 保存できなくても動作は継続 */ }
}

const S = loadSettings();

// ---------------------------------------------------------------- 実行時状態
// phase:
//   mode1: idle | running | paused | alarm
//   mode2: setWork | setRest | setCount | running | paused | alarm
const R = {
  phase: S.mode === 1 ? 'idle' : 'setWork',
  dir: 'down',          // down | up（モード1のみ up あり）
  total: 0,             // 現在の区間の全体秒数（目盛り計算用）
  endAt: 0,             // カウントダウン終了予定 (performance.now() 秒)
  startAt: 0,           // カウントアップ開始 (performance.now() 秒)
  remaining: 0,         // 一時停止時の残り秒
  elapsed: 0,           // 一時停止時の経過秒（カウントアップ）
  rep: 1,               // リピート計測: 何回目の作業か (1..count)
  seg: 'work',          // work | rest
  alarmUntil: 0,        // アラーム終了時刻 (performance.now() 秒)
  alarmKind: null,      // final | switch
};

const now = () => performance.now() / 1000;

// ---------------------------------------------------------------- 7セグ表示
const SEG_MAP = {
  0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg',
  5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
};
// 1桁 = 36x64。rect で 7 本のセグメントを置く。
const SEG_RECTS = {
  a: [6, 0, 24, 6], b: [30, 4, 6, 26], c: [30, 34, 6, 26], d: [6, 58, 24, 6],
  e: [0, 34, 6, 26], f: [0, 4, 6, 26], g: [6, 29, 24, 6],
};
const NS = 'http://www.w3.org/2000/svg';

function makeDigit(x) {
  const g = document.createElementNS(NS, 'g');
  g.setAttribute('transform', `translate(${x},0) skewX(-5)`);
  g.classList.add('digit');
  for (const [name, [rx, ry, rw, rh]] of Object.entries(SEG_RECTS)) {
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', rx); r.setAttribute('y', ry);
    r.setAttribute('width', rw); r.setAttribute('height', rh);
    r.setAttribute('rx', 1.5);
    r.classList.add('segm', `seg-${name}`);
    g.appendChild(r);
  }
  return g;
}

function setDigit(g, value) {
  const on = value == null ? '' : SEG_MAP[value];
  for (const r of g.children) {
    const name = r.classList[1].slice(4);
    r.classList.toggle('on', on.includes(name));
  }
}

const bigDigitsG = document.getElementById('bigDigits');
// MM と SS の間を広めに取って M / S ラベルの余白を作る
const bigDigits = [0, 44, 118, 162].map((x) => {
  const d = makeDigit(x);
  bigDigitsG.appendChild(d);
  return d;
});

const repDigitsG = document.getElementById('repDigits');
const repDigits = [0, 44].map((x) => {
  const d = makeDigit(x);
  repDigitsG.appendChild(d);
  return d;
});

// ---------------------------------------------------------------- 目盛り
const barEl = document.getElementById('bar');
const barSegs = [];
for (let i = 0; i < BAR_SEGS; i++) {
  const d = document.createElement('div');
  d.className = 'seg';
  barEl.appendChild(d);
  barSegs.push(d);
}

// ---------------------------------------------------------------- アラーム音
let audioCtx = null;
let alarmNodes = null;

function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// 「ピピピピ、ピピピピ…」を duration 秒ぶんスケジュールする。
function playAlarm(durationSec) {
  stopAlarmSound();
  if (S.muted) return;
  let ctx;
  try { ctx = ensureAudio(); } catch { return; }
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.value = 2730; // 圧電ブザーらしい高さ
  gain.gain.value = 0;
  osc.connect(gain).connect(ctx.destination);
  const t0 = ctx.currentTime + 0.02;
  for (let t = 0; t < durationSec; t += 0.6) {
    for (let k = 0; k < 4; k++) {
      const on = t0 + t + k * 0.11;
      gain.gain.setValueAtTime(0.18, on);
      gain.gain.setValueAtTime(0, on + 0.06);
    }
  }
  osc.start(t0);
  osc.stop(t0 + durationSec + 0.1);
  alarmNodes = { osc, gain };
}

function stopAlarmSound() {
  if (!alarmNodes) return;
  try {
    const { osc, gain } = alarmNodes;
    gain.gain.cancelScheduledValues(0);
    gain.gain.value = 0;
    osc.stop();
  } catch { /* 既に停止済み */ }
  alarmNodes = null;
}

// 操作音（短いクリック音）。消音時は鳴らさない。
function clickSound() {
  if (S.muted) return;
  try {
    const ctx = ensureAudio();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 2730;
    gain.gain.value = 0.12;
    osc.connect(gain).connect(ctx.destination);
    const t = ctx.currentTime;
    osc.start(t);
    gain.gain.setValueAtTime(0, t + 0.04);
    osc.stop(t + 0.05);
  } catch { /* 音が出なくても続行 */ }
}

function startAlarm(kind) {
  const dur = kind === 'final' ? ALARM_FINAL : ALARM_SWITCH;
  R.alarmKind = kind;
  R.alarmUntil = now() + dur;
  playAlarm(dur);
}

function cancelAlarm() {
  R.alarmKind = null;
  R.alarmUntil = 0;
  stopAlarmSound();
}

// ---------------------------------------------------------------- 計測ロジック
function addTime(delta) {
  if (S.mode === 1) {
    if (R.phase === 'idle') {
      S.m1.set = Math.min(MAX_DOWN, S.m1.set + delta);
    } else if ((R.phase === 'running' || R.phase === 'paused') && R.dir === 'down') {
      // 計測中の追加: 残り時間と全体の両方を伸ばす（目盛りの比率を保つ）
      const rem = R.phase === 'running' ? R.endAt - now() : R.remaining;
      const nrem = Math.min(MAX_DOWN, rem + delta);
      const added = nrem - rem;
      if (added <= 0) return;
      R.total += added;
      if (R.phase === 'running') R.endAt += added; else R.remaining = nrem;
    } else {
      return;
    }
  } else {
    if (R.phase === 'setWork') S.m2.work = Math.min(MAX_DOWN, S.m2.work + delta);
    else if (R.phase === 'setRest') S.m2.rest = Math.min(MAX_DOWN, S.m2.rest + delta);
    else return;
  }
  saveSettings();
}

function bumpRepeat() {
  if (S.mode !== 2) return;
  if (!['setWork', 'setRest', 'setCount'].includes(R.phase)) return;
  S.m2.count = (S.m2.count % 99) + 1;
  saveSettings();
}

function beginCountdown(total) {
  R.dir = 'down';
  R.total = total;
  R.endAt = now() + total;
  R.phase = 'running';
}

function pressStart() {
  if (R.phase === 'alarm') {
    cancelAlarm();
    R.phase = S.mode === 1 ? 'idle' : 'setWork';
    return;
  }

  if (S.mode === 1) {
    if (R.phase === 'idle') {
      if (S.m1.set > 0) {
        beginCountdown(S.m1.set);
      } else {
        R.dir = 'up';
        R.total = MAX_UP;
        R.startAt = now();
        R.phase = 'running';
      }
    } else if (R.phase === 'running') {
      if (R.dir === 'down') R.remaining = Math.max(0, R.endAt - now());
      else R.elapsed = now() - R.startAt;
      R.phase = 'paused';
    } else if (R.phase === 'paused') {
      if (R.dir === 'down') R.endAt = now() + R.remaining;
      else R.startAt = now() - R.elapsed;
      R.phase = 'running';
    }
    return;
  }

  // モード2 リピート計測
  switch (R.phase) {
    case 'setWork':
      if (S.m2.work <= 0) return; // 作業時間 0 では先に進めない
      R.phase = 'setRest';
      break;
    case 'setRest':
      R.phase = 'setCount';
      break;
    case 'setCount':
      R.rep = 1;
      R.seg = 'work';
      beginCountdown(S.m2.work);
      break;
    case 'running':
      R.remaining = Math.max(0, R.endAt - now());
      R.phase = 'paused';
      break;
    case 'paused':
      R.endAt = now() + R.remaining;
      R.phase = 'running';
      break;
  }
}

function pressMode() {
  if (R.phase === 'running' || R.phase === 'paused') return; // 計測中は無視
  cancelAlarm();
  S.mode = S.mode === 1 ? 2 : 1;
  R.phase = S.mode === 1 ? 'idle' : 'setWork';
  saveSettings();
}

function pressReset() {
  cancelAlarm();
  if (S.mode === 1) {
    if (R.phase === 'idle') {
      S.m1.set = 0; // 待機中にもう一度リセット → 00:00 に戻す
    }
    R.phase = 'idle';
  } else {
    if (R.phase === 'setWork') {
      S.m2.work = 0; S.m2.rest = 0; S.m2.count = 1;
    }
    R.phase = 'setWork';
    R.rep = 1;
    R.seg = 'work';
  }
  saveSettings();
}

// 区間終了時の処理（モード1 / モード2）
function onCountdownEnd() {
  if (S.mode === 1) {
    R.phase = 'alarm';
    startAlarm('final');
    return;
  }
  // モード2
  if (R.seg === 'work') {
    if (R.rep >= S.m2.count) {
      R.phase = 'alarm';
      startAlarm('final');
      return;
    }
    startAlarm('switch');
    if (S.m2.rest > 0) {
      R.seg = 'rest';
      beginCountdown(S.m2.rest);
    } else {
      // 休憩 0 秒なら即次の作業へ
      R.rep += 1;
      R.seg = 'work';
      beginCountdown(S.m2.work);
    }
  } else {
    startAlarm('switch');
    R.rep += 1;
    R.seg = 'work';
    beginCountdown(S.m2.work);
  }
}

function onCountupEnd() {
  R.phase = 'alarm';
  R.elapsed = MAX_UP;
  startAlarm('final');
}

function tick() {
  const t = now();
  if (R.phase === 'running') {
    if (R.dir === 'down') {
      if (R.endAt - t <= 0) onCountdownEnd();
    } else if (t - R.startAt >= MAX_UP) {
      onCountupEnd();
    }
  }
  if (R.alarmKind && t >= R.alarmUntil) {
    const wasFinal = R.alarmKind === 'final';
    cancelAlarm();
    if (wasFinal && R.phase === 'alarm') {
      // 完了アラームが鳴り終わったら待機状態へ戻る
      R.phase = S.mode === 1 ? 'idle' : 'setWork';
    }
  }
  render(t);
}

// ---------------------------------------------------------------- 描画
const el = {
  clock: document.getElementById('icoClock'),
  down: document.getElementById('icoDown'),
  up: document.getElementById('icoUp'),
  cup: document.getElementById('icoCup'),
  mute: document.getElementById('icoMute'),
  rep: repDigitsG,
  mute_switch: document.getElementById('muteSwitch'),
  mute_btn: document.getElementById('muteBtn'),
  top: document.getElementById('topBtn'),
  status: document.getElementById('status'),
};

function fmt(sec) {
  sec = Math.max(0, Math.round(sec));
  return [Math.floor(sec / 60), sec % 60];
}

// 画面に出す秒数と、目盛り本数、アイコン状態をまとめて決める
function render(t) {
  let shown = 0;          // 表示秒
  let segsOn = 0;         // 目盛り本数
  let countdown = true;   // 矢印の向き
  let cup = false;
  let blinkDigits = false;
  let blinkRep = false;
  let status = '';

  const blinkPhase = Math.floor(t * 2) % 2 === 0; // 2Hz
  const barBlink = R.alarmKind != null && R.phase === 'alarm';

  if (S.mode === 1) {
    if (R.phase === 'idle') {
      shown = S.m1.set;
      countdown = S.m1.set > 0;
      segsOn = S.m1.set > 0 ? BAR_SEGS : 0;
      status = S.m1.set > 0 ? 'カウントダウン待機' : 'カウントアップ待機';
    } else if (R.phase === 'running' || R.phase === 'paused') {
      if (R.dir === 'down') {
        const rem = R.phase === 'running' ? R.endAt - t : R.remaining;
        shown = Math.ceil(rem - 1e-6);
        segsOn = Math.min(BAR_SEGS, Math.ceil(rem / (R.total / BAR_SEGS) - 1e-6));
        status = R.phase === 'running' ? 'カウントダウン中' : '一時停止';
      } else {
        const elapsed = R.phase === 'running' ? t - R.startAt : R.elapsed;
        shown = Math.floor(elapsed);
        segsOn = Math.min(BAR_SEGS, Math.floor(elapsed / UP_SEG_SEC));
        countdown = false;
        status = R.phase === 'running' ? 'カウントアップ中' : '一時停止';
      }
      if (R.phase === 'paused') blinkDigits = true;
    } else if (R.phase === 'alarm') {
      if (R.dir === 'down') { shown = 0; segsOn = 0; }
      else { shown = MAX_UP; segsOn = BAR_SEGS; countdown = false; }
      blinkDigits = true;
      status = '終了！（ボタンで停止）';
    }
  } else {
    // モード2
    if (R.phase === 'setWork') {
      shown = S.m2.work;
      segsOn = S.m2.work > 0 ? BAR_SEGS : 0;
      status = '作業時間を設定 → 決定';
    } else if (R.phase === 'setRest') {
      shown = S.m2.rest;
      segsOn = S.m2.rest > 0 ? BAR_SEGS : 0;
      cup = true;
      status = '休憩時間を設定 → 決定';
    } else if (R.phase === 'setCount') {
      shown = S.m2.work;
      segsOn = BAR_SEGS;
      blinkRep = true;
      status = 'リピート数を設定 → 決定で開始';
    } else if (R.phase === 'running' || R.phase === 'paused') {
      const rem = R.phase === 'running' ? R.endAt - t : R.remaining;
      shown = Math.ceil(rem - 1e-6);
      segsOn = Math.min(BAR_SEGS, Math.ceil(rem / (R.total / BAR_SEGS) - 1e-6));
      cup = R.seg === 'rest';
      if (R.phase === 'paused') blinkDigits = true;
      const label = R.seg === 'rest' ? '休憩' : '作業';
      status = `${label} ${R.rep}/${S.m2.count} 回目${R.phase === 'paused' ? '（一時停止）' : ''}`;
    } else if (R.phase === 'alarm') {
      shown = 0; segsOn = 0;
      blinkDigits = true;
      status = 'リピート完了！（ボタンで停止）';
    }
  }

  // 目盛り
  barSegs.forEach((d, i) => d.classList.toggle('on', i < segsOn));
  barEl.classList.toggle('blink-off', barBlink && !blinkPhase);

  // 本体数字
  const [mm, ss] = fmt(shown);
  const hide = blinkDigits && !blinkPhase;
  const vals = [Math.floor(mm / 10), mm % 10, Math.floor(ss / 10), ss % 10];
  bigDigits.forEach((g, i) => setDigit(g, hide ? null : vals[i]));

  // リピート数（モード2のみ）
  const repVisible = S.mode === 2;
  el.rep.classList.toggle('on', repVisible);
  if (repVisible) {
    let c = S.m2.count;
    if (R.phase === 'running' || R.phase === 'paused') c = S.m2.count - R.rep + 1; // 残り作業回数
    const hideRep = blinkRep && !blinkPhase;
    setDigit(repDigits[0], hideRep ? null : Math.floor(c / 10));
    setDigit(repDigits[1], hideRep ? null : c % 10);
  } else {
    setDigit(repDigits[0], null);
    setDigit(repDigits[1], null);
  }

  // アイコン
  el.clock.classList.toggle('on', S.mode === 2);
  el.down.classList.toggle('on', countdown);
  el.up.classList.toggle('on', !countdown);
  el.cup.classList.toggle('on', cup);
  el.mute.classList.toggle('on', S.muted);
  el.mute_switch.setAttribute('aria-pressed', String(S.muted));
  el.mute_btn.setAttribute('aria-pressed', String(S.muted));
  syncWakeLock();
  el.top.setAttribute('aria-pressed', String(S.alwaysOnTop));
  if (el.status.textContent !== status) el.status.textContent = status;

  updateTitle(mm, ss, status);
}

// ウィンドウタイトルにも残り時間を出す（タスクバーから確認できるように）
let lastTitle = '';
function updateTitle(mm, ss, status) {
  const running = R.phase === 'running';
  const title = running
    ? `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')} - Visual Bar Timer`
    : 'Visual Bar Timer';
  if (title === lastTitle) return;
  lastTitle = title;
  document.title = title;
  try { window.__TAURI__?.window?.getCurrentWindow?.().setTitle(title); } catch { /* ブラウザ単体時 */ }
}

// ---------------------------------------------------------------- 常に手前
async function applyAlwaysOnTop() {
  try {
    await window.__TAURI__?.window?.getCurrentWindow?.().setAlwaysOnTop(S.alwaysOnTop);
  } catch { /* ブラウザ単体時は無視 */ }
}

function toggleAlwaysOnTop() {
  S.alwaysOnTop = !S.alwaysOnTop;
  saveSettings();
  applyAlwaysOnTop();
}

// ---------------------------------------------------------------- コンパクト表示
// ボタン類（上面ボタン・下段・右側面スイッチ）を隠し、ウィンドウも液晶の高さに縮める。
// 操作はキーボード / ホバーで出る小ボタン / 液晶ダブルクリックで続けられる。
const WIN_W = 720;
const WIN_H_FULL = 272;
const WIN_H_COMPACT = 158;
const deviceEl = document.getElementById('device');
const compactBtn = document.getElementById('compactBtn');

async function applyCompact() {
  deviceEl.classList.toggle('compact', S.compact);
  compactBtn.setAttribute('aria-pressed', String(S.compact));
  try {
    const tw = window.__TAURI__?.window;
    if (!tw) return;
    const size = new tw.LogicalSize(WIN_W, S.compact ? WIN_H_COMPACT : WIN_H_FULL);
    await tw.getCurrentWindow().setSize(size);
  } catch { /* ブラウザ単体時は無視 */ }
}

function toggleCompact() {
  S.compact = !S.compact;
  saveSettings();
  applyCompact();
  fitDevice();
}

function toggleMute() {
  S.muted = !S.muted;
  if (S.muted) stopAlarmSound();
  else if (R.alarmKind) playAlarm(Math.max(0, R.alarmUntil - now()));
  saveSettings();
}

// ---------------------------------------------------------------- 入力
// どのボタンを押してもアラームは止まる（実機と同じ）
function anyKeyStopsAlarm() {
  if (R.phase !== 'alarm') {
    // 切替アラーム（3秒）鳴動中もボタン操作で止める
    if (R.alarmKind === 'switch') cancelAlarm();
    return false;
  }
  cancelAlarm();
  R.phase = S.mode === 1 ? 'idle' : 'setWork';
  return true;
}

const actions = {
  mode: () => { if (!anyKeyStopsAlarm()) pressMode(); },
  m10: () => { if (!anyKeyStopsAlarm()) addTime(600); },
  m1: () => { if (!anyKeyStopsAlarm()) addTime(60); },
  s10: () => { if (!anyKeyStopsAlarm()) addTime(10); },
  rep: () => { if (!anyKeyStopsAlarm()) bumpRepeat(); },
  start: () => pressStart(),
  reset: () => pressReset(),
};

function runAction(name) {
  clickSound();
  actions[name]?.();
  render(now());
}

document.querySelectorAll('[data-key]').forEach((btn) => {
  btn.addEventListener('click', () => runAction(btn.dataset.key));
});
el.mute_switch.addEventListener('click', () => { toggleMute(); render(now()); });
el.mute_btn.addEventListener('click', () => { toggleMute(); render(now()); });

// iOS/Android は「ユーザー操作中に作った AudioContext」しか鳴らせないので、
// 最初のタップ/キー操作で（消音中でも）作って unlock しておく。
function unlockAudio() {
  try { ensureAudio(); } catch { /* 無音環境 */ }
  window.removeEventListener('pointerdown', unlockAudio);
  window.removeEventListener('keydown', unlockAudio);
}
window.addEventListener('pointerdown', unlockAudio);
window.addEventListener('keydown', unlockAudio);
el.top.addEventListener('click', toggleAlwaysOnTop);
compactBtn.addEventListener('click', toggleCompact);
document.querySelectorAll('.lcd').forEach((lcd) => lcd.addEventListener('dblclick', toggleCompact));

const KEYMAP = {
  ' ': 'start', 'Enter': 'start',
  '1': 'm10', '2': 'm1', '3': 's10',
  'm': 'mode', 'M': 'mode',
  'n': 'rep', 'N': 'rep',
  'r': 'reset', 'R': 'reset',
};

function flashKey(name) {
  const b = document.querySelector(`[data-key="${name}"]`);
  if (!b) return;
  b.classList.add('pressed');
  setTimeout(() => b.classList.remove('pressed'), 90);
}

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.key === 's' || e.key === 'S') { toggleMute(); render(now()); e.preventDefault(); return; }
  if (e.key === 't' || e.key === 'T') { toggleAlwaysOnTop(); render(now()); e.preventDefault(); return; }
  if (e.key === 'h' || e.key === 'H') { toggleCompact(); e.preventDefault(); return; }
  const name = KEYMAP[e.key];
  if (!name) return;
  e.preventDefault();
  flashKey(name);
  runAction(name);
});

// 右クリックメニュー・ドラッグ選択を抑止して「機器」らしくする
window.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------------------------------------------------------------- 最小化ガード
// 最小化ボタンは tauri.conf.json (minimizable: false) で外してあるが、
// Win+D（デスクトップ表示）やタスクバーのクリックでは隠されるので、気付いたら即復元する。
// 移動は普通にできる。
let unminimizing = false;
async function guardMinimize() {
  if (unminimizing) return;
  try {
    const win = window.__TAURI__?.window?.getCurrentWindow?.();
    if (!win) return;
    if (await win.isMinimized()) {
      unminimizing = true;
      await win.unminimize();
    }
  } catch { /* ブラウザ単体時は無視 */ } finally {
    unminimizing = false;
  }
}

// ---------------------------------------------------------------- スマホ / ブラウザ(PWA)
const IS_TAURI = Boolean(window.__TAURI__);
if (!IS_TAURI) document.documentElement.classList.add('web');

// 計測中は画面をスリープさせない（実機と同じく「画面に置いて見る」使い方のため）。
// iPhone の Web アプリはバックグラウンドで音を鳴らせないので、これが実質のアラーム保証になる。
let wakeLock = null;
let wakeLockBusy = false;
async function syncWakeLock() {
  if (IS_TAURI || !('wakeLock' in navigator) || wakeLockBusy) return;
  const want = (R.phase === 'running' || R.phase === 'alarm') && document.visibilityState === 'visible';
  if (want === Boolean(wakeLock)) return;
  wakeLockBusy = true;
  try {
    if (want) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { wakeLock = null; } finally { wakeLockBusy = false; }
}
document.addEventListener('visibilitychange', () => {
  // 戻ってきたら即座に時刻を進める（バックグラウンドでは tick が止まるため）
  if (document.visibilityState === 'visible') tick();
});

// 横向きスマホなど、幅が足りないときは本体を縮小して収める（縦向きは CSS で組み替える）
const DEVICE_W = 688;
const DEVICE_H_FULL = 240;
const DEVICE_H_COMPACT = 138;
function fitDevice() {
  if (IS_TAURI) return;
  const portrait = window.matchMedia('(max-width: 640px) and (orientation: portrait)').matches;
  if (portrait) { document.documentElement.style.removeProperty('--fit'); return; }
  const h = S.compact ? DEVICE_H_COMPACT : DEVICE_H_FULL;
  const fit = Math.min(1, (window.innerWidth - 16) / DEVICE_W, (window.innerHeight - 16) / h);
  document.documentElement.style.setProperty('--fit', fit.toFixed(3));
}
window.addEventListener('resize', fitDevice);
window.addEventListener('orientationchange', () => setTimeout(fitDevice, 50));

if (!IS_TAURI && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* file:// 等では登録できない */ });
  });
}

// ---------------------------------------------------------------- 起動
applyAlwaysOnTop();
fitDevice();
applyCompact();
setInterval(guardMinimize, 300);
render(now());
setInterval(tick, 50);
