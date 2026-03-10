export async function execCloudflareAdmin(
  args: Record<string, unknown>,
  env: Env
): Promise<Record<string, unknown>> {
  const CF_API = "https://api.cloudflare.com/client/v4";
  const token = (env as any).CF_API_TOKEN;
  const accountId = (env as any).CF_ACCOUNT_ID;

  if (!token) return { error: "CF_API_TOKEN not set. Run: wrangler secret put CF_API_TOKEN" };
  if (!accountId) return { error: "CF_ACCOUNT_ID not set. Add CF_ACCOUNT_ID to wrangler.toml [vars]" };

  const h = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const cfFetch = async (path: string, opts: RequestInit = {}) => {
    const res = await fetch(`${CF_API}${path}`, { ...opts, headers: { ...h, ...(opts.headers ?? {}) } });
    const json = await res.json() as { success: boolean; result: unknown; errors?: { message: string }[] };
    if (!json.success) return { error: json.errors?.[0]?.message ?? "CF API error", raw: json };
    return { success: true, result: json.result };
  };

  const { action } = args as { action: string };

  switch (action) {
    // ── Workers ──────────────────────────────────────────────────────────────
    case "list_workers":
      return cfFetch(`/accounts/${accountId}/workers/scripts`);

    case "get_worker_code": {
      const { worker_name } = args as { worker_name: string };
      if (!worker_name) return { error: "worker_name required" };
      const res = await fetch(`${CF_API}/accounts/${accountId}/workers/scripts/${worker_name}`, {
        headers: { "Authorization": `Bearer ${token}` },
      });
      const text = await res.text();
      return { success: res.ok, code: text.slice(0, 50000) }; // truncate for context
    }

    case "deploy_worker": {
      const { worker_name, worker_code } = args as { worker_name: string; worker_code: string };
      if (!worker_name || !worker_code) return { error: "worker_name and worker_code required" };
      // Deploy via multipart form (Workers API requirement)
      const form = new FormData();
      form.append("metadata", JSON.stringify({
        main_module: "index.js",
        compatibility_date: "2025-09-15",
        compatibility_flags: ["nodejs_compat"],
      }));
      form.append("index.js", new Blob([worker_code], { type: "application/javascript+module" }), "index.js");
      const res = await fetch(`${CF_API}/accounts/${accountId}/workers/scripts/${worker_name}`, {
        method: "PUT",
        headers: { "Authorization": `Bearer ${token}` },
        body: form,
      });
      const json = await res.json() as { success: boolean; result: unknown };
      return { success: json.success, deployed: worker_name, result: json.result };
    }

    case "tail_logs": {
      // Create a tail session and return the WebSocket URL — agent can poll it
      const { worker_name } = args as { worker_name: string };
      if (!worker_name) return { error: "worker_name required" };
      const res = await cfFetch(`/accounts/${accountId}/workers/scripts/${worker_name}/tails`, {
        method: "POST", body: JSON.stringify({}),
      });
      return res; // Returns { id, url, expires_at } — ws:// URL for live logs
    }

    case "get_worker_analytics": {
      const { worker_name } = args as { worker_name: string };
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      return cfFetch(
        `/accounts/${accountId}/workers/scripts/${worker_name}/analytics/requests?since=${since}`
      );
    }

    // ── KV ───────────────────────────────────────────────────────────────────
    case "list_kv_namespaces":
      return cfFetch(`/accounts/${accountId}/storage/kv/namespaces`);

    case "create_kv_namespace": {
      const { namespace_title } = args as { namespace_title: string };
      return cfFetch(`/accounts/${accountId}/storage/kv/namespaces`, {
        method: "POST", body: JSON.stringify({ title: namespace_title }),
      });
    }

    case "kv_get": {
      const { namespace_id, kv_key } = args as { namespace_id: string; kv_key: string };
      const res = await fetch(
        `${CF_API}/accounts/${accountId}/storage/kv/namespaces/${namespace_id}/values/${kv_key}`,
        { headers: { "Authorization": `Bearer ${token}` } }
      );
      return { success: res.ok, value: await res.text() };
    }

    case "kv_set": {
      const { namespace_id, kv_key, kv_value } = args as { namespace_id: string; kv_key: string; kv_value: string };
      const res = await fetch(
        `${CF_API}/accounts/${accountId}/storage/kv/namespaces/${namespace_id}/values/${kv_key}`,
        { method: "PUT", headers: { "Authorization": `Bearer ${token}` }, body: kv_value }
      );
      return { success: res.ok };
    }

    // ── D1 ───────────────────────────────────────────────────────────────────
    case "list_d1_databases":
      return cfFetch(`/accounts/${accountId}/d1/database`);

    case "create_d1_database": {
      const { database_name } = args as { database_name: string };
      return cfFetch(`/accounts/${accountId}/d1/database`, {
        method: "POST", body: JSON.stringify({ name: database_name }),
      });
    }

    case "query_d1": {
      const { database_id, sql } = args as { database_id: string; sql: string };
      return cfFetch(`/accounts/${accountId}/d1/database/${database_id}/query`, {
        method: "POST", body: JSON.stringify({ sql }),
      });
    }

    // ── R2 ───────────────────────────────────────────────────────────────────
    case "list_r2_buckets":
      return cfFetch(`/accounts/${accountId}/r2/buckets`);

    case "create_r2_bucket": {
      const { bucket_name } = args as { bucket_name: string };
      return cfFetch(`/accounts/${accountId}/r2/buckets`, {
        method: "POST", body: JSON.stringify({ name: bucket_name }),
      });
    }

    // ── DNS ──────────────────────────────────────────────────────────────────
    case "list_dns_records": {
      const { zone_id } = args as { zone_id: string };
      if (!zone_id) return { error: "zone_id required. Find it in the Cloudflare dashboard sidebar." };
      return cfFetch(`/zones/${zone_id}/dns_records`);
    }

    case "create_dns_record": {
      const { zone_id, dns_type, dns_name, dns_content, dns_ttl = 1 } = args as {
        zone_id: string; dns_type: string; dns_name: string; dns_content: string; dns_ttl?: number;
      };
      return cfFetch(`/zones/${zone_id}/dns_records`, {
        method: "POST",
        body: JSON.stringify({ type: dns_type, name: dns_name, content: dns_content, ttl: dns_ttl }),
      });
    }

    case "delete_dns_record": {
      const { zone_id, record_id } = args as { zone_id: string; record_id: string };
      return cfFetch(`/zones/${zone_id}/dns_records/${record_id}`, { method: "DELETE" });
    }

    // ── Pages ────────────────────────────────────────────────────────────────
    case "list_pages_projects":
      return cfFetch(`/accounts/${accountId}/pages/projects`);

    default:
      return { error: `Unknown action: ${action}` };
  }
}
