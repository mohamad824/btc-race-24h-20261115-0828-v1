// Washout-recovery bot for btc-race-24h-20261115-0828 (agent-fun/bars-replay/v1).
//
// Strategy (deep-dip / washout mean-reversion, from market research on this
// edition's dev window):
// - The dev window falls -3.92% overall with two sharp legs down and a +1.62%
//   recovery leg. The biggest edge is the washout near minute ~1037: a -2.82%
//   60-minute drop followed by a +4.3% snap-back within the next hour.
// - Sleeve A (washout, main): when the close has fallen >= 2.2% over the last
//   60 bars, buy with all cash. Exit on a trailing stop (arms at +1.5%, exits
//   on a 0.8% give-back), a +4% take-profit, a -3% hard stop, or a 360-bar
//   max hold. This rides the snap-back instead of catching a falling knife.
// - Sleeve B (dip, secondary): when the 60-bar drop is >= 1.5% but below the
//   washout trigger, and the 240-bar drift is better than -2% (not a grinding
//   down-leg), buy 25% of cash. Tight +1% / -1% exits, 90-bar max hold. This
//   keeps the bot trading on shallower dislocations so the race window is
//   not a single-event bet.
// - Top-up: while a B position is held, a washout signal buys the remaining
//   cash and promotes the position to sleeve A exits (blended entry).
//
// Determinism: a pure function of the hello/batch stream. No wall clock, no
// environment, no files, no unseeded randomness. All thresholds are integer
// basis points computed from integer bar closes. The bot speaks the
// agent-fun/bars-replay/v1 line protocol: hello, then one batch per bar, then
// done; it answers every batch with exactly one reply echoing its seq.
// Orders fill at the next bar's open, so every decision is made on the bar
// that just closed.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Parameters (basis points unless noted).
const WASHOUT_DROP_BPS = 220; // 60-bar drop that triggers sleeve A (full size)
const DIP_DROP_BPS = 150; // 60-bar drop that triggers sleeve B (small size)
const REGIME_DRIFT_BPS = -200; // sleeve B only if 240-bar drift is above this
const DIP_FRACTION_BPS = 2500; // sleeve B size: 25% of cash
const TP_A_BPS = 400; // sleeve A take-profit
const SL_A_BPS = -300; // sleeve A hard stop
const TRAIL_ARM_BPS = 150; // sleeve A trailing stop arms here
const TRAIL_GIVEBACK_BPS = 80; // sleeve A trailing stop give-back
const MAX_HOLD_A = 360; // sleeve A max hold, bars
const TP_B_BPS = 100; // sleeve B take-profit
const SL_B_BPS = -100; // sleeve B hard stop
const MAX_HOLD_B = 90; // sleeve B max hold, bars
const COOLDOWN_BARS = 30; // bars after a buy before a new flat entry
const MAX_SLIPPAGE_BPS = 300; // named on every order
const MIN_NOTIONAL = 1_000_000n; // 1 USDC in quote units

// Mutable per-run state. Everything here derives from the batch stream.
const closes: bigint[] = []; // closes of CBBTC bars seen, in order
let mode: 'A' | 'B' | null = null; // sleeve of the position currently held
let bestRetBps = 0; // best return since entry, in bps
let holdBars = 0; // bars held since the last buy fill
let cooldown = 0; // bars left before a new flat entry
let qtyScale = 8;
let priceScale = 6;
let quoteScale = 6;

function entryPriceFromAccount(state: BarsState): bigint {
  const holding = state.positions.get(SYMBOL);
  if (holding === undefined || holding.qty <= 0n) return 0n;
  // value = qty * price * 10^quoteScale / 10^(qtyScale + priceScale),
  // so price = cost * 10^(qtyScale + priceScale) / (qty * 10^quoteScale).
  return (
    (holding.cost * 10n ** BigInt(qtyScale + priceScale)) /
    (holding.qty * 10n ** BigInt(quoteScale))
  );
}

function retBps(close: bigint, entryPrice: bigint): number {
  if (entryPrice <= 0n) return 0;
  return Number((close * 10_000n) / entryPrice - 10_000n);
}

function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  // Fold buy fills into entry / hold bookkeeping first.
  for (const fill of batch.fills) {
    if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
    if (fill.side === 'buy') {
      holdBars = 0;
      bestRetBps = 0;
      cooldown = COOLDOWN_BARS;
    }
  }

  let bar = null;
  for (const b of batch.bars) {
    if (b.symbol === SYMBOL) bar = b;
  }
  if (bar === null) return [];
  const close = BigInt(bar.c);
  closes.push(close);
  if (closes.length > 300) closes.splice(0, closes.length - 300);

  const holding = state.positions.get(SYMBOL);
  const qty = holding === undefined ? 0n : holding.qty;
  const entryPrice = entryPriceFromAccount(state);

  if (state.warmingUp) return [];

  if (qty > 0n) {
    holdBars += 1;
    const ret = retBps(close, entryPrice);
    if (ret > bestRetBps) bestRetBps = ret;
    let sell = false;
    if (mode === 'A') {
      if (
        ret >= TP_A_BPS ||
        ret <= SL_A_BPS ||
        holdBars >= MAX_HOLD_A ||
        (bestRetBps >= TRAIL_ARM_BPS && ret <= bestRetBps - TRAIL_GIVEBACK_BPS)
      ) {
        sell = true;
      }
    } else {
      // Sleeve B exits.
      if (ret >= TP_B_BPS || ret <= SL_B_BPS || holdBars >= MAX_HOLD_B) {
        sell = true;
      }
    }
    if (sell) {
      return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    // Top-up: a washout signal while holding a B position buys the
    // remaining cash and promotes the position to sleeve A exits.
    if (mode === 'B' && closes.length > 60) {
      const drop60 = Number((close * 10_000n) / closes[closes.length - 61]! - 10_000n);
      if (drop60 <= -WASHOUT_DROP_BPS && state.cash >= MIN_NOTIONAL) {
        mode = 'A';
        return [
          {
            side: 'buy',
            symbol: SYMBOL,
            notional_quote_units: state.cash,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          },
        ];
      }
    }
    return [];
  }

  // Flat: look for an entry. Cooldown ticks down one bar at a time.
  if (cooldown > 0) {
    cooldown -= 1;
    return [];
  }
  if (closes.length <= 60) return [];
  const drop60 = Number((close * 10_000n) / closes[closes.length - 61]! - 10_000n);
  if (drop60 <= -WASHOUT_DROP_BPS) {
    if (state.cash < MIN_NOTIONAL) return [];
    mode = 'A';
    return [
      {
        side: 'buy',
        symbol: SYMBOL,
        notional_quote_units: state.cash,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }
  if (drop60 <= -DIP_DROP_BPS && closes.length > 240) {
    const drift240 = Number((close * 10_000n) / closes[closes.length - 241]! - 10_000n);
    if (drift240 > REGIME_DRIFT_BPS) {
      const amount = (state.cash * BigInt(DIP_FRACTION_BPS)) / 10_000n;
      if (amount < MIN_NOTIONAL) return [];
      mode = 'B';
      return [
        {
          side: 'buy',
          symbol: SYMBOL,
          notional_quote_units: amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }
  }
  return [];
}

await runBars({
  onHello(state) {
    const sym = state.hello.symbols[0];
    if (sym !== undefined) {
      qtyScale = sym.qty_scale;
      priceScale = sym.price_scale;
    }
    quoteScale = state.hello.capital.quote_scale;
  },
  onBatch,
});
