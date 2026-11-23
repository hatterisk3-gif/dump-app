const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

const EXT_BY_MIME = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif"
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/img/")) {
      let key = "";
      try {
        key = decodeURIComponent(url.pathname.slice(5));
      } catch (_) {
        return jsonResponse({ error: "bad_key" }, 400);
      }
      if (!key || key.includes("..")) {
        return jsonResponse({ error: "bad_key" }, 400);
      }

      const obj = request.method === "HEAD"
        ? await env.MEDIA_BUCKET.head(key)
        : await env.MEDIA_BUCKET.get(key);

      if (!obj) {
        return jsonResponse({ error: "not_found" }, 404);
      }

      const headers = {
        ...CORS_HEADERS,
        "Content-Type": obj.httpMetadata?.contentType || "image/jpeg",
        "Cache-Control": "public, max-age=31536000, immutable"
      };
      if (obj.httpEtag) headers["ETag"] = obj.httpEtag;
      if (typeof obj.size === "number") headers["Content-Length"] = String(obj.size);

      return new Response(request.method === "HEAD" ? null : obj.body, {
        status: 200,
        headers
      });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return jsonResponse({ ok: true, service: "dump-media" });
    }

    if (request.method === "POST" && (url.pathname === "/upload" || url.pathname === "/")) {
      let body;
      try {
        body = await request.json();
      } catch (_) {
        return jsonResponse({ success: false, error: "bad_json" }, 400);
      }

      const raw = String(body?.data || body?.dataUrl || "");
      if (!raw) {
        return jsonResponse({ success: false, error: "empty" }, 400);
      }

      let mime = String(body?.mimeType || "image/jpeg").toLowerCase();
      let b64 = raw;
      const m = raw.match(/^data:([^;]+);base64,(.+)$/i);
      if (m) {
        mime = (m[1] || mime).toLowerCase();
        b64 = m[2];
      }
      b64 = String(b64 || "").replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
      if (!b64) {
        return jsonResponse({ success: false, error: "empty" }, 400);
      }

      let bytes;
      try {
        const bin = atob(b64);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) {
          bytes[i] = bin.charCodeAt(i);
        }
      } catch (_) {
        return jsonResponse({ success: false, error: "bad_base64" }, 400);
      }

      if (!bytes.byteLength) {
        return jsonResponse({ success: false, error: "empty" }, 400);
      }
      if (bytes.byteLength > 10 * 1024 * 1024) {
        return jsonResponse({ success: false, error: "too_large" }, 413);
      }

      const ext = EXT_BY_MIME[mime] || "jpg";
      const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const rand = Math.random().toString(36).slice(2, 8);
      const key = `${ymd}-${Date.now()}-${rand}.${ext}`;

      await env.MEDIA_BUCKET.put(key, bytes, {
        httpMetadata: {
          contentType: mime,
          cacheControl: "public, max-age=31536000, immutable"
        }
      });

      const publicUrl = `${url.origin}/img/${key}`;
      return jsonResponse({
        success: true,
        id: key,
        url: publicUrl,
        viewUrl: publicUrl,
        thumb: publicUrl,
        storage: "r2"
      });
    }

    return jsonResponse({ error: "not_found" }, 404);
  }
};
