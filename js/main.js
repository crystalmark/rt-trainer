// App shell: setup → briefing → flight → debrief. Wires the engine to the browser radio,
// push-to-talk and (optionally) Claude.
import { Engine } from './engine.js';
import { SCENARIOS } from './scenarios/index.js';
import { PROFILES } from './config.js';
import { BrowserRadio, realClock } from './radio.js';
import { PushToTalk } from './ptt.js';
import { Claude } from './claude.js';
import { computeDebrief } from './debrief.js';
import { tokens, findCallsign, normalize } from './normalize.js';

const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('rt.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('rt.' + k, JSON.stringify(v)); } catch { /* storage off */ } },
};

const state = {
  profiles: store.get('profiles', PROFILES),
  profileId: store.get('profileId', PROFILES[0].id),
  scenarioId: store.get('scenarioId', SCENARIOS[0].id),
  showText: store.get('showText', false),
  engine: null, radio: null, ptt: null, lastEnd: null,
};
const DELAYS = { fast: [0.3, 1], normal: [0.4, 1.6], busy: [1, 3] };

function show(id) { for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id; window.scrollTo(0, 0); }
const profile = () => state.profiles.find(p => p.id === state.profileId) || state.profiles[0];
const scenario = () => SCENARIOS.find(s => s.id === state.scenarioId) || SCENARIOS[0];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------- setup ----------------
function renderSetup() {
  $('aircraft').innerHTML = state.profiles.map(p => `
    <button class="card" type="button" data-p="${p.id}" aria-pressed="${p.id === state.profileId}">
      <span class="reg">${esc(p.reg)}</span><span>${esc(p.note || p.type)}</span>
      <span class="tag ${p.transponder ? 'x' : ''}">${p.transponder ? 'Mode S / C' : 'No transponder'} · ${p.speedKt} kt</span>
    </button>`).join('');
  $('aircraft-edit').innerHTML = state.profiles.map((p, i) => `
    <div class="edit-row">
      <label class="opts-l">Registration<input type="text" id="e-reg-${i}" value="${esc(p.reg)}"></label>
      <label class="opts-l">Type as spoken<input type="text" id="e-type-${i}" value="${esc(p.type)}"></label>
      <label class="opts-l">Cruise kt<input type="number" id="e-kt-${i}" value="${p.speedKt}" min="30" max="140"></label>
      <label class="check"><input type="checkbox" id="e-x-${i}" ${p.transponder ? 'checked' : ''}> Transponder</label>
    </div>`).join('');
  state.profiles.forEach((p, i) => {
    for (const f of ['reg', 'type', 'kt', 'x']) $(`e-${f}-${i}`).addEventListener('change', () => {
      p.reg = $(`e-reg-${i}`).value.trim().toUpperCase() || p.reg;
      p.type = $(`e-type-${i}`).value.trim() || p.type;
      p.speedKt = Number($(`e-kt-${i}`).value) || p.speedKt;
      p.transponder = $(`e-x-${i}`).checked;
      store.set('profiles', state.profiles); renderSetup();
    });
  });
  $('scenarios').innerHTML = SCENARIOS.map(s => `
    <button class="card" type="button" data-s="${s.id}" aria-pressed="${s.id === state.scenarioId}">
      <b>${esc(s.title)}</b><span>${esc(s.subtitle)}</span><span class="mono">${esc(s.unit)} · ${esc(s.freq)}</span>
    </button>`).join('');
  const h = store.get('history', []);
  $('history-block').hidden = !h.length;
  $('history').innerHTML = h.slice(0, 8).map(x => `<li>${esc(x.date)} · ${esc(x.title)} · ${esc(x.reg)}: ${x.stats.readbacksRightFirstTime}/${x.stats.readbacks} readbacks right first time, score ${x.stats.averageScore ?? '–'}</li>`).join('');
}

