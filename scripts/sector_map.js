// Best-effort GICS-sector-via-SPDR-ETF classification for the full 233-ticker universe.
// Ported from ll_backtest/sector_map_extended.js + engine.js's base SECTOR_ETF, merged
// into one self-contained map (no cross-repo dependency).
const BASE = {
  AAL: 'XLI', AAPL: 'XLK', ABT: 'XLV', ALAB: 'XLK', AMAT: 'XLK', AMD: 'XLK', ANET: 'XLK',
  APH: 'XLK', APP: 'XLC', ARM: 'XLK', AUR: 'XLK', AVGO: 'XLK', BKNG: 'XLY', CMG: 'XLY',
  CPNG: 'XLY', CRDO: 'XLK', CRWD: 'XLK', CSCO: 'XLK', DASH: 'XLY', DDOG: 'XLK', DELL: 'XLK',
  DKNG: 'XLY', FCEL: 'XLE', FIG: 'XLK', FLEX: 'XLK', GLW: 'XLK', HIMS: 'XLV', HOOD: 'XLF',
  HPE: 'XLK', HPQ: 'XLK', IBM: 'XLK', JBLU: 'XLI', KDP: 'XLP', KHC: 'XLP', KLAC: 'XLK',
  LRCX: 'XLK', LYFT: 'XLC', MDLN: 'XLV', META: 'XLC', MRNA: 'XLV', MRVL: 'XLK', MU: 'XLK',
  NBIS: 'XLK', NCLH: 'XLY', NOW: 'XLK', NVDA: 'XLK', OPEN: 'XLF', PANW: 'XLK', PATH: 'XLK',
  PINS: 'XLC', PYPL: 'XLK', RBLX: 'XLC', RIVN: 'XLY', SHOP: 'XLK', SNDK: 'XLK', SNOW: 'XLK',
  SOFI: 'XLF', TOST: 'XLK', TSLA: 'XLY', TSM: 'XLK', TXN: 'XLK', U: 'XLC', UAL: 'XLI',
  UBER: 'XLY', VRT: 'XLI', WDAY: 'XLK', WDC: 'XLK',
};
const EXT = {
  AAL:'XLI', ABBV:'XLV', ABNB:'XLY', ABT:'XLV', AES:'XLU', AIG:'XLF', AMZN:'XLY', APA:'XLE',
  APH:'XLK', BAC:'XLF', BA:'XLI', BKNG:'XLY', BKR:'XLE', BMY:'XLV', BSX:'XLV', CARR:'XLI',
  CCL:'XLY', CEG:'XLU', CFG:'XLF', CMCSA:'XLC', CNC:'XLV', COHR:'XLK', COIN:'XLF', COP:'XLE',
  CRM:'XLK', CSX:'XLI', CVNA:'XLY', CVS:'XLV', CVX:'XLE', C:'XLF', DAL:'XLI', DD:'XLB',
  DIS:'XLC', DOW:'XLB', DVN:'XLE', DXCM:'XLV', EA:'XLC', EBAY:'XLY', EQT:'XLE', FCX:'XLB',
  FITB:'XLF', FSLR:'XLK', F:'XLY', GEN:'XLK', GEV:'XLI', GE:'XLI', GILD:'XLV', GM:'XLY',
  GOOGL:'XLC', GOOG:'XLC', HAL:'XLE', IP:'XLB', JPM:'XLF', KEY:'XLF', KMI:'XLE', KR:'XLP',
  KVUE:'XLP', LUV:'XLI', LVS:'XLY', MCHP:'XLK', MGM:'XLY', MOS:'XLB', MPC:'XLE', MRK:'XLV',
  MSTR:'XLK', MS:'XLF', NEE:'XLU', NEM:'XLB', NFLX:'XLC', NKE:'XLY', NXPI:'XLK', ON:'XLK',
  ORCL:'XLK', ORLY:'XLY', OXY:'XLE', PCG:'XLU', PDD:'XLY', PFE:'XLV', PLTR:'XLK', QCOM:'XLK',
  RCL:'XLY', RF:'XLF', RTX:'XLI', SBUX:'XLY', SCHW:'XLF', SLB:'XLE', SMCI:'XLK', SPG:'XLRE',
  STX:'XLK', SYF:'XLF', TER:'XLK', TFC:'XLF', TJX:'XLY', TTD:'XLC', T:'XLC', UNH:'XLV',
  USB:'XLF', VST:'XLU', VTRS:'XLV', WBD:'XLC', WFC:'XLF', WMB:'XLE', WMT:'XLP', WYNN:'XLY',
  XOM:'XLE', XYZ:'XLF',
  MARA:'XLK', NIO:'XLY', RIOT:'XLK', ROKU:'XLC', PLUG:'XLU', GME:'XLY', AFRM:'XLF', IONQ:'XLK',
  WULF:'XLK', CLSK:'XLK', SOUN:'XLK', QBTS:'XLK', OKLO:'XLU', M:'XLY', PTON:'XLY', ASTS:'XLC',
  RGTI:'XLK', BE:'XLU', CLF:'XLB', APLD:'XLK', BBAI:'XLK', UPST:'XLF', CIFR:'XLK', AI:'XLK',
  QS:'XLK', AMC:'XLY', ACHR:'XLI', SMR:'XLU', NVAX:'XLV', NVTS:'XLK', QUBT:'XLK', MP:'XLB',
  JOBY:'XLI', RDDT:'XLC', CRWV:'XLK', ONDS:'XLK', LCID:'XLY', TEM:'XLV', RKT:'XLF', BYND:'XLP',
  RUN:'XLU', CORZ:'XLK', ENPH:'XLK', AA:'XLB', BTBT:'XLK', PENN:'XLY', LUNR:'XLI', SE:'XLY',
  CHWY:'XLY', FSLY:'XLK', GAP:'XLY', OSCR:'XLV', RR:'XLI', RXRX:'XLV', CDE:'XLB',
  INTC:'XLK', MSFT:'XLK', SNAP:'XLC', NET:'XLK', ZM:'XLK', LITE:'XLK', FTNT:'XLK',
  PSKY:'XLC', RKLB:'XLI', ECHO:'XLI',
};
module.exports = { ...BASE, ...EXT };
