import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, findCallsign, tokens, speakable } from '../js/normalize.js';
import { match } from '../js/matcher.js';

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
