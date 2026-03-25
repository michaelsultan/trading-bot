# Trading Bot

Automated stock trading bot targeting $500/day on a $100K Alpaca paper portfolio.

Built on **Supabase Edge Functions** (Deno) with a 10-category quantitative scoring engine and 6 external intelligence layers.

## Architecture

```
Alpaca IEX Feed (181 stocks)
        │
        ▼
┌─────────────────────────────────────┐
│   Supabase Edge Function (Deno)     │
│                                     │
│  Scanner → Hot List → Technicals    │
│       │                             │
│       ▼                             │
│  ┌──────────────────────────────┐   │
│  │  Quant Scoring Engine (0-100)│   │
│  │  + Massive Market Data       │   │
│  │  + BigData/RavenPack         │   │
│  │  + VIX Regime Detection      │   │
│  │  + Short Interest Squeeze    │   │
│  │  + Macro Economic Calendar   │   │
│  └──────────────────────────────┘   │
│       │                             │
│       ▼                             │
│  OTO Bracket Orders (ATR stops)     │
│  → Alpaca Markets API               │
└─────────────────────────────────────┘
        │
        ▼
  Supabase PostgreSQL (trades, signals, metrics)
```

## Quick Start

### Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli) (`npm install -g supabase`)
- [Alpaca Markets](https://alpaca.markets/) paper trading account (free)
- [xAI / Grok](https://x.ai/) API key (for sell-side risk assessment)
- [Finnhub](https://finnhub.io/) API key (free tier works)

### 1. Create a Supabase Project

Go to [supabase.com](https://supabase.com) and create a new project. Note your **project ID** (from the URL: `supabase.com/dashboard/project/<PROJECT_ID>`).

### 2. Clone and Link

```bash
git clone <your-repo-url> trading-bot
cd trading-bot
npx supabase link --project-ref <YOUR_PROJECT_ID>
```

### 3. Create Database Tables

Run the SQL in `setup/schema.sql` via the Supabase SQL Editor or CLI:

```bash
npx supabase db push
```

Or paste the contents of `setup/schema.sql` into the SQL Editor at:
`https://supabase.com/dashboard/project/<YOUR_PROJECT_ID>/sql`

### 4. Set Secrets

```bash
npx supabase secrets set ALPACA_API_KEY=<your-alpaca-key>
npx supabase secrets set ALPACA_SECRET=<your-alpaca-secret>
npx supabase secrets set GROK_API_KEY=<your-xai-key>
npx supabase secrets set FINNHUB_API_KEY=<your-finnhub-key>
npx supabase secrets set BOT_SECRET=<any-random-string>
```

### 5. Deploy

```bash
npx supabase functions deploy trading-bot --no-verify-jwt
```

### 6. Schedule the Bot (pg_cron)

In the Supabase SQL Editor, run:

```sql
SELECT cron.schedule(
  'trading-bot-cycle',
  '*/3 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://<YOUR_PROJECT_ID>.supabase.co/functions/v1/trading-bot',
    body := jsonb_build_object('secret', '<YOUR_BOT_SECRET>'),
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  $$
);
```

Replace `<YOUR_PROJECT_ID>` and `<YOUR_BOT_SECRET>` with your values.

This runs the bot every 3 minutes, Monday-Friday. The bot automatically detects market hours (9:30 AM - 4:00 PM ET) and skips cycles outside trading hours.

## Intelligence Layers (Optional but Recommended)

The bot works standalone with just Alpaca data, but performs best with external intelligence. These require **Cowork mode** with MCP connectors:

| Layer | Source | What It Provides | Scheduled Task |
|-------|--------|-----------------|----------------|
| Massive Market Data | Polygon.io MCP | Daily RSI, MACD, SMA, news sentiment, short volume | `massive-market-intel` (every 10 min) |
| BigData/RavenPack | RavenPack MCP | Analyst ratings, price targets, earnings dates, sentiment | `bigdata-market-intel` (3x/day) |
| VIX Regime | RavenPack MCP | Market regime detection (calm/normal/elevated/panic) | Included in bigdata task |
| Short Interest | Polygon.io MCP | Short volume ratio for squeeze detection | Included in massive task |
| Macro Calendar | RavenPack MCP | US economic calendar (HIGH/MEDIUM/LOW impact events) | Included in bigdata task |

Without MCP connectors, the bot still uses its core 7 scoring categories (momentum, volume, RSI, MACD, patterns, social, options flow) and all risk management features.

## Scoring Engine

Each stock is scored 0-100 across 10 categories:

| # | Category | Max Points | Source |
|---|----------|-----------|--------|
| 1 | Momentum | 25 | Alpaca snapshots |
| 2 | Volume | 20 | Alpaca snapshots |
| 3 | RSI Signal | 15 | Intraday technicals |
| 4 | MACD Signal | 10 | Intraday technicals |
| 5 | Pattern Score | 15 | Candlestick detection |
| 6 | Social Buzz | 10 | Reddit/WSB |
| 7 | Options Flow | 10 | Unusual Whales |
| 8 | Massive News | +15 / -5 | Massive Market Data |
| 9 | BigData Fundamentals | +17 / -10 | RavenPack |
| 10 | Short Interest | +8 / -5 | Short volume data |

Minimum score to buy: **35** (adjusted dynamically by VIX regime).

## Risk Management

- **ATR-based stop-losses** on every trade (OTO bracket orders)
- **VIX regime scaling**: Elevated VIX = smaller positions + higher score threshold
- **Macro calendar**: Half-size positions on Fed/CPI/NFP days
- **Correlation guard**: Max 2 leveraged bull, 1 bear, 3 total leveraged positions
- **Intraday-only rule**: All leveraged ETFs flattened at 3:50 PM ET
- **Bid-ask spread filter**: Skip trades with > 0.3% spread
- **Smart cooldowns**: 60 min after loss, 15 min after profit
- **Crash filter**: Block buys on stocks down > 10% intraday

## Configuration

All tunable parameters are in `supabase/functions/trading-bot/config.ts`:

```typescript
STARTING_CAPITAL = 100_000    // Starting portfolio value
MAX_POSITIONS = 6             // Max simultaneous positions
MIN_SCORE = 35                // Minimum quant score to buy
MAX_PICKS = 4                 // Max buys per cycle
DAILY_PROFIT_TARGET = 500     // $500/day target
MAX_DRAWDOWN_PCT = 0.15       // 15% drawdown halt
MAX_SPREAD_PCT = 0.003        // 0.3% max spread
```

## Project Structure

```
trading-bot/
├── supabase/
│   └── functions/
│       └── trading-bot/
│           ├── index.ts          # Main orchestrator
│           ├── config.ts         # All tunable parameters
│           ├── types.ts          # TypeScript interfaces
│           ├── scoring.ts        # Quant scoring engine + intelligence layers
│           ├── scanner.ts        # Market scanner + hot list builder
│           ├── market-data.ts    # Technical analysis (RSI, MACD, patterns)
│           ├── portfolio.ts      # Supabase client + portfolio queries
│           ├── execution.ts      # Alpaca order execution (OTO brackets)
│           ├── risk.ts           # Risk management (correlation, flatten, etc.)
│           ├── sell-engine.ts    # Grok AI sell decisions
│           ├── social.ts         # Reddit/WSB + Finnhub social signals
│           └── utils.ts          # fetchWithTimeout, helpers
├── setup/
│   └── schema.sql               # Database schema (run this first)
├── dashboard.html                # Real-time P&L dashboard
├── deno.json                     # Deno configuration
└── README.md                     # This file
```

## Dashboard

Open `dashboard.html` in a browser and enter your Supabase URL + anon key. It shows:

- Real-time equity curve
- Trade history with entry/exit prices and P&L
- Open positions
- Performance metrics (win rate, Sharpe, drawdown)

## License

Private — do not redistribute without permission.
