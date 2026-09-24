// Optional Claude integration, called straight from the browser with your own API key.
//  - atc():     takes over as the controller once you leave the script (diversion, weather, …)
//  - debrief(): writes the end-of-session instructor debrief
// The key is kept in this browser's localStorage only. See README for the trade-offs.
import { MODELS } from './config.js';
import { briefLine } from './scenarios/common.js';

const API = 'https://api.anthropic.com/v1/messages';

// How long to wait for an answer. A stalled connection at the airfield otherwise held the controller silent, and End
// with it, until the browser gave up on the socket: minutes.
const TIMEOUTS = { atc: 15000, debrief: 90000 };

// The lines of the frequency log that set the scene for the off-script controller.
const SCENE = ['atc', 'pilot', 'traffic', 'position', 'cue', 'note'];
const logLine = e => `[${e.type}${e.speaker && e.speaker !== 'atc' ? ' ' + e.speaker : ''}] ${e.text || e.label || ''}`;

export class Claude {
  constructor({ apiKey, models = MODELS, timeouts = TIMEOUTS }) {
    this.apiKey = apiKey;
    this.models = models;
    this.timeouts = timeouts;
    this.inFlight = new AbortController();
  }

  /** Stop whatever is being asked: the flight has ended, and nobody is waiting for the answer. */
  cancel() { this.inFlight.abort(); this.inFlight = new AbortController(); }

