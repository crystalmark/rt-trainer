# RT Trainer

Radio telephony practice for UK VFR pilots. A scripted controller talks to you through your
phone or laptop; you hold a push-to-talk button and answer out loud. It listens for exact
readbacks, corrects you the way ATC does ("negative, QNH 1017", "please confirm you will not
enter controlled airspace"), fills the frequency with other traffic, and debriefs you at the end.

Built for G-CLHP (flexwing, no transponder) and G-CZIA (QuikR, Mode S/C); both editable in the app.

## Scenarios

| Scenario | Unit | What it drills |
|---|---|---|
| Leeds zone transit | Leeds Radar 134.580 | Salts Mill → Eccup Reservoir. Clearance readbacks, delays, orbits, traffic info, QNH changes, and refusals ("remain outside controlled airspace" / "confirm you will not enter controlled airspace"). Different handling with and without a transponder. |
| Leeds Basic Service | Leeds Radar 134.580 | Skirting the west of the zone. Mostly listening; boundary warnings; position requests. |
| Edinburgh zone transit | Edinburgh Approach 121.205 | Musselburgh → Kirkcaldy Harbour. Holding outside, asking for height over the Forth, hand-off to Scottish Information. |
| Carlisle arrival | Carlisle Radio 123.605 | Air/Ground: no clearances. Overhead join and circuit calls. One run in four the radio isn't staffed and you must switch to "Carlisle Traffic" blind calls. |
| Carlisle from the south | London Information 125.475, then Carlisle Radio 123.605 | Up the Eden valley from Oxenhope on a Basic Service from a FISO (no radar, so traffic information is only what others report), then Air/Ground at Carlisle. The operator asks how you'd like to join and you fly what you choose: overhead, downwind, base or straight in. |
| East Fortune to the Forth bridges | East Fortune Radio 118.755, then Edinburgh Approach 121.205 | Across Edinburgh on a zone transit via Musselburgh, orbits over the three bridges, and home, on the moving map. After an instructor's 2017 recording of the same flight. East Fortune is Air/Ground when someone's on, blind calls when not. |
| Carlisle departure | Carlisle Radio 123.605 | Radio check, taxi and line-up announcements, leaving the ATZ. |
| Scottish Information | 119.875 | Carlisle → East Fortune, ~75 nm. A long listening watch with position reports: the "get on with something else and listen for your callsign" mode. |
| Leeds: your own route | Leeds Radar 134.580 | Any route you describe. See below. |
| Edinburgh: your own route | Edinburgh Approach 121.205 | The same, around the Edinburgh CTR: a 10 nm circle, surface to 6000 ft, with the CTAs tiling the ring outside it. |
| Manchester: your own route | Manchester Radar 118.580 | The same, around one of the biggest Class D zones in the country, with the North West Transit Corridor down its western side. |
| Listen out | Any of the above units | No calls to make: sit on the frequency and listen to the traffic. |

## Your own route (Leeds, Edinburgh, Manchester)

Pick an area's **your own route** card and describe the flight, e.g. “Skipton to Wetherby via Salts Mill and Eccup
Reservoir at 2800 ft” (or arrows, or commas). The app lays it over the Leeds airspace at your altitude and tells
you what ATC will make of it: where you enter and leave controlled airspace, the point you'll be cleared via, the
points you'll report, and anything you pass close underneath (“CTA 3, base 3000 ft: only 200 ft above you”). Typos
are forgiven (“Riddlesdon”), and names it doesn't know are flagged with suggestions; tap a place in the list to add it.

A route through the zone becomes a transit, with the same checks and surprises as the scripted one; a route that
stays outside becomes a Basic Service flight with a warning if you pass close to the boundary. The aircraft moves
along the route the whole time (in real time while anyone is talking), holds outside the zone until you're
cleared, and the flight screen shows your altitude, QNH, the next waypoint and the time to it.

Routes must start and finish outside controlled airspace, at least 4 nm before it, below the transition altitude
(5000 ft, or 6000 ft at Edinburgh). The airport itself isn't a destination yet.

Each area is transcribed point for point from the UK AIP, and the differences between them are the point:

- **Edinburgh** publishes its CTR as a plain circle, 10 nm around the airport, surface to 6000 ft, with CTA bases
  of 2500 ft north-east and west and 3500 ft north-west and south. Every CTA arc runs anti-clockwise, because
  they tile the ring outside that circle.
- **Manchester** has no arcs at all, a CTR that reaches from Glossop to Knutsford, and CTA bases stepping down
  through 3000, 2500, 2000 and 1500 ft. Above it all sits the TMA, **Class A** — the app refuses to plan through
  that rather than offering you a VFR transit nobody could give you.
- The **Manchester Low Level Route no longer exists**: it was withdrawn on 20 February 2025 and replaced by the
  North West Transit Corridor (EGR323), which is **Class G** from the surface to 1500 ft. So a route down the
  corridor below 1500 ft plans as an ordinary flight outside controlled airspace — no clearance, nobody to call —
  which is exactly what it now is. At 2400 ft the same route is refused: that's CTA 6, Class D.

### The map
The briefing shows your route on a map drawn from the same data (no map tiles, so it works offline): the zone and
CTAs with their bases, VRPs (purple triangles), landmarks, the airport's runways and ATZ, and your route in magenta.
In flight it becomes a moving map with the track you've flown: track-up (TRK) or north-up (N), zoom, drag to look
around (⌖ brings you back). **Log** swaps it for the radio log.

### Changing the route in flight
Tap a place on the map: **Direct to** skips ahead to it (or detours via it and carries on), **Divert** makes it your
destination, and **Orbit** holds you where you are. Then tell ATC, as you would in the air. Outside controlled
airspace you turn straight away and the controller re-clears you or carries on with a Basic Service. Cleared inside
it, the new route shows dashed and you keep to your clearance until they approve (“roger, route direct Wetherby…”)
or say “unable, continue as cleared”. Before your first call it simply re-plans.

## Listening out

Pick **Listen out**, choose a frequency and press on. Nothing is expected of you: the traffic talks, you listen.
Good for getting a unit's rhythm into your ear, or leaving on while you do something else. Turn *Other traffic* up
for a busy frequency, and turn the text on if you want to check what you heard.

## Using it

1. Open it in **Chrome** (Pixel or MacBook). Speech recognition is Chrome-only.
2. Pick aircraft and scenario, set traffic and flight-time speed, then **Brief me** → **Start flight**.
3. **Hold** the big button (or the space bar) to transmit. Press, pause a beat, speak, release.
4. **Do as you're told, not just say it.** Tap the transponder to set a squawk or press IDENT, and press *Orbit* on
   the map when told to orbit. Read a squawk back and leave the box on 7000 and you'll be chased for it, then asked
   to reset it and ident, exactly as happens in the air.
5. Use headphones so the controller's voice doesn't reach the mic.
6. **Controller voice**: each unit gets its own voice, so Leeds and Edinburgh sound like different people. Pick one
   to use everywhere instead, and press *Hear it* to compare.
7. **End & debrief** at any time. The debrief lists every call, what was missing, the better wording, and anything
   you read back but never did.

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
npm run serve            # then open http://localhost:8080 (never cached, so reloads pick up changes)
```

The microphone only works on `https://` or `http://localhost`. To test on the Pixel before
deploying, use Chrome remote debugging port-forwarding (`chrome://inspect` → Port forwarding
8080 → localhost:8080) and open `http://localhost:8080` on the phone.

## Deploying

Plain static files, no build step, all paths relative. It's served at `https://crystalmark.co.uk/rt/` from the
site's S3 bucket through CloudFront: `deploy/deploy.sh` publishes it (after a one-off `deploy/cloudfront.sh`).
See `docs/deploy.md`.

## Known limits
- Chrome's speech recognition runs on Google's servers, so transmitting needs data signal. It is also poor at the
  words that matter most: “squawk” often comes back as “escort” or “squat”, and the phonetic alphabet wanders. Three
  things make up for it: every transcript Chrome offers is matched against what the controller is expecting, not
  just the first; the common mishearings are folded back (“escort” → “squawk”, “alfie” → Alpha); and hesitation
  sounds (er, erm, uh) are ignored. The debrief says when it took a different guess, and counts the ers.
- The synthesised voices can't be band-limited like a real radio; static and squelch clicks go around them. The
  noise and the voice come out of different audio paths and can't be mixed, so on some devices (Android especially)
  the voice is much quieter than the noise: *Radio noise* has Off, Quiet and Normal, and Quiet is the default.
- Voice quality depends on the device. The app ranks the voices it finds (British first, Chrome's “Google UK English”
  and any enhanced/premium version preferred), never uses the novelty voices macOS ships, and gives each unit its own.
  On a Mac, Apple offers Oliver, Kate and Serena as downloads under System Settings → Accessibility → Spoken Content →
  System voice; they are far better than the compact Daniel. Restart Chrome afterwards to see them.
- No regional accents are available: Chrome's British voices and Apple's are all standard English, and Apple's Scottish
  voice was dropped years ago. A soft Scottish Edinburgh or a Yorkshire Leeds would need a speech API.
- Long transmissions are spoken a clause at a time, because Chrome cuts an utterance off after about fifteen seconds.
- On Android, keep the screen on (the app requests a wake lock). A locked phone suspends speech.
- Squawk codes, pressures and traffic are illustrative. Check the AIP and NOTAMs before flying.

## Sources
- CAA SafetySense 22 Radiotelephony (July 2026), CAP 413
- UK AIP AD 2 EGNM (Leeds Bradford) and EGPH (Edinburgh); ENR 2.1 for the Leeds CTAs (AIRAC 3 September 2026)
- UK VRP dataset, NATS AIS digital datasets (AIRAC 3 September 2026; usage unrestricted). Since October 2025 VRPs
  are published here rather than in each aerodrome's AD 2 entry: Keighley is no longer a Leeds VRP.
- Landmark positions: GeoNames (CC BY 4.0), via the Open-Meteo geocoder
- Carlisle Lake District Airport airfield information; Flexwing Scotland airfield cards
