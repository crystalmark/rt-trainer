// Text normalisation for radio calls.
// Turns speech-recognition output ("golf hotel papa, QNH one zero one seven, three thousand feet")
// and scenario patterns into one comparable token stream ("g h p qnh 1017 3000 feet").
// Pure functions only: shared by the browser app and the Node tests.

export const PHONETIC = {
  alpha: 'a', alfa: 'a', bravo: 'b', charlie: 'c', charly: 'c', delta: 'd', echo: 'e',
  foxtrot: 'f', golf: 'g', gulf: 'g', hotel: 'h', india: 'i', juliet: 'j', juliett: 'j',
  kilo: 'k', lima: 'l', leema: 'l', mike: 'm', november: 'n', oscar: 'o', papa: 'p',
  pappa: 'p', poppa: 'p', quebec: 'q', romeo: 'r', sierra: 's', tango: 't', uniform: 'u',
  victor: 'v', whiskey: 'w', whisky: 'w', xray: 'x', yankee: 'y', zulu: 'z',
  // and the spellings the recogniser comes back with
  alpher: 'a', alfie: 'a', elfa: 'a', alta: 'a', bravour: 'b', charley: 'c', deltar: 'd', ecco: 'e',
  hotell: 'h', indiya: 'i', juliette: 'j', keelo: 'k', leemah: 'l', maik: 'm', novemba: 'n',
  papaa: 'p', romio: 'r', cierra: 's', sierre: 's', tangoo: 't', unicorn: 'u', victa: 'v',
  whisker: 'w', yanky: 'y', zoolu: 'z',
};
export const LETTER_TO_WORD = {
  a: 'Alpha', b: 'Bravo', c: 'Charlie', d: 'Delta', e: 'Echo', f: 'Foxtrot', g: 'Golf', h: 'Hotel',
  i: 'India', j: 'Juliett', k: 'Kilo', l: 'Lima', m: 'Mike', n: 'November', o: 'Oscar', p: 'Papa',
  q: 'Quebec', r: 'Romeo', s: 'Sierra', t: 'Tango', u: 'Uniform', v: 'Victor', w: 'Whiskey',
  x: 'X-ray', y: 'Yankee', z: 'Zulu',
};

// "oh" is not CAP 413 — it should be "zero" — but pilots say it, so hear it and let the matcher flag it.
const DIGITS = { zero: 0, oh: 0, one: 1, two: 2, three: 3, tree: 3, four: 4, fower: 4, five: 5, fife: 5,
  six: 6, seven: 7, eight: 8, nine: 9, niner: 9 };
const TEENS = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
export const HESITATION = /^(e+r+m*|u+h+|u+m+|a+h+|e+h+|h+m+|m+h+m*)$/i;

// Words written with a hyphen that are not registrations. "X-ray" is how the alphabet spells it and how the recogniser
// writes it: taken for a registration it came out as the letters x r a y, and one with an X lost its callsign.
const HYPHENATED = [[/\bx-ray\b/g, 'xray'], [/\be-mail/g, 'email']];

