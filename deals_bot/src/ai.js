// Writes the Hebrew post with Claude (Anthropic API), from the product photo
// or screenshot, product data from AliExpress (when available) and Oren's notes.

const API_BASE = process.env.ANTHROPIC_API_BASE || "https://api.anthropic.com";
export const LINK_PLACEHOLDER = "{{LINK}}";

const SYSTEM = `אתה כותב פוסטים בעברית עבור אורן, שמנהל קהילה גדולה של חובבי בית חכם שתומך ב-Apple Home (HomeKit).
הפוסטים מתפרסמים בערוץ טלגרם, בקבוצות וואטסאפ ובדף פייסבוק, עם קישור שותפים לעליאקספרס.

כללים:
1. השתמש רק בעובדות שמופיעות בתמונה, בנתוני המוצר או בהערות של אורן. אל תמציא מפרט, מחיר, הנחה, דירוג או תאימות.
2. תאימות: כתוב שהמוצר עובד עם Apple Home / HomeKit / Matter / Thread רק אם זה מופיע במפורש בחומר שקיבלת. אם זה לא ברור, אל תטען את זה, והוסף אזהרה לאורן.
3. מבנה: שורת פתיחה קליטה עם אימוג'י אחד או שניים. אחר כך 2–4 שורות קצרות: מה המוצר עושה ולמה הוא שימושי בבית חכם. פרוטוקול (Matter/Thread/Zigbee/Wi-Fi) ומחיר אם ידועים. בסוף שורה בדיוק כזו: "👉 לרכישה: ${LINK_PLACEHOLDER}".
4. טקסט רגיל בלבד: בלי Markdown, בלי כוכביות, בלי HTML, בלי האשטגים.
5. עד 650 תווים כולל הכול. כתוב בעברית טבעית וחמה, לא שיווקית מדי.
6. אל תוסיף הצהרה על קישור שותפים, היא מתווספת אוטומטית.

ענה ב-JSON בלבד, בלי שום טקסט מסביב, במבנה:
{"product_name": "שם קצר של המוצר", "post": "הפוסט המלא", "warnings": ["הערות לאורן בעברית, למשל מה לא היה ברור"]}`;

function mediaType(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return "image/webp";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif";
  return "image/jpeg";
}

export class PostWriter {
  constructor({ apiKey, model }) {
    this.apiKey = apiKey;
    this.model = model || "claude-sonnet-5-5";
  }

  /**
   * @param {object} input
   * @param {Buffer|null} input.image product photo or screenshot
   * @param {object|null} input.product data from the AliExpress API or the product page
   * @param {string} input.notes Oren's own words about the product
   * @param {string} [input.previousPost] set when asking for a different version
   * @param {string} [input.instruction] extra request, e.g. "shorter"
   */
  async write({ image, product, notes, previousPost, instruction }) {
    if (!this.apiKey) throw new Error("חסר מפתח Anthropic API בהגדרות התוסף.");
    const content = [];
    if (image) {
      content.push({ type: "image", source: { type: "base64", media_type: mediaType(image), data: image.toString("base64") } });
    }
    const parts = [];
    if (product) parts.push("נתוני המוצר מעליאקספרס:\n" + JSON.stringify(stripEmpty(product), null, 2));
    if (notes) parts.push("הערות של אורן על המוצר:\n" + notes);
    if (!product && !notes && image) parts.push("כל המידע נמצא בתמונה (צילום של המוצר או של דף המוצר).");
    if (previousPost) parts.push("זו הגרסה הקודמת, כתוב גרסה שונה וטובה יותר:\n" + previousPost);
    if (instruction) parts.push("בקשה של אורן לגרסה הזו: " + instruction);
    parts.push("כתוב את הפוסט.");
    content.push({ type: "text", text: parts.join("\n\n") });

    const res = await fetch(`${API_BASE}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: this.model, max_tokens: 1500, system: SYSTEM, messages: [{ role: "user", content }] }),
      signal: AbortSignal.timeout(90000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data.error && data.error.message) || `HTTP ${res.status}`;
      throw new Error(`Anthropic API: ${msg}`);
    }
    const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    return parseAnswer(text);
  }
}

export function parseAnswer(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  let obj = null;
  if (start >= 0 && end > start) {
    try {
      obj = JSON.parse(text.slice(start, end + 1));
    } catch {
      obj = null;
    }
  }
  if (!obj || typeof obj.post !== "string" || !obj.post.trim()) {
    // Fall back to the raw text rather than failing.
    obj = { product_name: "", post: text.trim(), warnings: ["התשובה לא הגיעה במבנה הצפוי, בדוק את הפוסט לפני פרסום."] };
  }
  let post = obj.post.replace(/\*\*/g, "").trim();
  if (!post.includes(LINK_PLACEHOLDER)) post += `\n\n👉 לרכישה: ${LINK_PLACEHOLDER}`;
  return {
    productName: String(obj.product_name || "").trim(),
    post,
    warnings: Array.isArray(obj.warnings) ? obj.warnings.map(String).filter(Boolean) : [],
  };
}

function stripEmpty(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)));
}