function bindSetup() {
  $('aircraft').addEventListener('click', e => { const b = e.target.closest('[data-p]'); if (!b) return; state.profileId = b.dataset.p; store.set('profileId', state.profileId); renderSetup(); });
  $('scenarios').addEventListener('click', e => { const b = e.target.closest('[data-s]'); if (!b) return; state.scenarioId = b.dataset.s; store.set('scenarioId', state.scenarioId); renderSetup(); });
  const opts = { 'o-density': 'normal', 'o-scale': '1', 'o-delay': 'normal', 'o-refuse': '0', 'o-key': '' };
  for (const [id, d] of Object.entries(opts)) { $(id).value = store.get(id, d); $(id).addEventListener('change', () => store.set(id, $(id).value)); }
  const checks = { 'o-text': false, 'o-mine': true, 'o-hot': true, 'o-hiss': true };
  for (const [id, d] of Object.entries(checks)) { $(id).checked = store.get(id, d); $(id).addEventListener('change', () => store.set(id, $(id).checked)); }
  $('support-warning').hidden = PushToTalk.supported();
  $('to-brief').addEventListener('click', renderBrief);
  bindMicTest();
}

function bindMicTest() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $('mic-test'), out = $('mic-result');
  if (!SR) { btn.disabled = true; out.textContent = 'Speech recognition is not available in this browser.'; return; }
  let rec = null, text = '';
  const down = e => {
    e.preventDefault(); text = '';
    rec = new SR(); rec.lang = 'en-GB'; rec.interimResults = true; rec.continuous = true;
    rec.onresult = ev => { text = [...ev.results].map(r => r[0].transcript).join(' '); out.textContent = text; };
    rec.onerror = ev => { out.textContent = `Microphone error: ${ev.error}. Check the site has microphone permission.`; };
    rec.onend = () => {
      if (!text) return;
      const cs = findCallsign(tokens(text), profile().reg);
      out.innerHTML = `Heard: “${esc(text)}”<br>Understood as: ${esc(normalize(text))}<br>${cs ? `Callsign recognised (${cs.form === 'full' ? 'full' : cs.form === 'abbr' ? 'abbreviated' : 'partial'}).` : 'Callsign not recognised: try speaking a little slower and clearer.'}`;
    };
    rec.start(); btn.classList.add('keyed'); btn.textContent = 'Listening…';
  };
  const up = e => { e.preventDefault(); rec?.stop(); btn.textContent = 'Hold to test'; };
  btn.addEventListener('pointerdown', down); btn.addEventListener('pointerup', up); btn.addEventListener('pointercancel', up);
  btn.addEventListener('contextmenu', e => e.preventDefault());
}

// ---------------- briefing ----------------
function engineCtxPreview() {
  const p = profile();
  const letters = p.reg.replace(/[^A-Z]/gi, '').toUpperCase();
  return { reg: p.reg, abbr: `${letters[0]}-${letters.slice(-2)}`, type: p.type, transponder: p.transponder, speedKt: p.speedKt };
}
function renderBrief() {
  const s = scenario(), p = profile();
  $('brief-aircraft').textContent = `${p.reg} · ${p.transponder ? 'Mode S' : 'No transponder'}`;
  $('brief-title').textContent = s.title;
  $('brief-sub').textContent = s.subtitle;
  $('brief-lines').innerHTML = s.briefing(engineCtxPreview()).map(l => `<li>${esc(l)}</li>`).join('');
  $('brief-unit').textContent = s.unit; $('brief-freq').textContent = s.freq;
  show('brief');
}