// Multi-word and spelling variants folded before tokenising.
const PHRASES = [
  [/\b[qu]\s?(?:n|&|and)\s?h(?=\s?\d)/g, 'qnh '],   // glued to its number, or the Q heard as "you": unh1015
  [/(\d) ?h(?=q ?(?:n|&|and) ?h\b)/g, '$1 8 '],            // "eight" heard as the letter: "1 0 0 HQ and H" for 1008 QNH
  [/\bq\.?\s?n\.?\s?h\.?\b/g, 'qnh'], [/\bq\s?(and|&)\s?h\b/g, 'qnh'],
  [/\bq\.?\s?f\.?\s?e\.?\b/g, 'qfe'],
  [/\bv\.?\s?f\.?\s?r\.?\b/g, 'vfr'],
  [/\bwill co\b/g, 'wilco'], [/\bwil?lco\b/g, 'wilco'], [/\bwilko\b/g, 'wilco'], [/\bwill come\b/g, 'wilco'],
  [/\baffirmative\b/g, 'affirm'],
  [/\bhecto ?pascals?\b/g, 'hectopascals'], [/\bhpa\b/g, 'hectopascals'],
  [/\bft\b/g, 'feet'], [/\bfoot\b/g, 'feet'],
  [/\bnm\b/g, 'miles'], [/\bmile\b/g, 'miles'], [/\bnautical miles\b/g, 'miles'],
  [/\bsouth-east\b/g, 'south east'], [/\bsoutheast\b/g, 'south east'],
  [/\bsouth-west\b/g, 'south west'], [/\bsouthwest\b/g, 'south west'],
  [/\bnorth-east\b/g, 'north east'], [/\bnortheast\b/g, 'north east'],
  [/\bnorth-west\b/g, 'north west'], [/\bnorthwest\b/g, 'north west'],
  [/\bdown wind\b/g, 'downwind'], [/\bdead side\b/g, 'deadside'],
  [/\bpan-pan\b/g, 'pan pan'], [/\bmay day\b/g, 'mayday'],
  // What speech recognition tends to make of the words that matter. "Squawk" is the worst of them, so the first
  // pattern sweeps up the whole family (squark, skork, scork, sqwak, skwak); the list holds the ones that are
  // real words, which no pattern should be catching by accident.
  [/\bs[qkc][uw]?[ao]?[wr]?c?ks?\b/g, 'squawk'],
  [/\b(escort|squat|squaw|squeak|squad|stork|swat|s quark|squawked|squawking)\b/g, 'squawk'],
  [/\b(cork|corks|corked|quark|quarks|score|scores|scored)\b(?=\s+\d)/g, 'squawk'],   // real words: only with a code after
  [/\b(remain|remaining) outside a controlled\b/g, '$1 outside controlled'],
  // "Controlled airspace" is the phrase that has to be read back exactly, and the recogniser keeps shaving it:
  // "control airspace", "controls air space". It never touches "control zone", which is a different place.
  [/\bair space\b/g, 'airspace'],
  [/\bcontrols? airspace\b/g, 'controlled airspace'],
  [/\bcontrolled service\b/g, 'control service'],        // ...and adds one to "radar control service", said right
  [/\bthe [dvb]?f\.?\s?r\.?\b/g, 'vfr'],                // "VFR" comes back as "the FR", "the DFR"
  [/\b[bd]\.?\s?f\.?\s?r\.?\b/g, 'vfr'],                  // ...and "BFR"
  [/\bthey are(?: the)?\b(?=\s+(?:not|\d))/g, 'vfr'],       // ...and, in a clearance, "they are the not above"
  [/\bnot of(?: an?)?\b(?=\s+\d)/g, 'not above'], [/\bnut above\b/g, 'not above'],          // "not of a 2000"
  [/\b(?:clear|glare) to (enter|transit|cross|land|leave)\b/g, 'cleared to $1'],   // the -ed goes missing, as on "controlled"
  [/\bmicro ?(light|lite|lyte)s?\b/g, 'microlight'],
  // "Golf India" said quickly comes back as one word, and the callsign is lost with it.
  [/\bg[ou]lfinderell?a?\b/g, 'golf india alpha'],     // "gulfinderella": golf India alpha
  [/\bg[ou]lf ?in(?:dia|der)\b/g, 'golf india'],        // "gulfindia", "gulfinder"
  [/\bwill co\b/g, 'wilco'], [/\broutine\b(?= (own )?navigation)/g, 'resume'], [/\broutine\b/g, 'routing'],
];

/** Split a written registration like "G-CLHP" into separate letters. */
function splitRegistrations(s) {
  return s.replace(/\b([a-z])-([a-z]{2,4})\b/g, (_, a, b) => ' ' + [a, ...b].join(' ') + ' ');
}

function isNumberWord(w) {
  return w in DIGITS || w in TEENS || w in TENS || w === 'hundred' || w === 'thousand' ||
    w === 'decimal' || w === 'point' || /^\d+(\.\d+)?$/.test(w);
}

function cleanDecimal(s) {
  if (!s.includes('.')) return s;
  let [a, b] = s.split('.');
  b = b.replace(/0+$/, '');
  return b ? `${a}.${b}` : a;
}

