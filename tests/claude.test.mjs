// The browser's calls to Claude, against a stand-in for the API. The debrief goes to Claude Sonnet 5, which thinks
// unless told otherwise, inside the same max_tokens as its answer: at 900 the thinking could use the lot, and a debrief
// cut off or empty was shown as if it were complete, with the button to try again gone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Claude } from '../js/claude.js';

function reply(data) {
  const sent = [];
  globalThis.fetch = async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, json: async () => data }; };
  return sent;
}
const ctx = { unit: 'Leeds Radar', freq: '134.580', reg: 'G-CZIA', abbr: 'G-IA', type: 'QuikR microlight', transponder: true, speedKt: 65 };
const session = { scenario: { title: 'Leeds zone transit' }, ctx, events: [], stats: {} };

test('the debrief asks for low effort, with room to finish', async () => {
  const sent = reply({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Overall: a tidy transit.' }] });
  assert.equal(await new Claude({ apiKey: 'k' }).debrief(session), 'Overall: a tidy transit.');
  assert.deepEqual(sent[0].output_config, { effort: 'low' });
  assert.ok(sent[0].max_tokens >= 2000, `max_tokens ${sent[0].max_tokens}`);
});

test('a reply cut off, declined or empty is an error, not a debrief', async () => {
  const claude = new Claude({ apiKey: 'k' });
  reply({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'Overall: a tidy transit, but' }] });
  await assert.rejects(claude.debrief(session), /cut off/);
  reply({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: 'Not something I can help with.' }, content: [] });
  await assert.rejects(claude.debrief(session), /declined: Not something/);
  reply({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }] });
  await assert.rejects(claude.debrief(session), /empty/);
});

test('the off-script controller is sent no effort: Haiku 4.5 does not take one', async () => {
  const sent = reply({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"transmissions": ["G-IA, roger"]}' }] });
  const out = await new Claude({ apiKey: 'k' }).atc({ scenario: { title: 'Leeds zone transit' }, ctx, events: [], history: [], pilot: 'G-IA, request diversion' });
  assert.deepEqual(out.transmissions, ['G-IA, roger']);
  assert.equal(sent[0].output_config, undefined);
});
