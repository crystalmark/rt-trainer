// A record of what speech recognition actually did, so the mishearing table can be driven by evidence rather
// than by guessing what Chrome might make of a place name. One row per transmission, kept in this browser only
// (never sent anywhere), capped, and exportable as JSON so a few flights' worth can be looked at properly.
//
// The question it exists to answer: when a transmission fails, would another fold have saved it, or is the
// tail endless? `folded` says the table changed the words; `failed` says it still wasn't enough.
import { tokens } from './normalize.js';

export const KEY = 'rt.heard';
const CAP = 400;

// Every way a transmission of yours reaches the log. Only the first two are marked against a spec; the rest
// are still words the recogniser produced, and an off-script flight consists of nothing else — which is how
// this log managed to record a whole flight as zero transmissions.
const JUDGED = ['call', 'readback'];
const UNJUDGED = ['free-assessment', 'unexpected', 'stepped-in', 'wrong-callsign', 'blocked', 'answer', 'callsign-given', 'say-again'];

/** One row per transmission from an engine event log. Pure: storage and the DOM are somebody else's problem. */
/**
 * Which device a flight was flown on, from the browser's own description of itself: "Android · Chrome",
 * "Mac · Chrome". The Pixel and the Mac hear very differently, and a log without this got the two confused.
 */
export function deviceName(ua = '') {
  const os = /Android/i.test(ua) ? 'Android' : /iPhone/i.test(ua) ? 'iPhone' : /iPad/i.test(ua) ? 'iPad'
    : /Mac OS X|Macintosh/i.test(ua) ? 'Mac' : /Windows/i.test(ua) ? 'Windows' : /CrOS/i.test(ua) ? 'ChromeOS' : /Linux/i.test(ua) ? 'Linux' : 'other';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'other';
  return `${os} · ${browser}`;
}

export function rowsFrom(events, { scenario = '', reg = '', device = '', at = Date.now() } = {}) {
  const kinds = [...JUDGED, ...UNJUDGED, 'empty-tx'];
  return events.filter(e => kinds.includes(e.type)).map(e => {
    const r = e.result || {};
    const text = e.text || '';
    const norm = tokens(text).join(' ');
    const row = {
      at, scenario, reg, device, kind: e.type, id: e.id || null, t: e.t,
      judged: JUDGED.includes(e.type),
      heardNothing: e.type === 'empty-tx',              // the recogniser returned no words at all
      raw: e.heard || text,                             // what it offered first
      norm,
      folded: norm !== tokens(text, { folds: false }).join(' '),
      rescued: !!e.rescued,                             // passed only because of the table (decided when it was marked)
      score: r.score ?? null,
      missing: r.missing || [],
      subs: (r.substitutions || []).map(s => s.said).filter(Boolean),
    };
    if (e.heard) row.used = text;                       // a later guess matched better than the first
    if (e.error) row.error = e.error;                   // why nothing came back, when nothing did
    if (e.trace) row.trace = e.trace;                   // what the recogniser reported: audiostart, speechstart…
    if (e.alts && e.alts.length > 1) row.alts = e.alts;
    return row;
  });
}

/** The numbers that decide whether to keep patching or go and buy a recogniser with a vocabulary. */
export function stats(rows) {
  const judged = rows.filter(r => r.judged);
  const failed = judged.filter(r => r.missing.length).length;
  return {
    transmissions: rows.length,
    judged: judged.length,                                         // marked against what ATC expected
    unjudged: rows.length - judged.length,                         // off script, blocked, unexpected: no spec
    heardNothing: rows.filter(r => r.heardNothing).length,         // the recogniser returned no words at all
    failed,                                                        // a hard item missing even after the folds
    folded: rows.filter(r => r.folded).length,                     // the table changed the words
    // A row kept from before `rescued` was recorded falls back to what used to be counted.
    rescued: judged.filter(r => r.rescued ?? (r.folded && !r.missing.length)).length,
    otherGuess: rows.filter(r => r.used).length,                   // best-of-five earned its keep
    substituted: rows.filter(r => r.subs.length).length,
    medianScore: median(rows.map(r => r.score).filter(v => v != null)),
    failRate: judged.length ? Math.round(100 * failed / judged.length) : null,
  };
}

function median(v) {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
}

// ---- storage: this browser only, and capped so it can never grow into the other apps' quota ----
export function load(store) {
  try { return JSON.parse(store.getItem(KEY) || '[]'); } catch { return []; }
}
export function append(store, rows) {
  if (!rows.length) return load(store);
  const all = [...load(store), ...rows].slice(-CAP);
  try { store.setItem(KEY, JSON.stringify(all)); } catch { /* full or blocked: the flight matters more */ }
  return all;
}
export function clear(store) { try { store.removeItem(KEY); } catch { /* nothing to do */ } }
