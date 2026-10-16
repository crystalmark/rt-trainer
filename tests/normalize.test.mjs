import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, findCallsign, tokens, speakable, tidyReg } from '../js/normalize.js';
import { match, hasAny, isSayAgain } from '../js/matcher.js';
import { AREAS } from '../js/areas/index.js';
import { BASIC, SQUAWK, ROS, RESUME, QNH, P } from '../js/scenarios/common.js';
import { rowsFrom, stats, append, load, clear } from '../js/heard.js';

test('numbers in all the ways speech recognition returns them', () => {
  assert.equal(normalize('QNH one zero one seven'), 'qnh 1017');
  assert.equal(normalize('QNH 1017'), 'qnh 1017');
  assert.equal(normalize('three thousand feet'), '3000 feet');
  assert.equal(normalize('3,000 ft'), '3000 feet');
  assert.equal(normalize('two thousand five hundred feet'), '2500 feet');
  assert.equal(normalize('one three four decimal five eight zero'), '134.58');
  assert.equal(normalize('134.580'), '134.58');
  assert.equal(normalize('squawk seven thousand'), 'squawk 7000');
  assert.equal(normalize('squawk zero zero three zero'), 'squawk 0030');
  assert.equal(normalize('niner'), '9');
});

test('callsigns: full, abbreviated, run-together, partial', () => {
  assert.equal(findCallsign(tokens('Leeds Radar Golf Charlie Lima Hotel Papa'), 'G-CLHP').form, 'full');
  assert.equal(findCallsign(tokens('wilco golf hotel papa'), 'G-CLHP').form, 'abbr');
  assert.equal(findCallsign(tokens('wilco G-HP'), 'G-CLHP').form, 'abbr');
  assert.equal(findCallsign(tokens('wilco GHP'), 'G-CLHP').form, 'abbr');
  assert.equal(findCallsign(tokens('wilco golf india alpha'), 'G-CZIA').form, 'abbr');
  assert.equal(findCallsign(tokens('wilco hotel papa'), 'G-CLHP').form, 'partial');
  assert.equal(findCallsign(tokens('wilco golf hotel tango'), 'G-CLHP'), null);
});

test('speech output reads numbers the way ATC does', () => {
  assert.equal(speakable('not above altitude 3000 feet'), 'not above altitude three thousand feet');
  assert.equal(speakable('QNH 1017'), 'QNH one zero one seven');
  assert.equal(speakable('squawk 7000'), 'squawk seven thousand');
  assert.equal(speakable('Leeds Tower 120.305'), 'Leeds Tower one two zero decimal three zero five');
});

test('matcher: missing items, substitutes, order, fillers', () => {
  const ctx = { reg: 'G-CLHP' };
  const spec = [{ label: 'squawk 5634', any: ['5634'] }, { label: 'remain outside', any: ['remain outside controlled airspace'], substitutes: ['zone'] }];
  let r = match('squawk 5634 remain outside controlled airspace G-HP', spec, ctx);
  assert.equal(r.hardMissing.length, 0); assert.ok(r.orderOk);
  r = match('remain outside controlled airspace squawk 5634 G-HP', spec, ctx);
  assert.equal(r.orderOk, false);
  r = match('squawk 5634 remain outside the zone G-HP', spec, ctx);
  assert.deepEqual(r.hardMissing.map(i => i.label), ['remain outside']);
  assert.equal(r.substitutions[0].substituted, 'zone');
  r = match('roger that with you G-HP', [], ctx);
  assert.equal(r.fillers.length, 2);
});

test('what speech recognition makes of the words that matter', () => {
  assert.equal(normalize('basic service escort 5603 remaining outside a controlled airspace golf Charlie Zulu India alpha'),
    'basic service squawk 5603 remaining outside controlled airspace g c z i a');
  assert.equal(normalize('squat 7000 wilco'), 'squawk 7000 wilco');
  assert.equal(normalize('squawking 5634 G-CZIA'), 'squawk 5634 g c z i a');
  assert.equal(normalize('basic service skork 5678'), 'basic service squawk 5678');
  for (const w of ['squark', 'skork', 'scork', 'sqwak', 'skwak', 'squawks', 'stork', 'squad'])
    assert.equal(normalize(`${w} 7000`), 'squawk 7000', w);
  // ...without swallowing anything a pilot might actually say
  for (const w of ['skipton', 'silsden', 'steeton', 'shipley', 'selby', 'scarborough', 'sherburn'])
    assert.equal(normalize(w), w);
  assert.equal(normalize('golf charlie zulu india alfie'), 'g c z i a');
  assert.ok(findCallsign(tokens('golf charlie zulu india alfie'), 'G-CZIA'));
});

