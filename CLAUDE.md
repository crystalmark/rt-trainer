# RT Trainer: notes for Claude Code

Radio-telephony practice web app for a UK microlight pilot (Tim). Static site, vanilla ES modules,
no build step, no dependencies. Target browsers: Chrome on Android (Pixel) and macOS.

## Architecture
- `js/normalize.js`: turns speech-recognition text and scenario patterns into one token stream
  (spoken numbers → digits, phonetic alphabet → letters, "3,000 ft" → "3000 feet"). Also
  `speakable()` for text-to-speech (QNH digit by digit, "three thousand feet", "decimal").
- `js/matcher.js`: `match(text, spec, ctx)` checks a transmission against readback items and
  returns missing hard/soft items, substitutions ("zone" for "controlled airspace"), order,
  fillers and a 0–100 score.
- `js/engine.js`: the scenario runner. Pure logic, DOM-free, driven through adapters:
  `radio.say/busy/interrupt`, `clock.now/sleep/tick`, `rng`, optional `claude`. It handles
  readbacks + corrections, missed calls, late reports, blocked transmissions, stepping into
  another exchange, similar-callsign traps, background traffic, and hands over to Claude
  (`freeMode`) when the pilot goes off script.
- `js/scenarios/*.js`: each scenario is `{ id, title, unit, freq, briefing(ctx), traffic(s), warn?, run(s) }`.
  `run` is an async script using the scenario API: `s.atc(text, { readback, model, clearance, reply })`,
  `s.expect({ id, cue, items, nudge, optional, initial, model })`, `s.leg(label, nm, { cue })`,
  `s.chance(p)`, `s.setRadio({ squawk })`, `s.note(text)`, `s.end(summary)`.
  Templates: `{CS}` full callsign, `{AB}` abbreviated, `{CALL}` whichever ATC is currently using,
  `{TYPE}`, `{UNIT}`, `{SIM}` a confusable callsign. Build items with `P()` and helpers in `common.js`.
  Always branch on `ctx.transponder` where handling differs.
- `js/radio.js` (speech synthesis + Web Audio squelch/static/heterodyne), `js/ptt.js`
  (hold-to-talk, Web Speech API, hot-mic detector), `js/claude.js` (browser calls to the
  Anthropic API), `js/debrief.js` (stats + issues), `js/main.js` (UI).

## Conventions
- UK CAP 413 phraseology only. Read CAA SafetySense 22 (July 2026) before changing wording.
- Every new scenario must pass the "perfect pilot" test for both aircraft profiles and several seeds
  (`tests/engine.test.mjs` does this automatically for everything in `SCENARIOS`).
- Frequencies/VRPs must come from the UK AIP or the airfield; squawks and pressures may be invented.
- Keep the engine DOM-free so it stays testable in Node.

## Commands
- `npm test`: Node test runner (no install needed).
- `python3 -m http.server 8080`: serve locally; microphone needs localhost or HTTPS.

## Ideas / backlog
- London Information scenario for Yorkshire local flying (confirm the frequency for the sector first).
- Bluetooth hardware PTT (a BLE remote mapped to a key).
- Server-side key proxy on crystalmark.co.uk (see docs/deploy.md).
- Use speech-recognition alternatives (`maxAlternatives`) to pick the best-matching transcript.
- Record sessions and replay your own audio in the debrief.
