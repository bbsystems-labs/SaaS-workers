export interface Env {
  DB: any;
  ORIGIN: string;
}

function forbiddenPage(): Response {
  return new Response(
    `<!doctype html><html lang="es"><head><meta charset="utf-8"/><title>Acceso restringido</title></head>
     <body style="font-family:system-ui;padding:24px">
       <h1>Acceso restringido</h1>
       <p>Tu usuario no está autorizado para acceder a esta aplicación.</p>
     </body></html>`,
    { status: 403, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

function getAccessEmail(request: Request): string | null {
  return (
    request.headers.get("CF-Access-Authenticated-User-Email") ||
    request.headers.get("Cf-Access-Authenticated-User-Email")
  );
}

async function userExists(email: string, env: Env): Promise<boolean> {
  const row = await env.DB
    .prepare(`SELECT user_id FROM users WHERE lower(user_id)=lower(?) LIMIT 1`)
    .bind(email)
    .first<{ user_id: string }>();
  return !!row;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const email = getAccessEmail(request);
      if (!email) return new Response("Unauthenticated", { status: 401 });

      const ok = await userExists(email, env);
      if (!ok) return forbiddenPage(); // ✅ NO throw

      // Proxy a la web real
      const url = new URL(request.url);
      const originBase = env.ORIGIN.replace(/\/+$/, "");
      const targetUrl = originBase + url.pathname + (url.search || "");

      return fetch(targetUrl, request);
    } catch (e: any) {
      return new Response(`Internal error: ${e?.message ?? "unknown"}`, { status: 500 });
    }
  },
};
