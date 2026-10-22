import type { User } from 'firebase/auth'

export async function apiRequest<T>(
  user: User,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = await user.getIdToken()
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  })
  const body = await response.json().catch(() => ({})) as { error?: string } & T
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`)
  return body
}
