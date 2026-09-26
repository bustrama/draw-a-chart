/**
 * The futures the app offers: continuous front-month contracts (the data provider rolls to the
 * next contract, so prices jump at each roll, like TradingView's ES1!). All of them trade CME
 * Globex hours (shared/sessions.ts `globexSessions`); grains and Treasuries, which do not (or quote
 * in 32nds), are left out, and so is Micro WTI (Yahoo has no daily history for it; CL has the
 * same prices).
 */
export interface FuturesContract {
  readonly symbol: string;
  readonly name: string;
  readonly exchange: string;
  /** Yahoo Finance's continuous front-month ticker. */
  readonly yahoo: string;
  /** First trade date Yahoo has data for (`YYYY-MM-DD`): it answers anything older with an error. */
  readonly dataFrom: string;
  /** Price step (tick). */
  readonly minMove: number;
  readonly pricePrecision: number;
}

export const FUTURES: readonly FuturesContract[] = [
  { symbol: 'ES', name: 'E-mini S&P 500', exchange: 'CME', yahoo: 'ES=F', dataFrom: '2000-09-18', minMove: 0.25, pricePrecision: 2 },
  { symbol: 'MES', name: 'Micro E-mini S&P 500', exchange: 'CME', yahoo: 'MES=F', dataFrom: '2019-05-03', minMove: 0.25, pricePrecision: 2 },
  { symbol: 'NQ', name: 'E-mini Nasdaq-100', exchange: 'CME', yahoo: 'NQ=F', dataFrom: '2000-09-18', minMove: 0.25, pricePrecision: 2 },
  { symbol: 'MNQ', name: 'Micro E-mini Nasdaq-100', exchange: 'CME', yahoo: 'MNQ=F', dataFrom: '2019-05-03', minMove: 0.25, pricePrecision: 2 },
  { symbol: 'YM', name: 'E-mini Dow', exchange: 'CBOT', yahoo: 'YM=F', dataFrom: '2002-04-05', minMove: 1, pricePrecision: 0 },
  { symbol: 'MYM', name: 'Micro E-mini Dow', exchange: 'CBOT', yahoo: 'MYM=F', dataFrom: '2019-05-03', minMove: 1, pricePrecision: 0 },
  { symbol: 'RTY', name: 'E-mini Russell 2000', exchange: 'CME', yahoo: 'RTY=F', dataFrom: '2017-07-10', minMove: 0.1, pricePrecision: 1 },
  { symbol: 'M2K', name: 'Micro E-mini Russell 2000', exchange: 'CME', yahoo: 'M2K=F', dataFrom: '2019-05-03', minMove: 0.1, pricePrecision: 1 },
  { symbol: 'CL', name: 'Crude Oil (WTI)', exchange: 'NYMEX', yahoo: 'CL=F', dataFrom: '2000-08-23', minMove: 0.01, pricePrecision: 2 },
  { symbol: 'NG', name: 'Natural Gas', exchange: 'NYMEX', yahoo: 'NG=F', dataFrom: '2000-08-30', minMove: 0.001, pricePrecision: 3 },
  { symbol: 'GC', name: 'Gold', exchange: 'COMEX', yahoo: 'GC=F', dataFrom: '2000-08-30', minMove: 0.1, pricePrecision: 1 },
  { symbol: 'MGC', name: 'Micro Gold', exchange: 'COMEX', yahoo: 'MGC=F', dataFrom: '2010-10-04', minMove: 0.1, pricePrecision: 1 },
  { symbol: 'SI', name: 'Silver', exchange: 'COMEX', yahoo: 'SI=F', dataFrom: '2000-08-30', minMove: 0.005, pricePrecision: 3 },
  { symbol: 'HG', name: 'Copper', exchange: 'COMEX', yahoo: 'HG=F', dataFrom: '2000-08-30', minMove: 0.0005, pricePrecision: 4 },
  { symbol: '6E', name: 'Euro FX', exchange: 'CME', yahoo: '6E=F', dataFrom: '2000-09-12', minMove: 0.00005, pricePrecision: 5 },
];

export const FUTURES_BY_SYMBOL: ReadonlyMap<string, FuturesContract> = new Map(FUTURES.map((c) => [c.symbol, c]));