// ---------------- flight ----------------
async function begin() {
  const s = scenario(), p = profile();
  $('begin').disabled = true;
  try {
    state.radio = new BrowserRadio({ hiss: $('o-hiss').checked });
    await state.radio.init();
    const key = $('o-key').value.trim();
    const claude = key ? new Claude({ apiKey: key }) : null;
    const settings = {
      trafficDensity: $('o-density').value, timeScale: Number($('o-scale').value),
      atcDelay: DELAYS[$('o-delay').value] || DELAYS.normal, refusalBias: Number($('o-refuse').value),
    };
    const engine = new Engine({ scenario: s, profile: p, settings, radio: state.radio, clock: realClock, claude, onEvent: onEngineEvent });
    state.engine = engine;
    resetFlightUi(p);
    show('flight');
    if (PushToTalk.supported()) {
      state.ptt = new PushToTalk({
        button: $('ptt'),
        onDown: () => { state.radio.keyClick(); engine.pilotKeyDown(); $('ptt').classList.add('keyed'); $('lamp-tx').classList.add('on'); if ($('o-mine').checked) { $('mine').hidden = false; $('mine').textContent = '…'; } },
        onUp: (text, meta) => {
          state.radio.stopHeterodyne(); state.radio.keyClick();
          $('ptt').classList.remove('keyed'); $('lamp-tx').classList.remove('on');
          if ($('o-mine').checked) $('mine').textContent = text ? `You: ${text}` : (meta.error ? `Not recognised (${meta.error})` : 'Not recognised');
          engine.pilotTransmission(text, meta);
        },
        onInterim: t => { if ($('o-mine').checked) $('mine').textContent = t || '…'; },
        onHotMic: () => engine.hotMic(),
        onLevel: (rms) => { $('meter').style.width = Math.min(100, rms * 900) + '%'; },
        isRadioBusy: () => state.radio.busy,
      });
      await state.ptt.init({ hotMic: $('o-hot').checked });
    } else toast('This browser can’t recognise speech: you can listen, but not transmit.', 'warn');
    requestWakeLock();
    lampLoop();
    await engine.start();
  } catch (err) {
    console.error(err);
    toast(`Couldn’t start: ${err.message || err}`, 'warn');
  } finally { $('begin').disabled = false; }
}

function resetFlightUi(p) {
  $('log').innerHTML = ''; $('cue').textContent = ''; $('leg-label').textContent = '—'; $('leg-time').textContent = '--:--';
  $('leg-bar').style.width = '0'; $('mine').hidden = true; $('toast').hidden = true;
  $('rh-reg').textContent = p.reg;
  $('rh-xpdr').classList.toggle('off', !p.transponder);
  $('rh-squawk').textContent = p.transponder ? '7000' : 'NONE';
  $('f-text').textContent = `Text: ${state.showText ? 'on' : 'off'}`;
  $('f-pause').textContent = 'Pause';
}

let legTimer = null;
function onEngineEvent(ev) {
  switch (ev.kind) {
    case 'radio': addLine(ev.speaker, ev.text, ev.meta || {}); break;
    case 'radioState': {
      const st = ev.state; if (st.unit) $('rh-unit').textContent = st.unit; if (st.freq) $('rh-freq').textContent = Number(st.freq).toFixed(3);
      if ('squawk' in st && profile().transponder) $('rh-squawk').textContent = st.squawk || '7000';
      break;
    }
    case 'leg': startLeg(ev); break;
    case 'cue': case 'position': $('cue').textContent = ev.text || ev.cue || ev.label || ''; break;
    case 'toast': if (ev.text && (!/without pressing PTT/.test(ev.text) || $('o-hot').checked)) toast(ev.text, ev.level); break;
    case 'end': onEnd(ev); break;
  }
}

function addLine(speaker, text, meta) {
  const log = $('log');
  const toMe = speaker === 'atc' && meta.toPilot;
  const cls = speaker === 'pilot' ? 'me' : toMe ? 'you' : '';
  const who = speaker === 'pilot' ? 'You' : speaker === 'atc' ? 'ATC' : speaker;
  const div = document.createElement('div');
  div.className = `line ${cls}${state.showText || speaker === 'pilot' ? '' : ' hidden-text'}`;
  div.innerHTML = `<b>${esc(who)}</b>${state.showText || speaker === 'pilot' ? esc(text) : '(transmission)'}`;
  div.dataset.text = text;
  log.appendChild(div);
  while (log.children.length > 60) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}

function startLeg({ label, ms, cue }) {
  clearInterval(legTimer);
  $('leg-label').textContent = label;
  if (cue) $('cue').textContent = cue;
  const t0 = Date.now();
  const tick = () => {
    const paused = state.engine?.paused;
    const left = Math.max(0, ms - (Date.now() - t0));
    if (!paused) {
      $('leg-time').textContent = fmt(left / 1000);
      $('leg-bar').style.width = `${Math.min(100, 100 * (1 - left / ms))}%`;
    }
    if (left <= 0) clearInterval(legTimer);
  };
  tick(); legTimer = setInterval(tick, 1000);
}

