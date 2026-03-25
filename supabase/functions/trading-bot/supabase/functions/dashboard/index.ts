import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Trading Bot — PnL Dashboard</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.5.1" integrity="sha384-jb8JQMbMoBUzgWatfe6COACi2ljcDdZQ2OxczGA3bGNeWe+6DChMTBJemed7ZnvJ" crossorigin="anonymous"></script>
    <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0" integrity="sha384-cVMg8E3QFwTvGCDuK+ET4PD341jF3W8nO1auiXfuZNQkzbUUiBGLsIQUE+b1mxws" crossorigin="anonymous"></script>
    <style>
        :root {
            --bg-primary: #0d1117;
            --bg-card: #161b22;
            --bg-header: #0d1117;
            --bg-input: #21262d;
            --border: #30363d;
            --text-primary: #e6edf3;
            --text-secondary: #8b949e;
            --text-muted: #484f58;
            --green: #3fb950;
            --green-bg: rgba(63,185,80,0.1);
            --red: #f85149;
            --red-bg: rgba(248,81,73,0.1);
            --blue: #58a6ff;
            --blue-bg: rgba(88,166,255,0.1);
            --orange: #d29922;
            --orange-bg: rgba(210,153,34,0.1);
            --purple: #bc8cff;
            --purple-bg: rgba(188,140,255,0.1);
            --cyan: #39d2c0;
            --gap: 16px;
            --radius: 12px;
        }
        * { margin:0; padding:0; box-sizing:border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            line-height: 1.5;
        }
        .dashboard { max-width:1440px; margin:0 auto; padding:20px; }

        /* Header */
        .header {
            display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;
            padding:20px 0; border-bottom:1px solid var(--border); margin-bottom:var(--gap);
        }
        .header h1 { font-size:22px; font-weight:700; display:flex; align-items:center; gap:10px; }
        .header h1 .dot { width:10px; height:10px; border-radius:50%; background:var(--green); display:inline-block; animation: pulse 2s infinite; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        .header-right { display:flex; gap:10px; align-items:center; }

        /* Connection bar */
        .connection-bar {
            background: var(--bg-card); border:1px solid var(--border); border-radius:var(--radius);
            padding:14px 20px; margin-bottom:var(--gap);
            display:grid; grid-template-columns: 1fr 1fr auto; gap:10px; align-items:end;
        }
        .connection-bar label { display:block; font-size:11px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:4px; }
        .connection-bar input {
            width:100%; padding:8px 12px; border:1px solid var(--border); border-radius:6px;
            background:var(--bg-input); color:var(--text-primary); font-size:13px; font-family:monospace;
        }
        .connection-bar input:focus { outline:none; border-color:var(--blue); }
        .btn {
            padding:8px 20px; border:none; border-radius:6px; font-size:13px; font-weight:600;
            cursor:pointer; transition:all 0.15s;
        }
        .btn-primary { background:var(--blue); color:#fff; }
        .btn-primary:hover { background:#79c0ff; }
        .btn-primary:disabled { opacity:0.5; cursor:not-allowed; }
        .btn-outline { background:transparent; border:1px solid var(--border); color:var(--text-primary); }
        .btn-outline:hover { background:var(--bg-input); }
        .btn-tf {
            padding:5px 14px; border:1px solid var(--border); border-radius:6px; font-size:12px; font-weight:600;
            cursor:pointer; background:transparent; color:var(--text-secondary); transition:all 0.15s;
        }
        .btn-tf:hover { background:var(--bg-input); color:var(--text-primary); }
        .btn-tf.active { background:var(--blue); color:#fff; border-color:var(--blue); }

        /* Status pill */
        .status { display:inline-flex; align-items:center; gap:6px; padding:4px 12px; border-radius:20px; font-size:12px; font-weight:500; }
        .status-connected { background:var(--green-bg); color:var(--green); }
        .status-disconnected { background:var(--red-bg); color:var(--red); }
        .status-loading { background:var(--orange-bg); color:var(--orange); }

        /* KPI Row */
        .kpi-row { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:var(--gap); margin-bottom:var(--gap); }
        .kpi-card {
            background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius);
            padding:18px 20px; position:relative; overflow:hidden;
        }
        .kpi-card::before { content:''; position:absolute; top:0; left:0; right:0; height:3px; }
        .kpi-card.green::before { background:var(--green); }
        .kpi-card.red::before { background:var(--red); }
        .kpi-card.blue::before { background:var(--blue); }
        .kpi-card.orange::before { background:var(--orange); }
        .kpi-card.purple::before { background:var(--purple); }
        .kpi-card.cyan::before { background:var(--cyan); }
        .kpi-label { font-size:11px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px; }
        .kpi-value { font-size:26px; font-weight:700; letter-spacing:-0.5px; }
        .kpi-sub { font-size:12px; margin-top:4px; }
        .kpi-sub.positive { color:var(--green); }
        .kpi-sub.negative { color:var(--red); }
        .kpi-sub.neutral { color:var(--text-secondary); }

        /* Chart rows */
        .chart-row { display:grid; grid-template-columns:1fr 1fr; gap:var(--gap); margin-bottom:var(--gap); }
        .chart-full { grid-column: 1 / -1; }
        .chart-card {
            background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius);
            padding:20px;
        }
        .chart-card h3 { font-size:13px; font-weight:600; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:14px; }
        .chart-card canvas { max-height:280px; }
        .chart-card.tall canvas { max-height:350px; }

        /* Tabs */
        .tabs { display:flex; gap:0; border-bottom:1px solid var(--border); margin-bottom:var(--gap); }
        .tab {
            padding:10px 20px; font-size:13px; font-weight:500; color:var(--text-secondary);
            background:none; border:none; cursor:pointer; border-bottom:2px solid transparent;
            transition:all 0.15s;
        }
        .tab:hover { color:var(--text-primary); }
        .tab.active { color:var(--blue); border-bottom-color:var(--blue); }

        /* Table */
        .table-card {
            background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius);
            overflow:hidden; margin-bottom:var(--gap);
        }
        .table-header { padding:16px 20px; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border); }
        .table-header h3 { font-size:14px; font-weight:600; }
        .table-header .count { font-size:12px; color:var(--text-secondary); }
        .table-wrap { overflow-x:auto; }
        table { width:100%; border-collapse:collapse; font-size:13px; }
        thead th {
            text-align:left; padding:10px 16px; border-bottom:1px solid var(--border);
            color:var(--text-secondary); font-weight:600; font-size:11px; text-transform:uppercase;
            letter-spacing:0.5px; cursor:pointer; user-select:none; white-space:nowrap;
        }
        thead th:hover { color:var(--text-primary); }
        tbody td { padding:10px 16px; border-bottom:1px solid rgba(48,54,61,0.5); white-space:nowrap; }
        tbody tr:hover { background:rgba(88,166,255,0.04); }
        .pill { display:inline-block; padding:2px 10px; border-radius:12px; font-size:11px; font-weight:600; }
        .pill-buy { background:var(--green-bg); color:var(--green); }
        .pill-sell { background:var(--red-bg); color:var(--red); }
        .pill-hold { background:var(--blue-bg); color:var(--blue); }
        .pill-scan { background:var(--purple-bg); color:var(--purple); }
        .pill-error { background:var(--orange-bg); color:var(--orange); }
        .pnl-positive { color:var(--green); font-weight:600; }
        .pnl-negative { color:var(--red); font-weight:600; }

        /* Pagination */
        .pagination { display:flex; justify-content:space-between; align-items:center; padding:12px 20px; border-top:1px solid var(--border); }
        .pagination span { font-size:12px; color:var(--text-secondary); }
        .pagination-btns { display:flex; gap:6px; }

        /* Filters */
        .filter-bar {
            display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:var(--gap);
            padding:12px 16px; background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius);
        }
        .filter-bar label { font-size:11px; color:var(--text-secondary); text-transform:uppercase; }
        .filter-bar select, .filter-bar input[type="date"] {
            padding:6px 10px; border:1px solid var(--border); border-radius:6px;
            background:var(--bg-input); color:var(--text-primary); font-size:12px;
        }

        /* Empty state */
        .empty-state { text-align:center; padding:60px 20px; color:var(--text-secondary); }
        .empty-state h3 { font-size:16px; color:var(--text-primary); margin-bottom:8px; }

        /* Loading */
        .loading { display:flex; align-items:center; justify-content:center; padding:40px; gap:10px; color:var(--text-secondary); }
        .spinner { width:20px; height:20px; border:2px solid var(--border); border-top-color:var(--blue); border-radius:50%; animation:spin 0.8s linear infinite; }
        @keyframes spin { to{transform:rotate(360deg)} }

        /* Open Positions */
        .positions-section { margin-bottom:var(--gap); }
        .positions-section h2 { font-size:15px; font-weight:600; margin-bottom:10px; display:flex; align-items:center; gap:8px; }
        .positions-section h2 .live-badge { font-size:10px; padding:2px 8px; border-radius:10px; background:var(--green-bg); color:var(--green); font-weight:600; text-transform:uppercase; letter-spacing:0.5px; }
        .positions-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(320px, 1fr)); gap:var(--gap); }
        .position-card {
            background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius);
            padding:16px 20px; position:relative; overflow:hidden;
        }
        .position-card::before { content:''; position:absolute; top:0; left:0; right:0; height:3px; }
        .position-card.pos-up::before { background:var(--green); }
        .position-card.pos-down::before { background:var(--red); }
        .position-card.pos-flat::before { background:var(--text-muted); }
        .position-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; }
        .position-symbol { font-size:18px; font-weight:700; }
        .position-qty { font-size:13px; color:var(--text-secondary); }
        .position-prices { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; margin-bottom:10px; }
        .position-price-item { }
        .position-price-label { font-size:10px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.5px; }
        .position-price-value { font-size:16px; font-weight:600; margin-top:2px; }
        .position-price-value.price-paid { color:var(--blue); }
        .position-price-value.price-current { color:var(--text-primary); }
        .position-pnl-bar { display:flex; justify-content:space-between; align-items:center; padding:8px 12px; border-radius:6px; margin-top:4px; }
        .position-pnl-bar.up { background:var(--green-bg); }
        .position-pnl-bar.down { background:var(--red-bg); }
        .position-pnl-bar.flat { background:var(--bg-input); }
        .position-pnl-value { font-size:15px; font-weight:700; }
        .position-pnl-pct { font-size:13px; font-weight:600; }

        /* Alpaca connection row */
        .alpaca-bar {
            background: var(--bg-card); border:1px solid var(--border); border-radius:var(--radius);
            padding:10px 16px; margin-bottom:var(--gap);
            display:flex; gap:10px; align-items:end; flex-wrap:wrap;
        }
        .alpaca-bar .field { flex:1; min-width:180px; }
        .alpaca-bar label { display:block; font-size:10px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:3px; }
        .alpaca-bar input {
            width:100%; padding:6px 10px; border:1px solid var(--border); border-radius:6px;
            background:var(--bg-input); color:var(--text-primary); font-size:12px; font-family:monospace;
        }
        .alpaca-bar .hint { font-size:11px; color:var(--text-muted); align-self:center; }

        /* Enhanced price cells */
        .price-cell { font-weight:600; font-family:'SF Mono',SFMono-Regular,Consolas,monospace; font-size:12px; }
        .price-entry { color:var(--blue); }
        .price-exit { color:var(--orange); }
        .price-current-cell { color:var(--cyan); }

        @media(max-width:768px) {
            .chart-row { grid-template-columns:1fr; }
            .kpi-row { grid-template-columns:repeat(2,1fr); }
            .connection-bar { grid-template-columns:1fr; }
            .positions-grid { grid-template-columns:1fr; }
            .alpaca-bar { flex-direction:column; }
        }
    </style>
