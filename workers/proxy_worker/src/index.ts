const API_ORIGIN = "https://balux-api.baluxvision.workers.dev";

type Env = {
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
};

function buildTargetUrl(requestUrl: string): string {
  const url = new URL(requestUrl);
  const path = url.pathname.startsWith("/api/")
    ? url.pathname.slice(4)
    : url.pathname;
  return `${API_ORIGIN}${path}${url.search}`;
}

function buildCorsHeaders(origin: string | null, request: Request) {
  const headers = new Headers();
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-credentials", "true");
    headers.set("vary", "origin");
  }
  const reqHeaders = request.headers.get("Access-Control-Request-Headers");
  if (reqHeaders) {
    headers.set("access-control-allow-headers", reqHeaders);
  } else {
    headers.set("access-control-allow-headers", "Content-Type, Authorization");
  }
  headers.set("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  headers.set("access-control-max-age", "86400");
  return headers;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      const headers = buildCorsHeaders(request.headers.get("Origin"), request);
      return new Response(null, { status: 204, headers });
    }
    const url = new URL(request.url);
    if (url.pathname === "/__health") {
      return new Response("ok", { status: 200 });
    }

    if (request.method === "OPTIONS") {
      const corsHeaders = buildCorsHeaders(request.headers.get("Origin"), request);
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const targetUrl = buildTargetUrl(request.url);
    const headers = new Headers(request.headers);
    headers.delete("host");
    const accessEmail =
      request.headers.get("CF-Access-Authenticated-User-Email") ||
      request.headers.get("Cf-Access-Authenticated-User-Email");
    if (accessEmail) {
      headers.set("x-access-user-email", accessEmail);
    }
    if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
      headers.set("CF-Access-Client-Id", env.CF_ACCESS_CLIENT_ID);
      headers.set("CF-Access-Client-Secret", env.CF_ACCESS_CLIENT_SECRET);
    }

    let response: Response;
    try {
      response = await fetch(targetUrl, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
      });
    } catch (err) {
      const corsHeaders = buildCorsHeaders(request.headers.get("Origin"), request);
      corsHeaders.set("content-type", "application/json; charset=utf-8");
      return new Response(
        JSON.stringify({
          error: "UpstreamFetchFailed",
          targetUrl,
          detail: String(err),
        }),
        { status: 502, headers: corsHeaders }
      );
    }

    const out = new Response(response.body, response);
    const corsHeaders = buildCorsHeaders(request.headers.get("Origin"), request);
    corsHeaders.forEach((value, key) => out.headers.set(key, value));
    return out;
  },
};