test('hesitation is ignored, however it is spelled', () => {
  assert.equal(normalize('err squawk 5634 erm wilco G-CZIA'), 'squawk 5634 wilco g c z i a');
  assert.equal(normalize('uhh basic service ah remaining outside controlled airspace'), 'basic service remaining outside controlled airspace');
  assert.equal(normalize('errr golf hotel papa'), 'g h p');
  assert.equal(normalize('eight hundred feet'), '800 feet', 'real words are left alone');
});

// A real "pass your message" reply off the Pixel, word for word. Nothing here was mumbled: this is what
// Chrome makes of a details call spoken slowly and clearly, and every item of it has to still be found.
test('a whole details call, as the Pixel heard it', () => {
  const said = 'golf Charlie Zulu India Alta micro light from Oxenhope 1,700 feet 1 0 2 1 q&h routine ' +
    'Oxenhope Keith Lee Ilkley adding them Skipton auction hope request airspace Transit ' +
    'Keith Lee Ilkley adding them the FR mode sierra golf Charlie Zulu alpha';
  const t = normalize(said);
  assert.equal(findCallsign(tokens(said), 'G-CZIA').form, 'full');
  assert.match(t, /^g c z i a microlight from oxenhope 1700 feet 1021 qnh routing /);
  for (const w of ['vfr', 'transit']) assert.ok(t.includes(w), w);
  assert.ok(!/\broutine\b/.test(t));
  // ...and the places along the route, by whatever name Chrome gave them
  const leeds = AREAS.find(a => a.id === 'leeds');
  for (const n of ['Oxenhope', 'Keighley', 'Ilkley', 'Addingham', 'Skipton'])
    assert.ok(hasAny(said, leeds.places.find(x => x.name === n).hear), n);
});

test('“resume own navigation” still beats “routing”', () => {
  assert.equal(normalize('routine own navigation to Eccup'), 'resume own navigation to eccup');
  assert.equal(normalize('routine north of the zone'), 'routing north of the zone');
});

// The recogniser keeps turning one phonetic word into an ordinary English one: Alpha as "author", India as
// "in the". We know the registration, so a word standing where a letter should be is read as that letter —
// but only when it begins with the same letter, and never over a letter belonging to another aircraft.
test('a callsign survives one of its letters being heard as a word', () => {
  const form = (t, reg = 'G-CZIA') => (findCallsign(tokens(t), reg) || {}).form || null;
  assert.equal(form('golf Charlie Zulu author'), 'full');
  assert.equal(form('golf Charlie Zulu in the alpha'), 'full');
  assert.equal(form('golf Charlie Zulu India author, requesting basic service'), 'full');
  assert.equal(form('golf Charlie Zulu India alpha'), 'full');
  assert.equal(form('Leeds Radar, golf Charlie Zulu author, request basic service and transit'), 'full');

  // ...and it stays honest about everything else
  assert.equal(form('golf India alpha'), 'abbr', 'an abbreviated callsign is not promoted');
  assert.equal(form('golf Charlie Zulu India hotel'), null, 'G-CZIH is a different aircraft');
  assert.equal(form('golf Charlie delta foxtrot kilo'), null);
  assert.equal(form('golf Charlie Zulu requesting basic service and transit'), null, 'the letters simply are not there');
  assert.equal(form('golf author lima hotel papa', 'G-CLHP'), 'partial', '“author” cannot stand in for Charlie');
  assert.equal(form('golf Charlie lima hotel papa', 'G-CLHP'), 'full');
});