/** Interpret one run of number tokens: digit strings, spoken digits, compounds, decimals. */
function interpretRun(run) {
  // Only the word just before "thousand" or "hundred" is its multiplier (or a tens word and a digit: "twenty
  // five"). Anything earlier is a separate number read digit by digit. Treating the whole run as one cardinal
  // added the digits up: "QNH one zero one eight, two thousand feet" came out as 12000.
  const k = run.findIndex(w => w === 'thousand' || w === 'hundred');
  if (k > 0) {
    let start = k - 1;
    if (start > 0 && run[start] in DIGITS && run[start - 1] in TENS) start--;
    if (start > 0) return [...interpretRun(run.slice(0, start)), ...interpretRun(run.slice(start))];
  }
  if (k >= 0) {
    // Digits read one at a time after the last "thousand" or "hundred" are the next number, not its units: "not above
    // two thousand one zero one seven" is an altitude and a QNH, and added up it came out as 2009.
    const last = Math.max(run.lastIndexOf('thousand'), run.lastIndexOf('hundred'));
    const tail = run.slice(last + 1);
    if (tail.length > 1 && tail.every(w => w in DIGITS)) return [...interpretRun(run.slice(0, last + 1)), ...interpretRun(tail)];
    let total = 0, cur = 0;
    for (const w of run) {
      if (w === 'thousand') { total += (cur || 1) * 1000; cur = 0; }
      else if (w === 'hundred') { cur = (cur || 1) * 100; }
      else if (w in DIGITS) cur += DIGITS[w];
      else if (w in TEENS) cur += TEENS[w];
      else if (w in TENS) cur += TENS[w];
      else if (/^\d+$/.test(w)) cur += Number(w);
    }
    return [String(total + cur)];
  }
  const out = [];
  let buf = '';
  let pendingTens = null;
  // The recogniser wrote a whole number ("2000", "1017"): whatever is said after it one digit at a time is the next
  // number. Appended, "not above 2000 1 0 1 7" came out as 20001017.
  let whole = false;
  const flushTens = () => { if (pendingTens !== null) { buf += String(pendingTens); pendingTens = null; } };
  for (const w of run) {
    if (w === 'decimal' || w === 'point') { flushTens(); buf += '.'; whole = false; continue; }
    if (whole && (w in DIGITS || w in TEENS || w in TENS || /^\d$/.test(w))) { out.push(cleanDecimal(buf)); buf = ''; }
    whole = /^\d{3,}(\.\d+)?$/.test(w);
    if (w in TENS) { flushTens(); pendingTens = TENS[w]; continue; }
    if (w in DIGITS) {
      if (pendingTens !== null) { buf += String(pendingTens + DIGITS[w]); pendingTens = null; }
      else buf += String(DIGITS[w]);
      continue;
    }
    flushTens();
    if (w in TEENS) { buf += String(TEENS[w]); continue; }
    // numeric token from speech recognition, e.g. "134.58" or "1017"
    if (buf && !buf.endsWith('.') && w.length > 1) { out.push(cleanDecimal(buf)); buf = ''; }
    buf += w;
  }
  flushTens();
  if (buf) out.push(cleanDecimal(buf.replace(/\.$/, '')));
  return out;
}

/**
 * normalize("Leeds Radar, G-CLHP, QNH one zero one seven") -> "leeds radar g c l h p qnh 1017"
 */
/**
 * `folds: false` skips the mishearing table (PHRASES) and gives the tokens the recogniser's words would have
 * produced on their own. Only js/heard.js uses it, to measure how much of the table is earning its keep.
 */
