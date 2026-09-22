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
| Carlisle departure | Carlisle Radio 123.605 | Radio check, taxi and line-up announcements, leaving the ATZ. |
| Scottish Information | 119.875 | Carlisle → East Fortune, ~75 nm. A long listening watch with position reports: the "get on with something else and listen for your callsign" mode. |
| Leeds: your own route | Leeds Radar 134.580 | Any route you describe. See below. |

## Your own route (Leeds so far)

Pick **Leeds: your own route** and describe the flight, e.g. “Skipton to Wetherby via Salts Mill and Eccup
Reservoir at 2800 ft” (or arrows, or commas). The app lays it over the Leeds airspace at your altitude and tells
you what ATC will make of it: where you enter and leave controlled airspace, the point you'll be cleared via, the
points you'll report, and anything you pass close underneath (“CTA 3, base 3000 ft: only 200 ft above you”). Typos
are forgiven (“Riddlesdon”), and names it doesn't know are flagged with suggestions; tap a place in the list to add it.

A route through the zone becomes a transit, with the same checks and surprises as the scripted one; a route that
stays outside becomes a Basic Service flight with a warning if you pass close to the boundary. The aircraft moves
along the route the whole time (in real time while anyone is talking), holds outside the zone until you're
cleared, and the flight screen shows your altitude, QNH, the next waypoint and the time to it.

Routes must start and finish outside controlled airspace, at least 4 nm before it, below the 5000 ft transition
altitude. Leeds Bradford itself isn't a destination yet.

### The map
The briefing shows your route on a map drawn from the same data (no map tiles, so it works offline): the zone and
CTAs with their bases, VRPs (purple triangles), landmarks, Leeds Bradford's runway and ATZ, and your route in magenta.
In flight it becomes a moving map with the track you've flown: track-up (TRK) or north-up (N), zoom, drag to look
around (⌖ brings you back). **Log** swaps it for the radio log.

### Changing the route in flight
Tap a place on the map: **Direct to** skips ahead to it (or detours via it and carries on), **Divert** makes it your
destination, and **Orbit** holds you where you are. Then tell ATC, as you would in the air. Outside controlled
airspace you turn straight away and the controller re-clears you or carries on with a Basic Service. Cleared inside
it, the new route shows dashed and you keep to your clearance until they approve (“roger, route direct Wetherby…”)
or say “unable, continue as cleared”. Before your first call it simply re-plans.

## Using it

1. Open it in **Chrome** (Pixel or MacBook). Speech recognition is Chrome-only.
2. Pick aircraft and scenario, set traffic and flight-time speed, then **Brief me** → **Start flight**.
3. **Hold** the big button (or the space bar) to transmit. Press, pause a beat, speak, release.
4. Use headphones so the controller's voice doesn't reach the mic.
5. **Controller voice**: pick one and press *Hear it*. Other stations use the next voices on the list.
6. **End & debrief** at any time. The debrief lists every call, what was missing, and the better wording.

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
- Chrome's speech recognition runs on Google's servers, so transmitting needs data signal.
- The synthesised voices can't be band-limited like a real radio; static and squelch clicks go around them.
- Voice quality depends on the device. The app ranks the voices it finds (British first, Chrome's “Google UK English”
  and any Enhanced/Premium versions preferred) and never uses the novelty ones macOS ships. On a Mac, fetching the
  Enhanced or Premium version of a voice in System Settings → Accessibility → Spoken Content → Manage Voices is the
  biggest single improvement. Long transmissions are spoken a clause at a time, because Chrome cuts an utterance off
  after about fifteen seconds.
- On Android, keep the screen on (the app requests a wake lock). A locked phone suspends speech.
- Squawk codes, pressures and traffic are illustrative. Check the AIP and NOTAMs before flying.

## Sources
- CAA SafetySense 22 Radiotelephony (July 2026), CAP 413
- UK AIP AD 2 EGNM (Leeds Bradford) and EGPH (Edinburgh); ENR 2.1 for the Leeds CTAs (AIRAC 3 September 2026)
- UK VRP dataset, NATS AIS digital datasets (AIRAC 3 September 2026; usage unrestricted). Since October 2025 VRPs
  are published here rather than in each aerodrome's AD 2 entry: Keighley is no longer a Leeds VRP.
- Landmark positions: GeoNames (CC BY 4.0), via the Open-Meteo geocoder
- Carlisle Lake District Airport airfield information; Flexwing Scotland airfield cards
