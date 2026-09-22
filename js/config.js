// Aircraft profiles. Edit here or in the app's setup screen (saved in the browser).
export const PROFILES = [
  { id: 'clhp', reg: 'G-CLHP', type: 'flexwing microlight', transponder: false, speedKt: 45, note: 'Fox 13T / Peabee trike, no transponder' },
  { id: 'czia', reg: 'G-CZIA', type: 'QuikR microlight', transponder: true, speedKt: 65, note: 'P&M QuikR, Mode S / C transponder' },
];

export const MODELS = {
  atc: 'claude-haiku-4-5-20251001',   // fast replies when you go off script
  debrief: 'claude-sonnet-5',          // end-of-session analysis
};
