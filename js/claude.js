// Optional Claude integration, called straight from the browser with your own API key.
//  - atc():     takes over as the controller once you leave the script (diversion, weather, …)
//  - debrief(): writes the end-of-session instructor debrief
// The key is kept in this browser's localStorage only. See README for the trade-offs.
import { MODELS } from './config.js';

const API = 'https://api.anthropic.com/v1/messages';

export class Claude {
  constructor({ apiKey, models = MODELS }) {
    this.apiKey = apiKey;
    this.models = models;
  }

  async call(model, system, messages, maxTokens = 600) {
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
    });
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return data.content.map(c => c.text || '').join('');
  }

  async atc({ scenario, ctx, events, history, pilot }) {
    const briefing = scenario.briefing ? scenario.briefing(ctx).join(' ') : '';
    const recent = events.filter(e => ['atc', 'pilot', 'traffic', 'position', 'cue', 'note'].includes(e.type))
      .slice(-30).map(e => `[${e.type}${e.speaker && e.speaker !== 'atc' ? ' ' + e.speaker : ''}] ${e.text || e.label || ''}`).join('\n');
    const system = `You are the ${ctx.unit} controller on ${ctx.freq} in a UK radiotelephony training simulator. ` +
      `Speak exactly as a real UK controller would, using CAP 413 phraseology: short, precise, no chit-chat. ` +
      `The pilot is ${ctx.reg} (abbreviated ${ctx.abbr}), a ${ctx.type}, ${ctx.transponder ? 'with a Mode S transponder' : 'with no transponder'}, flying VFR at about ${ctx.speedKt} kt. ` +
      `Scenario: ${scenario.title}. ${briefing} ` +
      (/radio$/i.test(ctx.unit) ? 'You are an Air/Ground operator: you cannot give clearances or instructions, only information. ' : '') +
      (/information$/i.test(ctx.unit) ? 'You are a FISO giving a Basic Service: information only, no clearances. ' : '') +
      `The pilot has left the training script (for example a diversion, weather, a change of plan or an emergency). Handle it realistically: ` +
      `challenge incorrect or incomplete readbacks ("negative…", "read back…"), ask for missing information ("say altitude"), refuse or delay if that is what a real controller would do, ` +
      `and never break character. Use sensible invented values for pressure settings, squawks and traffic. ` +
      `Reply with ONLY a JSON object: {"transmissions": ["what you say on frequency, in order"], "assessment": "one short sentence for the debrief on the pilot's last call against CAP 413", "position": "optional short description of where the aircraft now is", "end": false, "summary": "only when end is true"}. ` +
      `Set end true only when the pilot has left your frequency or landed.`;
    const msgs = [{ role: 'user', content: `Recent frequency log:\n${recent}\n\nThe pilot just transmitted: "${pilot}"\n\nRespond as ${ctx.unit}.` }];
    const text = await this.call(this.models.atc, system, msgs, 400);
    const json = text.match(/\{[\s\S]*\}/);
    if (!json) throw new Error('No JSON from Claude');
    const out = JSON.parse(json[0]);
    if (!Array.isArray(out.transmissions)) out.transmissions = [];
    return out;
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
    return this.call(this.models.debrief, system, msgs, 900);
  }
}

function fmt(t) { const m = Math.floor(t / 60), s = t % 60; return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`; }
