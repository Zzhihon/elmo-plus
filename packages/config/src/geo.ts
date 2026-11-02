export function isGeoWorkspaceEnabled(env: Record<string, string | undefined> = process.env): boolean {
	const value = env.GEO_WORKSPACE_ENABLED?.trim().toLowerCase();
	return value === "1" || value === "true";
}
