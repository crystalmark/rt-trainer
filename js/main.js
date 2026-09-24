// App shell: setup → briefing → flight → debrief. Wires the engine to the browser radio,
// push-to-talk and (optionally) Claude.
import { Engine } from './engine.js';
import { SCENARIOS } from './scenarios/index.js';
import { AREAS } from './areas/index.js';
import { parseRoute, planRoute, routeText, mapPoints } from './route.js';
import { MovingMap } from './map.js';
import { customScenario } from './scenarios/custom.js';
import { LISTEN_UNITS, listenScenario } from './scenarios/listen.js';
import { briefLine } from './scenarios/common.js';
import { PROFILES } from './config.js';
import { BrowserRadio, realClock, voiceChoices, voiceForUnit } from './radio.js';
import { PushToTalk } from './ptt.js';
import { Claude } from './claude.js';
import { computeDebrief } from './debrief.js';
import { rowsFrom, stats as heardStats, append as heardAppend, load as heardLoad, clear as heardClear } from './heard.js';
import { tokens, findCallsign, normalize, speakable } from './normalize.js';

const $ = id => document.getElementById(id);
// Site data can be blocked (a browser setting), and then even reading window.localStorage throws. So it is read once,
// here, and null when it can't be had: the debrief read it directly, threw, and was never shown.
const LS = (() => { try { return window.localStorage; } catch { return null; } })();
const store = {
  get(k, d) { try { const v = LS.getItem('rt.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { LS.setItem('rt.' + k, JSON.stringify(v)); } catch { /* storage off */ } },
};

// Storage is shared with the other apps on crystalmark.co.uk, so what comes back is only taken if it has the shape this
// page writes, and it is escaped wherever it is shown: planted there, markup would otherwise run at every launch.
const isProfile = p => p && typeof p.id === 'string' && typeof p.reg === 'string' && typeof p.type === 'string'
  && Number.isFinite(p.speedKt) && typeof p.transponder === 'boolean';
const storedProfiles = () => { const v = store.get('profiles', null); return Array.isArray(v) && v.length && v.every(isProfile) ? v : PROFILES; };
const pastSessions = () => { const v = store.get('history', []); return Array.isArray(v) ? v.filter(x => x && typeof x === 'object' && x.stats) : []; };

const state = {
  profiles: storedProfiles(),
  profileId: store.get('profileId', PROFILES[0].id),
  scenarioId: store.get('scenarioId', SCENARIOS[0].id),
  showText: store.get('showText', false),
  routes: store.get('routes', { leeds: { text: 'Skipton to Wetherby via Salts Mill and Eccup Reservoir', alt: 2800 } }),
  listenUnit: store.get('listenUnit', 'leeds'),
  engine: null, radio: null, ptt: null, lastEnd: null, built: null,
};
const DELAYS = { fast: [0.3, 1], normal: [0.4, 1.6], busy: [1, 3] };
// "Your own route" cards, one per area: the scenario is built from the route when you ask for a briefing.
const CUSTOM = AREAS.map(area => ({ id: `custom-${area.id}`, area, title: `${area.name}: your own route`,
  subtitle: 'Describe a route: ATC works out the clearance, the VRPs you report and where you leave.', unit: area.unit, freq: area.freq }));
// Listening out: one card, with the frequency chosen below it.
const listenCard = () => {
  const u = LISTEN_UNITS.find(x => x.id === state.listenUnit) || LISTEN_UNITS[0];
  return { id: 'listen', listen: true, title: 'Listen out', unit: u.unit, freq: u.freq,
    subtitle: 'Sit on a frequency and listen to the traffic: no calls to make.' };
};
const choices = () => [...SCENARIOS, ...CUSTOM, listenCard()];

function show(id) { for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id; window.scrollTo(0, 0); }
const profile = () => state.profiles.find(p => p.id === state.profileId) || state.profiles[0];
const choice = () => choices().find(s => s.id === state.scenarioId) || SCENARIOS[0];
const scenario = () => state.built || choice();
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------- setup ----------------
function renderSetup() {
  $('aircraft').innerHTML = state.profiles.map(p => `
    <button class="card" type="button" data-p="${esc(p.id)}" aria-pressed="${p.id === state.profileId}">
      <span class="reg">${esc(p.reg)}</span><span>${esc(p.note || p.type)}</span>
      <span class="tag ${p.transponder ? 'x' : ''}">${p.transponder ? 'Mode S / C' : 'No transponder'} · ${esc(p.speedKt)} kt</span>
    </button>`).join('');
  $('aircraft-edit').innerHTML = state.profiles.map((p, i) => `
    <div class="edit-row">
      <label class="opts-l">Registration<input type="text" id="e-reg-${i}" value="${esc(p.reg)}"></label>
      <label class="opts-l">Type as spoken<input type="text" id="e-type-${i}" value="${esc(p.type)}"></label>
      <label class="opts-l">Cruise kt<input type="number" id="e-kt-${i}" value="${esc(p.speedKt)}" min="30" max="140"></label>
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
  $('scenarios').innerHTML = choices().map(s => `
    <button class="card" type="button" data-s="${esc(s.id)}" aria-pressed="${s.id === state.scenarioId}">
      <b>${esc(s.title)}</b><span>${esc(s.subtitle)}</span><span class="mono">${esc(s.unit)} · ${esc(s.freq)}</span>
    </button>`).join('');
  renderRoutePanel();
  renderListenPanel();
  const h = pastSessions();
  $('history-block').hidden = !h.length;
  $('history').innerHTML = h.slice(0, 8).map(x => `<li>${esc(x.date)} · ${esc(x.title)} · ${esc(x.reg)}: ${esc(x.stats.readbacksRightFirstTime)}/${esc(x.stats.readbacks)} readbacks right first time, score ${esc(x.stats.averageScore ?? '–')}</li>`).join('');
}

function renderListenPanel() {
  const c = choice();
  $('listen-panel').hidden = !c.listen;
  if (!c.listen) return;
  const here = LISTEN_UNITS.find(u => u.id === state.listenUnit) || LISTEN_UNITS[0];
  $('listen-unit').innerHTML = LISTEN_UNITS.map(u =>
    `<option value="${esc(u.id)}"${u.id === here.id ? ' selected' : ''}>${esc(u.unit)} · ${esc(u.freq)}</option>`).join('');
  $('listen-about').textContent = here.about;
}

// ---------------- your own route ----------------
function renderRoutePanel() {
  const { area } = choice();
  $('route-panel').hidden = !area;
  if (!area) return;
  const r = state.routes[area.id] || { text: '', alt: 2500 };
  $('route-text').value = r.text;
  $('route-alt').value = r.alt;
  $('route-places-title').textContent = `Places I know around ${area.name}`;
  const places = [...area.places].sort((a, b) => (b.kind === 'vrp') - (a.kind === 'vrp') || a.name.localeCompare(b.name));
  $('route-places').innerHTML = places.map(p => `<button type="button" class="chip${p.kind === 'vrp' ? ' vrp' : ''}" data-place="${esc(p.name)}">${esc(p.name)}${p.kind === 'vrp' ? '<b>VRP</b>' : ''}</button>`).join('');
  checkRoute();
}

/**
 * Read the route box, show what ATC will make of it, and remember it. An altitude typed in the route
 * ("at 2800 ft") fills the altitude box when it came from the text. Returns { points, altitude } if it can be flown.
 */
function checkRoute({ fromText = false } = {}) {
  const { area } = choice();
  if (!area) return null;
  const text = $('route-text').value;
  const parsed = parseRoute(text, area);
  if (fromText && parsed.altitude) $('route-alt').value = parsed.altitude;
  const alt = Number($('route-alt').value) || 2500;
  state.routes[area.id] = { text, alt };
  store.set('routes', state.routes);
  if (!text.trim()) {
    $('route-check').innerHTML = '<p class="hint">Where you start, any points on the way and where you finish, e.g. “Skipton to Wetherby via Salts Mill and Eccup Reservoir at 2800 ft”.</p>';
    return null;
  }
  const out = parsed.unknown.map(u => `<p class="warn">I don’t know “${esc(u.text)}”.${u.suggestions.length
    ? ` Did you mean${u.suggestions.map(n => ` <button type="button" class="chip" data-swap="${esc(u.text)}" data-to="${esc(n)}">${esc(n)}</button>`).join('')}?`
    : ' Pick a place from the list below.'}</p>`);
  out.push(...parsed.notes.map(n => `<p class="hint">${esc(n)}</p>`));
  const plan = planRoute(area, parsed.points, alt);
  if (parsed.points.length) out.push(`<div class="path">${esc(routeText(parsed.points, alt))}</div>`);
  if (plan.errors.length) out.push(...plan.errors.map(e => `<p class="warn">${esc(e)}</p>`));
  else {
    const T = plan.transit, p = profile();
    const lines = [`${Math.round(plan.total)} nm, about ${Math.round(plan.total / p.speedKt * 60)} min at ${p.speedKt} kt.`];
    if (T) lines.push(`Zone transit: into ${T.entryVolume.name} after ${Math.round(T.sIn)} nm${T.via ? `, cleared via ${T.via.place.name}` : ''}; out to the ${T.exitSide} after ${Math.round(T.sOut)} nm.`,
      T.reports.length ? `You’ll report ${T.reports.map(r => r.place.name).join(', ')}.` : 'No reporting points on the way: you’ll report leaving controlled airspace.');
    else lines.push(`Stays outside controlled airspace (${plan.closest.d.toFixed(1)} nm from ${plan.closest.volume.name} at the closest): a Basic Service flight.`);
    lines.push(...plan.under.map(u => `Passes under ${u.volume.name}, base ${u.volume.base} ft: only ${u.gap} ft above you.`), ...plan.warnings);
    out.push(`<ul>${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>`);
  }
  $('route-check').innerHTML = out.join('');
  return !plan.errors.length && !parsed.unknown.length ? { points: parsed.points, altitude: alt } : null;
}

function bindRoute() {
  let timer = null;
  $('route-text').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => checkRoute({ fromText: true }), 250); });
  $('route-alt').addEventListener('input', () => checkRoute());
  $('route-check').addEventListener('click', e => {
    const b = e.target.closest('[data-swap]'); if (!b) return;
    $('route-text').value = $('route-text').value.replace(b.dataset.swap, b.dataset.to);
    checkRoute({ fromText: true });
  });
  $('route-places').addEventListener('click', e => {
    const b = e.target.closest('[data-place]'); if (!b) return;
    const t = $('route-text').value.trim().replace(/[,;]$/, '');
    $('route-text').value = t ? `${t}, ${b.dataset.place}` : b.dataset.place;
    checkRoute({ fromText: true });
  });
}

function bindSetup() {
  $('aircraft').addEventListener('click', e => { const b = e.target.closest('[data-p]'); if (!b) return; state.profileId = b.dataset.p; store.set('profileId', state.profileId); renderSetup(); });
  $('scenarios').addEventListener('click', e => { const b = e.target.closest('[data-s]'); if (!b) return; state.scenarioId = b.dataset.s; store.set('scenarioId', state.scenarioId); renderSetup(); });
  // The old on/off static switch becomes a level, for anyone who ever set it. It was only stored once changed, and
  // "never set" was taken as on: every new install started at Normal, not the Quiet the page is meant to start at.
  const hiss = store.get('o-hiss', null);
  if (store.get('o-noise', null) === null && hiss !== null) store.set('o-noise', hiss ? 'normal' : 'off');
  const opts = { 'o-density': 'normal', 'o-scale': '1', 'o-delay': 'normal', 'o-refuse': '0', 'o-noise': 'low', 'o-key': '' };
  for (const [id, d] of Object.entries(opts)) { $(id).value = store.get(id, d); $(id).addEventListener('change', () => store.set(id, $(id).value)); }
  const checks = { 'o-text': false, 'o-mine': true, 'o-hot': true };
  for (const [id, d] of Object.entries(checks)) { $(id).checked = store.get(id, d); $(id).addEventListener('change', () => store.set(id, $(id).checked)); }
  $('o-noise').addEventListener('change', () => state.radio?.setNoise($('o-noise').value));   // takes effect in flight
  $('listen-unit').addEventListener('change', () => { state.listenUnit = $('listen-unit').value; store.set('listenUnit', state.listenUnit); renderSetup(); });
  $('support-warning').hidden = PushToTalk.supported();
  $('to-brief').addEventListener('click', renderBrief);
  bindVoice();
  bindRoute();
  bindMicTest();
}

// ---------------- controller voice ----------------
const SAMPLE = 'Golf Charlie Lima Hotel Papa, Leeds Radar, cleared to enter the Leeds control zone via Salts Mill, ' +
  'VFR, not above altitude 3000 feet, Leeds QNH 1017. Report Salts Mill';

function fillVoices() {
  const voices = voiceChoices();
  if (!voices.length) return;
  const chosen = store.get('voice', '');
  $('o-voice').innerHTML = [`<option value="">A different voice for each unit</option>`,
    ...voices.map(v => `<option value="${esc(v.name)}"${v.name === chosen ? ' selected' : ''}>${esc(v.name)} · ${esc(v.lang)}${v.localService ? '' : ' · network'}</option>`)].join('');
}

function bindVoice() {
  fillVoices();
  speechSynthesis.addEventListener('voiceschanged', fillVoices);
  $('o-voice').addEventListener('change', () => { store.set('voice', $('o-voice').value); testVoice(); });
  $('voice-test').addEventListener('click', testVoice);
}

function testVoice() {
  const voice = voiceForUnit(choice().unit, $('o-voice').value);
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(speakable(SAMPLE));
  if (voice) { u.voice = voice; u.lang = voice.lang; }
  u.rate = 1.08;
  speechSynthesis.speak(u);
}

function bindMicTest() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $('mic-test'), out = $('mic-result');
  if (!SR) { btn.disabled = true; out.textContent = 'Speech recognition is not available in this browser.'; return; }
  let rec = null, text = '', heard = false;
  const down = e => {
    e.preventDefault(); text = ''; heard = false;
    try { rec?.abort(); } catch { /* finished */ }   // an old one still running holds the recogniser (Android)
    rec = new SR(); rec.lang = 'en-GB'; rec.interimResults = true; rec.continuous = true;
    for (const ev of ['audiostart', 'soundstart', 'speechstart']) rec.addEventListener(ev, () => { heard = true; });
    rec.onresult = ev => { text = [...ev.results].map(r => r[0].transcript).join(' '); out.textContent = text; };
    rec.onerror = ev => { out.textContent = `Microphone error: ${ev.error}. Check the site has microphone permission.`; };
    rec.onend = () => {
      if (!text) { if (!/error/.test(out.textContent)) out.textContent = heard ? 'Heard sound but no words: try again, a little slower.' : 'No sound reached the speech recogniser. Check the microphone permission, and that nothing else is using the microphone.'; return; }
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
  const c = choice(), p = profile();
  let s = c;
  if (c.listen) s = listenScenario(state.listenUnit);
  else if (c.area) {                              // your own route: build it now, with fresh QNH, squawk and surprises
    const route = checkRoute();
    if (!route) { show('setup'); $('route-panel').scrollIntoView({ block: 'center' }); toast('That route can’t be flown yet: see the notes under it.', 'warn'); return; }
    s = customScenario(c.area, route);
  }
  state.built = s;
  $('brief-aircraft').textContent = `${p.reg} · ${p.transponder ? 'Mode S' : 'No transponder'}`;
  $('brief-title').textContent = s.title;
  $('brief-sub').textContent = s.subtitle;
  $('brief-lines').innerHTML = briefRows(s.briefing(engineCtxPreview()));
  $('brief-unit').textContent = s.unit; $('brief-freq').textContent = s.freq;
  $('brief-map').hidden = !s.plan;
  if (s.plan) {                                   // your own route: see it on the map before you go
    state.briefMap ||= new MovingMap($('brief-map'));
    state.briefMap.setArea(s.plan.area);
    state.briefMap.setRoute({ points: mapPoints(s.plan) });
    state.briefMap.fit(mapPoints(s.plan));
  }
  show('brief');
}

// One row per briefing item, label beside the text, so nothing runs together. A label repeated by the
// next item (several warnings, say) is printed once and the run reads as a group.
function briefRows(lines) {
  let last = null;
  return lines.map(briefLine).map(({ label, text, kind }) => {
    const head = label && label !== last ? esc(label) : '';
    last = label;
    return `<div${kind === 'warn' ? ' class="caution"' : ''}><dt>${head}</dt><dd>${esc(text)}</dd></div>`;
  }).join('');
}

// ---------------- flight ----------------
async function begin() {
  const s = scenario(), p = profile();
  $('begin').disabled = true;
  let flying = false;
  try {
    state.radio = new BrowserRadio({ noise: $('o-noise').value });
    await state.radio.init();
    state.radio.setAtcVoice(store.get('voice', ''));
    const key = $('o-key').value.trim();
    const claude = key ? new Claude({ apiKey: key }) : null;
    const settings = {
      trafficDensity: $('o-density').value, timeScale: Number($('o-scale').value),
      atcDelay: DELAYS[$('o-delay').value] || DELAYS.normal, refusalBias: Number($('o-refuse').value),
    };
    // Only the current flight's events: one abandoned mid-request could otherwise end the next flight when it settles.
    const engine = new Engine({ scenario: s, profile: p, settings, radio: state.radio, clock: realClock, claude,
      onEvent: ev => { if (state.engine === engine) onEngineEvent(ev); } });
    state.engine = engine;
    resetFlightUi(p);
    $('flight').classList.toggle('listen', !!s.listen);
    if (s.plan) {
      state.map ||= new MovingMap($('map'), { onPick: showPick });
      state.map.reset();
      state.map.setArea(s.plan.area);
    }
    setView(s.plan ? store.get('flightView', 'map') : 'log');
    show('flight');
    if (s.listen) { /* nothing to say: the frequency does the talking */ }
    else if (PushToTalk.supported()) {
      state.ptt = new PushToTalk({
        button: $('ptt'),
        onDown: () => { engine.pilotKeyDown(); $('ptt').classList.add('keyed'); $('lamp-tx').classList.add('on'); $('ptt').querySelector('.ptt-label').textContent = 'WAIT…'; if ($('o-mine').checked) { $('mine').hidden = false; $('mine').textContent = '…'; } },
        // The click is "you're on air": it comes when the recogniser is actually listening, which on Android is a
        // noticeable beat after the press. Speak after the click and the start of the call isn't lost.
        onListening: () => { state.radio.keyClick(); $('ptt').querySelector('.ptt-label').textContent = 'SPEAK'; },
        // Off air the moment you let go. The words can take another second to arrive, and a button still showing
        // TX meanwhile invited a second press.
        onRelease: () => {
          state.radio.stopHeterodyne(); state.radio.keyClick(); $('ptt').querySelector('.ptt-label').textContent = 'HOLD TO TRANSMIT';
          $('ptt').classList.remove('keyed'); $('lamp-tx').classList.remove('on');
        },
        onUp: (text, meta) => {
          if ($('o-mine').checked) $('mine').textContent = text ? `You: ${text}` : (meta.error ? `Not recognised (${meta.error})` : 'Not recognised');
          engine.pilotTransmission(text, meta);
        },
        onInterim: t => { if ($('o-mine').checked) $('mine').textContent = t || '…'; },
        onHotMic: () => engine.hotMic(),
        onLevel: (rms) => { $('meter').style.width = Math.min(100, rms * 900) + '%'; },
        isRadioBusy: () => state.radio.busy,
        onNotice: t => toast(t, 'info'),
      });
      // No microphone (refused, missing or busy): fly it listening, as a browser without speech recognition does.
      try { await state.ptt.init({ hotMic: $('o-hot').checked }); }
      catch (err) { console.error(err); state.ptt.destroy(); state.ptt = null; listenOnly(MIC_TROUBLE[err?.name] || `No microphone (${err.message || err}).`); }
    } else listenOnly('This browser can’t recognise speech.');
    requestWakeLock();
    lampLoop();
    flying = true;
    await engine.start();
  } catch (err) {
    console.error(err);
    if (flying) toast(`Something went wrong: ${err.message || err}`, 'warn');
    else { abandonFlight(); toast(`Couldn’t start: ${err.message || err}`, 'warn'); }
  } finally { $('begin').disabled = false; }
}

// What to do about a microphone that couldn't be had.
const MIC_TROUBLE = {
  NotAllowedError: 'The microphone is blocked for this site: allow it in the browser’s site settings and start again.',
  NotFoundError: 'No microphone found.',
  NotReadableError: 'The microphone couldn’t be opened: close anything else using it and start again.',
};

function listenOnly(why) {
  $('ptt').disabled = true;
  $('ptt').querySelector('.ptt-label').textContent = 'LISTEN ONLY';
  toast(`${why} You can listen, but not transmit.`, 'warn');
}

// Out of a flight that never got going, or that stopped without reaching the debrief: nothing left running, and back
// to the briefing. A flight that failed to start used to leave the flight screen up, End doing nothing and the
// static hissing until a reload.
function abandonFlight() {
  clearInterval(legTimer);
  state.engine?.stop(); state.engine = null;
  state.ptt?.destroy(); state.ptt = null;
  state.radio?.stopAll();
  wakeLock?.release?.(); wakeLock = null;
  show('brief');
}

function resetFlightUi(p) {
  $('log').innerHTML = ''; $('cue').textContent = ''; $('leg-label').textContent = '—'; $('leg-time').textContent = '--:--';
  $('leg-bar').style.width = '0'; $('mine').hidden = true; $('toast').hidden = true;
  $('navdata').hidden = true; $('nd-alt').textContent = '----'; $('nd-qnh').textContent = '----'; $('nd-next').textContent = '';
  $('xpdr-pad').hidden = true; $('rh-xpdr').classList.remove('wanted', 'identing'); $('map-orbit').classList.remove('wanted');
  $('ptt').disabled = false; $('ptt').classList.remove('keyed'); $('ptt').querySelector('.ptt-label').textContent = 'HOLD TO TRANSMIT';
  $('lamp-tx').classList.remove('on');
  $('rh-reg').textContent = p.reg;
  $('rh-xpdr').classList.toggle('off', !p.transponder);
  $('rh-xpdr-mode').textContent = p.transponder ? 'ALT' : 'XPDR';    // as the head unit reads in Mode C
  $('rh-squawk').textContent = p.transponder ? '7000' : 'NONE';
  $('f-text').textContent = `Text: ${state.showText ? 'on' : 'off'}`;
  $('f-pause').textContent = 'Pause';
  $('f-skip').textContent = 'Skip ahead'; $('f-skip').setAttribute('aria-pressed', 'false'); $('f-skip').classList.remove('on');
}

let legTimer = null;
function onEngineEvent(ev) {
  switch (ev.kind) {
    case 'radio': addLine(ev.speaker, ev.text, ev.meta || {}); break;
    case 'radioState': {
      const st = ev.state; if (st.unit) $('rh-unit').textContent = st.unit; if (st.freq) $('rh-freq').textContent = Number(st.freq).toFixed(3);
      if (st.unit) state.radio?.setUnit(st.unit);        // a new unit is a new controller, so a new voice
      if ('squawk' in st && profile().transponder) $('rh-squawk').textContent = st.squawk || '7000';
      if (st.qnh) $('nd-qnh').textContent = st.qnh;
      break;
    }
    case 'leg':                                   // on your own route the nav events keep the time and the bar
      if (ev.nav) { $('leg-label').textContent = ev.label || ''; if (ev.cue) $('cue').textContent = ev.cue; } else startLeg(ev);
      break;
    case 'nav': showNav(ev); state.map?.update(ev); break;
    case 'action': showAction(ev); break;
    case 'ident': flashXpdr(); break;
    case 'route': state.map?.setRoute(ev); break;
    case 'skip': {
      const b = $('f-skip');
      b.textContent = ev.on ? 'Skipping…' : 'Skip ahead';
      b.setAttribute('aria-pressed', String(!!ev.on));
      b.classList.toggle('on', !!ev.on);
      break;
    }
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
  // Counted down only while the flight isn't paused: by the clock, a pause showed less time left than there was, and
  // one longer than the leg froze the countdown.
  let left = ms, last = Date.now();
  const tick = () => {
    const now = Date.now();
    if (!state.engine?.paused) left = Math.max(0, left - (now - last));
    last = now;
    $('leg-time').textContent = fmt(left / 1000);
    $('leg-bar').style.width = `${Math.min(100, 100 * (1 - left / ms))}%`;
    if (left <= 0) clearInterval(legTimer);
  };
  tick(); legTimer = setInterval(tick, 1000);
}

// Your own route: altitude, QNH, the next waypoint and the flight time to it, like the moving map in the aircraft.
function showNav(n) {
  clearInterval(legTimer);
  $('navdata').hidden = false;
  $('nd-alt').textContent = n.altitude;
  $('nd-next').textContent = n.orbiting ? n.hold : n.next ? `Next ${n.next.name} ${n.next.nm.toFixed(1)} nm` : 'Route complete';
  const held = n.orbiting && !n.pilotHold;                    // ATC is holding you: the button can't change that
  const orbit = $('map-orbit');
  orbit.disabled = held;
  orbit.textContent = held ? 'Held' : 'Orbit';
  orbit.title = held ? n.hold : 'Orbit where you are';
  orbit.setAttribute('aria-pressed', String(!!n.pilotHold));
  $('leg-time').textContent = n.next && !n.orbiting ? fmt(n.next.sec) : '--:--';
  $('leg-bar').style.width = `${Math.min(100, 100 * n.s / n.total)}%`;
}

// ---------------- things to do, not just say ----------------
// ATC is waiting for you to set the code or start the orbit: point at the control that does it.
function showAction(ev) {
  const xpdr = $('rh-xpdr'), orbit = $('map-orbit');
  if (!ev.pending) { xpdr.classList.remove('wanted'); orbit.classList.remove('wanted'); return; }
  if (ev.action === 'orbit') {
    orbit.classList.add('wanted');
    if ($('map').hidden && !!scenario().plan) setView('map');
  } else if (ev.action) {
    xpdr.classList.add('wanted');
  }
}

function flashXpdr() {
  const x = $('rh-xpdr');
  x.classList.add('identing');
  setTimeout(() => x.classList.remove('identing'), 1200);
}

function bindXpdr() {
  const pad = $('xpdr-pad'), entry = $('xpdr-entry');
  let typed = '';
  const show = () => { entry.textContent = (typed + '····').slice(0, 4); };
  $('rh-xpdr').addEventListener('click', () => {
    if (!profile().transponder || !state.engine?.running) return;
    typed = ''; show(); pad.hidden = false;
  });
  pad.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.d) {
      if (typed.length < 4) typed += b.dataset.d;
      show();
      if (typed.length === 4) { state.engine?.setSquawk(typed); toast(`Squawk ${typed} set.`, 'info'); setTimeout(() => { pad.hidden = true; }, 600); }
    } else if (b.id === 'xpdr-back') { typed = typed.slice(0, -1); show(); }
    else if (b.id === 'xpdr-ident') { state.engine?.ident(); toast('Ident.', 'info'); }
    else if (b.id === 'xpdr-close') pad.hidden = true;
  });
}

// ---------------- moving map ----------------
function setView(view) {
  const hasMap = !!scenario().plan, map = hasMap && view === 'map';
  $('map').hidden = !map; $('log').hidden = map; $('map-pick').hidden = true;
  $('f-view').hidden = !hasMap;
  $('f-view').textContent = map ? 'Log' : 'Map';
}

// A place tapped on the map: how far and which way, and Direct to / Divert.
function showPick(place, info) {
  state.picked = place;
  $('pick-name').textContent = place.name;
  const mins = info && Math.round(info.d / profile().speedKt * 60);
  $('pick-info').textContent = [place.kind === 'vrp' ? 'VRP' : '', info && `${info.d.toFixed(1)} nm`,
    info && `${String(Math.round(info.brg) % 360).padStart(3, '0')}°T`, info && `${mins} min`].filter(Boolean).join(' · ');
  $('map-pick').hidden = false;
}

function bindMap() {
  $('f-view').addEventListener('click', () => { const v = $('map').hidden ? 'map' : 'log'; store.set('flightView', v); setView(v); });
  $('map-orbit').addEventListener('click', () => {
    const e = state.engine; if (!e?.nav) return;
    e.setOrbit(!e.nav.pilotHold);
    $('map-orbit').setAttribute('aria-pressed', String(e.nav.pilotHold));
  });
  $('pick-close').addEventListener('click', () => { $('map-pick').hidden = true; });
  for (const [id, action] of [['pick-direct', 'direct'], ['pick-divert', 'divert']]) $(id).addEventListener('click', () => {
    const e = state.engine, place = state.picked;
    $('map-pick').hidden = true;
    if (!e || !place) return;
    const err = e.changeRoute({ action, place });
    if (err) { toast(err, 'warn'); return; }
    toast(`${action === 'divert' ? 'Diverting to' : 'Direct to'} ${place.name}${e.nav?.pending ? ': ask ATC first, and keep to your clearance until they approve.' : '.'}`, 'info');
  });
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
  // Skip the boring middle of a long leg. The engine refuses while anyone is talking or anything is expected of
// you, so it can never carry you past a call; it stops by itself when the leg ends.
$('f-skip').addEventListener('click', () => {
  const e = state.engine;
  if (!e) return;
  const wasOn = e.boost !== 1;
  const ok = e.skip();
  if (wasOn) toast('Back to real time.', 'info');
  else if (!ok) toast('Nothing to skip just now: wait until the frequency is clear.', 'info');
});
$('f-pause').addEventListener('click', () => {
    const e = state.engine; if (!e) return;
    e.setPaused(!e.paused); $('f-pause').textContent = e.paused ? 'Resume' : 'Pause';
    if (e.paused) state.radio?.pause(); else state.radio?.resume();
  });
  // A flight that has already stopped and still shows this screen never reached its debrief: End leaves it anyway.
  $('f-end').addEventListener('click', () => { if (state.engine?.running) state.engine.stop(); else abandonFlight(); });
  bindMap();
  bindXpdr();
}

// ---------------- debrief ----------------
function onEnd({ events, ctx, summary }) {
  clearInterval(legTimer);
  state.ptt?.destroy(); state.ptt = null;
  state.radio?.stopAll();
  wakeLock?.release?.(); wakeLock = null;
  const s = scenario();
  if (s.listen) {                                 // nothing to debrief: just say how long you sat there
    const mins = Math.round((events.at(-1)?.t || 0) / 60);
    renderSetup();
    show('setup');
    toast(`Listened to ${s.unit} for ${mins} minute${mins === 1 ? '' : 's'}.`, 'info');
    return;
  }
  const d = computeDebrief(events);
  state.lastEnd = { events, ctx, summary, d };
  // What the recogniser made of each transmission, for deciding whether the mishearing table is converging.
  try { heardAppend(LS, rowsFrom(events, { scenario: s.id, reg: ctx.reg })); } catch { /* storage off */ }
  const h = pastSessions();
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
  renderHeard(rowsFrom(state.lastEnd.events, { scenario: s.id, reg: ctx.reg }));
}

// How the recogniser did, this flight and over every flight this browser remembers.
function renderHeard(rows) {
  const st = (label, v, cls = '') => `<div class="stat ${cls}"><b>${v ?? '\u2013'}</b><span>${label}</span></div>`;
  const h = heardStats(rows);
  $('d-heard').innerHTML = [
    st('transmissions', h.transmissions),
    st('rescued by the mishearing table', h.rescued, h.rescued ? 'good' : ''),
    st('still failed', h.failed, h.failed ? 'bad' : 'good'),
    st('nothing recognised', h.heardNothing, h.heardNothing ? 'bad' : ''),
    st('a later guess matched better', h.otherGuess),
  ].join('');
  const all = heardLoad(LS);
  const a = heardStats(all);
  $('d-heard-total').textContent = all.length
    ? `${all.length} kept: ${a.judged} marked (${a.failed} failed, ${a.failRate}%), ${a.unjudged} off script, ${a.rescued} rescued`
    : 'Nothing kept yet.';
}

function saveHeard() {
  const all = heardLoad(LS);
  if (!all.length) return toast('Nothing recorded yet: fly one and it will be here.', 'info');
  const blob = new Blob([JSON.stringify({ saved: new Date().toISOString(), stats: heardStats(all), rows: all }, null, 1)],
    { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rt-heard-${new Date().toISOString().slice(0, 10)}.json`;
  a.style.display = 'none';
  document.body.append(a);                   // a detached anchor does not download on Android Chrome
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 5000);
  toast(`Saved ${all.length} transmission${all.length === 1 ? '' : 's'}.`, 'info');
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
    const heard = e.heard ? `<div class="soft">Speech recognition first heard “${esc(e.heard)}”: taken from its other guesses.</div>` : '';
    const model = e.model && (miss || subs || soft || fil || order || cs) ? `<div class="model">Better: ${esc(e.model)}</div>` : '';
    const bad = miss || subs || cs ? ' bad' : '';
    return `<li class="tl${bad}"><div class="t">${fmt(e.t)}<span class="score">${r.score != null ? r.score + '/100' : ''}</span></div>${atc}<div class="said">You: ${esc(e.text)}</div>${heard}${miss}${subs}${cs}${order}${soft}${fil}${model}</li>`;
  }
  const labels = {
    correction: `ATC corrected you: “${e.text}”`, missed: 'No reply to ATC', late: 'Late report: ATC chased you', 'no-call': 'Expected call not made',
    blocked: 'Blocked: you transmitted over another station', 'hot-mic': 'Spoke without pressing PTT (not transmitted)', 'stepped-in': 'Called in the middle of another exchange',
    'wrong-callsign': `Answered a call for ${e.forCall}`, note: e.text, offscript: `Left the script: “${e.text}”. Claude took over.`,
    'free-assessment': `You: “${e.text}”${e.assessment ? ` · ${e.assessment}` : ''}`, 'claude-error': `Claude couldn’t answer: ${e.text}`, 'say-again': 'You asked for a repeat', answer: `Asked for ${e.asked}: “${e.text}”`,
    'route-change': `Changed route: ${e.text}`, orbit: e.text, 'squawk-set': e.text, ident: 'Ident',
    action: `Did it: ${e.text}`, 'late-action': 'ATC had to chase you for it', 'no-action': `Never done: ${e.text}`,
    unexpected: `Unexpected call: “${e.text}”`, position: e.label, cue: e.text, atc: `ATC: ${e.text}`,
  };
  const neutral = ['note', 'position', 'cue', 'atc', 'say-again', 'answer', 'free-assessment', 'claude-error', 'route-change', 'orbit', 'squawk-set', 'ident', 'action'].includes(e.type);
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
  } catch (err) { $('d-claude').textContent = `Couldn’t get a debrief: ${err.reason || err.message}`; }
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
$('d-heard-save').addEventListener('click', saveHeard);
$('d-heard-clear').addEventListener('click', () => {
  heardClear(LS);
  if (state.lastEnd) renderHeard(rowsFrom(state.lastEnd.events, { scenario: scenario().id, reg: state.lastEnd.ctx.reg }));
  toast('Speech recognition log cleared.', 'info');
});
$('d-again').addEventListener('click', renderBrief);
$('d-claude-btn').addEventListener('click', claudeDebrief);
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
window.__rt = state; // debugging / automated tests
