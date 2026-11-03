export const GEO_ROLES = [
	"platform_admin",
	"geo_operator",
	"tech_reviewer",
	"marketing_reviewer",
	"knowledge_reviewer",
	"viewer",
] as const;
export type GeoRole = (typeof GEO_ROLES)[number];

export type GeoAccess = "read" | "write";

const ALL_ROLES = GEO_ROLES;
const STAFF = ["platform_admin", "geo_operator", "tech_reviewer", "marketing_reviewer", "knowledge_reviewer"] as const;

/**
 * Administrators hold no review or publishing permission: an owner who needs one
 * has to grant it to themselves, which leaves a trace in the audit log.
 *
 * `access` is the API-key scope a permission needs on top of the role, so a
 * read-only key can never reach a write even if a role would allow it.
 */
const PERMISSIONS = {
	"brand.read": { access: "read", roles: ALL_ROLES },
	"brand.manage": { access: "write", roles: ["platform_admin"] },

	"prompt.read": { access: "read", roles: ALL_ROLES },
	"prompt.write": { access: "write", roles: ["geo_operator", "platform_admin"] },
	"prompt.review": { access: "write", roles: ["marketing_reviewer", "tech_reviewer"] },
	"prompt.freeze": { access: "write", roles: ["geo_operator", "platform_admin"] },

	"target.read": { access: "read", roles: ALL_ROLES },
	"target.manage": { access: "write", roles: ["platform_admin"] },

	"sampling.read": { access: "read", roles: ALL_ROLES },
	"sampling.run": { access: "write", roles: ["geo_operator", "platform_admin"] },
	"evidence.import": { access: "write", roles: ["geo_operator", "platform_admin"] },

	"observation.read": { access: "read", roles: ALL_ROLES },
	"observation.review": { access: "write", roles: ["tech_reviewer", "marketing_reviewer"] },
	// Only a technical review may call an answer's fact wrong: the error rate counts nothing else.
	"claim.review": { access: "write", roles: ["tech_reviewer"] },

	"metric.read": { access: "read", roles: ALL_ROLES },

	"report.read": { access: "read", roles: ALL_ROLES },
	"report.generate": { access: "write", roles: ["geo_operator", "platform_admin"] },
	"report.review": { access: "write", roles: ["marketing_reviewer", "tech_reviewer"] },

	"knowledge.read": { access: "read", roles: ALL_ROLES },
	"knowledge.read_confidential": { access: "read", roles: ["tech_reviewer", "knowledge_reviewer", "platform_admin"] },
	"knowledge.write": { access: "write", roles: STAFF },
	"knowledge.review": { access: "write", roles: ["knowledge_reviewer", "tech_reviewer", "marketing_reviewer"] },

	"task.read": { access: "read", roles: ALL_ROLES },
	"task.create": { access: "write", roles: STAFF },
	"task.transition": { access: "write", roles: ["geo_operator", "platform_admin"] },
	"task.review_tech": { access: "write", roles: ["tech_reviewer"] },
	"task.review_marketing": { access: "write", roles: ["marketing_reviewer"] },
	"task.publish": { access: "write", roles: ["geo_operator"] },

	"content.read": { access: "read", roles: ALL_ROLES },
	"content.write": { access: "write", roles: ["geo_operator"] },
	"content.review_tech": { access: "write", roles: ["tech_reviewer"] },
	"content.review_marketing": { access: "write", roles: ["marketing_reviewer"] },
	"content.publish": { access: "write", roles: ["geo_operator"] },

	"site.read": { access: "read", roles: ALL_ROLES },
	"site.read_snapshot": { access: "read", roles: STAFF },
	"site.manage": { access: "write", roles: ["platform_admin"] },
	"site.crawl": { access: "write", roles: ["geo_operator", "platform_admin"] },
	"site.reparse": { access: "write", roles: ["geo_operator", "platform_admin"] },

	"site_audit.read": { access: "read", roles: ALL_ROLES },
	"site_audit.run": { access: "write", roles: ["geo_operator", "platform_admin"] },
	"site_audit.triage": { access: "write", roles: ["geo_operator", "platform_admin"] },

	"settings.read": { access: "read", roles: ["platform_admin"] },
	"settings.manage": { access: "write", roles: ["platform_admin"] },
	"rbac.manage": { access: "write", roles: ["platform_admin"] },
	"secret.manage": { access: "write", roles: ["platform_admin"] },
	"llm.approve": { access: "write", roles: ["platform_admin"] },
	"audit.read": { access: "read", roles: ["platform_admin"] },
	"alert.read": { access: "read", roles: STAFF },
	"alert.manage": { access: "write", roles: ["geo_operator", "platform_admin"] },

	"dashboard.read": { access: "read", roles: ALL_ROLES },
	// Each person arranges only their own cards, which changes nothing anyone else sees.
	"dashboard.customize": { access: "write", roles: ALL_ROLES },
	// Customers ask live too: a live answer is capped per day and never moves a metric.
	"console.simulate": { access: "write", roles: ALL_ROLES },
	"console.read": { access: "read", roles: ALL_ROLES },

	"recommendation.read": { access: "read", roles: ALL_ROLES },
	"recommendation.generate": { access: "write", roles: ["geo_operator", "platform_admin"] },
	"recommendation.triage": { access: "write", roles: ["geo_operator", "platform_admin"] },

	"competitor.read": { access: "read", roles: ALL_ROLES },
	"competitor.discover": { access: "write", roles: ["geo_operator", "platform_admin"] },
	// Accepting a candidate edits the brand dictionary, so it takes the same role as brand.manage.
	"competitor.decide": { access: "write", roles: ["platform_admin"] },

	// The customer picking questions from our catalog is the business review for those questions.
	"prompt.select_catalog": { access: "write", roles: ["marketing_reviewer", "geo_operator", "platform_admin"] },
} as const satisfies Record<string, { access: GeoAccess; roles: readonly GeoRole[] }>;

export type GeoPermission = keyof typeof PERMISSIONS;

/** What a platform administrator does to the workspace itself: only from a session that proved a second factor. */
const SECOND_FACTOR_PERMISSIONS: readonly GeoPermission[] = [
	"brand.manage",
	"competitor.decide",
	"target.manage",
	"site.manage",
	"settings.read",
	"settings.manage",
	"rbac.manage",
	"secret.manage",
	"llm.approve",
	"audit.read",
];

export function permissionNeedsSecondFactor(permission: GeoPermission): boolean {
	return SECOND_FACTOR_PERMISSIONS.includes(permission);
}

export const GEO_PERMISSIONS = Object.keys(PERMISSIONS) as GeoPermission[];

export function can(roles: readonly GeoRole[], permission: GeoPermission): boolean {
	const allowed: readonly GeoRole[] = PERMISSIONS[permission].roles;
	return roles.some((role) => allowed.includes(role));
}

export function permissionAccess(permission: GeoPermission): GeoAccess {
	return PERMISSIONS[permission].access;
}

export function isGeoRole(value: string): value is GeoRole {
	return (GEO_ROLES as readonly string[]).includes(value);
}
