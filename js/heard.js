// A record of what speech recognition actually did, so the mishearing table can be driven by evidence rather
// than by guessing what Chrome might make of a place name. One row per transmission, kept in this browser only
// (never sent anywhere), capped, and exportable as JSON so a few flights' worth can be looked at properly.
//
// The question it exists to answer: when a transmission fails, would another fold have saved it, or is the
// tail endless? `folded` says the table changed the words; `failed` says it still wasn't enough.
import { tokens } from './normalize.js';

export const KEY = 'rt.heard';
const CAP = 400;

/** One row per transmission from an engine event log. Pure: storage and the DOM are somebody else's problem. */
export function rowsFrom(events, { scenario = '', reg = '', at = Date.now() } = {}) {
  return events.filter(e => e.type === 'call' || e.type === 'readback').map(e => {
    const r = e.result || {};
    const text = e.text || '';
    const norm = tokens(text).join(' ');
    const row = {
      at, scenario, reg, kind: e.type, id: e.id || null, t: e.t,
      raw: e.heard || text,                            // what the recogniser offered first
      norm,
      folded: norm !== tokens(text, { folds: false }).join(' '),
      score: r.score ?? null,
      missing: r.missing || [],
      subs: (r.substitutions || []).map(s => s.said).filter(Boolean),
    };
    if (e.heard) row.used = text;                      // a later guess matched better than the first
    if (e.alts && e.alts.length > 1) row.alts = e.alts;
    return row;
  });
}

/** The numbers that decide whether to keep patching or go and buy a recogniser with a vocabulary. */
export function stats(rows) {
  const n = rows.length;
  const failed = rows.filter(r => r.missing.length).length;
  return {
    transmissions: n,
    failed,                                                        // a hard item missing even after the folds
    folded: rows.filter(r => r.folded).length,                     // the table changed the words
    rescued: rows.filter(r => r.folded && !r.missing.length).length,
    otherGuess: rows.filter(r => r.used).length,                   // best-of-five earned its keep
    substituted: rows.filter(r => r.subs.length).length,
    medianScore: median(rows.map(r => r.score).filter(v => v != null)),
    failRate: n ? Math.round(100 * failed / n) : null,
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