// "Controlled airspace" is the phrase that must be read back exactly, and the recogniser keeps clipping it to
// "control airspace" — which then reads as the pilot shortening it themselves, and is marked as a substitution.
test('the recogniser clips “controlled airspace”, and turns squawk into real words', () => {
  assert.equal(normalize('basic service cork 5626 remain outside control airspace golf India alpha'),
    'basic service squawk 5626 remain outside controlled airspace g i a');
  assert.equal(normalize('remaining outside controls air space'), 'remaining outside controlled airspace');
  assert.equal(normalize('quark 7000'), 'squawk 7000');

  // ...without touching the control zone, which is a different place, or Cork, which is a real one
  assert.equal(normalize('cleared to enter the control zone'), 'cleared to enter the control zone');
  assert.equal(normalize('report leaving the control zone'), 'report leaving the control zone');
  assert.equal(normalize('overhead Cork'), 'overhead cork');
});

test('and the whole readback then passes clean', () => {
  const spec = [BASIC(), SQUAWK('5626'), ROS()];
  const r = match('basic service cork 5626 remain outside control airspace golf India alpha', spec, { reg: 'G-CZIA' }, { kind: 'readback' });
  assert.deepEqual(r.hardMissing.map(i => i.label), []);
  assert.deepEqual(r.substitutions.map(i => i.substituted), []);
  assert.equal(r.score, 100);
});

// A clearance readback, as the Pixel heard it. Only the pressure is beyond saving: a mangled number is the one
// thing that must not be papered over, because reading back the wrong QNH is the error the check exists for.
test('a clearance readback: the acronyms recovered, the number left alone', () => {
  const said = 'clear to enter the Leeds controlled zone q&h 10005 the dfr not above 2,000 feet Wilco golf India alpha';
  // 10005 is Chrome doubling the zero of "one zero zero five", as the logs later showed it doing again and again.
  assert.equal(normalize(said), 'cleared to enter the leeds controlled zone qnh 1005 vfr not above 2000 feet wilco g i a');

  // Spelling the letters out is the thing a pilot can actually do about it: spaced letters fold back together,
  // where the recogniser's guess at the acronym does not.
  for (const t of ['q n h 1005', 'Q.N.H. one zero zero five', 'qnh one zero zero five']) assert.equal(normalize(t), 'qnh 1005', t);
  for (const t of ['v f r', 'V.F.R.', 'the dfr', 'the fr']) assert.equal(normalize(t), 'vfr', t);

  // "Oh" for zero is understood but is not CAP 413, so it is heard and then flagged rather than failed.
  assert.equal(normalize('qnh ten oh five'), 'qnh 1005');
  assert.equal(normalize('one zero one seven'), '1017');
  assert.ok(match('qnh one zero zero five', [], {}).fillers.length === 0);
  assert.match(match('qnh ten oh five', [], {}).fillers[0], /Every digit has its own word/);

  assert.equal(normalize('clear of the zone'), 'clear of the zone', '"clear of" is not a clearance');
});

// The speech-recognition log: the point of it is to tell a fold that rescued a transmission from one that fired
// and still wasn't enough, because only the second kind says the tail is long.
test('the speech recognition log separates rescued from still-failing', () => {
  const events = [
    // Passed only because "control airspace" is folded to "controlled airspace": the engine marks it rescued.
    { type: 'readback', t: 40, text: 'basic service cork 5626 remain outside control airspace golf India alpha', rescued: true,
      result: { score: 100, missing: [], substitutions: [] } },
    { type: 'readback', t: 70, text: 'clear to enter the Leeds controlled zone q&h 10005 the dfr not above 2,000 feet Wilco golf India alpha',
      result: { score: 70, missing: ['QNH 1005'], substitutions: [] } },
    { type: 'call', t: 90, text: 'golf Charlie Zulu author requesting transit',
      heard: 'golf Charlie Zulu author requesting transit', alts: ['a', 'b'],
      result: { score: 100, missing: [], substitutions: [] } },
    { type: 'atc', t: 95, text: 'not a transmission of yours' },
  ];
  const rows = rowsFrom(events, { scenario: 'custom-leeds', reg: 'G-CZIA', at: 1 });
  assert.equal(rows.length, 3, 'only the pilot transmissions');
  assert.deepEqual(rows.map(r => r.folded), [true, true, false]);
  assert.deepEqual(rows.map(r => r.rescued), [true, false, false]);
  assert.deepEqual(rows.map(r => r.missing.length > 0), [false, true, false]);
  assert.equal(rows[0].raw, 'basic service cork 5626 remain outside control airspace golf India alpha');
  assert.equal(rows[0].norm, 'basic service squawk 5626 remain outside controlled airspace g i a');

  const s = stats(rows);
  assert.equal(s.transmissions, 3);
  assert.equal(s.rescued, 1, 'a fold repaired one that would have failed');
  assert.equal(s.failed, 1, 'and one no fold reached');
  assert.equal(s.otherGuess, 1);
  assert.equal(s.failRate, 33);
});

