// Shared Yahoo Finance fetch helpers for the RS screener.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UNIVERSE_FILE = path.join(ROOT, 'rs_universe.json');
const DATA_FILE = path.join(ROOT, 'data.json');
const CONCURRENCY = 8;

function loadUniverse() {
  return JSON.parse(fs.readFileSync(UNIVERSE_FILE, 'utf8')).universe;
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { qqq: {}, updated: {}, tickers: {} };
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + '\n');
}

async function fetchChart(symbol, params) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?${params}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`${symbol}: no chart result`);
  return result;
}

async function pool(items, worker, concurrency = CONCURRENCY) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      try { results[i] = { ok: true, value: await worker(items[i]) }; }
      catch (e) { results[i] = { ok: false, error: e.message }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

// Current local time in America/Los_Angeles as a decimal hour (e.g. 6:31am -> 6.5166...)
function ptNowDecimalHour() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour12: false,
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    weekday: 'short',
  }).formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t)?.value;
  const hour = parseInt(get('hour'), 10) % 24;
  const minute = parseInt(get('minute'), 10);
  const second = parseInt(get('second'), 10);
  return { decimalHour: hour + minute / 60 + second / 3600, weekday: get('weekday') };
}

function ptDateString() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date()); // YYYY-MM-DD
}

module.exports = { loadUniverse, loadData, saveData, fetchChart, pool, ptNowDecimalHour, ptDateString };
