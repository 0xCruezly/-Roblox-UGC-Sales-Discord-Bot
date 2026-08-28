/**
 * Bot Notifikasi Penjualan UGC Roblox -> Discord (versi 2.0)
 * ===============================================================
 * 
 * Fitur:
 * - Notifikasi instan setiap penjualan baru
 * - Ringkasan harian 24 jam (00.00 WIB)
 * - Statistik penjualan (terlaris, revenue, distribusi jam)
 * - Support multiple Discord webhooks
 * - Auto-retry & rate limiting handler
 * - Menggunakan environment variables untuk keamanan
 */

require('dotenv').config();
const fs = require('fs');

// =========================================================
// KONFIGURASI (dari environment variables)
// =========================================================

const ROBLOSECURITY_COOKIE = process.env.ROBLOSECURITY_COOKIE;
const GROUP_ID = process.env.GROUP_ID || '';
const PERSONAL_USER_ID = process.env.PERSONAL_USER_ID || '';
const DISCORD_WEBHOOK_URLS = process.env.DISCORD_WEBHOOK_URLS.split(',').map(u => u.trim());
const DISCORD_USER_ID_TO_TAG = process.env.DISCORD_USER_ID_TO_TAG || '';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS) || 20000;

if (!ROBLOSECURITY_COOKIE) {
  console.error('[ERROR] ROBLOSECURITY_COOKIE tidak ditemukan di .env');
  process.exit(1);
}
if (!GROUP_ID && !PERSONAL_USER_ID) {
  console.error('[ERROR] Isi salah satu: GROUP_ID atau PERSONAL_USER_ID di .env');
  process.exit(1);
}
if (!DISCORD_WEBHOOK_URLS.length) {
  console.error('[ERROR] DISCORD_WEBHOOK_URLS tidak boleh kosong');
  process.exit(1);
}

// =========================================================
// MODUL: Retry Handler
// =========================================================
class RetryHandler {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || 3;
    this.baseDelay = options.baseDelay || 1000;
    this.maxDelay = options.maxDelay || 30000;
    this.backoffFactor = options.backoffFactor || 2;
  }

  async execute(fn, context = '') {
    let lastError;
    let delay = this.baseDelay;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        console.warn(`[Retry ${attempt}/${this.maxRetries}] ${context}: ${error.message}`);
        if (attempt === this.maxRetries) break;
        const jitter = Math.random() * 0.3 * delay;
        const waitTime = Math.min(delay + jitter, this.maxDelay);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        delay = Math.min(delay * this.backoffFactor, this.maxDelay);
      }
    }
    throw lastError;
  }

  async fetchWithRetry(url, options = {}) {
    return this.execute(async () => {
      const res = await fetch(url, options);
      const remaining = parseInt(res.headers.get('X-RateLimit-Remaining') || '1');
      if (res.status === 429 || remaining === 0) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '5');
        throw new Error(`Rate limited. Retry after ${retryAfter}s`);
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      return res;
    }, `fetch ${url}`);
  }
}

const retryHandler = new RetryHandler();

// =========================================================
// MODUL: Stats Manager
// =========================================================
class StatsManager {
  constructor() {
    this.statsFile = 'sales_stats.json';
    this.data = this.load();
  }

  load() {
    if (fs.existsSync(this.statsFile)) {
      try {
        return JSON.parse(fs.readFileSync(this.statsFile, 'utf-8'));
      } catch (e) {
        return this.getDefaultStats();
      }
    }
    return this.getDefaultStats();
  }

  getDefaultStats() {
    return {
      totalSales: 0,
      totalRevenue: 0,
      dailySales: {},
      monthlySales: {},
      bestSellingItems: {},
      salesByHour: Array(24).fill(0),
      lastUpdated: Date.now()
    };
  }

  updateStats(sale) {
    const itemName = sale.details?.name || 'Unknown';
    const price = sale.currency?.amount || 0;
    const date = new Date(sale.created || Date.now());
    const dateKey = date.toISOString().split('T')[0];
    const monthKey = dateKey.substring(0, 7);
    const hour = date.getHours();

    this.data.totalSales++;
    this.data.totalRevenue += price;
    this.data.dailySales[dateKey] = (this.data.dailySales[dateKey] || 0) + 1;
    this.data.monthlySales[monthKey] = (this.data.monthlySales[monthKey] || 0) + 1;
    this.data.bestSellingItems[itemName] = (this.data.bestSellingItems[itemName] || 0) + 1;
    this.data.salesByHour[hour]++;
    this.data.lastUpdated = Date.now();
    this.save();
  }

  save() {
    fs.writeFileSync(this.statsFile, JSON.stringify(this.data, null, 2));
  }

