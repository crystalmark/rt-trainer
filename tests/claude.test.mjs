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

// A stalled connection (one bar at the airfield) held the off-script controller silent, and End with it, until the
// browser gave up on the socket.
function stalled() {
  globalThis.fetch = (url, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason)));
}
const asked = { scenario: { title: 'Leeds zone transit' }, ctx, events: [], history: [], pilot: 'G-IA, request diversion' };

test('a request that gets no answer gives up, and cancel() stops one straight away', async () => {
  stalled();
  await assert.rejects(new Claude({ apiKey: 'k', timeouts: { atc: 50, debrief: 50 } }).atc(asked), /no answer from Claude in 0 s/);
  stalled();
  const claude = new Claude({ apiKey: 'k' });
  const pending = claude.atc(asked);
  claude.cancel();
  await assert.rejects(pending, e => e.name === 'AbortError');
});

test('a key that will never work says so, and is told apart from a busy moment', async () => {
  const status = (code, body) => { globalThis.fetch = async () => ({ ok: false, status: code, text: async () => body }); };
  const claude = new Claude({ apiKey: 'k' });
  status(401, '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}');
  await assert.rejects(claude.atc(asked), e => e.permanent && /API key was refused/.test(e.reason));
  status(400, '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low"}}');
  await assert.rejects(claude.atc(asked), e => e.permanent && /credit/.test(e.reason));
  status(529, '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
  await assert.rejects(claude.atc(asked), e => !e.permanent && e.status === 529);
});

// Only strings to say, and an end only when it says so: an object among the transmissions ended the session with an
// error, and "end": "false" ended it too.
test('a reply that breaks the shape keeps only what the engine can use', async () => {
  reply({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"transmissions": [{"text": "G-IA"}, null, "G-IA, roger", ""], "end": "false", "assessment": 7}' }] });
  const out = await new Claude({ apiKey: 'k' }).atc(asked);
  assert.deepEqual(out.transmissions, ['G-IA, roger']);
  assert.equal(out.end, false);
  assert.equal(out.assessment, null);
});

// Off script, Claude saw only the last 30 lines of the log, and the conversation it was passed went unread. With other
// traffic still talking, the pilot's request and the clearance given for it were gone within minutes, and Claude
// answered with no memory of what it had told the aircraft to do.
test('the off-script controller sees the whole conversation, however busy the frequency', async () => {
  const sent = reply({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"transmissions": ["G-IA, roger"]}' }] });
  const traffic = n => Array.from({ length: n }, (_, i) => (i % 2
    ? { type: 'traffic', speaker: 'Channex 47', text: `Heading ${i}, Channex 47`, traffic: true }
    : { type: 'atc', speaker: 'atc', text: `Channex 47, turn left heading ${i}`, traffic: true }));
  const request = 'G-IA, request return to East Fortune due weather';
  const events = [
    { type: 'atc', speaker: 'atc', text: 'G-CZIA, cleared to enter the zone via Musselburgh, not above altitude 2000 feet', toPilot: true },
    { type: 'pilot', text: 'Cleared to enter via Musselburgh, not above 2000 feet, G-CZIA' },
    ...traffic(30),
    { type: 'pilot', text: request },
    { type: 'offscript', text: request },
    ...traffic(60),
  ];
  const history = [
    { role: 'pilot', text: request },
    { role: 'atc', text: 'G-IA, leave controlled airspace eastbound, report Haddington Hill, squawk 5271' },
    ...Array.from({ length: 10 }, (_, i) => [{ role: 'pilot', text: `G-IA, ${i + 2} miles west of Haddington Hill` }, { role: 'atc', text: 'G-IA, roger' }]).flat(),
    { role: 'pilot', text: 'G-IA, overhead Haddington Hill' },
  ];
  await new Claude({ apiKey: 'k' }).atc({ scenario: { title: 'Edinburgh zone transit' }, ctx, events, history, pilot: 'G-IA, overhead Haddington Hill' });
  const prompt = sent[0].messages[0].content;
  assert.match(prompt, /report Haddington Hill, squawk 5271/, 'its own clearance');
  assert.match(prompt, /cleared to enter the zone via Musselburgh/, 'what the pilot was cleared to do before');
  assert.equal(prompt.split(request).length - 1, 1, 'the call that left the script, once');
  assert.equal(prompt.split('overhead Haddington Hill').length - 1, 1, 'the call being answered, once');
  const first = prompt.indexOf('G-IA, 2 miles west'), last = prompt.indexOf('G-IA, 11 miles west');
  assert.ok(first > 0 && first < last, 'the conversation, all of it and in order');
  const others = prompt.split('\n').filter(l => /Channex 47/.test(l)).length;
  assert.ok(others <= 11, `${others} lines of other traffic`);
});