</head>
<body>
<div class="dashboard">

    <!-- Header -->
    <div class="header">
        <h1><span class="dot" id="live-dot"></span> Trading Bot Dashboard</h1>
        <div class="header-right">
            <span class="status status-disconnected" id="conn-status">Disconnected</span>
            <select id="auto-refresh-interval" onchange="setAutoRefresh()" style="padding:6px 10px; border:1px solid var(--border); border-radius:6px; background:var(--bg-input); color:var(--text-primary); font-size:12px;">
                <option value="0">Auto-refresh: Off</option>
                <option value="5" selected>Every 5s</option>
                <option value="10">Every 10s</option>
                <option value="30">Every 30s</option>
                <option value="60">Every 60s</option>
            </select>
            <button class="btn btn-outline" onclick="manualRefresh()" id="refresh-btn" disabled>Refresh</button>
        </div>
    </div>

    <!-- Supabase Connection -->
    <div class="connection-bar" id="connection-bar">
        <div>
            <label>Supabase URL</label>
            <input type="text" id="input-url" placeholder="https://your-project.supabase.co" />
        </div>
        <div>
            <label>Anon Key (read-only)</label>
            <input type="password" id="input-key" placeholder="eyJhbGciOiJIUzI1NiIsIn..." />
        </div>
        <button class="btn btn-primary" onclick="connectSupabase()" id="connect-btn">Connect</button>
    </div>

    <!-- Alpaca Connection -->
    <div class="alpaca-bar" id="alpaca-bar">
        <div class="field">
            <label>Alpaca API Key (Paper)</label>
            <input type="text" id="input-alpaca-key" placeholder="PK..." />
        </div>
        <div class="field">
            <label>Alpaca Secret Key</label>
            <input type="password" id="input-alpaca-secret" placeholder="Your secret key" />
        </div>
        <button class="btn btn-primary" onclick="connectAlpaca()" id="alpaca-btn" style="font-size:12px; padding:6px 14px;">Connect Alpaca</button>
        <span class="hint" id="alpaca-hint">Shows your live portfolio, positions & current prices</span>
    </div>

    <!-- Open Positions -->
    <div class="positions-section" id="positions-section" style="display:none; margin-top:var(--gap)">
        <h2>Open Positions <span class="live-badge" id="positions-badge">FROM TRADES</span></h2>
        <div class="positions-grid" id="positions-grid">
            <div class="empty-state" style="padding:30px;"><p>No open positions detected.</p></div>
        </div>
    </div>

    <!-- KPI Row -->
    <div class="kpi-row" id="kpi-section" style="display:none">
        <div class="kpi-card green">
            <div class="kpi-label">Equity</div>
            <div class="kpi-value" id="kpi-equity">—</div>
            <div class="kpi-sub neutral" id="kpi-equity-sub">—</div>
        </div>
        <div class="kpi-card blue">
            <div class="kpi-label">Unrealized PnL</div>
            <div class="kpi-value" id="kpi-pnl">—</div>
            <div class="kpi-sub neutral" id="kpi-pnl-sub">—</div>
        </div>
        <div class="kpi-card cyan">
            <div class="kpi-label">Cash</div>
            <div class="kpi-value" id="kpi-cash">—</div>
            <div class="kpi-sub neutral" id="kpi-cash-sub">—</div>
        </div>
        <div class="kpi-card red">
            <div class="kpi-label">Realized PnL</div>
            <div class="kpi-value" id="kpi-realized">—</div>
            <div class="kpi-sub neutral" id="kpi-realized-sub">—</div>
        </div>
        <div class="kpi-card orange">
            <div class="kpi-label">Positions</div>
            <div class="kpi-value" id="kpi-positions">—</div>
            <div class="kpi-sub neutral" id="kpi-positions-sub">—</div>
        </div>
        <!-- Bot stats — shown only when Supabase has data -->
        <div class="kpi-card purple" id="kpi-card-winrate" style="display:none">
            <div class="kpi-label">Win Rate</div>
            <div class="kpi-value" id="kpi-winrate">—</div>
            <div class="kpi-sub neutral" id="kpi-winrate-sub">—</div>
        </div>
        <div class="kpi-card red" id="kpi-card-sharpe" style="display:none">
            <div class="kpi-label">Sharpe Ratio</div>
            <div class="kpi-value" id="kpi-sharpe">—</div>
            <div class="kpi-sub neutral" id="kpi-sharpe-sub">—</div>
        </div>
    </div>

    <!-- Charts — shown dynamically based on available data -->
    <div id="charts-section" style="display:none">
        <!-- Alpaca-powered charts (show when Alpaca connected) -->
        <div class="chart-row" id="alpaca-chart-equity" style="display:none">
            <div class="chart-card chart-full tall">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px;">
                    <h3 style="margin:0;">Portfolio Equity (from Alpaca)</h3>
                    <div id="equity-timeframe-btns" style="display:flex; gap:4px;">
                        <button class="btn-tf" data-tf="1D" onclick="changeEquityTimeframe('1D')">1D</button>
                        <button class="btn-tf active" data-tf="1W" onclick="changeEquityTimeframe('1W')">1W</button>
                        <button class="btn-tf" data-tf="1M" onclick="changeEquityTimeframe('1M')">1M</button>
                        <button class="btn-tf" data-tf="ALL" onclick="changeEquityTimeframe('ALL')">ALL</button>
                    </div>
                </div>
                <canvas id="chart-alpaca-equity"></canvas>
            </div>
        </div>
        <div class="chart-row" id="alpaca-charts" style="display:none">
            <div class="chart-card">
                <h3>Portfolio Allocation</h3>
                <canvas id="chart-allocation"></canvas>
            </div>
            <div class="chart-card">
                <h3>Position Performance (Unrealized PnL)</h3>
                <canvas id="chart-position-pnl"></canvas>
            </div>
        </div>
        <!-- Supabase-powered charts (show when bot has run) -->
        <div class="chart-row" id="sb-chart-equity" style="display:none">
            <div class="chart-card chart-full tall">
                <h3>Equity Curve & Cumulative PnL</h3>
                <canvas id="chart-equity"></canvas>
            </div>
        </div>
        <div class="chart-row" id="sb-chart-trades" style="display:none">
            <div class="chart-card">
                <h3>PnL Per Trade</h3>
                <canvas id="chart-pnl-per-trade"></canvas>
            </div>
            <div class="chart-card">
                <h3>Win / Loss Distribution</h3>
                <canvas id="chart-winloss"></canvas>
            </div>
        </div>
        <div class="chart-row" id="sb-chart-symbols" style="display:none">
            <div class="chart-card">
                <h3>PnL by Symbol</h3>
                <canvas id="chart-by-symbol"></canvas>
            </div>
            <div class="chart-card">
                <h3>Cycle Mode Activity</h3>
                <canvas id="chart-scan-activity"></canvas>
            </div>
        </div>
    </div>

    <!-- Tabs + Tables -->
    <div id="tables-section" style="display:none">
        <div class="tabs">
            <button class="tab active" onclick="switchTab('trades')">Trade History</button>
            <button class="tab" onclick="switchTab('scans')">Scan & Triggers</button>
            <button class="tab" onclick="switchTab('analyses')">Bot Analyses</button>
        </div>

        <!-- Filter bar -->
        <div class="filter-bar">
            <label>Action</label>
            <select id="filter-action" onchange="applyFilters()">
                <option value="all">All</option>
                <option value="BUY">BUY</option>
                <option value="SELL">SELL</option>
            </select>
            <label>Symbol</label>
            <select id="filter-symbol" onchange="applyFilters()"><option value="all">All</option></select>
            <label>From</label>
            <input type="date" id="filter-start" onchange="applyFilters()" />
            <label>To</label>
            <input type="date" id="filter-end" onchange="applyFilters()" />
        </div>

        <!-- Trades Table -->
        <div class="table-card" id="tab-trades">
            <div class="table-header">
                <h3>Trade History</h3>
                <span class="count" id="trade-count">0 trades</span>
            </div>
            <div class="table-wrap"><table id="trades-table"><thead><tr></tr></thead><tbody></tbody></table></div>
            <div class="pagination">
                <span id="trade-page-info">—</span>
                <div class="pagination-btns">
                    <button class="btn btn-outline" onclick="tradePage(-1)">← Prev</button>
                    <button class="btn btn-outline" onclick="tradePage(1)">Next →</button>
                </div>
            </div>
        </div>

        <!-- Scans Table -->
        <div class="table-card" id="tab-scans" style="display:none">
            <div class="table-header">
                <h3>Scan & Trigger Log</h3>
                <span class="count" id="scan-count">0 events</span>
            </div>
            <div class="table-wrap"><table id="scans-table"><thead><tr></tr></thead><tbody></tbody></table></div>
            <div class="pagination">
                <span id="scan-page-info">—</span>
                <div class="pagination-btns">
                    <button class="btn btn-outline" onclick="scanPage(-1)">← Prev</button>
                    <button class="btn btn-outline" onclick="scanPage(1)">Next →</button>
                </div>
            </div>
        </div>

        <!-- Analyses Table -->
        <div class="table-card" id="tab-analyses" style="display:none">
            <div class="table-header">
                <h3>Bot Self-Analyses</h3>
                <span class="count" id="analysis-count">0 analyses</span>
            </div>
            <div class="table-wrap" id="analyses-content"></div>
        </div>
    </div>

    <!-- Debug / Error banner -->
    <div id="error-banner" style="display:none; background:var(--red-bg); border:1px solid var(--red); border-radius:var(--radius); padding:12px 16px; margin-bottom:var(--gap); font-size:13px; color:var(--red);">
        <strong>Error:</strong> <span id="error-text"></span>
    </div>
    <div id="info-banner" style="display:none; background:var(--blue-bg); border:1px solid var(--blue); border-radius:var(--radius); padding:12px 16px; margin-bottom:var(--gap); font-size:13px; color:var(--blue);">
        <span id="info-text"></span>
    </div>

    <!-- Empty state before connection -->
    <div class="empty-state" id="empty-state">
        <h3>Connect to Supabase to view your bot's performance</h3>
        <p>Enter your Supabase URL and anon key above. Your credentials stay in this browser only.</p>
    </div>