test('the log is capped and survives storage being off', () => {
  const mem = new Map();
  const store = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: k => mem.delete(k) };
  const row = n => ({ at: n, scenario: 's', reg: 'G-CZIA', kind: 'call', id: null, t: n, raw: 'x', norm: 'x', folded: false, score: 100, missing: [], subs: [] });
  for (let i = 0; i < 90; i++) append(store, [row(i), row(i + 1000), row(i + 2000), row(i + 3000), row(i + 4000)]);
  const all = load(store);
  assert.equal(all.length, 400, 'capped, so it cannot eat the other apps\' storage');
  clear(store);
  assert.deepEqual(load(store), []);

  const dead = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  assert.deepEqual(load(dead), [], 'private window: no log, no crash');
  assert.doesNotThrow(() => append(dead, [row(1)]));
  assert.doesNotThrow(() => clear(dead));
});

// An off-script readback off the Pixel. "Score" for squawk is the fourth real English word the recogniser has
// produced for it, so it only folds where a code follows; 2677 is the Leeds listening squawk.
test('an off-script clearance readback, as the Pixel heard it', () => {
  assert.equal(normalize('score 2677 clear to Transit maintaining 1,700 willco report leaving northwest golf India outer'),
    'squawk 2677 cleared to transit maintaining 1700 wilco report leaving north west g i outer');
  assert.equal(normalize('scored a goal'), 'scored a goal', 'no code after it, so it is left alone');
  assert.equal(normalize('clear of the zone'), 'clear of the zone', '"clear of" is not a clearance');
});

// Off script there is no spec to mark against, but the words are still what the recogniser produced — and a
// whole flight of them used to log as zero transmissions.
test('the log records off-script and unrecognised transmissions too', () => {
  const events = [
    { type: 'readback', t: 40, text: 'squawk 5626 remain outside controlled airspace G-IA', result: { score: 100, missing: [], substitutions: [] } },
    { type: 'offscript', t: 60, text: 'request a diversion' },
    { type: 'free-assessment', t: 62, text: 'score 2677 clear to Transit maintaining 1,700 willco' },
    { type: 'unexpected', t: 80, text: 'golf India alpha' },
    { type: 'blocked', t: 85, text: 'talking over someone' },
    { type: 'empty-tx', t: 95 },
    { type: 'atc', t: 96, text: 'not one of mine' },
  ];
  const rows = rowsFrom(events, { scenario: 'custom-leeds', reg: 'G-CZIA', at: 1 });
  assert.deepEqual(rows.map(r => r.kind), ['readback', 'free-assessment', 'unexpected', 'blocked', 'empty-tx']);
  assert.deepEqual(rows.map(r => r.judged), [true, false, false, false, false]);

  const s = stats(rows);
  assert.equal(s.transmissions, 5);
  assert.equal(s.judged, 1);
  assert.equal(s.unjudged, 4);
  assert.equal(s.heardNothing, 1, 'the recogniser returned no words once');
  assert.equal(s.failRate, 0, 'the rate is over what was marked, not over everything');
});

