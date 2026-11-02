// Posts to a Facebook Page through the official Graph API (photo + text).
// Posting into Facebook groups is not possible through any API since 2024,
// so groups are handled by sharing from the Page.

const GRAPH = process.env.FACEBOOK_GRAPH_BASE || "https://graph.facebook.com";

export class FacebookPage {
  constructor({ pageId, token }) {
    this.pageId = pageId;
    this.token = token;
  }

  async check() {
    const res = await fetch(`${GRAPH}/${encodeURIComponent(this.pageId)}?fields=name&access_token=${encodeURIComponent(this.token)}`, {
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (data.error) throw new Error(`Facebook: ${data.error.message}`);
    return data.name;
  }

  /** Returns the URL of the new post. */
  async postPhoto(image, message) {
    const form = new FormData();
    form.append("message", message);
    form.append("published", "true");
    form.append("access_token", this.token);
    form.append("source", new Blob([image], { type: "image/jpeg" }), "photo.jpg");
    const res = await fetch(`${GRAPH}/${encodeURIComponent(this.pageId)}/photos`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json().catch(() => ({}));
    if (data.error) throw new Error(`Facebook: ${data.error.message}`);
    const postId = data.post_id || data.id;
    return postId ? `https://www.facebook.com/${postId}` : null;
  }
}
