# Trading Bot

Automated stock trading bot that scans 181 stocks every 3 minutes and makes trades on your Alpaca paper trading account. Uses a scoring engine that analyzes momentum, volume, RSI, MACD, patterns, news sentiment, analyst ratings, and more to pick the best trades.

---

## Setup Guide (Step by Step)

### What You Need Before Starting

1. **A Mac or PC with a terminal** (Terminal on Mac, Command Prompt on Windows)
2. **Node.js** installed -- download from [nodejs.org](https://nodejs.org/) (pick the LTS version, click Install, done)
3. **An Alpaca account** -- sign up at [alpaca.markets](https://alpaca.markets/) (free paper trading)
4. **A Supabase account** -- sign up at [supabase.com](https://supabase.com/) (free tier works)

---

### Step 1: Get Your API Keys

You need 4 keys. Here's where to find each one:

**Alpaca (required):**
1. Log in to [app.alpaca.markets](https://app.alpaca.markets/)
2. Make sure you're on **Paper Trading** (toggle at the top)
3. Go to the API Keys section on the home page
4. Click "Generate New Key"
5. Save both the **API Key** and the **Secret Key** -- you'll need both

**Grok / xAI (required for AI sell decisions):**
1. Go to [console.x.ai](https://console.x.ai/)
2. Sign up and create an API key
3. Save the key

**Finnhub (required for news data):**
1. Go to [finnhub.io](https://finnhub.io/)
2. Sign up (free)
3. Your API key is on the dashboard right after login
4. Save the key

**BOT_SECRET (make one up):**
- This is just a password the bot uses internally
- Pick any random word or phrase, like `mybot2026secret`
- Save it

---

### Step 2: Create a Supabase Project

1. Log in to [supabase.com](https://supabase.com/dashboard)
2. Click **"New Project"**
3. Give it a name (e.g., "trading-bot")
4. Choose a database password (save it somewhere)
5. Pick a region close to you
6. Click **"Create new project"** and wait ~2 minutes
7. Once ready, look at the URL in your browser -- it will look like:
   `https://supabase.com/dashboard/project/abcdefghijklmnop`
   The part after `/project/` is your **Project ID** -- save it

---

### Step 3: Set Up the Database

1. In your Supabase dashboard, click **"SQL Editor"** in the left sidebar
2. Click **"New query"**
3. Open the file `setup/schema.sql` from this repo (you can view it on GitHub)
4. Copy the **entire contents** of that file
5. Paste it into the SQL Editor
6. Click **"Run"** (the green play button)
7. You should see "Success" -- your database is ready

---

### Step 4: Download and Deploy the Bot

Open your terminal (on Mac: search for "Terminal" in Spotlight) and run these commands one at a time:

```bash
# Install the Supabase CLI (one-time setup)
npm install -g supabase

# Download the bot code
git clone https://github.com/michaelsultan/trading-bot.git
cd trading-bot

# Connect to your Supabase project (replace YOUR_PROJECT_ID with the ID from Step 2)
npx supabase link --project-ref YOUR_PROJECT_ID
```

It will ask for your database password -- enter the one you chose in Step 2.

Now set your API keys (replace each placeholder with your actual keys from Step 1):

```bash
npx supabase secrets set ALPACA_API_KEY=paste-your-alpaca-key-here
npx supabase secrets set ALPACA_SECRET=paste-your-alpaca-secret-here
npx supabase secrets set GROK_API_KEY=paste-your-xai-key-here
npx supabase secrets set FINNHUB_API_KEY=paste-your-finnhub-key-here
npx supabase secrets set BOT_SECRET=mybot2026secret
```

Deploy the bot:

```bash
npx supabase functions deploy trading-bot --no-verify-jwt
```

You should see "Function trading-bot deployed successfully" -- the bot code is now live on the cloud.

---

### Step 5: Start the Bot (Schedule It)

Go back to the **Supabase SQL Editor** and run this query. Replace the two placeholders:
- `YOUR_PROJECT_ID` = your project ID from Step 2
- `YOUR_BOT_SECRET` = the BOT_SECRET you chose in Step 1

```sql
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.schedule(
  'trading-bot-cycle',
  '*/3 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://YOUR_PROJECT_ID.supabase.co/functions/v1/trading-bot',
    body := jsonb_build_object('secret', 'YOUR_BOT_SECRET'),
    headers := '{"Content-Type": "application/json"}'::jsonb
  );
  $$
);
```

Click **"Run"** -- and that's it. The bot is now running every 3 minutes during market hours (9:30 AM - 4:00 PM ET, Monday to Friday).

---

### Step 6: Watch It Trade

Open the file `dashboard.html` in your browser (just double-click it from the downloaded folder). It will ask for:
- **Supabase URL**: `https://YOUR_PROJECT_ID.supabase.co`
- **Supabase Anon Key**: Find this in your Supabase dashboard under Settings > API > `anon` `public` key

The dashboard shows your equity, trade history, open positions, and performance stats in real time.

---

## How It Works

The bot scans 181 stocks every 3 minutes and scores each one from 0-100 based on:

- **Momentum** -- is the stock moving up in the right range?
- **Volume** -- is there unusual buying activity?
- **RSI** -- is the stock oversold or in a healthy trend?
- **MACD** -- is the trend turning bullish?
- **Chart Patterns** -- breakouts, double bottoms, etc.
- **Social Buzz** -- is Reddit/WallStreetBets talking about it?
- **Options Flow** -- are big traders making bullish bets?

Stocks scoring above 35 get bought automatically. The bot also:
- Sets automatic stop-losses on every trade
- Limits positions to 6 at a time
- Blocks buys on crashing stocks (down > 10%)
- Flattens leveraged ETFs before market close
- Adjusts position sizes based on market volatility (VIX)

---

## Configuration

If your Alpaca paper account has a different starting balance than $100,000, edit the file `supabase/functions/trading-bot/config.ts` and change this line:

```typescript
export const STARTING_CAPITAL = 100_000;  // Change to your starting balance
```

Then redeploy:
```bash
cd trading-bot
npx supabase functions deploy trading-bot --no-verify-jwt
```

---

## Stopping the Bot

To pause the bot, go to the Supabase SQL Editor and run:

```sql
SELECT cron.unschedule('trading-bot-cycle');
```

To restart it, run the schedule command from Step 5 again.

---

## Troubleshooting

**"Permission denied" in terminal:**
Try adding `sudo` before the command, e.g., `sudo npm install -g supabase`

**"Function not found" error:**
Make sure you ran `npx supabase link` first and that the deploy command succeeded.

**Bot not making trades:**
The bot only trades during US market hours (9:30 AM - 4:00 PM Eastern, Mon-Fri). Check the Supabase dashboard under Edge Functions > Logs to see what it's doing.

**Dashboard shows nothing:**
Make sure you entered the correct Supabase URL and anon key. The URL format is `https://YOUR_PROJECT_ID.supabase.co` (no trailing slash).

---

## License

Private -- do not redistribute without permission.
