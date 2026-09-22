// Turns the engine's event log into a debrief: headline numbers, the issues that matter most,
// and a call-by-call breakdown. Pure data here; rendering is in main.js.

export function computeDebrief(events) {
  const txs = events.filter(e => e.type === 'readback' || e.type === 'call');
  const readbacks = events.filter(e => e.type === 'readback');
  const firstAttempts = readbacks.filter(e => e.attempt === 1);
  const count = t => events.filter(e => e.type === t).length;
  const lat = txs.map(e => e.latency).filter(v => v != null && v > 0 && v < 60000);
  const stats = {
    transmissions: txs.length,
    readbacks: firstAttempts.length,
    readbacksRightFirstTime: firstAttempts.filter(e => !e.corrected).length,
    corrections: count('correction'),
    missedCalls: count('missed'),
    lateReports: count('late') + count('no-call'),
    blocked: count('blocked'),
    unkeyedSpeech: count('hot-mic'),
    steppedIn: count('stepped-in'),
    wrongCallsign: count('wrong-callsign'),
    fillers: txs.reduce((n, e) => n + (e.result?.fillers.length || 0), 0),
    averageScore: txs.length ? Math.round(txs.reduce((n, e) => n + (e.result?.score || 0), 0) / txs.length) : null,
    medianResponseSec: lat.length ? Math.round(median(lat) / 100) / 10 : null,
  };

  const issues = [];
  const add = (weight, title, detail) => issues.push({ weight, title, detail });
  const subs = txs.flatMap(e => (e.result?.substitutions || []).map(s => ({ ...s, text: e.text })));
  if (subs.length) add(9, 'Used your own words instead of the controller’s', subs.map(s => `Said “${s.said}” for “${s.label}”. ${s.why || ''}`).join(' '));
  if (stats.corrections) add(8, `${stats.corrections} readback${stats.corrections > 1 ? 's' : ''} corrected by ATC`, 'Read back every clearance item, in order: route, level, pressure, squawk, frequency.');
  if (stats.missedCalls) add(8, `${stats.missedCalls} call${stats.missedCalls > 1 ? 's' : ''} to you went unanswered`, 'Listen for your callsign: in the air that means repeats, “how do you read?”, and a controller losing confidence in you.');
  if (stats.unkeyedSpeech) add(7, `Spoke ${stats.unkeyedSpeech}× without pressing PTT`, 'Nothing you said was transmitted. Press, pause a beat, speak, release.');
  if (stats.blocked) add(7, `Blocked ${stats.blocked} transmission${stats.blocked > 1 ? 's' : ''}`, 'You keyed while someone else was talking. Listen before you transmit.');
  if (stats.steppedIn) add(5, `Called in the middle of someone else’s exchange ${stats.steppedIn}×`, 'Wait for the controller to finish with the other aircraft (their readback and any reply) before calling.');
  if (stats.wrongCallsign) add(6, 'Answered a call meant for a similar callsign', 'Listen to the whole callsign; ask “confirm that was for G-…?” if unsure.');
  if (stats.lateReports) add(6, `${stats.lateReports} position report${stats.lateReports > 1 ? 's' : ''} late or missed`, 'Make reports at the point you were asked to, without being chased.');
  // Reading an instruction back isn't flying it: the transponder and the orbit have to happen too.
  const undone = events.filter(e => e.type === 'no-action');
  if (undone.length) add(9, `Read back ${undone.length > 1 ? 'instructions' : 'an instruction'} but didn’t carry ${undone.length > 1 ? 'them' : 'it'} out`,
    `${undone.map(e => e.text).join(' ')} ATC works on what you do, not what you say.`);
  const chased = events.filter(e => e.type === 'late-action');
  if (chased.length && !undone.length) add(5, `Chased ${chased.length}× for something you had read back`, 'Set the code or start the turn as you read it back, not a minute later.');
  const soft = {};
  for (const e of txs) for (const s of e.result?.softMissing || []) if (s.why) soft[s.label] = s.why;
  const softList = Object.entries(soft);
  if (softList.length) add(4, 'Things to add to your calls', softList.map(([l, w]) => `${cap(l)}: ${w}`).join(' '));
  const fillers = [...new Set(txs.flatMap(e => e.result?.fillers || []))];
  if (fillers.length) add(4, 'Non-standard words', fillers.join(' '));
  const order = txs.filter(e => e.result && !e.result.orderOk).length;
  if (order) add(3, `Readback order changed ${order}×`, 'Read back in the order the controller gave it.');
  const callsignStart = txs.filter(e => e.type === 'readback' && e.result?.callsignPlacement === 'start').length;
  if (callsignStart) add(2, 'Callsign at the start of readbacks', 'Readbacks end with your callsign: “Squawk 5634, G-HP”.');
  if (stats.medianResponseSec && stats.medianResponseSec > 6) add(3, `Slow to answer (median ${stats.medianResponseSec} s)`, 'Aim to start your readback within about 3–5 seconds.');
  issues.sort((a, b) => b.weight - a.weight);

  const readbackAtc = new Set(events.filter(e => e.type === 'readback').map(e => e.atcText));
  const timeline = events.filter(e => !(e.type === 'atc' && readbackAtc.has(e.text))).filter(e => ['atc', 'readback', 'call', 'correction', 'missed', 'late', 'no-call', 'blocked', 'hot-mic',
    'stepped-in', 'wrong-callsign', 'note', 'offscript', 'free-assessment', 'say-again', 'answer', 'unexpected', 'position', 'cue',
    'route-change', 'orbit', 'squawk-set', 'ident', 'action', 'late-action', 'no-action'].includes(e.type) && !(e.type === 'atc' && !e.toPilot));
  return { stats, issues, timeline };
}

function median(a) { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function cap(s) { return s[0].toUpperCase() + s.slice(1); }
