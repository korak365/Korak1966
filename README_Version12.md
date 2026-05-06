# Global Inventory Heatmap

Monitors Out-of-Stock (OOS) status across regions for logistics planning. Supports two modes:
- api (preferred): queries partner API endpoints using a token stored in Key-Value Store.
- browser: logs in and scrapes pages using Playwright (authorized accounts only).

Important: Only use browser mode for accounts you own or have explicit permission to automate.

## Setup

1. Create project folders and paste files into `.actor/` and `src/`.
2. Install: