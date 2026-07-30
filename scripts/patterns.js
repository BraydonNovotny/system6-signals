// Re-exports the canonical pattern-detection logic from the shared strategy-core submodule --
// see vendor/strategy-core/patterns.js. Do NOT duplicate logic here; update the submodule
// instead so ll_backtest and system6-signals can never silently drift apart again.
module.exports = require('../vendor/strategy-core/patterns.js');