export function normalize(text, { folds = true } = {}) {
  let s = String(text || '').toLowerCase();
  s = s.replace(/(\d),(\d{3})\b/g, '$1$2');           // 3,000 -> 3000
  for (const [re, rep] of HYPHENATED) s = s.replace(re, rep);
  s = splitRegistrations(s);
  if (folds) for (const [re, rep] of PHRASES) s = s.replace(re, rep);
  s = s.replace(/[^a-z0-9.\s]/g, ' ').replace(/\.(?!\d)/g, ' ').replace(/(^|\s)\.(\d)/g, '$1$2');
  // Hesitation sounds, however the recogniser spells them: er, err, errr, erm, uh, umm, ah, eh, hmm.
  const raw = s.split(/\s+/).filter(Boolean).filter(w => !HESITATION.test(w));
  const tokens = [];
  for (let i = 0; i < raw.length;) {
    if (isNumberWord(raw[i]) && !(raw[i] === 'point' && !isNumberWord(raw[i + 1] || ''))) {
      const run = [];
      while (i < raw.length && isNumberWord(raw[i])) run.push(raw[i++]);
      // "point" / "decimal" dangling at the ends isn't numeric
      while (run.length && (run[0] === 'decimal' || run[0] === 'point')) tokens.push(run.shift());
      tokens.push(...interpretRun(run));
    } else {
      const w = raw[i++];
      tokens.push(PHONETIC[w] || w);
    }
  }
  // A squawk is four digits and a pressure setting three or four. Read digit by digit, whatever number follows
  // runs straight on into it — "QNH one zero one eight, four miles" arrived as 10184, "squawk 5626 two miles" as
  // 56262 — and a pause is no help, because the recogniser's pauses fall mid-number just as often. So split
  // anything past the code's own length back off as the next number.
  for (let i = 0; i + 1 < tokens.length; i++) {
    const next = tokens[i + 1];
    // "One zero zero nine" comes back as 10009, or "10 0 0 9": Chrome doubles the zero. It did it four times in two
    // days' logs, on both devices. No pressure setting has three zeros after the one, so take one back out — which
    // cannot turn a wrong readback into a right one — rather than splitting it into 1000 and 9. (The cost: QNH
    // 1000 followed at once by a one-digit number reads as 100X. Rare, and it fails rather than passes.)
    if (/^(qnh|qfe|rps|pressure)$/.test(tokens[i]) && /^1000\d$/.test(next)) { tokens[i + 1] = `100${next[4]}`; continue; }
    const m = tokens[i] === 'squawk' ? /^([0-7]{4})(\d+)$/.exec(next)
      : /^(qnh|qfe|rps|pressure)$/.test(tokens[i]) ? /^(9\d\d|1\d{3})(\d+)$/.exec(next) : null;
    if (m) tokens.splice(i + 1, 1, m[1], m[2]);
  }
  return tokens.join(' ');
}

export function tokens(text, opts) {
  return normalize(text, opts).split(' ').filter(Boolean);
}

/** "G-CLHP" -> { full: "gclhp", abbr: "ghp" } */
export function callsignForms(reg) {
  const letters = String(reg).toLowerCase().replace(/[^a-z]/g, '');
  return { full: letters, abbr: letters[0] + letters.slice(-2) };
}

/** "G-CLHP" -> "Golf Charlie Lima Hotel Papa" */
export function phoneticCallsign(reg) {
  return String(reg).toLowerCase().replace(/[^a-z]/g, '').split('').map(c => LETTER_TO_WORD[c]).join(' ');
}

/**
 * Find the callsign in a token list. Letters may arrive as phonetic words (already folded to
 * single letters) or as a run-together token like "ghp".
 */
export function findCallsign(toks, reg) {
  const { full, abbr } = callsignForms(reg);
  // Expand run-together tokens that exactly equal a form of our callsign.
  const expanded = [];
  const origIndex = [];
  toks.forEach((t, i) => {
    if (t === full || t === abbr) { for (const c of t) { expanded.push(c); origIndex.push(i); } }
    else { expanded.push(t); origIndex.push(i); }
  });
  // Build runs of single letters.
  const runs = [];
  let cur = null;
  expanded.forEach((t, i) => {
    if (/^[a-z]$/.test(t)) {
      if (!cur) { cur = { start: origIndex[i], end: origIndex[i], letters: '' }; runs.push(cur); }
      cur.letters += t; cur.end = origIndex[i];
    } else cur = null;
  });
  let best = null;
  for (const r of runs) {
    let form = null;
    if (r.letters.includes(full)) form = 'full';
    else if (r.letters.includes(abbr)) form = 'abbr';
    else if (r.letters.endsWith(abbr.slice(1)) && r.letters.length >= 2) form = 'partial';
    if (form && (!best || rank(form) > rank(best.form))) best = { form, start: r.start, end: r.end };
  }
  if (best && best.form === 'full') return best;
  return spelled(toks, full, 'full') || (best && best.form === 'abbr' ? best : spelled(toks, abbr, 'abbr')) || best;
  function rank(f) { return { full: 3, abbr: 2, partial: 1 }[f]; }
}

