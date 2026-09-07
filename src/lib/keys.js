/**
 * Every KV key begins with a namespace and then the tenant id. Tenancy is
 * therefore structural: there is no code path that can read a share belonging
 * to another domain, because the tenant is part of the lookup key rather than
 * a field checked afterwards.
 */
export const keys = Object.freeze({
	share: (tenantId, shareId) => ["share", tenantId, shareId],
	sharePrefix: (tenantId) => ["share", tenantId],
	pending: (tenantId, shareId) => ["pending", tenantId, shareId],
	magic: (tenantId, tokenHash) => ["magic", tenantId, tokenHash],
	session: (tenantId, sessionId) => ["session", tenantId, sessionId],
	pinAttempts: (tenantId, shareId) => ["pinfail", tenantId, shareId],
	loginAttempts: (tenantId, email) => ["loginfail", tenantId, email],
});
