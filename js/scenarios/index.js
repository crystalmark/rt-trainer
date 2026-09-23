import leedsTransit from './leeds-transit.js';
import leedsBasic from './leeds-basic.js';
import edinburghTransit from './edinburgh-transit.js';
import { carlisleArrival, carlisleSouth, carlisleDeparture } from './carlisle.js';
import { forthBridges } from './forth-bridges.js';
import scottishInfo from './scottish-info.js';

export const SCENARIOS = [leedsTransit, leedsBasic, edinburghTransit, forthBridges, carlisleArrival, carlisleSouth, carlisleDeparture, scottishInfo];
