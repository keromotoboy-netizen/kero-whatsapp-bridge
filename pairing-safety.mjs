// Non-destructive pairing guard for an existing CRM/WhatsApp session.
// This module intentionally has no filesystem side effects.
export function assertFreshPairingSafe(entries) {
  if (!Array.isArray(entries) || entries.length > 0) {
    throw new Error('existing_session_data_protected');
  }
}
