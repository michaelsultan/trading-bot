# AI Trading Bot

An autonomous stock trading bot powered by AI, running on Supabase Edge Functions.

## Stack

- **Runtime**: TypeScript on Deno (Supabase Edge Functions)
- **Trading**: Alpaca Markets API (paper trading)
- **AI**: Grok (`grok-3` from X.AI) — market discovery + trade decisions
- **Database**: Supabase PostgreSQL

## How it works

The bot runs automatically every 30 minutes during US market hours (Mon–Fri, 09:30–16:00 ET) via a `pg_cron` job:

1. Checks if the market is open (Alpaca clock API)
2. Fetches current portfolio (cash + positions)
3. Logs a portfolio snapshot to the database
4. Asks Grok to scan X, Reddit and financial news to pick the most promising symbols
5. Fetches real-time technical data (SMA, RSI, MACD) + news for each symbol
6. Sends everything to Grok for a final trade decision
7. Executes BUY/SELL orders on Alpaca and logs them to the database
8. Every 5 cycles: generates a self-analysis to improve future decisions
9. End of week (Friday close): generates a weekly performance summary

## Project structure

```
supabase/
  functions/
    trading-bot/      # Main bot logic (runs every 30 min)
    get-logs/         # Edge function for the dashboard logs view
    get-portfolio/    # Edge function for the dashboard portfolio view
  migrations/         # Database schema (trades, portfolio_snapshots, bot_analyses)
dashboard/            # Simple HTML dashboard to monitor the bot
```

## Environment variables

Create a `.env` file at the root with the following variables:

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (bypasses RLS) |
| `ALPACA_API_KEY` | Alpaca API key |
| `ALPACA_SECRET_KEY` | Alpaca secret key |
| `GROK_API_KEY` | X.AI Grok API key |

> The bot is configured for **paper trading** (no real money).

## Setup

### Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli)
- A [Supabase](https://supabase.com) project
- An [Alpaca](https://alpaca.markets) account (paper trading)
- A [Grok / X.AI](https://x.ai) API key

### Deploy

```bash
# Link to your Supabase project
npx supabase link --project-ref <your-project-ref>

# Push the database schema
npx supabase db push

# Set secrets on Supabase (instead of .env for production)
npx supabase secrets set ALPACA_API_KEY=... ALPACA_SECRET_KEY=... GROK_API_KEY=...

# Deploy the edge functions
npx supabase functions deploy trading-bot
npx supabase functions deploy get-logs
npx supabase functions deploy get-portfolio
```

The cron job is set up automatically by the migrations — the bot will start running on its own once deployed.

### Local development

```bash
npx supabase start
npx supabase functions serve trading-bot
```
