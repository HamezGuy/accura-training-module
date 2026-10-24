const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes text for an HTML text or quoted attribute position. Shared by the
 * learner lesson renderer and the error digest mail. */
export const escapeHtml = (v: string): string => v.replace(/[&<>"']/g, c => ENTITIES[c] ?? c);
