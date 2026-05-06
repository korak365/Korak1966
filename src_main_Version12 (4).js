// Global Inventory Heatmap Actor
// Modes: 'api' (preferred) and 'browser' (authorized accounts only).
// - API mode: query partner endpoints using token from KVS
// - Browser mode: login via Playwright using credentials from KVS, scrape pages
//
// IMPORTANT: Only use browser mode for accounts you own or have written permission to automate.

import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, KeyValueStore, CheerioCrawler } from 'crawlee';
import fetch from 'node-fetch';
import { chromium } from 'playwright';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
  mode = 'api',
  apiBaseUrl = '',
  apiTokenKvKey = 'INVENTORY_API_TOKEN',
  startUrls = [],
  loginUrl = '',
  credentialsKvKey = 'INVENTORY_CREDENTIALS',
  selectors = { row: '.inventory-row', region: '.region', sku: '.sku', stock: '.stock-status', stockNumeric: '.stock-qty' },
  regions = ['US', 'EU', 'APAC'],
  oosThreshold = 0,
  maxRequestsPerCrawl = 1000,
  concurrency = 3,
  screenshot = false,
  webhookUrl = '',
  storagePrefix = 'global-inventory',
  respectRobots = true
} = input;

const kvStore = await KeyValueStore.open();
const dataset = await Dataset.open();

async function fetchApiInventory() {
  const tokenRaw = await kvStore.getValue(apiTokenKvKey);
  if (!tokenRaw) throw new Error(`API token not found in KVS key "${apiTokenKvKey}"`);
  const token = (typeof tokenRaw === 'string') ? tokenRaw : JSON.stringify(tokenRaw);
  if (!apiBaseUrl) throw new Error('apiBaseUrl is required for API mode');

  // Example: provider-specific endpoints. This is a template—adapt to your partner API.
  // For each region, call /inventory?region={region}&page=...
  for (const region of regions) {
    let page = 1;
    let more = true;
    while (more) {
      const url = `${apiBaseUrl.replace(/\/$/, '')}/inventory?region=${encodeURIComponent(region)}&page=${page}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        redirect: 'follow'
      });
      if (!res.ok) {
        console.warn('API request failed', { url, status: res.status });
        break;
      }
      const data = await res.json();
      if (!Array.isArray(data.items)) break;
      for (const item of data.items) {
        const sku = item.sku || item.product_id || null;
        const qty = (typeof item.stock === 'number') ? item.stock : (parseInt(item.stock_qty) || null);
        const inStock = (qty === null) ? Boolean(item.in_stock) : (qty > oosThreshold);
        const out = {
          sku,
          region,
          inStock,
          stockQty: qty,
          source: url,
          metadata: item,
          screenshotKey: null,
          timestamp: new Date().toISOString()
        };
        await dataset.pushData(out);
        if (!inStock && webhookUrl) await postWebhook(out);
      }
      more = !!data.next; // provider-specific
      page += 1;
    }
  }
}

async function postWebhook(payload) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.warn('Webhook post failed', e.message);
  }
}

async function fetchBrowserInventory() {
  // Load credentials from KVS
  const raw = await kvStore.getValue(credentialsKvKey);
  if (!raw) throw new Error(`Credentials not found in KVS key "${credentialsKvKey}"`);
  let creds = raw;
  if (typeof raw === 'string') {
    try { creds = JSON.parse(raw); } catch { creds = { token: raw }; }
  }

  // Save or reuse storage state in KVS
  const stateKey = `${storagePrefix}/storageState.json`;
  let storageState = await kvStore.getValue(stateKey);

  // If no state, do login flow once to persist storage state
  if (!storageState) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(loginUrl, { waitUntil: 'load', timeout: 60000 });
      // Basic form login: adapt in input.loginSelectors if necessary
      if (creds.username && creds.password) {
        // Try common selectors; user should tune the actor input to match their site
        try { await page.fill('input[name="username"]', String(creds.username)); } catch {}
        try { await page.fill('input[name="password"]', String(creds.password)); } catch {}
        try {
          await Promise.all([page.click('button[type="submit"]'), page.waitForNavigation({ waitUntil: 'networkidle', timeout: 45000 }).catch(() => null)]);
        } catch {}
      }
      // Save storage state
      storageState = await context.storageState();
      await kvStore.setValue(stateKey, storageState, { contentType: 'application/json' });
    } finally {
      await browser.close();
    }
  }

  // Use a PlaywrightCrawler to visit startUrls and scrape rows
  const crawler = new PlaywrightCrawler({
    launchContext: {
      launchOptions: { headless: true, storageState }
    },
    maxRequestsPerCrawl,
    maxConcurrency: concurrency,
    requestHandler: async ({ page, request, log }) => {
      const url = request.url;
      log.info('Visiting', { url });
      // wait for main content
      await page.waitForTimeout(1000);

      // Evaluate page and scrape rows
      const rows = await page.$$eval(selectors.row, (els, sel) => {
        return els.map(el => {
          const regionEl = el.querySelector(sel.region);
          const skuEl = el.querySelector(sel.sku);
          const stockEl = el.querySelector(sel.stock) || el.querySelector(sel.stockNumeric);
          const region = regionEl ? regionEl.textContent.trim() : null;
          const sku = skuEl ? skuEl.textContent.trim() : null;
          const stockText = stockEl ? stockEl.textContent.trim() : null;
          return { region, sku, stockText };
        });
      }, selectors);

      for (const r of rows) {
        const qty = parseInt((r.stockText || '').replace(/[^\d\-]/g, '')) || null;
        const inStock = (qty === null) ? !/out of stock|oos|unavailable/i.test(String(r.stockText || '')) : (qty > oosThreshold);
        const item = {
          sku: r.sku || null,
          region: r.region || null,
          inStock,
          stockQty: qty,
          source: url,
          metadata: { rawStockText: r.stockText },
          screenshotKey: null,
          timestamp: new Date().toISOString()
        };
        await dataset.pushData(item);
        if (!inStock && webhookUrl) await postWebhook(item);
      }

      // optionally save screenshot
      if (screenshot) {
        try {
          const buffer = await page.screenshot({ fullPage: false });
          const key = `${storagePrefix}/screenshots/${encodeURIComponent(new URL(url).hostname)}_${Date.now()}.png`;
          await kvStore.setValue(key, buffer, { contentType: 'image/png' });
        } catch (e) {
          log.warning('Screenshot failed', e.message);
        }
      }
    }
  });

  await crawler.run(startUrls);
}

async function run() {
  if (mode === 'api') {
    console.log('Running in API mode');
    await fetchApiInventory();
  } else if (mode === 'browser') {
    console.log('Running in Browser mode (authorized accounts only).');
    // basic legal check: require credentialsKvKey
    if (!credentialsKvKey) throw new Error('credentialsKvKey is required for browser mode');
    await fetchBrowserInventory();
  } else {
    throw new Error('Unknown mode: ' + mode);
  }
}

try {
  await run();
  console.log('Actor finished.');
} catch (err) {
  console.error('Actor failed:', err);
  throw err;
} finally {
  await Actor.exit();
}