// Found by the speech recognition log on its first real flight — and not the recogniser's fault. Chrome heard
// "QNH one zero one eight, four miles" perfectly; the normaliser ran the numbers together.
test('numbers next to each other stay separate numbers', () => {
  // the details call from the log, word for word
  assert.equal(
    normalize('golf Charlie Zulu India alpha microlite Oxenhope Ilkley Skipton Oxenhope 1,700 feet qnh one zero one eight  four miles southwest salt Mill VIP'),
    'g c z i a microlight oxenhope ilkley skipton oxenhope 1700 feet qnh 1018 4 miles south west salt mill vip');

  // a code has a fixed length, so whatever follows it is the next number
  assert.equal(normalize('squawk 5626 two miles'), 'squawk 5626 2 miles');
  assert.equal(normalize('squawk five six two six two miles north'), 'squawk 5626 2 miles north');
  assert.equal(normalize('qnh nine nine eight three miles'), 'qnh 998 3 miles');

  // and only the word before "thousand" multiplies: this one used to come out as 12000
  assert.equal(normalize('qnh one zero one eight two thousand feet'), 'qnh 1018 2000 feet');
  for (const [said, want] of [['two thousand five hundred feet', '2500 feet'], ['one thousand seven hundred', '1700'],
    ['eleven thousand', '11000'], ['twenty five thousand', '25000'], ['squawk seven thousand', 'squawk 7000']]) {
    assert.equal(normalize(said), want, said);
  }
});

test('and the readback those numbers belong to now passes', () => {
  const r = match('squawk 5626 two miles north of Skipton G-IA', [SQUAWK('5626')], { reg: 'G-CZIA' }, { kind: 'readback' });
  assert.deepEqual(r.hardMissing, []);
  const q = match('QNH one zero one eight, two thousand feet, G-IA', [P('QNH 1018', ['1018']), P('2000 feet', ['2000'])], { reg: 'G-CZIA' }, { kind: 'readback' });
  assert.deepEqual(q.hardMissing.map(i => i.label), []);
});

// The clearance readback from the second log, three attempts, word for word. Every one was correct as spoken;
// ATC corrected the first two purely on what the recogniser made of them.
test('the same clearance read back three times now passes every time', () => {
  const spec = [P('cleared to enter', ['cleared to enter', 'cleared into', 'cleared']), P('VFR', ['vfr']),
    P('not above', ['not above']), P('2000 feet', ['2000']), P('QNH 1015', ['1015'])];
  for (const said of [
    'cleared via Ilkley  they are the  not of a 2000 q&h 1015 report ickley  golf India alpha',
    'glare to enter via Ilkley VFR not above 2,000 feet qnh1015 Wilko  golf India alpha',
    'clear to enter the Leeds control Zone via Ilkley VFR not above 2,000 feet unh1015 report Ilkley Wilko golf India alpha',
  ]) {
    const r = match(said, spec, { reg: 'G-CZIA' }, { kind: 'readback' });
    assert.deepEqual(r.hardMissing.map(i => i.label), [], said);
  }
  // ...without reading anything into ordinary English
  for (const t of ['they are the best', 'not of a doubt', 'glare of the sun', 'unhappy']) assert.equal(normalize(t), t);
});

test('parallel runways are spoken digit by digit and then the side', () => {
  assert.equal(speakable('runway 25L left-hand, QFE 1015'), 'runway two five left left-hand, QFE one zero one five');
  assert.equal(speakable('final 29L'), 'final two niner left');
  assert.equal(speakable('runway 05R'), 'runway zero five right');
  assert.equal(speakable('runway 24'), 'runway two four', 'a single runway is unchanged');
  // ...and a pilot saying it either way is heard as the same runway
  assert.equal(normalize('runway two five left'), 'runway 25 left');
});

test('an abbreviated callsign survives a clipped alpha too', () => {
  const form = t => (findCallsign(tokens(t), 'G-CZIA') || {}).form || null;
  assert.equal(form('basic service squawk 5666 will remain outside of controlled airspace golf India alph'), 'abbr');
  assert.equal(form('golf India Al'), 'abbr');
  assert.equal(form('golf India requesting basic service'), null, 'the letters are not there');
  assert.equal(form('golf India hotel'), null, 'a different aircraft');
});

// "Golf India" said quickly arrives as one word, and the callsign with it: "gulfinderella" drew "Station reading back,
// say callsign" on 24 September, and the rest are Chrome's other guesses from the same flights.
test('a callsign run together into one word is still found', () => {
  const form = t => (findCallsign(tokens(t), 'G-CZIA') || {}).form || null;
  assert.equal(form('resuming own and navigation to Ilkley gulfinderella'), 'abbr');
  assert.equal(form('resuming own and navigation to Ilkley gulfinder Alpha'), 'abbr');
  assert.equal(form('gulfindia alpha reporting overhead Ilkley'), 'abbr');
  assert.equal(form('looking out gulfindia Alpha'), 'abbr');
  assert.equal(form('gulfindia hotel'), null, 'still a different aircraft');
});