function lampLoop() {
  const rx = $('lamp-rx');
  const loop = () => { if (!state.engine?.running) { rx.classList.remove('on'); return; } rx.classList.toggle('on', !!state.radio?.busy); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}

let toastTimer = null;
function toast(text, level = 'warn') {
  const t = $('toast'); t.textContent = text; t.className = `toast ${level}`; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

let wakeLock = null;
async function requestWakeLock() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not allowed */ } }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.engine?.running) requestWakeLock(); });

function bindFlight() {
  $('f-text').addEventListener('click', () => {
    state.showText = !state.showText; store.set('showText', state.showText);
    $('f-text').textContent = `Text: ${state.showText ? 'on' : 'off'}`;
    for (const l of $('log').children) if (!l.classList.contains('me')) { l.classList.toggle('hidden-text', !state.showText); l.lastChild.textContent = state.showText ? l.dataset.text : '(transmission)'; }
  });
  $('f-pause').addEventListener('click', () => {
    const e = state.engine; if (!e) return;
    e.paused = !e.paused; $('f-pause').textContent = e.paused ? 'Resume' : 'Pause';
    if (e.paused) speechSynthesis.pause(); else speechSynthesis.resume();
  });
  $('f-end').addEventListener('click', () => state.engine?.stop());
}

// ---------------- debrief ----------------
function onEnd({ events, ctx, summary }) {
  clearInterval(legTimer);
  state.ptt?.destroy(); state.ptt = null;
  state.radio?.stopAll();
  wakeLock?.release?.(); wakeLock = null;
  const s = scenario();
  const d = computeDebrief(events);
  state.lastEnd = { events, ctx, summary, d };
  const h = store.get('history', []);
  h.unshift({ date: new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }), title: s.title, reg: ctx.reg, summary, stats: d.stats });
  store.set('history', h.slice(0, 30));
  renderDebrief(s, ctx, summary, d);
  show('debrief');
}

function renderDebrief(s, ctx, summary, { stats, issues, timeline }) {
  $('d-eyebrow').textContent = `${s.title} · ${ctx.reg}`;
  $('d-summary').textContent = summary || 'Session ended early.';
  const st = (label, v, cls = '') => `<div class="stat ${cls}"><b>${v ?? '–'}</b><span>${label}</span></div>`;
  $('d-stats').innerHTML = [
    st('average call score', stats.averageScore, stats.averageScore >= 85 ? 'good' : stats.averageScore < 65 ? 'bad' : ''),
    st('readbacks right first time', `${stats.readbacksRightFirstTime}/${stats.readbacks}`, stats.readbacks && stats.readbacksRightFirstTime === stats.readbacks ? 'good' : ''),
    st('ATC corrections', stats.corrections, stats.corrections ? 'bad' : 'good'),
    st('missed calls', stats.missedCalls, stats.missedCalls ? 'bad' : 'good'),
    st('spoke without PTT', stats.unkeyedSpeech, stats.unkeyedSpeech ? 'bad' : ''),
    st('blocked transmissions', stats.blocked, stats.blocked ? 'bad' : ''),
    st('late or missed reports', stats.lateReports, stats.lateReports ? 'bad' : 'good'),
    st('median reply time (s)', stats.medianResponseSec),
  ].join('');
  $('d-issues').innerHTML = issues.length ? issues.slice(0, 6).map(i => `<li><b>${esc(i.title)}</b><span>${esc(i.detail)}</span></li>`).join('') : '<li><b>Clean session.</b><span>Try it busier, faster, or with refusals set to “More often”.</span></li>';
  $('d-timeline').innerHTML = timeline.map(renderTl).join('');
  $('d-claude').textContent = '';
  const hasKey = !!$('o-key').value.trim();
  $('d-claude-btn').hidden = !hasKey;
  $('d-claude-block').hidden = !hasKey;
}

