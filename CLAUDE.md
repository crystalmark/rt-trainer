# RT Trainer: notes for Claude Code

Radio-telephony practice web app for a UK microlight pilot (Tim). Static site, vanilla ES modules,
no build step, no dependencies. Target browsers: Chrome on Android (Pixel) and macOS.

## Architecture
- `js/normalize.js`: turns speech-recognition text and scenario patterns into one token stream
  (spoken numbers → digits, phonetic alphabet → letters, "3,000 ft" → "3000 feet"). Also
  `speakable()` for text-to-speech (QNH digit by digit, "three thousand feet", "decimal").
  It also folds what the recogniser mishears (“escort”/“squat” → squawk, odd spellings of the alphabet) and drops
  hesitation (`HESITATION`). Add new mishearings here with a test, rather than loosening the readback items.
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
  `s.chance(p)`, `s.setRadio({ qnh })`, `s.note(text)`, `s.end(summary)`.
  Instructions that need doing, not just saying, use `s.action({ id, action, value, cue, done, nudge, timeout })`:
  it waits for `done()`, chases with `nudge`, and logs `action` / `late-action` / `no-action` for the debrief.
  The pilot's own state lives in the engine: `s.squawk()`, `s.identedWithin(sec)`, `s.orbiting()`, set from the UI
  by `engine.setSquawk(code)`, `engine.ident()`, `engine.setOrbit(on)`. `useSquawk(s, code)` in common.js is the
  standard "set the code ATC gave you" step, ending in "reset squawk … and ident" if it never appears.
  `js/scenarios/listen.js` is the listen-out session: no expectations, the traffic loop does the talking.
  Templates: `{CS}` full callsign, `{AB}` abbreviated, `{CALL}` whichever ATC is currently using,
  `{TYPE}`, `{UNIT}`, `{SIM}` a confusable callsign. Build items with `P()` and helpers in `common.js`.
  Always branch on `ctx.transponder` where handling differs.
- `js/ptt.js` asks for five alternative transcripts and hands them all over; `engine.bestMatch()` scores every one
  against the items expected and keeps the closest, recording the first as `heard` for the debrief.
- `js/radio.js` (speech synthesis + Web Audio squelch/static/heterodyne). Voices are ranked by `voiceChoices()`
  (British first, Google/enhanced/premium preferred) and macOS novelty voices are excluded, or ATC ends up sounding
  like Zarvox. Radio noise has three levels and must stay well under the voice: the speech synthesiser can't be
  routed through Web Audio, so on Android the voice is much quieter than anything Web Audio plays.
  Each unit gets its own controller voice (`voiceForUnit`, fixed by unit name, changed by `setUnit` when
  the frequency changes); the pilot can pin one voice for every controller in the setup screen. Transmissions are spoken a clause at a time: Chrome cuts an
  utterance off after about 15 s. `js/ptt.js`
  (hold-to-talk, Web Speech API, hot-mic detector), `js/claude.js` (browser calls to the
  Anthropic API), `js/debrief.js` (stats + issues), `js/main.js` (UI).
- Your own route: `js/areas/<area>.js` holds an area's airspace (copied point for point from the AIP, arcs
  included), VRPs (`js/data/vrps.js`, generated from the NATS dataset) with radio names and `hear` variants for
  speech recognition, and landmarks. `js/geo.js` puts it all on a flat nm grid; `js/route.js` parses a described
  route and plans it (entry/exit at the altitude, the "via" point, reports, CTAs close overhead);
  `js/scenarios/custom.js` turns the plan into a transit or a Basic Service flight. The engine flies it with
  `s.fly(plan)`, `s.reach(nm)`, `s.hold(nm)`, `s.position()`: continuous movement (real time while anyone is
  talking), `nav` events once a second and `route` events for the flight screen.
- `js/map.js`: the moving map, SVG drawn from the area data (symbols sized in pixels; track-up/north-up, drag, tap to
  pick a place). Route changes in flight: `engine.changeRoute({ action: 'direct' | 'divert', place })` asks the
  scenario's `routeChange()` for the new plan (turn now, or wait for ATC's approval when cleared inside controlled
  airspace), unwinds the script with a `Reroute`, and the scenario's `resume()` picks up from its own record of how
  far the flight has got. `engine.setOrbit(on)` holds the aircraft. Only the scenario's own waits take an abort;
  background traffic sleeps with `abortable = false`.

## Conventions
- UK CAP 413 phraseology only. Read CAA SafetySense 22 (July 2026) before changing wording.
- Every new scenario must pass the "perfect pilot" test for both aircraft profiles and several seeds
  (`tests/engine.test.mjs` does this automatically for everything in `SCENARIOS`).
- Frequencies/VRPs must come from the UK AIP or the airfield; squawks and pressures may be invented. VRPs now
  live only in the NATS VRP dataset, not in AD 2: regenerate `js/data/vrps.js` each AIRAC cycle with
  `node scripts/vrps.mjs <csv>`, and never call a landmark a VRP.
- A new area needs its AIP airspace, radio names for its VRPs, landmarks, and its perfect-pilot routes in
  `tests/custom.test.mjs`.
- Keep the engine DOM-free so it stays testable in Node.
- crystalmark.co.uk is one browser origin shared with Flight Log and Pollyglot: service-worker caches are named and
  cleared by the `rt-trainer-` prefix, localStorage keys start `rt.`. New JS files go in `FILES` in `sw.js` (tested).

## Commands
- `npm test`: Node test runner (no install needed).
- `npm run serve`: serve locally on http://localhost:8080, never cached; the microphone needs localhost or HTTPS.
- `deploy/deploy.sh`: tests, then publish to https://crystalmark.co.uk/rt/ (S3 + CloudFront, not the Lightsail box;
  see docs/deploy.md). `--dryrun` to preview.
- `node scripts/vrps.mjs <EG_VRP_DS_AREA1_FULL_yyyymmdd.csv>`: refresh the VRPs from the NATS dataset
  (nats-uk.ead-it.com → Publications → Digital datasets → VRP).

## Ideas / backlog
- More things to do rather than say: set the altitude you were cleared to, turn onto a heading.
- Listen out covers the four scripted units; add each new area's unit as it arrives.
- More areas for your own route: Manchester (EGCC VRPs are already in `js/data/vrps.js`; the Low Level Route),
  Edinburgh (EGPH), York (Leeds East EGCM VRPs; Humberside, Linton/Leeming).
- Change altitude in flight, and have ATC react if you climb into a CTA without a clearance.
- Import a SkyDemon route (need a sample export to see the format); unknown place names via the geocoder.
- Routes over the airport: have ATC route you round it rather than just warning in the briefing.
- If the microphone is refused, still fly the scenario listen-only instead of failing to start.
- London Information scenario for Yorkshire local flying (confirm the frequency for the sector first).
- Better radio audio: synthesise through an API and band-limit it in Web Audio for a proper VHF sound (the browser's
  own voices can't be routed through Web Audio). It is also the only way to get regional accents: nothing in Chrome or
  macOS offers a Scottish or Yorkshire voice.
- Bluetooth hardware PTT (a BLE remote mapped to a key).
- Server-side key proxy on crystalmark.co.uk (see docs/deploy.md).
- Record sessions and replay your own audio in the debrief.