// The flight of 25 September: four readbacks failed that were right, or right but for the recogniser.
test('“resuming own navigation” is a correct readback', () => {
  for (const t of ['golf India alther resuming own navigation to Ilkley', 'golf in the alpha resuming owner navigation to Ilkley',
    'resume own navigation to Ilkley golf India alpha'])
    assert.deepEqual(match(t, [RESUME()], { reg: 'G-CZIA' }, { kind: 'readback' }).hardMissing, [], t);
});

test('“radar control service” said right, and a QNH whose eight was heard as an H', () => {
  assert.equal(normalize('radar controlled service'), 'radar control service');
  const said = 'not above 2,000 feet 1 0 0 HQ and H report Ilkley';
  assert.equal(normalize(said), 'not above 2000 feet 1008 qnh report ilkley');
  assert.deepEqual(match(said, [QNH(1008)], { reg: 'G-CZIA' }, { kind: 'readback' }).hardMissing, []);
  // ...and nothing else with an H in it moves
  assert.equal(normalize('squawk 5626 golf charlie lima hotel papa'), 'squawk 5626 g c l h p');
  assert.equal(normalize('q and h 1 0 0 8'), 'qnh 1008');
});

test('what the recogniser makes of “alpha” still ends the callsign, and no other letter does', () => {
  const form = t => (findCallsign(tokens(t), 'G-CZIA') || {}).form || null;
  assert.equal(form('skork 7000 changing frequency golf India outer'), 'abbr');
  assert.equal(form('q&h 1007 golf India offer'), 'abbr');
  assert.equal(form('orbit left golf India Elsa'), 'abbr');
  assert.equal(form('golf Charlie Zulu India outer'), 'full');
  assert.equal(form('golf India oscar'), null, 'Oscar is a letter: another aircraft');
  assert.equal(form('golf India echo'), null);
});

// "I say again" is the pilot repeating their own message, usually because ATC asked: it was taken as the pilot asking
// ATC to repeat, and the message thrown away. The words as heard decide it, because normalised, "I" is India.
test('"I say again" is a message, "say again" a request', () => {
  assert.equal(isSayAgain('G-CZIA, I say again, overhead Salts Mill'), false);
  assert.equal(isSayAgain('golf india alpha I say again Salts Mill'), false);
  assert.equal(isSayAgain('say again, golf india alpha'), true);
  assert.equal(isSayAgain('golf charlie zulu, say again'), true, 'a callsign ending in India is not "I"');
  assert.equal(isSayAgain('G-IA, request you repeat the QNH'), true);
});

// "X-ray" is how the alphabet spells it, and how the recogniser writes it. Split into letters as if it were a
// registration, it came out as x r a y, and a registration with an X lost its callsign.
test('X-ray is one letter, so a registration with an X is still found', () => {
  assert.equal(normalize('golf charlie x-ray tango lima'), 'g c x t l');
  assert.equal(findCallsign(tokens('golf charlie x-ray tango lima'), 'G-CXTL').form, 'full');
  assert.equal(findCallsign(tokens('squawk 5634 golf x-ray yankee'), 'G-BOXY').form, 'abbr');
  assert.equal(normalize('details sent by e-mail'), 'details sent by email');
  assert.equal(normalize('G-CLHP'), 'g c l h p', 'a registration is still spelt out');
});

// With site data blocked there is no storage at all: the log carries on without it rather than taking the debrief down.
test('the speech recognition log copes with no storage at all', () => {
  const rows = [{ kind: 'call', judged: true, failed: false }];
  assert.deepEqual(load(null), []);
  assert.deepEqual(append(null, rows), rows);
  assert.doesNotThrow(() => clear(null));
});

