// Listen out: sit on a frequency and hear the traffic, with nothing expected of you. Good for getting the rhythm
// and the phraseology of a unit into your ear before you fly it, or while you get on with something else.
import { leedsTraffic, edinburghTraffic, scottishTraffic, carlisleTraffic } from './common.js';

export const LISTEN_UNITS = [
  { id: 'leeds', unit: 'Leeds Radar', freq: '134.580', traffic: leedsTraffic,
    about: 'Airliners being vectored onto the ILS, GA transits and the odd police helicopter.' },
  { id: 'edinburgh', unit: 'Edinburgh Approach', freq: '121.205', traffic: edinburghTraffic,
    about: 'Jets on approach, and zone transits across the Forth.' },
  { id: 'carlisle', unit: 'Carlisle Radio', freq: '123.605', traffic: carlisleTraffic,
    about: 'Air/Ground: circuit calls and taxi calls, information rather than instructions.' },
  { id: 'scottish', unit: 'Scottish Information', freq: '119.875', traffic: scottishTraffic,
    about: 'Basic Service over a wide area: long gaps, position reports, the odd flight information broadcast.' },
];

/** A session that only listens: the engine's traffic does all the talking until you stop it. */
export function listenScenario(id) {
  const u = LISTEN_UNITS.find(x => x.id === id) || LISTEN_UNITS[0];
  return {
    id: `listen-${u.id}`,
    listen: true,
    title: `Listen out: ${u.unit}`,
    subtitle: `${u.freq} · nothing expected of you`,
    unit: u.unit,
    freq: u.freq,
    traffic: u.traffic,
    briefing: () => [
      ['Listening', `${u.unit} ${u.freq}. No calls to make, nothing to read back.`],
      ['Expect', u.about],
      ['Traffic', 'Set “Other traffic” to busy for a packed frequency, or quiet for the long gaps you get in the real thing.'],
      ['Text', 'Turn the text on if you want to check what you heard.'],
      ['Finish', 'End whenever you have had enough.'],
    ],
    async run(s) {
      s.at('Listening out', `Listening out on ${u.unit} ${u.freq}. Nothing is expected of you.`);
      for (;;) await s.pause(600);
    },
  };
}