</div>

<script>
// ── State ────────────────────────────────────────────────────────────────────
let supabaseUrl = '';
let supabaseKey = '';
let allTrades = [];
let allSnapshots = [];
let allMetrics = [];
let allAnalyses = [];
let filteredTrades = [];
let tradePageNum = 0;
let scanPageNum = 0;
const PAGE_SIZE = 50;
const charts = {};
let alpacaKey = '';
let alpacaSecret = '';
let livePrices = {};  // symbol -> { price, change_pct }
let openPositions = []; // derived from trades
let autoRefreshTimer = null;
let isRefreshing = false;

const COLORS = {
    green: '#3fb950', red: '#f85149', blue: '#58a6ff',
    orange: '#d29922', purple: '#bc8cff', cyan: '#39d2c0',
    gray: '#484f58',
};

// ── Supabase REST Helpers ────────────────────────────────────────────────────
async function sbFetch(table, query = '') {
    const res = await fetch(\`\${supabaseUrl}/rest/v1/\${table}?\${query}\`, {
        headers: {
            'apikey': supabaseKey,
            'Authorization': \`Bearer \${supabaseKey}\`,
            'Content-Type': 'application/json',
            'Prefer': 'count=exact',
        },
    });
    if (!res.ok) {
        console.warn(\`Supabase \${table}: \${res.status} \${res.statusText} (table may not exist yet)\`);
        return { data: [], count: 0 };
    }
    const count = res.headers.get('content-range')?.split('/')[1] ?? null;
    const data = await res.json();
    return { data, count: count ? parseInt(count) : data.length };
}

// Safe fetch — returns empty on error (for optional tables)
async function sbFetchSafe(table, query = '') {
    try { return await sbFetch(table, query); }
    catch (e) { console.warn(\`Table "\${table}" not available:\`, e.message); return { data: [], count: 0 }; }
}

// ── Connect ──────────────────────────────────────────────────────────────────
async function connectSupabase() {
    supabaseUrl = document.getElementById('input-url').value.replace(/\\/$/, '');
    supabaseKey = document.getElementById('input-key').value.trim();
    if (!supabaseUrl || !supabaseKey) return alert('Please enter both URL and key.');

    setStatus('loading', 'Connecting...');
    document.getElementById('connect-btn').disabled = true;

    try {
        // Test connection — try trades table (guaranteed to exist if bot ran)
        const testRes = await fetch(\`\${supabaseUrl}/rest/v1/trades?limit=1\`, {
            headers: { 'apikey': supabaseKey, 'Authorization': \`Bearer \${supabaseKey}\` },
        });
        if (!testRes.ok) {
            const body = await testRes.text();
            throw new Error(\`\${testRes.status} \${testRes.statusText} — \${body}\`);
        }
        setStatus('connected', 'Connected');
        document.getElementById('refresh-btn').disabled = false;
        document.getElementById('empty-state').style.display = 'none';
        document.getElementById('kpi-section').style.display = '';
        document.getElementById('charts-section').style.display = '';
        document.getElementById('tables-section').style.display = '';
        // Save to memory for this session
        sessionStorage.setItem('sb_url', supabaseUrl);
        sessionStorage.setItem('sb_key', supabaseKey);
        await refreshData();
    } catch (err) {
        setStatus('disconnected', 'Failed');
        showError('Connection failed: ' + err.message);
    }
    document.getElementById('connect-btn').disabled = false;
}

function setStatus(type, text) {
    const el = document.getElementById('conn-status');
    el.textContent = text;
    el.className = \`status status-\${type}\`;
    document.getElementById('live-dot').style.background = type === 'connected' ? COLORS.green : type === 'loading' ? COLORS.orange : COLORS.red;
}

function showError(msg) {
    const banner = document.getElementById('error-banner');
    document.getElementById('error-text').textContent = msg;
    banner.style.display = '';
    setTimeout(() => banner.style.display = 'none', 15000);
}

function showInfo(msg) {
    const banner = document.getElementById('info-banner');
    document.getElementById('info-text').textContent = msg;
    banner.style.display = '';
    setTimeout(() => banner.style.display = 'none', 10000);
}

// ── Refresh All Data ─────────────────────────────────────────────────────────
async function refreshData() {
    setStatus('loading', 'Refreshing...');
    try {
        // Core tables (trades + snapshots) — these must exist
        const [trades, snapshots] = await Promise.all([
            sbFetch('trades', 'order=created_at.desc&limit=1000'),
            sbFetch('portfolio_snapshots', 'order=created_at.asc&limit=2000'),
        ]);

        // Optional tables — gracefully return empty if they don't exist yet
        const [metrics, analyses] = await Promise.all([
            sbFetchSafe('performance_metrics', 'order=created_at.desc&limit=1'),
            sbFetchSafe('bot_analyses', 'order=created_at.desc&limit=10'),
        ]);

        allTrades = trades.data;
        allSnapshots = snapshots.data;
        allMetrics = metrics.data;
        allAnalyses = analyses.data;

        console.log(\`Loaded: \${allTrades.length} trades, \${allSnapshots.length} snapshots, \${allMetrics.length} metrics, \${allAnalyses.length} analyses\`);

        if (allTrades.length === 0 && allSnapshots.length === 0) {
            showInfo('Connected to Supabase but no data found yet. Run the bot at least once to see data here.');
        }

        populateSymbolFilter();
        applyFilters();
        computeOpenPositions();
        renderKPIs();
        renderCharts();
        renderAnalyses();
        // If Alpaca is connected, refresh positions
        if (alpacaKey && alpacaSecret && alpacaAccount) {
            try { await connectAlpaca(); } catch(e) { console.warn('Alpaca refresh:', e); }
        }
        setStatus('connected', \`Connected · \${new Date().toLocaleTimeString()}\`);
    } catch (err) {
        setStatus('disconnected', 'Error');
        showError('Data refresh failed: ' + err.message + ' — Check browser console (Cmd+Option+I) for details.');
        console.error('refreshData error:', err);
    }
}

// ── KPIs ─────────────────────────────────────────────────────────────────────
function renderKPIs() {
    // Only show bot-specific KPI cards when Supabase has closed trades
    const closedTrades = allTrades.filter(t => t.pnl != null && t.status === 'closed');
    if (closedTrades.length === 0) return; // Alpaca KPIs are handled by renderAlpacaKPIs

    // Show the advanced KPI cards
    document.getElementById('kpi-card-winrate').style.display = '';
    document.getElementById('kpi-card-sharpe').style.display = '';

    // Override PnL with realized from Supabase
    const totalPnl = closedTrades.reduce((s, t) => s + parseFloat(t.pnl || 0), 0);
    setKPI('kpi-pnl', \`\${totalPnl >= 0 ? '+' : ''}$\${totalPnl.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}\`,
        \`Realized · \${closedTrades.length} closed trades\`, totalPnl >= 0 ? 'positive' : 'negative');
    // Relabel
    const pnlLabel = document.querySelector('#kpi-pnl')?.closest('.kpi-card')?.querySelector('.kpi-label');
    if (pnlLabel) pnlLabel.textContent = 'Realized PnL';

    const m = allMetrics[0];
    if (m) {
        const wr = m.win_rate != null ? (m.win_rate * 100).toFixed(1) : '—';
        setKPI('kpi-winrate', \`\${wr}%\`, \`\${m.winning_trades ?? '?'}W / \${m.losing_trades ?? '?'}L\`, parseFloat(wr) >= 50 ? 'positive' : 'negative');
        setKPI('kpi-sharpe', m.sharpe_ratio != null ? m.sharpe_ratio.toFixed(2) : '—',
            'Risk-adjusted return', m.sharpe_ratio >= 1 ? 'positive' : m.sharpe_ratio >= 0 ? 'neutral' : 'negative');
    } else {
        const winners = closedTrades.filter(t => parseFloat(t.pnl) > 0);
        const losers = closedTrades.filter(t => parseFloat(t.pnl) < 0);
        const wr = closedTrades.length > 0 ? (winners.length / closedTrades.length * 100).toFixed(1) : '—';
        setKPI('kpi-winrate', \`\${wr}%\`, \`\${winners.length}W / \${losers.length}L\`, parseFloat(wr) >= 50 ? 'positive' : 'negative');
        setKPI('kpi-sharpe', '—', 'Run bot 5+ cycles', 'neutral');
    }
}

function setKPI(id, value, sub, subClass) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = value;
    const subEl = document.getElementById(id + '-sub');
    if (subEl) { subEl.textContent = sub; subEl.className = \`kpi-sub \${subClass}\`; }
}

// ── Charts ───────────────────────────────────────────────────────────────────
function renderCharts() {
    // Alpaca equity chart — show if we have portfolio history
    if (alpacaPortfolioHistory && alpacaPortfolioHistory.timestamp?.length > 1) {
        document.getElementById('alpaca-chart-equity').style.display = '';
        try { renderAlpacaEquityChart(); } catch(e) { console.warn('Alpaca equity chart error:', e); }
    }
    // Alpaca position charts — show if we have positions
    if (alpacaPositions.length > 0) {
        document.getElementById('alpaca-charts').style.display = '';
        try { renderAllocationChart(); } catch(e) { console.warn('Allocation chart error:', e); }
        try { renderPositionPnlChart(); } catch(e) { console.warn('Position PnL chart error:', e); }
    }

    // Supabase charts — only show if we have real data
    const closedTrades = allTrades.filter(t => t.pnl != null);
    if (allSnapshots.length > 2) {
        document.getElementById('sb-chart-equity').style.display = '';
        try { renderEquityCurve(); } catch(e) { console.warn('Equity chart error:', e); }
    }
    if (closedTrades.length > 0) {
        document.getElementById('sb-chart-trades').style.display = '';
        try { renderPnlPerTrade(); } catch(e) { console.warn('PnL chart error:', e); }
        try { renderWinLoss(); } catch(e) { console.warn('Win/Loss chart error:', e); }
    }
    if (closedTrades.length > 0) {
        document.getElementById('sb-chart-symbols').style.display = '';
        try { renderBySymbol(); } catch(e) { console.warn('Symbol chart error:', e); }
        try { renderScanActivity(); } catch(e) { console.warn('Scan chart error:', e); }
    }
}

function renderAlpacaEquityChart() {
    const h = alpacaPortfolioHistory;
    if (!h || !h.timestamp?.length) return;

    const STARTING_CAPITAL = 100000;
    const FUNDED_THRESHOLD = 1000; // filter out pre-funding $0 data points

    // Filter out data points where equity is below threshold (pre-funding period)
    const validIndices = [];
    for (let i = 0; i < h.equity.length; i++) {
        if (h.equity[i] != null && h.equity[i] >= FUNDED_THRESHOLD) {
            validIndices.push(i);
        }
    }
    // If no valid data after filtering, skip rendering
    if (validIndices.length === 0) return;

    const labels = validIndices.map(i => new Date(h.timestamp[i] * 1000));
    const equityData = validIndices.map(i => h.equity[i]);
    const plData = validIndices.map(i => h.profit_loss[i]);

    // Calculate Y-axis range centered around $100K
    const minEquity = Math.min(...equityData);
    const maxEquity = Math.max(...equityData);
    // Ensure $100K baseline is visible with some padding
    const yMin = Math.min(minEquity, STARTING_CAPITAL) - 500;
    const yMax = Math.max(maxEquity, STARTING_CAPITAL) + 500;

    if (charts.alpacaEquity) charts.alpacaEquity.destroy();
    charts.alpacaEquity = new Chart(document.getElementById('chart-alpaca-equity'), {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Equity',
                    data: equityData,
                    borderColor: '#58a6ff', backgroundColor: 'rgba(88,166,255,0.08)',
                    borderWidth: 2, fill: true, tension: 0.3, pointRadius: 0, pointHoverRadius: 5,
                    pointBackgroundColor: '#58a6ff',
                    yAxisID: 'y',
                },
                {
                    label: 'Profit / Loss',
                    data: plData,
                    borderColor: plData[plData.length-1] >= 0 ? '#3fb950' : '#f85149',
                    backgroundColor: plData[plData.length-1] >= 0 ? 'rgba(63,185,80,0.08)' : 'rgba(248,81,73,0.08)',
                    borderWidth: 2, fill: true, tension: 0.3, pointRadius: 0, pointHoverRadius: 4,
                    yAxisID: 'y1',
                },
                {
                    // $100K baseline reference line
                    label: '$100K Baseline',
                    data: labels.map(() => STARTING_CAPITAL),
                    borderColor: '#484f58', borderDash: [6, 4],
                    borderWidth: 1, fill: false, pointRadius: 0, pointHoverRadius: 0,
                    yAxisID: 'y',
                }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'top', labels: { color: '#8b949e', usePointStyle: true, padding: 16,
                    filter: item => item.text !== '$100K Baseline' // hide baseline from legend
                } },
                tooltip: {
                    backgroundColor: '#21262d', borderColor: '#30363d', borderWidth: 1,
                    titleColor: '#e6edf3', bodyColor: '#8b949e',
                    filter: item => item.dataset.label !== '$100K Baseline', // hide baseline from tooltip
                    callbacks: {
                        title: ctx => ctx[0]?.label ? new Date(ctx[0].label).toLocaleString(undefined, {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '',
                        label: ctx => \`\${ctx.dataset.label}: $\${ctx.parsed.y?.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}) ?? '—'}\`
                    }
                }
            },
            scales: {
                x: {
                    type: 'time',
                    time: getXAxisConfig(currentEquityTimeframe),
                    grid: { color: '#21262d' }, ticks: { color: '#484f58', maxTicksLimit: 10 }
                },
                y: {
                    position: 'left', min: yMin, max: yMax,
                    grid: { color: '#21262d' },
                    ticks: { color: '#58a6ff', callback: v => '$' + v.toLocaleString() },
                    title: { display: true, text: 'Equity', color: '#58a6ff' }
                },
                y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: '#3fb950', callback: v => '$' + v.toLocaleString() }, title: { display: true, text: 'P/L', color: '#3fb950' } },
            }
        }
    });
}

// ── Equity Chart Timeframe Switching ─────────────────────────────────────────
let currentEquityTimeframe = '1W';
const equityHistoryCache = {}; // cache API responses by timeframe key

function getTimeframeParams(tf) {
    switch (tf) {
        case '1D':  return { period: '1D', timeframe: '5Min' };
        case '1W':  return { period: '1W', timeframe: '1H' };
        case '1M':  return { period: '1M', timeframe: '1D' };
        case 'ALL': return { period: '1A', timeframe: '1D', start: '2026-03-18T00:00:00Z' };
        default:    return { period: '1D', timeframe: '5Min' };
    }
}

function getXAxisConfig(tf) {
    switch (tf) {
        case '1D':  return { unit: 'hour', displayFormats: { hour: 'HH:mm', minute: 'HH:mm' }, tooltipFormat: 'MMM d HH:mm' };
        case '1W':  return { unit: 'day', displayFormats: { day: 'MMM d', hour: 'MMM d HH:mm' }, tooltipFormat: 'MMM d HH:mm' };
        case '1M':  return { unit: 'day', displayFormats: { day: 'MMM d' }, tooltipFormat: 'MMM d, yyyy' };
        case 'ALL': return { unit: 'week', displayFormats: { week: 'MMM d', day: 'MMM d' }, tooltipFormat: 'MMM d, yyyy' };
        default:    return { unit: 'hour', displayFormats: { hour: 'HH:mm' }, tooltipFormat: 'MMM d HH:mm' };
    }
}

async function changeEquityTimeframe(tf) {
    currentEquityTimeframe = tf;

    // Update button states
    document.querySelectorAll('#equity-timeframe-btns .btn-tf').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tf === tf);
    });

    // Check cache first
    if (equityHistoryCache[tf]) {
        alpacaPortfolioHistory = equityHistoryCache[tf];
        renderAlpacaEquityChart();
        return;
    }

    // Fetch from Alpaca
    if (!alpacaKey || !alpacaSecret) return;

    try {
        const params = getTimeframeParams(tf);
        let url = \`\${ALPACA_BASE}/v2/account/portfolio/history?period=\${params.period}&timeframe=\${params.timeframe}\`;
        if (params.start) url += \`&start=\${params.start}\`;

        const res = await fetch(url, { headers: alpacaHeaders() });
        if (res.ok) {
            const data = await res.json();
            equityHistoryCache[tf] = data;
            alpacaPortfolioHistory = data;
            renderAlpacaEquityChart();
        }
    } catch (e) {
        console.warn('Timeframe fetch error:', e);
    }
}

function renderAllocationChart() {
    const labels = alpacaPositions.map(p => p.symbol);
    const values = alpacaPositions.map(p => Math.abs(parseFloat(p.market_value)));
    const total = values.reduce((a, b) => a + b, 0);
    // Add cash slice
    if (alpacaAccount) {
        const cash = parseFloat(alpacaAccount.cash);
        if (cash > 0) {
            labels.push('Cash');
            values.push(cash);
        }
    }
    const palette = ['#58a6ff','#3fb950','#f85149','#d29922','#bc8cff','#39d2c0','#f778ba','#79c0ff','#7ee787','#ffa657'];
    const colors = values.map((_, i) => palette[i % palette.length]);
    // Last one (cash) is always gray
    if (alpacaAccount && parseFloat(alpacaAccount.cash) > 0) colors[colors.length - 1] = '#484f58';

    if (charts.allocation) charts.allocation.destroy();
    charts.allocation = new Chart(document.getElementById('chart-allocation'), {
        type: 'doughnut',
        data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: '#161b22', borderWidth: 3 }] },
        options: {
            responsive: true, maintainAspectRatio: false, animation: false, cutout: '60%',
            plugins: {
                legend: { position: 'right', labels: { color: '#8b949e', usePointStyle: true, padding: 10, font: { size: 12 } } },
                tooltip: { callbacks: { label: ctx => {
                    const val = ctx.parsed;
                    const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                    return \`\${ctx.label}: $\${val.toLocaleString(undefined,{minimumFractionDigits:0})} (\${(val/total*100).toFixed(1)}%)\`;
                }}}
            }
        }
    });
}

function renderPositionPnlChart() {
    const sorted = [...alpacaPositions].sort((a, b) => parseFloat(b.unrealized_pl) - parseFloat(a.unrealized_pl));
    const labels = sorted.map(p => p.symbol);
    const data = sorted.map(p => parseFloat(p.unrealized_pl));
    const pcts = sorted.map(p => (parseFloat(p.unrealized_plpc) * 100).toFixed(2));
    const bgColors = data.map(v => v >= 0 ? '#3fb950AA' : '#f85149AA');
    const borderColors = data.map(v => v >= 0 ? '#3fb950' : '#f85149');

    if (charts.positionPnl) charts.positionPnl.destroy();
    charts.positionPnl = new Chart(document.getElementById('chart-position-pnl'), {
        type: 'bar',
        data: { labels, datasets: [{ label: 'Unrealized PnL', data, backgroundColor: bgColors, borderColor: borderColors, borderWidth: 1, borderRadius: 4 }] },
        options: {
            responsive: true, maintainAspectRatio: false, animation: false, indexAxis: 'y',
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => \`$\${ctx.parsed.x.toFixed(2)} (\${pcts[ctx.dataIndex]}%)\` } }
            },
            scales: {
                x: { grid: { color: '#21262d' }, ticks: { color: '#484f58', callback: v => '$' + v } },
                y: { grid: { display: false }, ticks: { color: '#8b949e', font: { weight: 'bold' } } },
            }
        }
    });
}

function renderEquityCurve() {
    if (allSnapshots.length === 0) return;
    const labels = allSnapshots.map(s => s.created_at);
    const equityData = allSnapshots.map(s => parseFloat(s.equity));

    // Cumulative realized PnL curve
    const tradesByDate = allTrades
        .filter(t => t.pnl != null)
        .sort((a,b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    let cumPnl = 0;
    const pnlPoints = tradesByDate.map(t => { cumPnl += parseFloat(t.pnl); return { x: t.created_at, y: cumPnl }; });

    if (charts.equity) charts.equity.destroy();
    charts.equity = new Chart(document.getElementById('chart-equity'), {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Equity',
                    data: equityData,
                    borderColor: COLORS.blue,
                    backgroundColor: COLORS.blue + '15',
                    borderWidth: 2, fill: true, tension: 0.3, pointRadius: 0, pointHoverRadius: 4,
                    yAxisID: 'y',
                },
                {
                    label: 'Cumulative Realized PnL',
                    data: pnlPoints,
                    borderColor: COLORS.green,
                    backgroundColor: COLORS.green + '15',
                    borderWidth: 2, fill: true, tension: 0.3, pointRadius: 0, pointHoverRadius: 4,
                    yAxisID: 'y1',
                },
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position:'top', labels:{ color:COLORS.gray, usePointStyle:true, padding:16 } },
                tooltip: {
                    backgroundColor: '#21262d', borderColor: '#30363d', borderWidth: 1,
                    titleColor: '#e6edf3', bodyColor: '#8b949e',
                    callbacks: { label: ctx => \`\${ctx.dataset.label}: $\${ctx.parsed.y?.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}) ?? '—'}\` }
                }
            },
            scales: {
                x: { type:'time', time:{ tooltipFormat:'MMM d, HH:mm' }, grid:{color:'#21262d'}, ticks:{color:COLORS.gray, maxTicksLimit:12} },
                y: { position:'left', grid:{color:'#21262d'}, ticks:{color:COLORS.blue, callback:v=>'$'+v.toLocaleString()}, title:{display:true, text:'Equity', color:COLORS.blue} },
                y1: { position:'right', grid:{drawOnChartArea:false}, ticks:{color:COLORS.green, callback:v=>'$'+v.toLocaleString()}, title:{display:true, text:'Cum. PnL', color:COLORS.green} },
            }
        }
    });
}

function renderPnlPerTrade() {
    const closed = allTrades.filter(t => t.pnl != null).sort((a,b)=>new Date(a.created_at).getTime()-new Date(b.created_at).getTime()).slice(-60);
    const labels = closed.map(t => t.symbol || '?');
    const data = closed.map(t => parseFloat(t.pnl));
    const bgColors = data.map(v => v >= 0 ? COLORS.green + 'AA' : COLORS.red + 'AA');
    const borderColors = data.map(v => v >= 0 ? COLORS.green : COLORS.red);

    if (charts.pnlPerTrade) charts.pnlPerTrade.destroy();
    charts.pnlPerTrade = new Chart(document.getElementById('chart-pnl-per-trade'), {
        type: 'bar',
        data: { labels, datasets: [{ label:'PnL', data, backgroundColor:bgColors, borderColor:borderColors, borderWidth:1, borderRadius:3 }] },
        options: {
            responsive:true, maintainAspectRatio:false, animation:false,
            plugins: { legend:{display:false}, tooltip:{ callbacks:{ label:ctx=>\`$\${ctx.parsed.y.toFixed(2)}\` } } },
            scales: {
                x: { grid:{display:false}, ticks:{color:COLORS.gray, maxRotation:45} },
                y: { grid:{color:'#21262d'}, ticks:{color:COLORS.gray, callback:v=>'$'+v} },
            }
        }
    });
}

function renderWinLoss() {
    const closed = allTrades.filter(t => t.pnl != null);
    const wins = closed.filter(t => parseFloat(t.pnl) > 0).length;
    const losses = closed.filter(t => parseFloat(t.pnl) < 0).length;
    const breakeven = closed.filter(t => parseFloat(t.pnl) === 0).length;

    if (charts.winloss) charts.winloss.destroy();
    charts.winloss = new Chart(document.getElementById('chart-winloss'), {
        type: 'doughnut',
        data: {
            labels: ['Wins', 'Losses', 'Breakeven'],
            datasets: [{ data:[wins, losses, breakeven], backgroundColor:[COLORS.green+'CC', COLORS.red+'CC', COLORS.gray+'CC'], borderColor:'#161b22', borderWidth:3 }]
        },
        options: {
            responsive:true, maintainAspectRatio:false, animation:false, cutout:'65%',
            plugins: {
                legend: { position:'right', labels:{color:COLORS.gray, usePointStyle:true, padding:12} },
                tooltip: { callbacks:{ label:ctx=> { const t=ctx.dataset.data.reduce((a,b)=>a+b,0); return \`\${ctx.label}: \${ctx.parsed} (\${(ctx.parsed/t*100).toFixed(1)}%)\`; } } }
            }
        }
    });
}

function renderBySymbol() {
    const symbolPnl = {};
    allTrades.filter(t => t.pnl != null && t.symbol).forEach(t => {
        symbolPnl[t.symbol] = (symbolPnl[t.symbol] || 0) + parseFloat(t.pnl);
    });
    const sorted = Object.entries(symbolPnl).sort((a,b) => b[1] - a[1]).slice(0, 15);
    const labels = sorted.map(s => s[0]);
    const data = sorted.map(s => +s[1].toFixed(2));
    const colors = data.map(v => v >= 0 ? COLORS.green + 'AA' : COLORS.red + 'AA');

    if (charts.bySymbol) charts.bySymbol.destroy();
    charts.bySymbol = new Chart(document.getElementById('chart-by-symbol'), {
        type: 'bar',
        data: { labels, datasets:[{ label:'PnL', data, backgroundColor:colors, borderRadius:3 }] },
        options: {
            responsive:true, maintainAspectRatio:false, animation:false, indexAxis:'y',
            plugins:{ legend:{display:false}, tooltip:{callbacks:{label:ctx=>\`$\${ctx.parsed.x.toFixed(2)}\`}} },
            scales: {
                x: { grid:{color:'#21262d'}, ticks:{color:COLORS.gray, callback:v=>'$'+v} },
                y: { grid:{display:false}, ticks:{color:COLORS.gray} },
            }
        }
    });
}

function renderScanActivity() {
    // Count scan vs full vs trigger cycles by date
    const scans = allTrades.filter(t => t.status === 'scan' || t.action?.startsWith('SCAN'));
    const fullCycles = allTrades.filter(t => t.action && !t.action.startsWith('SCAN') && t.action !== 'HOLD' && t.status !== 'scan');

    // Group by day
    const days = {};
    scans.forEach(t => {
        const d = t.created_at?.split('T')[0];
        if (!d) return;
        if (!days[d]) days[d] = {scan_quiet:0, scan_triggered:0, trades:0};
        if (t.action === 'SCAN_TRIGGERED') days[d].scan_triggered++;
        else days[d].scan_quiet++;
    });
    fullCycles.forEach(t => {
        const d = t.created_at?.split('T')[0];
        if (!d) return;
        if (!days[d]) days[d] = {scan_quiet:0, scan_triggered:0, trades:0};
        days[d].trades++;
    });

    const labels = Object.keys(days).sort().slice(-14);
    const scanQuiet = labels.map(d => days[d]?.scan_quiet || 0);
    const scanTriggered = labels.map(d => days[d]?.scan_triggered || 0);
    const trades = labels.map(d => days[d]?.trades || 0);

    if (charts.scanActivity) charts.scanActivity.destroy();
    charts.scanActivity = new Chart(document.getElementById('chart-scan-activity'), {
        type: 'bar',
        data: {
            labels,
            datasets: [
                { label:'Quiet Scans', data:scanQuiet, backgroundColor:COLORS.gray+'88', borderRadius:2, stack:'s' },
                { label:'Triggered Scans', data:scanTriggered, backgroundColor:COLORS.orange+'AA', borderRadius:2, stack:'s' },
                { label:'Trades Executed', data:trades, backgroundColor:COLORS.blue+'AA', borderRadius:2, stack:'s' },
            ]
        },
        options: {
            responsive:true, maintainAspectRatio:false, animation:false,
            plugins:{ legend:{position:'top', labels:{color:COLORS.gray, usePointStyle:true, padding:12}} },
            scales: {
                x: { stacked:true, grid:{display:false}, ticks:{color:COLORS.gray} },
                y: { stacked:true, grid:{color:'#21262d'}, ticks:{color:COLORS.gray}, beginAtZero:true },
            }
        }
    });
}

// ── Tables ───────────────────────────────────────────────────────────────────
function populateSymbolFilter() {
    const symbols = [...new Set(allTrades.map(t => t.symbol).filter(Boolean))].sort();
    const sel = document.getElementById('filter-symbol');
    sel.innerHTML = '<option value="all">All</option>';
    symbols.forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; sel.appendChild(o); });
}

function applyFilters() {
    const action = document.getElementById('filter-action').value;
    const symbol = document.getElementById('filter-symbol').value;
    const start = document.getElementById('filter-start').value;
    const end = document.getElementById('filter-end').value;

    filteredTrades = allTrades.filter(t => {
        if (action !== 'all' && t.action !== action) return false;
        if (symbol !== 'all' && t.symbol !== symbol) return false;
        if (start && t.created_at < start) return false;
        if (end && t.created_at > end + 'T23:59:59') return false;
        return true;
    });

    tradePageNum = 0;
    scanPageNum = 0;
    renderTradesTable();
    renderScansTable();
}

function renderTradesTable() {
    // Merge Supabase trades + Alpaca orders into a unified list
    let trades = filteredTrades.filter(t => t.status !== 'scan' && t.action !== 'HOLD');

    // Build buy prices map from Alpaca orders (for PnL calc)
    const buyPrices = {};
    const filledOrders = alpacaOrders
        .filter(o => o.filled_qty && parseFloat(o.filled_qty) > 0)
        .sort((a, b) => new Date(a.filled_at || a.created_at) - new Date(b.filled_at || b.created_at));
    for (const o of filledOrders) {
        if (o.side === 'buy' && o.filled_avg_price) {
            buyPrices[o.symbol] = parseFloat(o.filled_avg_price); // latest buy price per symbol
        }
    }

    // If Supabase has no trades, use Alpaca orders
    let useAlpaca = false;
    if (trades.length === 0 && alpacaOrders.length > 0) {
        useAlpaca = true;
        trades = filledOrders.map(o => {
            const isBuy = o.side === 'buy';
            const isSell = o.side === 'sell';
            const filledPrice = parseFloat(o.filled_avg_price);
            const qty = parseFloat(o.filled_qty);
            const entryPrice = buyPrices[o.symbol] || null;

            let pnl = null;
            if (isSell && entryPrice && filledPrice) {
                pnl = (filledPrice - entryPrice) * qty;
            }

            return {
                created_at: o.filled_at || o.submitted_at || o.created_at,
                symbol: o.symbol,
                action: o.side?.toUpperCase(),
                quantity: qty,
                price_entry: isBuy ? filledPrice : entryPrice,
                price_exit: isSell ? filledPrice : null,
                filled_price: filledPrice,
                pnl: pnl,
                status: o.status,
                reason: \`\${o.type} \${o.time_in_force} · \${o.status}\`,
                order_type: o.type,
            };
        });
    }

    // Also include pending orders (not yet filled) so user sees all activity
    if (useAlpaca) {
        const pendingOrders = alpacaOrders
            .filter(o => !o.filled_qty || parseFloat(o.filled_qty) === 0)
            .filter(o => ['pending_new', 'accepted', 'new', 'partially_filled'].includes(o.status))
            .map(o => ({
                created_at: o.submitted_at || o.created_at,
                symbol: o.symbol,
                action: o.side?.toUpperCase(),
                quantity: parseFloat(o.qty),
                price_entry: o.side === 'buy' ? null : buyPrices[o.symbol] || null,
                price_exit: null,
                filled_price: null,
                pnl: null,
                status: '⏳ ' + o.status,
                reason: \`\${o.type} \${o.time_in_force} · pending\`,
                order_type: o.type,
            }));
        trades = [...trades, ...pendingOrders];
    }

    // Sort by time — most recent first
    trades.sort((a, b) => {
        const tA = a.created_at ? new Date(a.created_at).getTime() : 0;
        const tB = b.created_at ? new Date(b.created_at).getTime() : 0;
        return tB - tA;
    });

    document.getElementById('trade-count').textContent = \`\${trades.length} trades\${useAlpaca ? ' (from Alpaca)' : ''}\`;

    const start = tradePageNum * PAGE_SIZE;
    const page = trades.slice(start, start + PAGE_SIZE);
    document.getElementById('trade-page-info').textContent = trades.length > 0
        ? \`\${start + 1}–\${Math.min(start + PAGE_SIZE, trades.length)} of \${trades.length}\`
        : 'No trades yet';

    const thead = document.querySelector('#trades-table thead tr');
    thead.innerHTML = ['Time','Symbol','Side','Qty','Price Paid','Price Sold','Current','PnL','Status'].map(h => \`<th>\${h}</th>\`).join('');

    const tbody = document.querySelector('#trades-table tbody');
    if (trades.length === 0) {
        tbody.innerHTML = \`<tr><td colspan="9" style="text-align:center; padding:40px; color:var(--text-secondary);">No trades yet. Connect Alpaca or run the bot to see trade history.</td></tr>\`;
        return;
    }

    tbody.innerHTML = page.map(t => {
        const isBuy = (t.action || '').toUpperCase().includes('BUY');
        const isSell = (t.action || '').toUpperCase().includes('SELL');
        const isProfitTake = (t.action || '').toUpperCase().includes('PROFIT_TAKE');
        const actionPill = isProfitTake ? 'pill-sell' : isBuy ? 'pill-buy' : isSell ? 'pill-sell' : 'pill-hold';
        const actionLabel = isProfitTake ? '💰 PROFIT' : (t.action || '—').toUpperCase();
        const time = t.created_at ? new Date(t.created_at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '—';

        // Price columns — compute from all available data
        const entryPrice = t.price_entry ? parseFloat(t.price_entry)
                         : (t.filled_price && isBuy) ? t.filled_price : null;
        const exitPrice = t.price_exit ? parseFloat(t.price_exit)
                        : (t.filled_price && (isSell || isProfitTake)) ? t.filled_price : null;

        const pricePaid = entryPrice ? '$' + entryPrice.toFixed(2) : '—';
        const priceSold = exitPrice ? '$' + exitPrice.toFixed(2) : '—';

        // Current price from live Alpaca positions data
        const curPrice = livePrices[t.symbol]?.price;
        const curPriceStr = curPrice ? '$' + curPrice.toFixed(2) : '—';

        // PnL calculation — use stored PnL, or compute from prices
        let pnl = t.pnl != null ? parseFloat(t.pnl) : null;
        const qty = t.quantity ? parseFloat(t.quantity) : 0;

        if (pnl == null && qty > 0) {
            if (exitPrice && entryPrice) {
                // Closed trade: (sell price - buy price) × qty
                pnl = (exitPrice - entryPrice) * qty;
            } else if (isBuy && entryPrice && curPrice) {
                // Open buy: (current price - buy price) × qty
                pnl = (curPrice - entryPrice) * qty;
            } else if ((isSell || isProfitTake) && exitPrice && curPrice) {
                // Sell with no entry: show as realized at sell price
                pnl = null; // Can't compute without entry
            }
        }

        // Also compute % gain/loss
        let pnlPct = null;
        if (pnl != null && entryPrice && qty > 0) {
            pnlPct = ((pnl / (entryPrice * qty)) * 100).toFixed(1);
        }

        const pnlClass = pnl > 0 ? 'pnl-positive' : pnl < 0 ? 'pnl-negative' : '';
        const pnlStr = pnl != null
            ? \`\${pnl >= 0 ? '+' : ''}$\${pnl.toFixed(2)}\${pnlPct ? \` (\${pnlPct}%)\` : ''}\`
            : '—';

        return \`<tr>
            <td>\${time}</td>
            <td><strong>\${t.symbol || '—'}</strong></td>
            <td><span class="pill \${actionPill}">\${actionLabel}</span></td>
            <td>\${qty || '—'}</td>
            <td class="price-cell price-entry">\${pricePaid}</td>
            <td class="price-cell price-exit">\${priceSold}</td>
            <td class="price-cell price-current-cell">\${curPriceStr}</td>
            <td class="\${pnlClass}">\${pnlStr}</td>
            <td title="\${t.reason || ''}">\${(t.reason || t.status || '—').slice(0, 50)}</td>
        </tr>\`;
    }).join('');
}

function renderScansTable() {
    const scans = filteredTrades.filter(t => t.status === 'scan' || t.action?.startsWith('SCAN'));
    document.getElementById('scan-count').textContent = \`\${scans.length} events\`;

    const start = scanPageNum * PAGE_SIZE;
    const page = scans.slice(start, start + PAGE_SIZE);
    document.getElementById('scan-page-info').textContent = \`\${Math.min(start + 1, scans.length)}–\${Math.min(start + PAGE_SIZE, scans.length)} of \${scans.length}\`;

    const thead = document.querySelector('#scans-table thead tr');
    thead.innerHTML = ['Time','Type','Triggers','Details'].map(h => \`<th>\${h}</th>\`).join('');

    const tbody = document.querySelector('#scans-table tbody');
    tbody.innerHTML = page.map(t => {
        const time = t.created_at ? new Date(t.created_at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
        const typePill = t.action === 'SCAN_TRIGGERED' ? 'pill-buy' : 'pill-scan';
        return \`<tr>
            <td>\${time}</td>
            <td><span class="pill \${typePill}">\${t.action === 'SCAN_TRIGGERED' ? 'TRIGGERED' : 'QUIET'}</span></td>
            <td>\${t.quantity ?? 0}</td>
            <td title="\${t.reason || ''}">\${(t.reason || '—').slice(0, 100)}\${(t.reason?.length || 0) > 100 ? '...' : ''}</td>
        </tr>\`;
    }).join('');
}

function renderAnalyses() {
    document.getElementById('analysis-count').textContent = \`\${allAnalyses.length} analyses\`;
    const container = document.getElementById('analyses-content');
    if (!allAnalyses.length) { container.innerHTML = '<div class="empty-state"><p>No analyses yet.</p></div>'; return; }

    container.innerHTML = allAnalyses.map(a => {
        const time = new Date(a.created_at).toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'});
        const typePill = a.type === 'weekly_summary' ? 'pill-buy' : 'pill-scan';
        return \`<div style="padding:16px 20px; border-bottom:1px solid var(--border);">
            <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
                <span><strong>Cycle #\${a.trade_count}</strong> · \${time}</span>
                <span class="pill \${typePill}">\${a.type === 'weekly_summary' ? 'Weekly Summary' : 'Self-Analysis'}</span>
            </div>
            <pre style="white-space:pre-wrap; font-size:12px; color:var(--text-secondary); line-height:1.6; max-height:300px; overflow-y:auto;">\${(a.analysis || '').replace(/</g,'&lt;')}</pre>
        </div>\`;
    }).join('');
}

// ── Open Positions ──────────────────────────────────────────────────────────
function computeOpenPositions() {
    // Derive open positions from trades: BUY adds, SELL removes
    const holdings = {};  // symbol -> { qty, totalCost, entries: [] }
    const sortedTrades = [...allTrades]
        .filter(t => t.action === 'BUY' || t.action === 'SELL' || t.action === 'BUY_REJECTED' || t.action === 'SELL_REJECTED')
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    sortedTrades.forEach(t => {
        if (t.action === 'BUY_REJECTED' || t.action === 'SELL_REJECTED') return;
        const sym = t.symbol;
        if (!sym) return;
        const qty = parseInt(t.quantity) || 0;
        const price = parseFloat(t.price_entry || t.price || 0);

        if (t.action === 'BUY') {
            if (!holdings[sym]) holdings[sym] = { qty: 0, totalCost: 0, entries: [] };
            holdings[sym].qty += qty;
            holdings[sym].totalCost += qty * price;
            holdings[sym].entries.push({ qty, price, time: t.created_at });
        } else if (t.action === 'SELL') {
            if (holdings[sym]) {
                holdings[sym].qty -= qty;
                if (holdings[sym].qty <= 0) {
                    delete holdings[sym];
                }
            }
        }
    });

    openPositions = Object.entries(holdings).map(([symbol, h]) => ({
        symbol,
        qty: h.qty,
        avgEntry: h.totalCost / (h.qty + (h.totalCost / h.qty - h.totalCost / h.qty)), // recalc properly
        pricePaid: h.qty > 0 ? h.totalCost / h.qty : 0,
        currentPrice: livePrices[symbol]?.price ?? null,
        changePct: livePrices[symbol]?.change_pct ?? null,
    })).filter(p => p.qty > 0);

    renderOpenPositions();
}

function renderOpenPositions() {
    const grid = document.getElementById('positions-grid');
    if (openPositions.length === 0) {
        grid.innerHTML = '<div class="empty-state" style="padding:30px; grid-column:1/-1;"><p>No open positions. The bot hasn\\'t bought anything yet, or your Alpaca portfolio is empty.</p></div>';
        return;
    }

    grid.innerHTML = openPositions.map(p => {
        const hasLive = p.currentPrice != null;
        const unrealizedPnl = p.unrealizedPnl ?? (hasLive ? (p.currentPrice - p.pricePaid) * p.qty : null);
        const unrealizedPct = p.unrealizedPct ?? (hasLive && p.pricePaid > 0 ? ((p.currentPrice - p.pricePaid) / p.pricePaid * 100) : null);
        const marketValue = p.marketValue ?? (hasLive ? p.currentPrice * p.qty : p.pricePaid * p.qty);
        const direction = unrealizedPnl > 0.01 ? 'up' : unrealizedPnl < -0.01 ? 'down' : 'flat';
        const cardClass = \`pos-\${direction}\`;
        const pnlColor = direction === 'up' ? 'green' : direction === 'down' ? 'red' : 'text-secondary';

        return \`<div class="position-card \${cardClass}">
            <div class="position-header">
                <span class="position-symbol">\${p.symbol}</span>
                <span class="position-qty">\${p.qty} share\${p.qty !== 1 ? 's' : ''}</span>
            </div>
            <div class="position-prices">
                <div class="position-price-item">
                    <div class="position-price-label">Price Paid</div>
                    <div class="position-price-value price-paid">$\${p.pricePaid.toFixed(2)}</div>
                </div>
                <div class="position-price-item">
                    <div class="position-price-label">Current Price</div>
                    <div class="position-price-value price-current">\${hasLive ? '$' + p.currentPrice.toFixed(2) : '—'}</div>
                </div>
                <div class="position-price-item">
                    <div class="position-price-label">Market Value</div>
                    <div class="position-price-value">$\${marketValue.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
                </div>
            </div>
            <div class="position-pnl-bar \${direction}">
                <span class="position-pnl-value" style="color:var(--\${pnlColor})">
                    \${unrealizedPnl != null ? (unrealizedPnl >= 0 ? '+' : '') + '$' + unrealizedPnl.toFixed(2) : '—'}
                </span>
                <span class="position-pnl-pct" style="color:var(--\${pnlColor})">
                    \${unrealizedPct != null ? (unrealizedPct >= 0 ? '+' : '') + unrealizedPct.toFixed(2) + '%' : ''}
                </span>
            </div>
        </div>\`;
    }).join('');
}

// ── Alpaca Connection ───────────────────────────────────────────────────────
let alpacaAccount = null;   // { equity, cash, buying_power, ... }
let alpacaPositions = [];   // raw positions from Alpaca API
let alpacaOrders = [];      // filled orders from Alpaca API
let alpacaPortfolioHistory = null;  // { timestamp[], equity[], profit_loss[], ... }

const ALPACA_BASE = 'https://paper-api.alpaca.markets';

function alpacaHeaders() {
    return {
        'APCA-API-KEY-ID': alpacaKey,
        'APCA-API-SECRET-KEY': alpacaSecret,
    };
}

async function connectAlpaca() {
    alpacaKey = document.getElementById('input-alpaca-key').value.trim();
    alpacaSecret = document.getElementById('input-alpaca-secret').value.trim();
    if (!alpacaKey || !alpacaSecret) return alert('Please enter both Alpaca API Key and Secret.');

    document.getElementById('alpaca-btn').disabled = true;
    document.getElementById('alpaca-hint').textContent = 'Connecting to Alpaca...';

    try {
        // 1. Fetch account info
        const accRes = await fetch(\`\${ALPACA_BASE}/v2/account\`, { headers: alpacaHeaders() });
        if (!accRes.ok) {
            const body = await accRes.text();
            throw new Error(\`Account: \${accRes.status} \${accRes.statusText} — \${body}\`);
        }
        alpacaAccount = await accRes.json();

        // 2. Fetch positions
        const posRes = await fetch(\`\${ALPACA_BASE}/v2/positions\`, { headers: alpacaHeaders() });
        if (!posRes.ok) throw new Error(\`Positions: \${posRes.status} \${posRes.statusText}\`);
        alpacaPositions = await posRes.json();

        // 3. Fetch all orders (filled, partially_filled, canceled — last 500)
        const ordRes = await fetch(\`\${ALPACA_BASE}/v2/orders?status=all&limit=500&direction=desc\`, { headers: alpacaHeaders() });
        if (ordRes.ok) {
            alpacaOrders = await ordRes.json();
            console.log(\`Loaded \${alpacaOrders.length} orders from Alpaca\`);
        } else {
            console.warn('Could not fetch orders:', ordRes.status);
            alpacaOrders = [];
        }

        // 3b. Fetch portfolio history for equity chart
        try {
            const initParams = getTimeframeParams(currentEquityTimeframe);
            let initHistUrl = \`\${ALPACA_BASE}/v2/account/portfolio/history?period=\${initParams.period}&timeframe=\${initParams.timeframe}\`;
            if (initParams.start) initHistUrl += \`&start=\${initParams.start}\`;
            const histRes = await fetch(initHistUrl, { headers: alpacaHeaders() });
            if (histRes.ok) {
                alpacaPortfolioHistory = await histRes.json();
                equityHistoryCache[currentEquityTimeframe] = alpacaPortfolioHistory;
                console.log(\`Loaded \${alpacaPortfolioHistory.timestamp?.length || 0} portfolio history points (\${currentEquityTimeframe})\`);
            }
        } catch(e) { console.warn('Portfolio history not available:', e); }

        // 4. Build livePrices + openPositions from Alpaca directly
        livePrices = {};
        openPositions = alpacaPositions.map(p => {
            const currentPrice = parseFloat(p.current_price);
            const avgEntry = parseFloat(p.avg_entry_price);
            const qty = parseInt(p.qty);
            const unrealizedPnl = parseFloat(p.unrealized_pl);
            const unrealizedPct = parseFloat(p.unrealized_plpc) * 100;

            livePrices[p.symbol] = { price: currentPrice, change_pct: parseFloat(p.change_today) * 100 };

            return {
                symbol: p.symbol,
                qty,
                pricePaid: avgEntry,
                currentPrice,
                unrealizedPnl,
                unrealizedPct,
                marketValue: parseFloat(p.market_value),
                side: p.side,
            };
        });

        // 4. Show everything
        document.getElementById('positions-section').style.display = '';
        document.getElementById('positions-badge').textContent = 'LIVE FROM ALPACA';
        document.getElementById('positions-badge').style.background = 'var(--green-bg)';
        renderOpenPositions();
        renderAlpacaKPIs();

        // Show all sections
        document.getElementById('kpi-section').style.display = '';
        document.getElementById('charts-section').style.display = '';
        document.getElementById('tables-section').style.display = '';
        document.getElementById('empty-state').style.display = 'none';

        // Render charts with Alpaca data
        renderCharts();

        document.getElementById('alpaca-hint').textContent = 'Connected · ' + new Date().toLocaleTimeString();
        document.getElementById('refresh-btn').disabled = false;
        sessionStorage.setItem('alpaca_key', alpacaKey);
        sessionStorage.setItem('alpaca_secret', alpacaSecret);

        // Render trade history from Alpaca orders
        renderTradesTable();

        // Start auto-refresh
        setAutoRefresh();

    } catch (err) {
        document.getElementById('alpaca-hint').textContent = 'Failed: ' + err.message;
        showError('Alpaca connection failed: ' + err.message);
        console.error('Alpaca error:', err);
    }
    document.getElementById('alpaca-btn').disabled = false;
}

function renderAlpacaKPIs() {
    if (!alpacaAccount) return;

    const equity = parseFloat(alpacaAccount.equity);
    const cash = parseFloat(alpacaAccount.cash);
    const buyingPower = parseFloat(alpacaAccount.buying_power);
    const lastEquity = parseFloat(alpacaAccount.last_equity);
    const dayChange = equity - lastEquity;
    const dayChangePct = lastEquity > 0 ? (dayChange / lastEquity * 100) : 0;

    const totalUnrealized = alpacaPositions.reduce((s, p) => s + parseFloat(p.unrealized_pl), 0);
    const totalMarketValue = alpacaPositions.reduce((s, p) => s + Math.abs(parseFloat(p.market_value)), 0);

    // Realized PnL = (Equity - Starting Capital) - Unrealized PnL
    // Starting capital for paper = initial deposit. We can get it from portfolio history or use 100k default.
    const startingCapital = alpacaPortfolioHistory?.base_value || 100000;
    const totalPnl = equity - startingCapital;
    const realizedPnl = totalPnl - totalUnrealized;

    // Equity
    setKPI('kpi-equity', \`$\${equity.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}\`,
        \`\${dayChange >= 0 ? '+' : ''}$\${dayChange.toFixed(2)} today (\${dayChangePct >= 0 ? '+' : ''}\${dayChangePct.toFixed(2)}%)\`,
        dayChange >= 0 ? 'positive' : 'negative');

    // Unrealized PnL
    setKPI('kpi-pnl', \`\${totalUnrealized >= 0 ? '+' : ''}$\${totalUnrealized.toFixed(2)}\`,
        \`Across \${alpacaPositions.length} position\${alpacaPositions.length !== 1 ? 's' : ''}\`,
        totalUnrealized >= 0 ? 'positive' : 'negative');

    // Realized PnL
    const filledSells = alpacaOrders.filter(o => o.side === 'sell' && o.filled_qty && parseFloat(o.filled_qty) > 0);
    setKPI('kpi-realized', \`\${realizedPnl >= 0 ? '+' : ''}$\${realizedPnl.toFixed(2)}\`,
        \`\${filledSells.length} sell\${filledSells.length !== 1 ? 's' : ''} executed\`,
        realizedPnl >= 0 ? 'positive' : 'negative');

    // Cash
    setKPI('kpi-cash', \`$\${cash.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}\`,
        \`Buying power: $\${buyingPower.toLocaleString(undefined, {minimumFractionDigits:0})}\`, 'neutral');

    // Positions count + total market value
    setKPI('kpi-positions', \`\${alpacaPositions.length}\`,
        \`Market value: $\${totalMarketValue.toLocaleString(undefined, {minimumFractionDigits:0})}\`, 'neutral');
}

// ── Tab Switching ────────────────────────────────────────────────────────────
function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.table-card').forEach(t => t.style.display = 'none');
    event.target.classList.add('active');
    document.getElementById(\`tab-\${tab}\`).style.display = '';
}

// ── Pagination ───────────────────────────────────────────────────────────────
function tradePage(dir) {
    let count = filteredTrades.filter(t => t.status !== 'scan' && t.action !== 'HOLD').length;
    if (count === 0 && alpacaOrders.length > 0) count = alpacaOrders.filter(o => o.filled_qty && parseFloat(o.filled_qty) > 0).length;
    const max = Math.ceil(count / PAGE_SIZE) - 1;
    tradePageNum = Math.max(0, Math.min(max, tradePageNum + dir));
    renderTradesTable();
}
function scanPage(dir) {
    const max = Math.ceil(filteredTrades.filter(t => t.status === 'scan' || t.action?.startsWith('SCAN')).length / PAGE_SIZE) - 1;
    scanPageNum = Math.max(0, Math.min(max, scanPageNum + dir));
    renderScansTable();
}

// ── Auto-Refresh ─────────────────────────────────────────────────────────────
function setAutoRefresh() {
    if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
    const seconds = parseInt(document.getElementById('auto-refresh-interval').value);
    if (seconds > 0) {
        autoRefreshTimer = setInterval(silentRefresh, seconds * 1000);
        console.log(\`Auto-refresh set to every \${seconds}s\`);
    }
}

async function silentRefresh() {
    if (isRefreshing) return; // skip if already refreshing
    isRefreshing = true;
    try {
        // Refresh ALL Alpaca data (account, positions, orders, portfolio history)
        if (alpacaKey && alpacaSecret) {
            const silentParams = getTimeframeParams(currentEquityTimeframe);
            let silentHistUrl = \`\${ALPACA_BASE}/v2/account/portfolio/history?period=\${silentParams.period}&timeframe=\${silentParams.timeframe}\`;
            if (silentParams.start) silentHistUrl += \`&start=\${silentParams.start}\`;
            const [accRes, posRes, ordRes, histRes] = await Promise.all([
                fetch(\`\${ALPACA_BASE}/v2/account\`, { headers: alpacaHeaders() }),
                fetch(\`\${ALPACA_BASE}/v2/positions\`, { headers: alpacaHeaders() }),
                fetch(\`\${ALPACA_BASE}/v2/orders?status=all&limit=500&direction=desc\`, { headers: alpacaHeaders() }),
                fetch(silentHistUrl, { headers: alpacaHeaders() }),
            ]);
            if (accRes.ok) alpacaAccount = await accRes.json();
            if (posRes.ok) {
                alpacaPositions = await posRes.json();
                livePrices = {};
                openPositions = alpacaPositions.map(p => {
                    const currentPrice = parseFloat(p.current_price);
                    const avgEntry = parseFloat(p.avg_entry_price);
                    const qty = parseInt(p.qty);
                    livePrices[p.symbol] = { price: currentPrice, change_pct: parseFloat(p.change_today) * 100 };
                    return {
                        symbol: p.symbol, qty, pricePaid: avgEntry, currentPrice,
                        unrealizedPnl: parseFloat(p.unrealized_pl),
                        unrealizedPct: parseFloat(p.unrealized_plpc) * 100,
                        marketValue: parseFloat(p.market_value), side: p.side,
                    };
                });
            }
            if (ordRes.ok) {
                alpacaOrders = await ordRes.json();
            }
            if (histRes.ok) {
                alpacaPortfolioHistory = await histRes.json();
                equityHistoryCache[currentEquityTimeframe] = alpacaPortfolioHistory;
            }
            // Update ALL UI components — not just positions
            renderOpenPositions();
            renderAlpacaKPIs();
            renderTradesTable();
            renderCharts();        // refresh equity curve + allocation + P&L bars
            setStatus('connected', \`Live · \${new Date().toLocaleTimeString()}\`);
        }
        // Also refresh Supabase trade data if connected
        if (supabaseUrl && supabaseKey) {
            try {
                const [trades, snapshots] = await Promise.all([
                    sbFetch('trades', 'order=created_at.desc&limit=1000'),
                    sbFetch('portfolio_snapshots', 'order=created_at.asc&limit=2000'),
                ]);
                allTrades = trades.data;
                allSnapshots = snapshots.data;
            } catch(e) { /* supabase optional during silent refresh */ }
        }
    } catch(e) { console.warn('Silent refresh error:', e); }
    isRefreshing = false;
}

function manualRefresh() {
    if (alpacaKey && alpacaSecret) {
        connectAlpaca(); // full refresh including orders + portfolio history
    }
    if (supabaseUrl && supabaseKey) {
        refreshData();
    }
}

// ── Auto-restore session ─────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
    const savedUrl = sessionStorage.getItem('sb_url');
    const savedKey = sessionStorage.getItem('sb_key');
    if (savedUrl && savedKey) {
        document.getElementById('input-url').value = savedUrl;
        document.getElementById('input-key').value = savedKey;
        connectSupabase();
    }
    // Restore Alpaca keys if saved — and auto-connect
    const savedAlpacaKey = sessionStorage.getItem('alpaca_key');
    const savedAlpacaSecret = sessionStorage.getItem('alpaca_secret');
    if (savedAlpacaKey && savedAlpacaSecret) {
        document.getElementById('input-alpaca-key').value = savedAlpacaKey;
        document.getElementById('input-alpaca-secret').value = savedAlpacaSecret;
        connectAlpaca();
    }
});
</script>
</body>
</html>
`;

serve((req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      },
    });
  }

  return new Response(HTML, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
    },
  });
});
