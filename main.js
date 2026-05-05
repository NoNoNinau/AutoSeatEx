#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

const PROXIES_FILE = path.resolve(__dirname, 'proxies.txt');
const ACCOUNTS_FILE = path.resolve(__dirname, 'accounts.txt');
const SESSIONS_DIR = path.resolve(__dirname, 'sessions');

const TARGET_URL = process.env.TARGET_URL || 'https://ticketbox.vn';
const LOGIN_URL = process.env.LOGIN_URL || 'https://ticketbox.vn/sign-in';
const RELOAD_INTERVAL_MS = Number(process.env.RELOAD_INTERVAL_MS || 400);
const POST_LOGIN_SETTLE_MS = Number(process.env.POST_LOGIN_SETTLE_MS || 3000);
const BUY_BUTTON_SELECTOR = 'button#buynow-btn';
const QUEUE_HINT_SELECTORS = [
  '[data-testid*="queue"]',
  '[class*="queue"]',
  'text=/hàng chờ|waiting room|queue/i',
];

async function readLines(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function parseProxy(line, index) {
  const [host, port, username, password] = line.split(':');
  if (!host || !port) {
    throw new Error(`Proxy không hợp lệ ở dòng ${index + 1}: ${line}`);
  }
  const proxy = { server: `http://${host}:${port}` };
  if (username && password) {
    proxy.username = username;
    proxy.password = password;
  }
  return proxy;
}

function parseAccount(line, index) {
  const [email, password] = line.split('|');
  if (!email || !password) {
    throw new Error(`Account không hợp lệ ở dòng ${index + 1}: ${line}`);
  }
  return { email, password };
}

function safeName(input) {
  return input.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function ensureSessionDir() {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
}

async function hasSession(sessionPath) {
  try {
    await fs.access(sessionPath);
    return true;
  } catch {
    return false;
  }
}

async function isQueuePage(page) {
  for (const selector of QUEUE_HINT_SELECTORS) {
    const matched = await page.locator(selector).first().isVisible().catch(() => false);
    if (matched) return true;
  }
  return false;
}

async function doLoginIfNeeded(context, page, account, sessionPath) {
  const sessionExists = await hasSession(sessionPath);
  if (sessionExists) {
    console.log(`[${account.email}] Session đã có, bỏ qua login.`);
    return;
  }

  console.log(`[${account.email}] Chưa có session, bắt đầu đăng nhập.`);
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(POST_LOGIN_SETTLE_MS);

  await page.fill('input[type="text"], input[type="email"]', account.email);
  await page.fill('input[type="password"]', account.password);

  const loginButton = page.locator('button:has-text("Đăng nhập"), button:has-text("Login"), button[type="submit"]').first();
  await loginButton.click().catch(() => {});

  console.log(`[${account.email}] Nếu có OTP/xác thực, vui lòng hoàn thành thủ công trong 120 giây...`);
  await page.waitForTimeout(120000);

  await context.storageState({ path: sessionPath });
  console.log(`[${account.email}] Đã lưu session: ${sessionPath}`);
}

async function runSniperLoop(page, account) {
  console.log(`[${account.email}] Bắt đầu sniper loop.`);
  while (true) {
    if (await isQueuePage(page)) {
      console.log(`[${account.email}] Phát hiện hàng chờ. Dừng reload để giữ queue.`);
      return;
    }

    const button = page.locator(BUY_BUTTON_SELECTOR).first();
    const exists = await button.count();

    if (exists > 0) {
      const disabled = await button.getAttribute('disabled');
      if (disabled === null) {
        console.log(`[${account.email}] Phát hiện Mua vé ngay! Click...`);
        await button.click({ timeout: 1000 }).catch(() => {});

        if (await isQueuePage(page)) {
          console.log(`[${account.email}] Sau click vào hàng chờ. Giữ nguyên tab.`);
          return;
        }
      }
    }

    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(RELOAD_INTERVAL_MS);
  }
}

async function runWorker(index, proxyLine, accountLine) {
  const proxy = parseProxy(proxyLine, index);
  const account = parseAccount(accountLine, index);
  const sessionPath = path.join(SESSIONS_DIR, `${safeName(account.email)}.json`);

  const sessionExists = await hasSession(sessionPath);
  const contextOptions = {
    proxy,
    viewport: { width: 1280, height: 800 },
  };
  if (sessionExists) {
    contextOptions.storageState = sessionPath;
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  try {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
    await doLoginIfNeeded(context, page, account, sessionPath);
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
    await runSniperLoop(page, account);
  } catch (error) {
    console.error(`[${account.email}] Lỗi:`, error.message);
  }
}

async function main() {
  await ensureSessionDir();
  const [proxyLines, accountLines] = await Promise.all([
    readLines(PROXIES_FILE),
    readLines(ACCOUNTS_FILE),
  ]);

  if (proxyLines.length === 0 || accountLines.length === 0) {
    throw new Error('proxies.txt hoặc accounts.txt đang trống.');
  }

  const total = Math.min(proxyLines.length, accountLines.length);
  if (proxyLines.length !== accountLines.length) {
    console.warn(`Số lượng proxy (${proxyLines.length}) khác accounts (${accountLines.length}). Chỉ chạy ${total} cặp.`);
  }

  console.log(`Khởi tạo ${total} worker...`);
  await Promise.allSettled(
    Array.from({ length: total }, (_, i) => runWorker(i, proxyLines[i], accountLines[i]))
  );
}

main().catch((err) => {
  console.error('Lỗi hệ thống:', err);
  process.exit(1);
});
