# 🏛️ Philly Cultural Radar

A 3-layer genetic pipeline that discovers and archives events from Philadelphia's libraries and museums.

```
Layer 1 · 地理定位   →   Layer 2 · 活动爬取   →   Layer 3 · 数据存档
 Map & venues            AI web scraping           Filterable table
```

## Tech Stack

- **Frontend**: React 18 + Vite
- **AI Scraping**: Anthropic Claude API (`claude-sonnet-4-20250514`) + Web Search tool
- **Styling**: Inline CSS with DM Mono / Syne fonts

## Getting Started

### 1. Clone & install

```bash
git clone https://github.com/YOUR_USERNAME/philly-radar.git
cd philly-radar
npm install
```

### 2. Set up API key

```bash
cp .env.example .env
# Then edit .env and paste your Anthropic API key
```

Get your key at: https://console.anthropic.com

### 3. Run locally

```bash
npm run dev
# → http://localhost:3000
```

## Project Structure

```
philly-radar/
├── src/
│   ├── App.jsx              # Main UI — 3-layer interface
│   ├── main.jsx             # React entry point
│   ├── api/
│   │   └── scraper.js       # Layer 2: Anthropic API + web search
│   └── data/
│       └── venues.js        # Layer 1: Philadelphia venue data
├── public/
├── .env.example             # API key template (safe to commit)
├── .gitignore               # Excludes .env and node_modules
├── index.html
├── vite.config.js
└── package.json
```

## Deploy to Vercel

1. Push repo to GitHub
2. Connect repo at [vercel.com](https://vercel.com)
3. Add `VITE_ANTHROPIC_API_KEY` in Vercel → Settings → Environment Variables
4. Deploy ✓

> ⚠️ **Note**: This app calls the Anthropic API directly from the browser.
> For production use, consider adding a backend proxy to keep your API key server-side.

## Adding More Venues

Edit `src/data/venues.js` — add entries with `id`, `type`, `name`, `address`, `lat`, `lng`, `rating`, `website`, and `color`.