  getTopItems(limit = 5) {
    return Object.entries(this.data.bestSellingItems)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);
  }

  getDailyStats(days = 7) {
    const today = new Date();
    const result = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const key = date.toISOString().split('T')[0];
      result.push({
        date: key,
        sales: this.data.dailySales[key] || 0
      });
    }
    return result;
  }
}

const statsManager = new StatsManager();

// =========================================================
// MODUL: Discord Manager (multi-webhook)
// =========================================================
class DiscordManager {
  constructor(webhooks) {
    this.webhooks = webhooks;
  }

  async sendMessage(payload) {
    const results = [];
    for (const webhook of this.webhooks) {
      try {
        const res = await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        results.push({ webhook: webhook.substring(0, 50) + '...', success: res.ok, status: res.status });
        if (!res.ok) {
          console.warn(`[Webhook] Gagal: ${res.status} ${await res.text()}`);
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (e) {
        results.push({ webhook: webhook.substring(0, 50) + '...', success: false, error: e.message });
      }
    }
    return results;
  }

  async sendSaleNotification(sale, thumbnailUrl, originalPrice) {
    const embed = this.formatSaleEmbed(sale, thumbnailUrl, originalPrice);
    return this.sendMessage(embed);
  }

  formatSaleEmbed(sale, thumbnailUrl, originalPrice) {
    const details = sale.details || {};
    const itemName = details.name || 'Item tidak diketahui';
    const assetId = details.id;
    const itemUrl = assetId ? `https://www.roblox.com/catalog/${assetId}` : null;
    const buyer = (sale.agent && sale.agent.name) || 'Tidak diketahui';
    const amount = (sale.currency && sale.currency.amount) ?? '?';
    const created = sale.created || '';

    let waktu = created;
    try {
      const dt = new Date(created);
      waktu = dt.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false }) + ' WIB';
    } catch (e) {}

    const fields = [
      { name: 'Item', value: itemUrl ? `[${itemName}](${itemUrl})` : itemName, inline: false },
    ];
    if (originalPrice !== null && originalPrice !== undefined) {
      fields.push({ name: 'Harga Jual (Robux)', value: String(originalPrice), inline: true });
    }
    fields.push({ name: 'Pembeli', value: buyer, inline: true });
    fields.push({ name: 'Waktu', value: waktu, inline: false });

    // Tambahkan statistik singkat
    const todayKey = new Date().toISOString().split('T')[0];
    const todaySales = statsManager.data.dailySales[todayKey] || 0;
    fields.push(
      { name: '📊 Total Hari Ini', value: `${todaySales} penjualan`, inline: true },
      { name: '💰 Revenue Hari Ini', value: `${statsManager.data.totalRevenue} Robux`, inline: true }
    );

    return {
      username: 'KLCR SALES',
      embeds: [{
        title: '🛒 UGC Terjual!',
        url: itemUrl || undefined,
        color: 3066993,
        thumbnail: thumbnailUrl ? { url: thumbnailUrl } : undefined,
        fields,
        footer: { text: `Total semua: ${statsManager.data.totalSales} penjualan` }
      }]
    };
  }

  async sendDailySummary(summaryData) {
    const { recent, pendingRobux, topItems, bottomItem, totalItems, totalTransactions } = summaryData;
    const fields = [];

    if (recent && recent.length) {
      fields.push({ name: '🏆 Item Terlaris', value: topItems[0]?.[0] || '-', inline: false });
      fields.push({ name: 'Jumlah Terjual', value: String(topItems[0]?.[1] || 0), inline: true });
      fields.push({ name: 'Total Robux (Item Ini)', value: String(topItems[0]?.[2] || 0), inline: true });

      if (bottomItem && bottomItem[0] !== topItems[0]?.[0]) {
        fields.push({ name: '📉 Item Paling Kurang Laku', value: bottomItem[0] || '-', inline: false });
        fields.push({ name: 'Jumlah Terjual', value: String(bottomItem[1] || 0), inline: true });
        fields.push({ name: 'Total Robux (Item Ini)', value: String(bottomItem[2] || 0), inline: true });
      }

      fields.push(
        { name: 'Total Transaksi', value: String(totalTransactions), inline: false },
        { name: 'Jumlah Item Berbeda', value: String(totalItems), inline: true }
      );
    } else {
      fields.push({ name: 'Penjualan 24 Jam Terakhir', value: 'Tidak ada penjualan.', inline: false });
    }

    if (pendingRobux !== null) {
      fields.push({ name: '⏳ Pending Robux Saat Ini', value: String(pendingRobux), inline: false });
    }

    const payload = {
      username: 'KLCR SALES',
      content: DISCORD_USER_ID_TO_TAG ? `<@${DISCORD_USER_ID_TO_TAG}>` : undefined,
      allowed_mentions: DISCORD_USER_ID_TO_TAG ? { users: [DISCORD_USER_ID_TO_TAG] } : undefined,
      embeds: [{
        title: '📊 Ringkasan Penjualan 24 Jam Terakhir',
        color: 15105570,
        fields
      }]
    };

    return this.sendMessage(payload);
  }
}

