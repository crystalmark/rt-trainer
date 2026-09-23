import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, findCallsign, tokens, speakable } from '../js/normalize.js';
import { match, hasAny } from '../js/matcher.js';
import { AREAS } from '../js/areas/index.js';

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
