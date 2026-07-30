// Re-exports the canonical indicator implementations from the shared strategy-core submodule --
// see vendor/strategy-core/indicators.js. Do NOT duplicate logic here; update the submodule
// instead so ll_backtest and system6-signals can never silently drift apart again.
module.exports = require('../vendor/strategy-core/indicators.js');
