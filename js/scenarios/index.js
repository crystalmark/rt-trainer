import leedsTransit from './leeds-transit.js';
import leedsBasic from './leeds-basic.js';
import edinburghTransit from './edinburgh-transit.js';
import { carlisleArrival, carlisleDeparture } from './carlisle.js';
import scottishInfo from './scottish-info.js';

export const SCENARIOS = [leedsTransit, leedsBasic, edinburghTransit, carlisleArrival, carlisleDeparture, scottishInfo];