  // `extra` goes into the request as it is (the debrief's effort). Anything short of a whole answer throws, so the
  // caller can say so and offer another try: a reply cut off at max_tokens was shown as if complete. An error the API
  // gives back says whether trying again could help (`permanent`), and why not in the pilot's terms (`reason`).
  async call(model, system, messages, { maxTokens = 600, timeout = 20000, extra = {} } = {}) {
    const signals = [AbortSignal.timeout(timeout), this.inFlight.signal];
    let data;
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages, ...extra }),
        signal: AbortSignal.any ? AbortSignal.any(signals) : signals[0],
      });
      if (!res.ok) {
        const body = await res.text();
        const reason = res.status === 401 ? 'the API key was refused: check it on the setup screen'
          : res.status === 403 ? 'the API key isn’t allowed to do this'
          : /credit/i.test(body) ? 'the API account has run out of credit' : null;
        throw Object.assign(new Error(`Claude API ${res.status}: ${body.slice(0, 200)}`),
          { status: res.status, reason, permanent: res.status >= 400 && res.status < 500 && ![408, 409, 429].includes(res.status) });
      }
      data = await res.json();
    } catch (err) {
      if (err.name === 'TimeoutError') throw new Error(`no answer from Claude in ${Math.round(timeout / 1000)} s`);
      throw err;
    }
    if (data.stop_reason === 'refusal') throw new Error(`Claude declined${data.stop_details?.explanation ? `: ${data.stop_details.explanation}` : ''}`);
    if (data.stop_reason === 'max_tokens') throw new Error('Claude’s reply was cut off before the end');
    const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    if (!text.trim()) throw new Error('Claude sent back an empty reply');
    return text;
  }

  async atc({ scenario, ctx, events, history, pilot, nav = null }) {
    const briefing = scenario.briefing
      ? scenario.briefing(ctx).map(briefLine).map(b => (b.label ? `${b.label}: ${b.text}` : b.text)).join(' ') : '';
    const places = scenario.places ? `Published VRPs: ${scenario.places.filter(p => p.kind === 'vrp').map(p => p.name).join(', ')}. ` +
      `Other landmarks you may use for routing and positions: ${scenario.places.filter(p => p.kind !== 'vrp').map(p => p.name).join(', ')}. ` +
      'Never call anything else a VRP, and never invent frequencies. ' : '';
    // The whole off-script conversation, with the frequency around it. It used to be the last 30 lines of the log, and
    // with other traffic still talking, the pilot's request and the clearance given for it were gone within minutes:
    // Claude answered with no memory of what it had told the aircraft to do.
    const cut = events.findLastIndex(e => e.type === 'offscript');
    const left = cut < 0 ? null : events[cut].text;              // the call that left the script: quoted as the dialogue's start
    const scene = (cut < 0 ? events : events.slice(0, cut)).filter(e => SCENE.includes(e.type) && !(e.type === 'pilot' && e.text === left));
    // The pilot's own last exchanges (what they were cleared to do) first, however busy the frequency has been since.
    const own = e => e.type !== 'traffic' && !(e.type === 'atc' && !e.toPilot);
    const kept = new Set([...scene.filter(own).slice(-10), ...scene.filter(e => !own(e)).slice(-5)]);
    const before = scene.filter(e => kept.has(e)).map(logLine).join('\n');
    const others = cut < 0 ? '' : events.slice(cut + 1)
      .filter(e => (e.type === 'traffic' || e.type === 'atc') && !e.claude).slice(-6).map(logLine).join('\n');
    const said = history.at(-1)?.role === 'pilot' ? history.slice(0, -1) : history;    // the last is the call to answer
    const dialogue = said.map(h => `${h.role === 'pilot' ? 'Pilot' : ctx.unit}: ${h.text}`).join('\n');
    const system = `You are the ${ctx.unit} controller on ${ctx.freq} in a UK radiotelephony training simulator. ` +
      `Speak exactly as a real UK controller would, using CAP 413 phraseology: short, precise, no chit-chat. ` +
      `The pilot is ${ctx.reg} (abbreviated ${ctx.abbr}), a ${ctx.type}, ${ctx.transponder ? 'with a Mode S transponder' : 'with no transponder'}, flying VFR at about ${ctx.speedKt} kt. ` +
      `Scenario: ${scenario.title}. ${briefing} ${places}` +
      (/radio$/i.test(ctx.unit) ? 'You are an Air/Ground operator: you cannot give clearances or instructions, only information. ' : '') +
      (/information$/i.test(ctx.unit) ? 'You are a FISO giving a Basic Service: information only, no clearances. ' : '') +
      `The pilot has left the training script (for example a diversion, weather, a change of plan or an emergency). Handle it realistically: ` +
      `challenge incorrect or incomplete readbacks ("negative…", "read back…"), ask for missing information ("say altitude"), refuse or delay if that is what a real controller would do, ` +
      `and never break character. Use sensible invented values for pressure settings, squawks and traffic. ` +
      `Reply with ONLY a JSON object: {"transmissions": ["what you say on frequency, in order"], "assessment": "one short sentence for the debrief on the pilot's last call against CAP 413", "position": "optional short description of where the aircraft now is", "end": false, "summary": "only when end is true"}. ` +
      `Set end true only when the pilot has left your frequency or landed.`;
    const where = nav && `The aircraft is now ${nav.where || 'on its route'}${nav.route.length ? `, routing ${nav.route.join(', ')}` : ''}.`;
    const content = [
      before && `The frequency before the pilot left the script:\n${before}`,
      dialogue && `Since then, between you and the pilot:\n${dialogue}`,
      others && `Other transmissions on the frequency since:\n${others}`,
      where,
      `The pilot just transmitted: "${pilot}"`,
      `Respond as ${ctx.unit}.`,
    ].filter(Boolean).join('\n\n');
    const msgs = [{ role: 'user', content }];
    const text = await this.call(this.models.atc, system, msgs, { maxTokens: 400, timeout: this.timeouts.atc });
    const json = text.match(/\{[\s\S]*\}/);
    if (!json) throw new Error('No JSON from Claude');
    const out = JSON.parse(json[0]);
    // Only what the engine can use: things to say, as strings, and an end only when it says so in so many words. An
    // object among the transmissions ended the session with an error, and "end": "false" ended it as well.
    const str = v => (typeof v === 'string' && v.trim() ? v : null);
    return { transmissions: [].concat(out.transmissions ?? []).filter(str), assessment: str(out.assessment),
      position: str(out.position), end: out.end === true, summary: str(out.summary) };
  }

  async debrief({ scenario, ctx, events, stats }) {
    const lines = events.filter(e => !['traffic', 'log'].includes(e.type)).map(e => {
      const r = e.result ? ` | missing: ${e.result.missing.join('; ') || 'none'} | soft missing: ${e.result.softMissing.map(s => s.label).join('; ') || 'none'} | substitutions: ${e.result.substitutions.map(s => `${s.said} for ${s.label}`).join('; ') || 'none'} | fillers: ${e.result.fillers.length} | order ok: ${e.result.orderOk} | callsign: ${e.result.callsign}` : '';
      const extra = e.assessment ? ` | assessment: ${e.assessment}` : '';
      return `${fmt(e.t)} ${e.type}${e.speaker && e.speaker !== 'atc' ? ' ' + e.speaker : ''}: ${e.text || e.label || e.summary || ''}${r}${extra}`;
    }).join('\n');
    const system = 'You are a UK flight radiotelephony instructor and FRTOL examiner debriefing a microlight pilot after a practice session. ' +
      'Be direct and specific, not flattering. Quote what the pilot said and give the correct CAP 413 wording. Use British English. ' +
      'Structure: a two-sentence overall verdict; then "What to fix" with the three most important points (each: what happened, why it matters, the exact wording to use); ' +
      'then "Good habits" with one or two things done well; then a one-line "Next session" suggestion. No more than 350 words. Plain text with simple headings.';
    const msgs = [{ role: 'user', content: `Scenario: ${scenario.title} (${ctx.unit} ${ctx.freq}). Aircraft ${ctx.reg} (${ctx.abbr}), ${ctx.type}, ${ctx.transponder ? 'Mode S' : 'no transponder'}.\nScores: ${JSON.stringify(stats)}\n\nSession log:\n${lines}` }];
    // Sonnet 5 thinks unless told otherwise, inside the same max_tokens as its answer: at 900 the thinking could use
    // the lot and leave the debrief cut off, or empty. Low effort is plenty for 350 words, with room to finish them.
    return this.call(this.models.debrief, system, msgs, { maxTokens: 4000, timeout: this.timeouts.debrief, extra: { output_config: { effort: 'low' } } });
  }
}

function fmt(t) { const m = Math.floor(t / 60), s = t % 60; return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`; }
