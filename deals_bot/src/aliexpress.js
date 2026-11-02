// AliExpress helpers: find links in a message, resolve a short affiliate link
// to its product id, and (once API keys are approved) read product details and
// create affiliate links through the official Affiliate API.

import crypto from "node:crypto";

const API_URL = process.env.ALIEXPRESS_API_URL || "https://api-sg.aliexpress.com/sync";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const LINK_RE = /https?:\/\/(?:[a-z0-9-]+\.)*(?:aliexpress\.(?:com|us|ru)|aliexpress-media\.com|ali\.ski)\/[^\s<>"']+/gi;

export function findAliExpressLinks(text) {
  return [...String(text || "").matchAll(LINK_RE)].map((m) => m[0].replace(/[).,!?»"']+$/, ""));
}

/** Product id from a URL that already contains it, or null. */
export function productIdFromUrl(url) {
  let decoded = url;
  for (let i = 0; i < 3; i++) {
    try {
      const d = decodeURIComponent(decoded);
      if (d === decoded) break;
      decoded = d;
    } catch {
      break;
    }
  }
  const m =
    decoded.match(/\/item\/(?:[^/?#]*?\/)?(\d{8,20})\.html/i) ||
    decoded.match(/[?&](?:productIds?|itemId|item_id|objectId)=(\d{8,20})/i) ||
    decoded.match(/\/i\/(\d{8,20})\.html/i);
  return m ? m[1] : null;
}

/**
 * Follow a short link (s.click.aliexpress.com/e/...) hop by hop until a URL
 * with the product id shows up. Returns { productId, finalUrl }.
 */
export async function resolveProduct(url, maxHops = 8) {
  let current = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    const id = productIdFromUrl(current);
    if (id) return { productId: id, finalUrl: current };
    let res;
    try {
      res = await fetch(current, {
        redirect: "manual",
        headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" },
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      break;
    }
    const loc = res.headers.get("location");
    if (loc) {
      current = new URL(loc, current).toString();
      continue;
    }
    // Some hops redirect with a page instead of a header.
    const body = await res.text().catch(() => "");
    const inPage =
      body.match(/(?:window\.location(?:\.href)?\s*=|url=)\s*["']?([^"'\s>]+)/i) ||
      body.match(/https?:\/\/[^"'\s<>]*\/item\/\d{8,20}\.html/i);
    const next = inPage ? (inPage[1] || inPage[0]).replace(/&amp;/g, "&") : null;
    if (!next || next === current) {
      const id2 = productIdFromUrl(body.slice(0, 200000));
      return { productId: id2, finalUrl: current };
    }
    current = new URL(next, current).toString();
  }
  return { productId: productIdFromUrl(current), finalUrl: current };
}

/** Best effort without API keys: title and main image from the public product page. */
export async function scrapeProduct(productId) {
  try {
    const res = await fetch(`https://www.aliexpress.com/item/${productId}.html`, {
      headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const meta = (prop) => {
      const m =
        html.match(new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)`, "i")) ||
        html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${prop}["']`, "i"));
      return m ? decodeEntities(m[1]) : null;
    };
    const title = meta("og:title");
    let image = meta("og:image");
    if (image && image.startsWith("//")) image = "https:" + image;
    if (!title && !image) return null;
    return { title: title ? title.replace(/\s*-\s*AliExpress.*$/i, "").trim() : null, image };
  } catch {
    return null;
  }
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export async function downloadImage(url) {
  if (url.startsWith("//")) url = "https:" + url;
  const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`image download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error("image download returned too little data");
  return buf;
}

/** Official AliExpress Affiliate API ("sync" gateway, HMAC-SHA256 signature). */
export class AliExpressApi {
  constructor({ appKey, appSecret, trackingId }) {
    this.appKey = appKey;
    this.appSecret = appSecret;
    this.trackingId = trackingId;
  }

  sign(params) {
    const base = Object.keys(params)
      .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== "")
      .sort()
      .map((k) => k + String(params[k]))
      .join("");
    return crypto.createHmac("sha256", this.appSecret).update(base, "utf8").digest("hex").toUpperCase();
  }

  async call(method, params) {
    const all = {
      ...params,
      method,
      app_key: this.appKey,
      sign_method: "sha256",
      timestamp: String(Date.now()),
    };
    all.sign = this.sign(all);
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(all)) if (v !== undefined && v !== null && v !== "") body.append(k, String(v));
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
      body,
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => null);
    if (!data) throw new Error(`AliExpress API: unexpected answer (HTTP ${res.status})`);
    if (data.error_response) {
      const e = data.error_response;
      throw new Error(`AliExpress API: ${e.msg || e.sub_msg || e.code}`);
    }
    const key = method.replace(/\./g, "_") + "_response";
    const resp = data[key] && data[key].resp_result;
    if (!resp) throw new Error("AliExpress API: empty answer");
    if (resp.resp_code && Number(resp.resp_code) !== 200) {
      throw new Error(`AliExpress API: ${resp.resp_msg || resp.resp_code}`);
    }
    return resp.result || {};
  }

  async productDetails(productId) {
    const result = await this.call("aliexpress.affiliate.productdetail.get", {
      product_ids: productId,
      target_currency: "ILS",
      target_language: "EN",
      ship_to_country: "IL",
      tracking_id: this.trackingId,
    });
    const list = asList(result.products, "product");
    const p = list[0];
    if (!p) return null;
    return {
      title: p.product_title,
      image: p.product_main_image_url,
      images: asList(p.product_small_image_urls, "string"),
      price: p.target_sale_price ? `${p.target_sale_price} ${p.target_sale_price_currency || "ILS"}` : null,
      originalPrice: p.target_original_price ? `${p.target_original_price} ${p.target_original_price_currency || p.target_sale_price_currency || "ILS"}` : null,
      discount: p.discount || null,
      rating: p.evaluate_rate || null,
      orders: p.lastest_volume || null,
      category: p.second_level_category_name || p.first_level_category_name || null,
      shop: p.shop_name || null,
      promotionLink: p.promotion_link || null,
      detailUrl: p.product_detail_url || null,
    };
  }

  async affiliateLink(sourceUrl) {
    const result = await this.call("aliexpress.affiliate.link.generate", {
      promotion_link_type: 0,
      source_values: sourceUrl,
      tracking_id: this.trackingId,
    });
    const links = asList(result.promotion_links, "promotion_link");
    return (links[0] && links[0].promotion_link) || null;
  }
}

// The API returns lists either as arrays or wrapped as { product: [...] }.
function asList(value, innerKey) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  const inner = value[innerKey];
  if (Array.isArray(inner)) return inner;
  return inner ? [inner] : [];
}
