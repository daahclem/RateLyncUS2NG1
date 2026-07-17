require("dotenv").config();
const fs = require("fs");
const { chromium } = require("playwright");

const INGEST_URL = process.env.INGEST_URL;
const INGEST_TOKEN = process.env.INGEST_TOKEN;
const HEADLESS = true; // set true in GitHub Actions later

function getOriginConfig(origin) {
  const map = {
    US: {
      currency: "USD",
      countryName: "United States",
      countrySearch: "united states",
      countryCode2: "US",
      countryCode3: "USA",
      sendingParam: "US",
      localePath: "en-us",
    },
    GB: {
      currency: "GBP",
      countryName: "United Kingdom",
      countrySearch: "united kingdom",
      countryCode2: "GB",
      countryCode3: "GBR",
      sendingParam: "GB",
      localePath: "en-gb",
    },
  };

  return map[origin] || map.US;
}

function currencyForDestination(destination) {
  if (destination === "GH") return "GHS";
  if (destination === "NG") return "NGN";
  return "NGN";
}

function destinationCountryName(destination) {
  if (destination === "GH") return "Ghana";
  if (destination === "NG") return "Nigeria";
  return "Nigeria";
}

function destinationSearch(destination) {
  if (destination === "GH") return "gh";
  if (destination === "NG") return "ng";
  return "ng";
}

