/**
 * 1Click partner auth: a JWT (three base64url parts) goes in `Authorization: Bearer` (the OpenAPI's JWT-auth
 * scheme); any other key in `X-API-Key`.
 *
 * Live response shape: since spec 0.2.0 the `OneClick*` schemas accept what live 1Click sends (`null` for unset
 * optional fields, `GET /v0/status` nesting the quote without its `correlationId`, `appFees[].limitOrderId`), so
 * bodies are validated as received; the Stage 1 normalisation is gone (lld/rails.md §3).
 */
export function oneClickAuthHeaders(apiKey: string | undefined): Record<string, string> {
  if (!apiKey) return {};
  return /^[\w-]+\.[\w-]+\.[\w-]+$/.test(apiKey) ? { authorization: `Bearer ${apiKey}` } : { "x-api-key": apiKey };
}