const discordManager = new DiscordManager(DISCORD_WEBHOOK_URLS);

// =========================================================
// FUNGSI UTAMA BOT
// =========================================================

function getTransactionsUrl() {
  if (GROUP_ID) {
    return `https://economy.roblox.com/v2/groups/${GROUP_ID}/transactions?transactionType=Sale&limit=100&sortOrder=Desc`;
  } else if (PERSONAL_USER_ID) {
    return `https://economy.roblox.com/v2/users/${PERSONAL_USER_ID}/transactions?transactionType=Sale&limit=100&sortOrder=Desc`;
  }
  throw new Error('Isi salah satu: GROUP_ID atau PERSONAL_USER_ID');
}

async function fetchLatestSales() {
  const url = getTransactionsUrl();
  const res = await retryHandler.fetchWithRetry(url, {
    headers: {
      Cookie: `.ROBLOSECURITY=${ROBLOSECURITY_COOKIE}`,
      'User-Agent': 'Mozilla/5.0',
    },
  });
  const data = await res.json();
  return data.data || [];
}

async function fetchPendingRobux() {
  if (!GROUP_ID) return null;
  try {
    const url = `https://economy.roblox.com/v1/groups/${GROUP_ID}/revenue/summary/Day`;
    const res = await retryHandler.fetchWithRetry(url, {
      headers: {
        Cookie: `.ROBLOSECURITY=${ROBLOSECURITY_COOKIE}`,
        'User-Agent': 'Mozilla/5.0',
      },
    });
    const data = await res.json();
    return typeof data.pendingRobux === 'number' ? data.pendingRobux : null;
  } catch (e) {
    console.warn(`[WARNING] Gagal ambil pending Robux: ${e.message}`);
    return null;
  }
}

async function fetchItemThumbnail(assetId) {
  try {
    const url = `https://thumbnails.roblox.com/v1/assets?assetIds=${assetId}&size=150x150&format=Png&isCircular=false`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return (data.data && data.data[0] && data.data[0].imageUrl) || null;
  } catch (e) {
    return null;
  }
}

async function fetchOriginalPrice(assetId) {
  try {
    const url = `https://economy.roblox.com/v2/assets/${assetId}/details`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.PriceInRobux === 'number' ? data.PriceInRobux : null;
  } catch (e) {
    return null;
  }
}

// =========================================================
// MANAJEMEN SEEN TRANSACTIONS
// =========================================================
const SEEN_FILE = 'seen_transactions.json';
const SEEN_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

function loadSeen() {
  if (fs.existsSync(SEEN_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf-8'));
    } catch (e) {
      return {};
    }
  }
  return {};
}

function saveSeen(seen) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen));
}

function pruneSeen(seen) {
  const cutoff = Date.now() - SEEN_RETENTION_MS;
  for (const token of Object.keys(seen)) {
    if (seen[token] < cutoff) delete seen[token];
  }
  return seen;
}

function getSaleToken(sale) {
  return sale.purchaseToken || sale.idHash || String(sale.id);
}

// =========================================================
// RIWAYAT PENJUALAN UNTUK RINGKASAN HARIAN
// =========================================================
const SALES_HISTORY_FILE = 'sales_history.json';

function loadSalesHistory() {
  if (fs.existsSync(SALES_HISTORY_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(SALES_HISTORY_FILE, 'utf-8'));
    } catch (e) {
      return [];
    }
  }
  return [];
}

function recordSale(itemName, price) {
  const history = loadSalesHistory();
  history.push({ itemName, price: typeof price === 'number' ? price : 0, timestamp: Date.now() });
  fs.writeFileSync(SALES_HISTORY_FILE, JSON.stringify(history));
}

// =========================================================
// KIRIM NOTIFIKASI & RINGKASAN
// =========================================================

async function sendDiscordNotification(sale) {
  const assetId = sale.details && sale.details.id;
  const itemName = (sale.details && sale.details.name) || 'Item tidak diketahui';
  const thumbnailUrl = assetId ? await fetchItemThumbnail(assetId) : null;
  const originalPrice = assetId ? await fetchOriginalPrice(assetId) : null;

  await discordManager.sendSaleNotification(sale, thumbnailUrl, originalPrice);

  // Update statistik dan riwayat
  statsManager.updateStats(sale);
  recordSale(itemName, originalPrice !== null ? originalPrice : (sale.currency && sale.currency.amount) || 0);
}