/**
 * A second look, for when speech recognition turned one of the letters into an ordinary word: "golf charlie
 * zulu author" or "golf charlie zulu in the alpha" for G-CZIA. We know the registration, so a word may stand
 * in for one of the letters still to come only when it begins with that letter ("Author" for "Alpha", "India"
 * for the "in" of "in the"), or when it is one the recogniser has been heard to make of that letter's name (ALIKE);
 * a word that fits nothing is a stray the recogniser invented, and we allow a couple of those. A single letter that
 * is not the next one is a different aircraft, and stops the scan — so G-CZIH is never read as G-CZIA. At least half
 * the letters must still have arrived as letters.
 */
// "Alpha" most of all, and not always with an A: "golf India outer" drew "say callsign" on 25 September. None of these
// is a letter's name, so none can be another aircraft's letter.
const ALIKE = { a: ['outer', 'out', 'offer', 'oven', 'elsa', 'elfa', 'ella', 'elther', 'eltha', 'rather'] };
function spelled(toks, full, form = 'full') {
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] !== full[0]) continue;
    let k = 1, j = i + 1, heard = 1, slack = 2;
    while (k < full.length && j < toks.length && j - i <= full.length + 3) {
      const t = toks[j];
      if (t === full[k]) { k++; j++; heard++; continue; }
      if (t.length === 1) break;                              // a letter we did not expect: not this aircraft
      if (ALIKE[full[k]]?.includes(t)) { k++; j++; continue; } // what the recogniser makes of that letter's name
      const at = full.indexOf(t[0], k);
      if (at >= 0) { k = at + 1; j++; continue; }              // the word stands in for that letter
      if (slack) { slack--; j++; continue; }                   // a stray word between the letters
      break;
    }
    if (k === full.length && heard * 2 >= full.length) return { form, start: i, end: j - 1 };
  }
  return null;
}

/**
 * Words the speech synthesiser should say the way a controller does:
 * "3000 feet" -> "three thousand feet", "1017" -> "one zero one seven",
 * "134.580" -> "one three four decimal five eight zero".
 */
const SAY_DIGIT = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner'];
export function speakable(text) {
  let s = String(text);
  s = s.replace(/\bcallsigns?\b/gi, m => (m.endsWith('s') ? 'call signs' : 'call sign'));   // said as one word it comes out "calsigen"
  s = s.replace(/\b(\d{1,2})(000|500|[1-9]00)\s+feet\b/g, (_, th, rest) => {
    const t = Number(th), h = Number(rest) / 100;
    const words = [];
    if (t) words.push(numberWord(t), 'thousand');
    if (h) words.push(SAY_DIGIT[h] === 'niner' ? 'nine' : SAY_DIGIT[h], 'hundred');
    return words.join(' ') + ' feet';
  });
  s = s.replace(/\b(\d{3,4})\s+feet\b/g, (_, n) => {
    const v = Number(n); const h = Math.floor(v / 100);
    return v % 100 === 0 ? `${SAY_DIGIT[h] === 'niner' ? 'nine' : SAY_DIGIT[h]} hundred feet` : n + ' feet';
  });
  s = s.replace(/\bsquawk (\d)000\b/gi, (_, d) => `squawk ${SAY_DIGIT[+d]} thousand`);
  // Parallel runways: "25L" is "two five left", never "twenty-five L".
  s = s.replace(/\b(\d{2})([LRC])\b/g, (_, n, side) => `${n} ${{ L: 'left', R: 'right', C: 'centre' }[side]}`);
  s = s.replace(/\b\d+\.\d+\b/g, m => m.split('').map(c => c === '.' ? 'decimal' : SAY_DIGIT[+c]).join(' '));
  s = s.replace(/\b\d{2,}\b/g, m => m.split('').map(c => SAY_DIGIT[+c]).join(' '));
  s = s.replace(/\b\d\b/g, m => ({ '9': 'niner' }[m] || ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'][+m]));
  return s;
}
function numberWord(n) {
  const small = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  return small[n] || String(n);
}