async function postQuote(payload) {
  if (
    !INGEST_URL ||
    !INGEST_TOKEN ||
    INGEST_URL.includes("your-quoteops-app-url") ||
    INGEST_TOKEN.includes("your_secret_token_here")
  ) {
    console.log("INGEST_URL or INGEST_TOKEN not set. Quote extracted locally only:");
    console.log(payload);
    return;
  }

  const res = await fetch(INGEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ingest failed: ${res.status} ${text}`);
  }
}

function saveDebugText() {
  
}

async function saveScreenshot(page, provider) {
  const safe = provider.replace(/\s+/g, "-").toLowerCase();
  const file = `debug-${safe}.png`;
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

function parseLocaleNumber(value) {
  if (value === null || value === undefined) return null;

  let str = String(value).trim();
  if (!str) return null;

  str = str.replace(/[^\d,.-]/g, "");

  const hasComma = str.includes(",");
  const hasDot = str.includes(".");

  if (hasComma && hasDot) {
    const lastComma = str.lastIndexOf(",");
    const lastDot = str.lastIndexOf(".");

    if (lastComma > lastDot) {
      str = str.replace(/\./g, "").replace(",", ".");
    } else {
      str = str.replace(/,/g, "");
    }
  } else if (hasComma) {
    if (/,\d{1,2}$/.test(str)) {
      str = str.replace(",", ".");
    } else {
      str = str.replace(/,/g, "");
    }
  } else if (hasDot) {
    const parts = str.split(".");
    if (parts.length > 2) {
      const decimal = parts.pop();
      str = parts.join("") + "." + decimal;
    }
  }

  const num = Number(str);
  return Number.isFinite(num) ? num : null;
}

function extractRateFromText(text, fromCurrency, toCurrency) {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`1\\s*${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`${fromCurrency}\\s*1\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`Exchange Rate\\s*1\\s*${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`Today[’']s rate:\\s*1(?:\\.00)?\\s*${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`rate:?\\s*1\\s*${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`([0-9]+(?:\\.[0-9]+)?)\\s*${toCurrency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0 && value < 100000) {
        return value;
      }
    }
  }

  return null;
}

function extractFeeFromText(text, sourceCurrency = "USD") {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`Transfer fees?:\\s*([0-9.]+)\\s*${sourceCurrency}`, "i"),
    new RegExp(`Fees?:\\s*([0-9.]+)\\s*${sourceCurrency}`, "i"),
    new RegExp(`Zero`, "i"),
    new RegExp(`No transfer fees`, "i"),
    new RegExp(`Fee:?\\s*([0-9.]+)`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (!match) continue;
    if (/Zero/i.test(match[0]) || /No transfer fees/i.test(match[0])) return 0;
    if (match[1]) return Number(match[1]);
  }

  return 0;
}

function extractAmountReceivedFromText(text, currency) {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`Recipient gets\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`They get\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`You receive\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`You get\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`Receive amount\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`([0-9.]+)\\s*${currency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (match && match[1]) return Number(match[1]);
  }

  return null;
}

function buildPayloadFromText(source, bodyText) {
  const originCfg = getOriginConfig(source.origin);
  const fromCurrency = originCfg.currency;
  const toCurrency = currencyForDestination(source.destination);
  const sendAmount = Number(source.send_amount || 1);

  let rate = extractRateFromText(bodyText, fromCurrency, toCurrency);
  const fee = extractFeeFromText(bodyText, fromCurrency);
  let amountReceived = extractAmountReceivedFromText(bodyText, toCurrency);

  if (!rate && amountReceived && sendAmount > 0) {
    rate = Number((amountReceived / sendAmount).toFixed(6));
  }

  if (!amountReceived && rate) {
    amountReceived = Number((rate * sendAmount).toFixed(3));
  }

  if (!rate || !amountReceived) return null;

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: sendAmount,
    exchange_rate: rate,
    fee,
    amount_received: Number(amountReceived.toFixed(3)),
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
  };
}

function buildResult(source, rate, fee = 0, amountReceived = null, extra = {}) {
  const sendAmount = Number(source.send_amount || 1);
  const normalizedAmountReceived =
    amountReceived !== null && amountReceived !== undefined
      ? Number(Number(amountReceived).toFixed(6))
      : Number(Number(rate).toFixed(6));

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: sendAmount,
    exchange_rate: Number(Number(rate).toFixed(6)),
    fee: Number(Number(fee || 0).toFixed(6)),
    amount_received: normalizedAmountReceived,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
    ...extra,
  };
}

async function handleLemFi(page, source) {
  const originCfg = getOriginConfig(source.origin);
  const destName = destinationCountryName(source.destination);
  const destCurrency = currencyForDestination(source.destination);

  await page.goto("https://www.lemfi.com/en-us/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByRole("button", { name: "Accept all cookies" }).click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1000);

  // Source currency
  await page.getByText(originCfg.currency, { exact: true }).click({ timeout: 6000 }).catch(() => {});
  let searchInput = page.getByPlaceholder("Enter currency or country");
  await searchInput.waitFor({ timeout: 10000 });
  await searchInput.click();
  await searchInput.fill("usd");
  await page.waitForTimeout(1200);

  await page.locator("div").filter({ hasText: "United StatesUSD - US Dollars" }).nth(2).click({ timeout: 8000 }).catch(async () => {
    await page.getByText(/United StatesUSD - US Dollars|United States.*USD|USD/i).first().click().catch(() => {});
  });

  await page.waitForTimeout(1200);

  // Destination currency
  await page.getByText("EUR", { exact: true }).click({ timeout: 6000 }).catch(async () => {
    const codes = page.locator("div").filter({ hasText: /^[A-Z]{3}$/ });
    const count = await codes.count();
    if (count >= 2) await codes.nth(1).click({ force: true }).catch(() => {});
  });

  searchInput = page.getByPlaceholder("Enter currency or country");
  await searchInput.waitFor({ timeout: 10000 });
  await searchInput.click();
  await searchInput.fill("nig");
  await page.waitForTimeout(1200);

  await page.locator("div").filter({ hasText: "NigeriaNGN - Naira" }).nth(2).click({ timeout: 8000 }).catch(async () => {
    await page.getByText(/NigeriaNGN - Naira|Nigeria.*NGN|NGN/i).first().click().catch(() => {});
  });

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    /USD\s*=\s*([0-9.,]+)\s*NGN/i,
    /1\s*USD\s*=\s*([0-9.,]+)\s*NGN/i,
    /USD\s*1\s*=\s*([0-9.,]+)\s*NGN/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate > 0) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    rate = extractRateFromText(bodyText, originCfg.currency, destCurrency);
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract LemFi rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handleSendwave(page, source) {
  const originCfg = getOriginConfig(source.origin);
  const destName = destinationCountryName(source.destination);
  const destCurrency = currencyForDestination(source.destination);

  await page.goto(`https://www.sendwave.com/${originCfg.localePath}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(3000);

  const sendInput = page.getByRole("textbox", { name: "exchange-calculator-send-" });
  await sendInput.waitFor({ timeout: 10000 });

  await page
    .getByTestId("exchange-calculator-send-country-select")
    .getByTestId("ExpandMoreRoundedIcon")
    .click();

  await page.getByRole("combobox", { name: "Search" }).fill(originCfg.countrySearch);
  await page.getByText(new RegExp(`${originCfg.countryName}.*${originCfg.currency}`, "i")).click().catch(async () => {
    await page.getByText(new RegExp(originCfg.countryName, "i")).first().click().catch(() => {});
  });

  await page.waitForTimeout(1000);

  await page.getByTestId("exchange-calculator-receive-country-select").click();
  await page.getByRole("combobox", { name: "Search" }).fill(destName.toLowerCase());
  await page.locator("div").filter({ hasText: new RegExp(`^${destName}${destCurrency}$`, "i") }).click().catch(async () => {
    await page.getByText(new RegExp(destName, "i")).first().click().catch(() => {});
  });

  await page.waitForTimeout(1000);

  await sendInput.click();
  await sendInput.fill("1");

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  const payload = buildPayloadFromText(source, bodyText);
  if (!payload) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Sendwave rate. Screenshot: ${file}`);
  }
  return payload;
}

async function handleTapTap(page, source) {
  const originCfg = getOriginConfig(source.origin);
  const destCurrency = currencyForDestination(source.destination);
  const destinationOption = source.destination === "NG" ? "NG-NGN-DESTINATION" : "GH-GHS-DESTINATION";

  await page.goto("https://www.taptapsend.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(3000);

  await page.getByRole("button", { name: "Close Cookie Popup" }).click({ timeout: 10000 }).catch(() => {});
  await page.locator("#destination-currency").selectOption(destinationOption).catch(() => {});
  await page.waitForTimeout(3000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    new RegExp(`${originCfg.currency}\\s*1\\s*=\\s*([0-9.]+)\\s*${destCurrency}`, "i"),
    new RegExp(`1\\s*${originCfg.currency}\\s*=\\s*([0-9.]+)\\s*${destCurrency}`, "i"),
    new RegExp(`${originCfg.currency}\\s*=\\s*([0-9.]+)\\s*${destCurrency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate > 0) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    rate = extractRateFromText(bodyText, originCfg.currency, destCurrency);
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract TapTap Send rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handlePayAngel(page, source) {
  const originCfg = getOriginConfig(source.origin);
  const fromCurrency = originCfg.currency; // USD for US->NG
  const toCurrency = currencyForDestination(source.destination); // NGN

  await page.goto("https://payangel.com/#rates", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByRole("button", { name: /Close dialogue/i })
    .click({ timeout: 5000 })
    .catch(() => {});

  await page.keyboard.press("Escape").catch(() => {});

  // First open source currency dropdown
  await page.getByRole("button", { name: /GBP|USD|CAD/i })
    .first()
    .click({ timeout: 10000 });

  // Site sometimes requires selecting CAD first before USD appears cleanly
  await page.getByRole("option", { name: /CAD Canada/i })
    .click({ timeout: 8000 })
    .catch(() => {});

  await page.waitForTimeout(1000);

  // Destination currency = NGN Nigeria
  await page.getByRole("button", { name: /GHS|NGN/i })
    .click({ timeout: 10000 });

  await page.getByRole("option", { name: /NGN Nigeria/i })
    .click({ timeout: 10000 });

  await page.waitForTimeout(1000);

  // Re-open source currency and set USD
  await page.getByRole("button", { name: /CAD|GBP|USD/i })
    .first()
    .click({ timeout: 10000 });

  await page.getByText(/^USD$/i)
    .first()
    .click({ timeout: 10000 });

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /USD\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /1\s*USD\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /USD\s*1\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;

    const candidate = parseLocaleNumber(match[1]);

    if (candidate && candidate >= 800 && candidate <= 2500) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract live PayAngel USD->NGN rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate, {
    source_url: "https://payangel.com/#rates",
    verification_status: "verified_from_live_payangel_rates_widget",
  });
}

async function handleNala(page, source) {
  await page.goto("https://www.nala.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByRole("button", { name: "Select currency" }).first().click({ timeout: 15000 });
  await page.getByRole("option", { name: /United States Dollar USD/i }).click({ timeout: 15000 });

  await page.waitForTimeout(1000);

  await page.getByRole("button", { name: "Select currency" }).nth(1).click({ timeout: 15000 });
  await page.getByRole("option", { name: /Nigerian Naira NGN Nigerian/i }).click({ timeout: 15000 });

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /USD\s*[≈=]\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /1\s*USD\s*[≈=]\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;

    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate >= 800 && candidate <= 2500) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract live Nala USD->NGN rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate, {
    verification_status: "verified_from_live_nala_widget",
    source_url: "https://www.nala.com/",
  });
}


async function handleInstarem(page, source) {
  const originCfg = getOriginConfig(source.origin);
  const destName = destinationCountryName(source.destination);
  const destCurrency = currencyForDestination(source.destination);

  await page.goto("https://www.instarem.com/en-gb/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  // Source -> United States of America / USD
  await page.locator(".widget-calculator__dropdown-main-right").first().click();
  await page.getByText("United States of America").first().click().catch(async () => {
    await page.getByText(/United States of America|United States|USD/i).first().click().catch(() => {});
  });

  await page.waitForTimeout(1500);

  // Destination -> Nigeria / NGN
  await page
    .locator(".widget-calculator__recive > .widget-calculator__dropdown > .widget-calculator__dropdown-main > .widget-calculator__dropdown-main-right")
    .click();

  await page.getByText("Nigeria NGN").click().catch(async () => {
    await page.getByText(/Nigeria NGN|Nigeria|NGN/i).first().click().catch(() => {});
  });

  await page.waitForTimeout(3000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    /\b(1337\.2511)\b/i,
    /1\s*USD\s*=\s*([0-9,]+\.\d+)\s*NGN/i,
    /USD\s*=\s*([0-9,]+\.\d+)\s*NGN/i,
    /([0-9,]+\.\d+)\s*NGN/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate > 0) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Instarem rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}



async function runSource(browser, source) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
  });

  try {
    let payload;

    if (source.provider === "LemFi") payload = await handleLemFi(page, source);
    else if (source.provider === "Sendwave") payload = await handleSendwave(page, source);
    else if (source.provider === "TapTap Send") payload = await handleTapTap(page, source);
    else if (source.provider === "PayAngel") payload = await handlePayAngel(page, source);
    else if (source.provider === "Nala") payload = await handleNala(page, source);
    else if (source.provider === "Instarem") payload = await handleInstarem(page, source);
    
    else throw new Error(`No handler configured for ${source.provider}`);

    await postQuote(payload);
    console.log(`OK: ${source.provider} ${source.origin}->${source.destination}`);
  } finally {
    await page.close();
  }
}

async function main() {
  const sources = JSON.parse(fs.readFileSync("./sources-us-ng1.json", "utf8"));
  const browser = await chromium.launch({ headless: HEADLESS });

  for (const source of sources) {
    try {
      await runSource(browser, source);
    } catch (err) {
      console.error(`FAIL: ${source.provider} - ${err.message}`);
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});