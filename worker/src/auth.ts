import { jwtVerify, type JWTPayload } from 'jose'

export interface AuthUser {
  sub: string    // Supabase user ID
  email?: string
}

/**
 * Verify a Supabase JWT and return the user payload.
 * Throws if the token is missing or invalid.
 */
export async function verifySupabaseJwt(
  token: string,
  jwtSecret: string,
): Promise<AuthUser> {
  const secret = new TextEncoder().encode(jwtSecret)
  const { payload } = await jwtVerify(token, secret, {
    issuer: 'supabase',
  })
  return { sub: payload.sub!, email: payload.email as string | undefined }
}

/**
 * Extract Bearer token from Authorization header.
 */
export function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get('Authorization')
  if (!auth || !auth.startsWith('Bearer ')) return null
  return auth.slice(7)
}
