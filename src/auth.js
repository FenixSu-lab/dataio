import crypto from "node:crypto";

const enabled = process.env.AUTH_ENABLED === "true";
const issuer = (process.env.OIDC_ISSUER || "").replace(/\/$/, "");
const internalIssuer = (process.env.OIDC_INTERNAL_ISSUER || issuer).replace(/\/$/, "");
const audience = process.env.OIDC_AUDIENCE || "";
const authzUrl = process.env.AUTHZ_CHECK_URL || "http://ai-portal:3000/api/authorization/check";
const serviceKey = process.env.AUTHZ_SERVICE_KEY || "";
let jwksCache = { expiresAt: 0, keys: [] };

function decode(segment) {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

async function getJwk(kid) {
  if (Date.now() >= jwksCache.expiresAt) {
    const response = await fetch(`${internalIssuer}/protocol/openid-connect/certs`);
    if (!response.ok) throw new Error("Unable to load OIDC signing keys");
    const body = await response.json();
    jwksCache = { keys: body.keys || [], expiresAt: Date.now() + 5 * 60_000 };
  }
  const key = jwksCache.keys.find((candidate) => candidate.kid === kid);
  if (!key) {
    jwksCache.expiresAt = 0;
    throw new Error("OIDC signing key not found");
  }
  return key;
}

async function verifyAccessToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed access token");
  const header = decode(parts[0]);
  const claims = decode(parts[1]);
  if (header.alg !== "RS256" || !header.kid) throw new Error("Unsupported access token");
  const key = crypto.createPublicKey({ key: await getJwk(header.kid), format: "jwk" });
  const valid = crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    key,
    Buffer.from(parts[2], "base64url"),
  );
  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!valid || claims.iss !== issuer || claims.exp <= now || (claims.nbf && claims.nbf > now)) {
    throw new Error("Invalid access token");
  }
  if (audience && !audiences.includes(audience)) throw new Error("Invalid token audience");
  if (!claims.sub) throw new Error("Access token subject is missing");
  return claims;
}

async function checkPermission(claims, permission) {
  const response = await fetch(authzUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Authz-Service-Key": serviceKey },
    body: JSON.stringify({ issuer: claims.iss, subject: claims.sub, permission, issuedAt: claims.iat }),
  });
  if (!response.ok) throw new Error(`Authorization service failed (${response.status})`);
  return response.json();
}

export function requirePermission(permission, options = {}) {
  return async (request, response, next) => {
    if (!enabled || options.bypass?.(request)) return next();
    try {
      const authorization = request.get("authorization") || "";
      const forwardedToken = request.get("x-forwarded-access-token") || "";
      const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : forwardedToken;
      if (!token) {
        return response.status(401).json({ error: "authentication_required" });
      }
      const requiredPermission = typeof permission === "function" ? permission(request) : permission;
      let claims;
      try {
        claims = await verifyAccessToken(token);
      } catch (error) {
        console.error("Access token validation failed", error);
        return response.status(401).json({ error: "invalid_access_token" });
      }
      let decision;
      try {
        decision = await checkPermission(claims, requiredPermission);
      } catch (error) {
        console.error("Authorization service failed", error);
        return response.status(503).json({ error: "authorization_service_unavailable" });
      }
      if (!decision.allowed) return response.status(403).json({ error: "permission_denied", permission: requiredPermission });
      request.auth = { claims, permission: requiredPermission, scopes: decision.scopes || [] };
      return next();
    } catch (error) {
      console.error("Authorization middleware failed", error);
      return response.status(500).json({ error: "authorization_middleware_failed" });
    }
  };
}

export function currentPrincipal(request) {
  const claims = request.auth?.claims;
  return claims ? {
    subject: claims.sub,
    username: claims.preferred_username || claims.email || claims.sub,
    email: claims.email || null,
  } : null;
}