async function sendDailySummary() {
  console.log('[Ringkasan 24 jam] Menyusun laporan...');
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const history = loadSalesHistory();
  const recent = history.filter(h => h.timestamp >= cutoff);

  // Kelompokkan berdasarkan item
  const grouped = {};
  for (const sale of recent) {
    if (!grouped[sale.itemName]) grouped[sale.itemName] = { count: 0, totalRobux: 0 };
    grouped[sale.itemName].count += 1;
    grouped[sale.itemName].totalRobux += sale.price;
  }

  const sorted = Object.entries(grouped).sort((a, b) => b[1].count - a[1].count);
  const topItems = sorted.slice(0, 3).map(([name, stats]) => [name, stats.count, stats.totalRobux]);
  const bottomItem = sorted.length > 1 ? [sorted[sorted.length - 1][0], sorted[sorted.length - 1][1].count, sorted[sorted.length - 1][1].totalRobux] : null;

  const pendingRobux = await fetchPendingRobux();

  const summaryData = {
    recent,
    pendingRobux,
    topItems,
    bottomItem,
    totalItems: sorted.length,
    totalTransactions: recent.length
  };

  await discordManager.sendDailySummary(summaryData);

  // Simpan hanya data 24 jam terakhir untuk file
  fs.writeFileSync(SALES_HISTORY_FILE, JSON.stringify(recent));
  console.log('[Ringkasan 24 jam] Selesai.');
}

// =========================================================
// LOGIKA POLLING & JADWAL
// =========================================================

async function checkOnce() {
  try {
    const waktuCek = new Date().toLocaleTimeString('id-ID', { hour12: false });
    console.log(`[${waktuCek}] Mengecek transaksi baru...`);

    const sales = await fetchLatestSales();

    if (!sales.length) {
      console.log(`[${waktuCek}] Tidak ada transaksi ditemukan.`);
      return;
    }

    const isFirstRun = !fs.existsSync(SEEN_FILE);
    let seen = loadSeen();

    if (isFirstRun) {
      for (const sale of sales) {
        seen[getSaleToken(sale)] = Date.now();
      }
      saveSeen(seen);
      console.log(`Inisialisasi awal. ${sales.length} transaksi dicatat sebagai baseline (tidak dinotifikasi).`);
      return;
    }

    const newSales = sales.filter(sale => !seen[getSaleToken(sale)]);

    if (newSales.length) {
      console.log(`[${waktuCek}] Ditemukan ${newSales.length} transaksi baru!`);
      for (const sale of newSales.reverse()) {
        await sendDiscordNotification(sale);
        seen[getSaleToken(sale)] = Date.now();
        console.log(`  -> Notifikasi terkirim: ${sale.details?.name || 'item'} (token: ${getSaleToken(sale)})`);
      }
      saveSeen(pruneSeen(seen));
    } else {
      console.log(`[${waktuCek}] Belum ada penjualan baru.`);
    }
  } catch (e) {
    console.error(`[ERROR] ${e.message}`);
  }
}

function getMsUntilNextMidnightWIB() {
  const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
  const now = new Date();
  const nowShifted = new Date(now.getTime() + WIB_OFFSET_MS);
  const nextMidnightShifted = new Date(
    Date.UTC(nowShifted.getUTCFullYear(), nowShifted.getUTCMonth(), nowShifted.getUTCDate() + 1, 0, 0, 0)
  );
  const nextMidnightUTC = new Date(nextMidnightShifted.getTime() - WIB_OFFSET_MS);
  return nextMidnightUTC.getTime() - now.getTime();
}

function scheduleDailySummaryAtMidnightWIB() {
  const msUntilMidnight = getMsUntilNextMidnightWIB();
  const jamLagi = (msUntilMidnight / 3600000).toFixed(1);
  console.log(`Ringkasan 24 jam dijadwalkan kirim jam 00.00 WIB (sekitar ${jamLagi} jam lagi).`);

  setTimeout(() => {
    sendDailySummary();
    setInterval(sendDailySummary, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);
}

// =========================================================
// START BOT
// =========================================================

console.log('🚀 Bot notifikasi penjualan UGC Roblox berjalan... (Ctrl+C untuk stop)');
checkOnce();
setInterval(checkOnce, POLL_INTERVAL_MS);
scheduleDailySummaryAtMidnightWIB();