// Two numbers spoken back to back, with no "feet" or "QNH" between them: added together, a correct readback of
// "not above 2000 feet, QNH 1017" came out as 2009, or as 20001017.
test('an altitude followed straight by a QNH is two numbers', () => {
  assert.equal(normalize('not above two thousand one zero one seven'), 'not above 2000 1017');
  assert.equal(normalize('altitude two thousand three hundred, one zero one six'), 'altitude 2300 1016');
  assert.equal(normalize('not above 2000 1 0 1 7'), 'not above 2000 1017');
  assert.equal(normalize('not above 2000 one zero one seven'), 'not above 2000 1017');
  assert.equal(normalize('two thousand five'), '2005', 'one digit after a thousand is still its units');
  assert.equal(normalize('one two five decimal four seven five'), '125.475');
  assert.equal(normalize('134 decimal five eight'), '134.58');
});

// Chrome doubles the zero in "one zero zero X", on the Mac and the Pixel alike: four times in two days of logs.
test('a pressure setting with a doubled zero is heard as it was said', () => {
  assert.equal(normalize('golf India alpha cleared into the controlled zone via Ilkley not above 2000 feet q&h 10009 report IKEA golf India alpha'),
    'g i a cleared into the controlled zone via ilkley not above 2000 feet qnh 1009 report ikea g i a');
  assert.equal(normalize('1,700 feet on q&h 10 0 0 8 currently four miles'), '1700 feet on qnh 1008 currently 4 miles');
  assert.equal(normalize('qnh 10008'), 'qnh 1008');
  // ...while a following number still comes off a real four-digit pressure, and nothing else is touched
  assert.equal(normalize('qnh one zero one eight four miles'), 'qnh 1018 4 miles');
  assert.equal(normalize('qnh 1000'), 'qnh 1000');
  assert.equal(normalize('squawk 10009'), 'squawk 1000 9', 'a squawk is split at its four digits, not collapsed like a pressure');
  // and the rest of that flight
  assert.equal(normalize('microlyte'), 'microlight');
  assert.equal(normalize('CTR nut above 2000'), 'ctr not above 2000');
});

// The Pixel and the Mac hear very differently, and a log without the device got the two confused.
test('the speech recognition log says which device each row came from', async () => {
  const { deviceName, rowsFrom } = await import('../js/heard.js');
  assert.equal(deviceName('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'), 'Android · Chrome');
  assert.equal(deviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'), 'Mac · Chrome');
  assert.equal(deviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'), 'Mac · Safari');
  assert.equal(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1'), 'iPhone · Chrome');
  assert.equal(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0'), 'Windows · Edge');
  const rows = rowsFrom([{ type: 'call', t: 1, text: 'golf india alpha', result: { score: 100, missing: [], substitutions: [] } }], { device: 'Android · Chrome' });
  assert.equal(rows[0].device, 'Android · Chrome');
});

// "Decimal four" heard as "decimal for": SafetyCom came out as "135 for 80", and the check on its frequency never saw it.
test('"decimal for" is a four', () => {
  assert.equal(normalize('request change frequency to safety comma 135 decimal for eight zero golf India alpha'),
    'request change frequency to safetycom 135.48 g i a');
  assert.equal(normalize('one three five decimal for eight zero'), '135.48');
  assert.equal(normalize('request frequency change for landing'), 'request frequency change for landing', 'only after "decimal"');
});

test('SafetyCom, however it is heard, is one word', () => {
  assert.equal(normalize('change frequency to safety comma 135 decimal for eight zero'), 'change frequency to safetycom 135.48');
  assert.equal(normalize('safety comm one three five decimal four eight zero'), 'safetycom 135.48');
  assert.equal(normalize('Safetycom'), 'safetycom');
});

test('a registration typed in setup is tidied, and recognised whichever way it was typed', () => {
  assert.equal(tidyReg(' gabcd '), 'G-ABCD');
  assert.equal(tidyReg('G-ABCD'), 'G-ABCD');
  assert.equal(tidyReg('g abcd'), 'G-ABCD');
  assert.equal(tidyReg('EI-ABC'), 'EI-ABC', 'only UK registrations get a hyphen put in');
  assert.equal(tidyReg('N123AB'), 'N123AB');
  for (const reg of ['G-ABCD', 'GABCD']) assert.equal(findCallsign(tokens('golf alpha bravo charlie delta'), reg).form, 'full');
});
