/**
 * Ids for sessions, messages and endpoints.
 *
 * Time-prefixed so ids sort roughly by creation, with a random tail so two
 * created in the same millisecond do not collide. Lowercase alphanumeric, which
 * is what SecretStorage requires of the ids derived from them.
 */
export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
