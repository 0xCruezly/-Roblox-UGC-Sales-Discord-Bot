# 🛒 Roblox UGC Sales Discord Bot

Automated notification bot for **Limited/UGC** sales from your Roblox group or personal account.  
Every time a new sale transaction occurs, the bot sends a detailed message to **Discord** via Webhook, including item name, buyer, time, thumbnail, and original price.  
Additionally, the bot sends a **24‑hour sales summary** every midnight (00:00 WIB / UTC+7).

## ✨ Features

- 🔍 **Automatic polling** every 20 seconds (configurable) for the latest *Sale* transactions.
- 📨 **Instant notifications** to Discord for each new sale (with thumbnail, original price, and catalog link).
- 📊 **Daily summary** automatically at 00:00 WIB:
  - Best‑selling and least‑selling items (by quantity sold).
  - Total transactions and number of distinct items sold.
  - Current **pending Robux** balance.
- 🧠 **Local storage** to prevent duplicate notifications (`seen_transactions.json`).
- 📈 **24‑hour sales history** stored in `sales_history.json` for summary generation.
- 📊 **Cumulative statistics** (total sales, total revenue, all‑time best‑selling items, hourly sales distribution) saved in `sales_stats.json`.
- 🔁 **Auto‑retry & rate‑limiting handler** for improved reliability.
- 📨 **Multi‑webhook support** – send notifications to multiple Discord channels simultaneously.
- 🔒 **Security** – all credentials are stored in a `.env` file (never committed).

## 📋 Prerequisites

- [Node.js](https://nodejs.org/) version **18.x** or higher (uses built‑in `fetch`).
- A Roblox account with **owner/admin** access to the group (if using group mode).
- Discord Webhook URL(s) – can be created in your server's settings.

## ⚙️ Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/username/repo-name.git
   cd repo-name
