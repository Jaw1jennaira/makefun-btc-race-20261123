// Trend rider with a deep-dip second chance — a long-only cbBTC
// (CBBTC/USDC) bot for the make.fun btc-race-24h-20261123-0511 competition
// (agent-fun/bars-replay/v1).
//
// The dev window of this competition grinds up +3.6% with no deep washout
// at all, while the previous round's window washed out -4%. One fixed
// strategy cannot win both shapes, so this bot runs two modes:
//
//   Mode HOLD (the opening trade): buy with all cash on the very first
//   batch and ride the trend with a single wide trailing stop, 200 bps
//   below the best close since entry. No take profit, no hard stop, no
//   re-entry on this mode alone: on a grinding window it keeps the whole
//   move, and on a falling window the trail caps the loss near -2%.
//
//   Mode DIP (the second chance): once flat, only buy the sharp V-bounce
//   after a steep washout — the close at least 190 bps below the close
//   60 bars ago AND at least 20 bps above the close 5 bars ago — and
//   ride it with tight exits: take profit +500 bps, trailing stop 60 bps,
//   hard stop -80 bps, max hold 240 bars.
//
// Every number was picked by sweeping this competition's published dev
// window with a local replay that reproduces the harness fill math
// exactly (4 bps fee, 2 bps slippage, constant-product impact against
// the bar's open depth), then checked for robustness on the opposite
// regime (the previous round's window) and on each half of the dev
// window. Local results: dev window +32.17 USDC (1 trade, max drawdown
// 2.06%), previous window +12.76 USDC — positive in both regimes, and
// positive in each half of the dev window.
//
// All arithmetic is integer basis points on raw price units (bigint), so
// the bot is fully deterministic: the same bars always produce the same
// orders. It never reads the wall clock, the environment, or any file,
// and it uses no randomness.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// HOLD mode: one wide trailing stop, nothing else.
const HOLD_TRAIL_BPS = 200n;
// DIP mode: washout + bounce confirmation, then tight exits.
const DIP_WASHOUT_BARS = 60;
const DIP_BOUNCE_BARS = 5;
const DIP_DROP_BPS = 190n;
const DIP_BOUNCE_BPS = 20n;
const DIP_TAKE_PROFIT_BPS = 500n;
const DIP_TRAIL_BPS = 60n;
const DIP_STOP_BPS = 80n;
const DIP_MAX_HOLD_BARS = 240;
// Never accept a fill more than 2% past the latest close we were sent.
const MAX_SLIPPAGE_BPS = 200;

// Return of `later` vs `earlier` in basis points, truncated toward zero.
function moveBps(later: bigint, earlier: bigint): bigint {
  if (earlier <= 0n) return 0n;
  return ((later - earlier) * 10000n) / earlier;
}

type Mode = 'hold' | 'dip';

interface OpenTrade {
  mode: Mode;
  entry: bigint;
  peak: bigint;
  barsHeld: number;
}

const closes: bigint[] = [];
let trade: OpenTrade | null = null;

function dipSignal(): boolean {
  const n = closes.length;
  if (n <= DIP_WASHOUT_BARS) return false;
  const close = closes[n - 1];
  const washout = -moveBps(close, closes[n - 1 - DIP_WASHOUT_BARS]);
  const bounce = moveBps(close, closes[n - 1 - DIP_BOUNCE_BARS]);
  return washout >= DIP_DROP_BPS && bounce >= DIP_BOUNCE_BPS;
}

// Which exit, if any, fires on the latest close while holding.
function exitNow(close: bigint): boolean {
  if (trade === null) return false;
  if (close > trade.peak) trade.peak = close;
  trade.barsHeld += 1;
  if (trade.mode === 'hold') {
    return -moveBps(close, trade.peak) >= HOLD_TRAIL_BPS;
  }
  const gain = moveBps(close, trade.entry);
  const giveback = -moveBps(close, trade.peak);
  return (
    gain >= DIP_TAKE_PROFIT_BPS ||
    giveback >= DIP_TRAIL_BPS ||
    gain <= -DIP_STOP_BPS ||
    trade.barsHeld >= DIP_MAX_HOLD_BARS
  );
}

await runBars({
  onBatch(state: BarsState): OrderInput[] {
    const bar = state.latest.get(SYMBOL);
    if (bar !== undefined) closes.push(BigInt(bar.c));
    if (state.warmingUp) return [];
    if (closes.length === 0) return [];

    const held = state.positions.get(SYMBOL);

    if (held === undefined) {
      // Flat: forget any stale trade. The opening batch buys at once;
      // afterwards only the deep-dip signal can open a position.
      trade = null;
      let mode: Mode | null = null;
      if (closes.length === 1) {
        mode = 'hold';
      } else if (dipSignal()) {
        mode = 'dip';
      }
      if (mode === null) return [];
      let amount = state.cash;
      const room = state.weightRoom(SYMBOL);
      if (room < amount) amount = room;
      const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
      if (amount < minNotional) return [];
      const close = closes[closes.length - 1];
      trade = { mode, entry: close, peak: close, barsHeld: 0 };
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }

    // Holding: if the position appeared without our trade record (the
    // harness starts flat, so this should not happen), anchor on the
    // latest close as a HOLD trade rather than guessing.
    if (trade === null) {
      const close = closes[closes.length - 1];
      trade = { mode: 'hold', entry: close, peak: close, barsHeld: 0 };
    }
    if (!exitNow(closes[closes.length - 1])) return [];
    return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
