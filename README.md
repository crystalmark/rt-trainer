# RT Trainer

Radio telephony practice for UK VFR pilots. A scripted controller talks to you through your
phone or laptop; you hold a push-to-talk button and answer out loud. It listens for exact
readbacks, corrects you the way ATC does ("negative, QNH 1017", "please confirm you will not
enter controlled airspace"), fills the frequency with other traffic, and debriefs you at the end.

Built for G-CLHP (flexwing, no transponder) and G-CZIA (QuikR, Mode S/C); both editable in the app.

## Scenarios

| Scenario | Unit | What it drills |
|---|---|---|
| Leeds zone transit | Leeds Radar 134.580 | Keighley → Eccup Reservoir. Clearance readbacks, delays, orbits, traffic info, QNH changes, and refusals ("remain outside controlled airspace" / "confirm you will not enter controlled airspace"). Different handling with and without a transponder. |
| Leeds Basic Service | Leeds Radar 134.580 | Skirting the west of the zone. Mostly listening; boundary warnings; position requests. |
| Edinburgh zone transit | Edinburgh Approach 121.205 | Musselburgh → Kirkcaldy Harbour. Holding outside, asking for height over the Forth, hand-off to Scottish Information. |
| Carlisle arrival | Carlisle Radio 123.605 | Air/Ground: no clearances. Overhead join and circuit calls. One run in four the radio isn't staffed and you must switch to "Carlisle Traffic" blind calls. |
| Carlisle departure | Carlisle Radio 123.605 | Radio check, taxi and line-up announcements, leaving the ATZ. |
| Scottish Information | 119.875 | Carlisle → East Fortune, ~75 nm. A long listening watch with position reports: the "get on with something else and listen for your callsign" mode. |

## Using it

1. Open it in **Chrome** (Pixel or MacBook). Speech recognition is Chrome-only.
2. Pick aircraft and scenario, set traffic and flight-time speed, then **Brief me** → **Start flight**.
3. **Hold** the big button (or the space bar) to transmit. Press, pause a beat, speak, release.
4. Use headphones so the controller's voice doesn't reach the mic.
5. **End & debrief** at any time. The debrief lists every call, what was missing, and the better wording.

### What the controller does
- Checks readbacks item by item (level, pressure, squawk, route, frequency, service, "wilco").
- One wrong item → "negative, QNH 1017". Several → "negative, I say again, …". Nothing useful → "read back the clearance".
- No reply within ~9 s of the frequency going quiet → repeats, then "how do you read?".
- Reporting points: if you don't call, you get chased ("report your position").
- You key while someone is talking → heterodyne squeal, your call is lost, "blocked, say again".
- You call in the middle of someone else's exchange → "standby", then "pass your message".
- A similar callsign (e.g. G-HT when you're G-HP) gets an instruction; answer it and you'll hear "negative, that was for G-HT".
- You talk without pressing PTT → flagged "not transmitted" (optional warning; always in the debrief).

### Going off script (needs a Claude API key)
Ask for something the script doesn't cover ("request diversion to Sherburn due weather") and
Claude takes over as the controller for the rest of the session. Replies take 1–3 s instead of
instant. Claude also writes an instructor-style debrief at the end.

The key lives only in the browser's localStorage and is sent directly to `api.anthropic.com`.
That's fine on your own phone; don't enter it on a shared device. If you'd rather not keep it in
the browser, the next step is a small proxy on crystalmark.co.uk (see CLAUDE.md).

## Running locally

```sh
npm test                 # engine, matcher and scenario tests (Node 20+)
python3 -m http.server 8080   # then open http://localhost:8080
```

The microphone only works on `https://` or `http://localhost`. To test on the Pixel before
deploying, use Chrome remote debugging port-forwarding (`chrome://inspect` → Port forwarding
8080 → localhost:8080) and open `http://localhost:8080` on the phone.

## Deploying

Plain static files, no build step, all paths relative. It's served at `https://crystalmark.co.uk/rt/` from the
site's S3 bucket through CloudFront: `deploy/deploy.sh` publishes it (after a one-off `deploy/cloudfront.sh`).
See `docs/deploy.md`.

## Known limits
- Chrome's speech recognition runs on Google's servers, so transmitting needs data signal.
- The synthesised voices can't be band-limited like a real radio; static and squelch clicks go around them. Voice quality depends on the voices installed on the device.
- On Android, keep the screen on (the app requests a wake lock). A locked phone suspends speech.
- Squawk codes, pressures and traffic are illustrative. Check the AIP and NOTAMs before flying.

## Sources
- CAA SafetySense 22 Radiotelephony (July 2026), CAP 413
- UK AIP AD 2 EGNM (Leeds Bradford) and EGPH (Edinburgh)
- Carlisle Lake District Airport airfield information; Flexwing Scotland airfield cards
