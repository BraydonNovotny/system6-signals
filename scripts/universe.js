const fs = require('fs');
const path = require('path');
function loadTickers() {
  return fs.readFileSync(path.join(__dirname, '..', 'all_tickers.txt'), 'utf8')
    .trim().split(/\r?\n/).filter(Boolean);
}
module.exports = { loadTickers };
