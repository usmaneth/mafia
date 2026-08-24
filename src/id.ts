export function createId(prefix = "job"): string {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(2, 14);
  const random = crypto.randomUUID().slice(0, 6);
  return `${prefix}-${stamp}-${random}`;
}