function renderTl(e) {
  const t = `<span class="t">${fmt(e.t)}</span>`;
  if (e.type === 'readback' || e.type === 'call') {
    const r = e.result || {};
    const miss = r.missing?.length ? `<div class="miss">Missing: ${esc(r.missing.join(', '))}</div>` : '';
    const subs = (r.substitutions || []).map(x => `<div class="miss">Said “${esc(x.said)}” for “${esc(x.label)}”. ${esc(x.why || '')}</div>`).join('');
    const soft = (r.softMissing || []).filter(x => x.why).map(x => `<div class="soft">${esc(x.label)}: ${esc(x.why)}</div>`).join('');
    const fil = (r.fillers || []).map(f => `<div class="soft">${esc(f)}</div>`).join('');
    const order = r.orderOk === false ? '<div class="soft">Items read back in a different order from the controller.</div>' : '';
    const cs = !r.callsign ? '<div class="miss">No callsign.</div>' : r.callsign === 'partial' ? '<div class="soft">Callsign incomplete.</div>' : '';
    const atc = e.atcText ? `<div class="atc">ATC: ${esc(e.atcText)}</div>` : '';
    const model = e.model && (miss || subs || soft || fil || order || cs) ? `<div class="model">Better: ${esc(e.model)}</div>` : '';
    const bad = miss || subs || cs ? ' bad' : '';
    return `<li class="tl${bad}"><div class="t">${fmt(e.t)}<span class="score">${r.score != null ? r.score + '/100' : ''}</span></div>${atc}<div class="said">You: ${esc(e.text)}</div>${miss}${subs}${cs}${order}${soft}${fil}${model}</li>`;
  }
  const labels = {
    correction: `ATC corrected you: “${e.text}”`, missed: 'No reply to ATC', late: 'Late report: ATC chased you', 'no-call': 'Expected call not made',
    blocked: 'Blocked: you transmitted over another station', 'hot-mic': 'Spoke without pressing PTT (not transmitted)', 'stepped-in': 'Called in the middle of another exchange',
    'wrong-callsign': `Answered a call for ${e.forCall}`, note: e.text, offscript: `Left the script: “${e.text}”. Claude took over.`,
    'free-assessment': `You: “${e.text}”${e.assessment ? ` · ${e.assessment}` : ''}`, 'say-again': 'You asked for a repeat', answer: `Asked for ${e.asked}: “${e.text}”`,
    unexpected: `Unexpected call: “${e.text}”`, position: e.label, cue: e.text, atc: `ATC: ${e.text}`,
  };
  const neutral = ['note', 'position', 'cue', 'atc', 'say-again', 'answer', 'free-assessment'].includes(e.type);
  return `<li class="tl event${neutral ? '' : ' bad'}">${t}<div class="${e.type === 'atc' ? 'atc' : ''}">${esc(labels[e.type] || e.type)}</div></li>`;
}

async function claudeDebrief() {
  const key = $('o-key').value.trim(); if (!key || !state.lastEnd) return;
  const btn = $('d-claude-btn'); btn.disabled = true; btn.textContent = 'Writing debrief…';
  try {
    const c = new Claude({ apiKey: key });
    const { events, ctx, d } = state.lastEnd;
    $('d-claude').textContent = await c.debrief({ scenario: scenario(), ctx, events, stats: d.stats });
    btn.hidden = true;
  } catch (err) { $('d-claude').textContent = `Couldn’t get a debrief: ${err.message}`; }
  finally { btn.disabled = false; btn.textContent = 'Ask Claude for a debrief'; }
}

function fmt(sec) { sec = Math.max(0, Math.round(sec)); return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`; }

// ---------------- boot ----------------
renderSetup();
bindSetup();
bindFlight();
$('brief-back').addEventListener('click', () => show('setup'));
$('begin').addEventListener('click', begin);
$('d-home').addEventListener('click', () => { renderSetup(); show('setup'); });
$('d-again').addEventListener('click', renderBrief);
$('d-claude-btn').addEventListener('click', claudeDebrief);
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
window.__rt = state; // debugging / automated tests
