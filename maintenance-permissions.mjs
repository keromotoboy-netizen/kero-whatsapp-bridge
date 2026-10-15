// Fail-closed controls for maintenance that can modify WhatsApp labels and
// clear message history. No mutation is enabled by default.
export function maintenanceMutationAllowed(env = {}) {
  return env.CRM_ALLOW_DESTRUCTIVE_MAINTENANCE === '1';
}

export function scheduledMaintenanceAllowed(env = {}) {
  return maintenanceMutationAllowed(env) &&
    env.CRM_MAINTENANCE_SCHEDULED === '1';
}
