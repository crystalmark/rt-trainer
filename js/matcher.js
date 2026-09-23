// Compares what the pilot said with what the controller expects.
// An expectation ("spec") is a list of items; each item has one or more acceptable phrases.
//   { label: 'QNH 1017', any: ['1017'], hard: true, fix: 'QNH 1017', substitutes: ['zone'], why: '...' }
// hard items must be present or ATC corrects you; soft items only count in the debrief.
import { tokens, findCallsign, normalize } from './normalize.js';

export const FILLERS = [
  { re: /\bwith you\b/, why: '“With you” is filler: just give your callsign and message.' },
  { re: /\bthis is\b/, why: '“This is” is filler: station, callsign, message.' },
  { re: /\broger that\b/, why: '“Roger” on its own; “roger that” is not standard.' },
  { re: /\bcopy that\b|\bcopied\b/, why: 'Use “roger”, not “copy”.' },
  { re: /\baffirmative\b/, why: 'UK phraseology is “affirm”, not “affirmative”.' },
  { re: /\bat my discretion\b/, why: 'Never reply “at my discretion”: state your intention, e.g. “landing”.' },
  { re: /\bover and out\b|\bover\b\s*$/, why: '“Over” / “over and out” are not used in UK VHF RT.' },
  { re: /\bten four\b/, why: 'Not RT phraseology.' },
  { re: /\b(zero|one|two|three|four|five|six|seven|eight|nine|niner)\s+oh\b|\boh\s+(zero|one|two|three|four|five|six|seven|eight|nine|niner)\b/,
    why: 'Every digit has its own word: “one zero zero five”, never “ten oh five”. It is also what speech recognition hears best.' },
  { re: /\bjoining instructions\b/, why: 'Only ATC gives instructions. Ask to join, or for airfield information.' },
  { re: /\bready for take ?off\b/, why: 'Say “ready for departure”; “take-off” is only used in the clearance.' },
];

function findPhrase(toks, phrase) {
  const p = tokens(phrase);
  if (!p.length) return -1;
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] !== p[0]) continue;
    let j = 1, k = i + 1;
    const limit = i + p.length + 3;               // allow a few extra words in between
    while (j < p.length && k < toks.length && k < limit) {
      if (toks[k] === p[j]) j++;
      k++;
    }
    if (j === p.length) return i;
  }
  return -1;
}

export function hasAny(text, phrases) {
  const t = tokens(text);
  return phrases.some(p => findPhrase(t, p) >= 0);
}

/**
 * @returns {{ text, norm, callsign, items, hardMissing, softMissing, substitutions,
 *             orderOk, fillers, score, hardRatio }}
 */
export function match(text, spec, ctx, opts = {}) {
  const toks = tokens(text);
  const raw = String(text || '').toLowerCase();
  const items = (spec || []).map(item => {
    let index = -1;
    for (const p of item.any) { const i = findPhrase(toks, p); if (i >= 0 && (index < 0 || i < index)) index = i; }
    let substituted = null;
    if (index < 0 && item.substitutes) substituted = item.substitutes.find(s => findPhrase(toks, s) >= 0) || null;
    const forbidden = (item.forbid || []).find(f => findPhrase(toks, f) >= 0) || null;
    return { ...item, hard: item.hard !== false, matched: index >= 0 && !forbidden, index, substituted, forbidden };
  });
  const cs = ctx ? findCallsign(toks, ctx.reg) : null;
  const matched = items.filter(i => i.matched);
  let orderOk = true;
  const idx = matched.map(i => i.index);
  for (let i = 1; i < idx.length; i++) if (idx[i] < idx[i - 1]) orderOk = false;
  const hard = items.filter(i => i.hard), soft = items.filter(i => !i.hard);
  const hardMissing = hard.filter(i => !i.matched);
  const softMissing = soft.filter(i => !i.matched);
  const fillers = FILLERS.filter(f => f.re.test(raw)).map(f => f.why);
  const hardRatio = hard.length ? (hard.length - hardMissing.length) / hard.length : 1;
  const softRatio = soft.length ? (soft.length - softMissing.length) / soft.length : 1;
  let callsignScore = cs ? (cs.form === 'partial' ? 0.5 : 1) : 0;
  // Callsign position: first on initial calls, last on readbacks.
  let callsignPlacement = 'ok';
  if (cs && opts.kind === 'readback' && cs.end < toks.length - 1 - 1 && cs.start < 2 && toks.length > 4) callsignPlacement = 'start';
  const score = Math.round(100 * (0.6 * hardRatio + 0.2 * softRatio + 0.1 * (orderOk ? 1 : 0) +
    0.1 * Math.max(0, callsignScore - 0.25 * fillers.length)));
  return {
    text, norm: toks.join(' '), callsign: cs, callsignPlacement, items, hardMissing, softMissing,
    substitutions: items.filter(i => i.substituted), orderOk, fillers, score, hardRatio,
  };
}

/** Did the pilot ask ATC to repeat? */
export function isSayAgain(text) {
  return hasAny(text, ['say again', 'repeat', 'did not copy', 'didnt copy', 'not understood']);
}

/** Heuristic: the transmission is a request the script doesn't cover (diversion, weather, etc). */
export function looksLikeRequest(text) {
  return hasAny(text, ['request', 'unable', 'divert', 'diversion', 'alternate', 'weather', 'cloud',
    'returning', 'return to', 'change of plan', 'instead', 'rejoin', 'precautionary', 'pan pan', 'mayday',
    'unsure of position', 'lost', 'low fuel', 'rough running', 'engine']);
}

export { normalize };
