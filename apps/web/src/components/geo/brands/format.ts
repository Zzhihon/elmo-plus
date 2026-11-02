export function formatGeoDateTime(value: Date | string | null): string {
	if (!value) return "—";
	return new Date(value).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short", hour12: false });
}

export function geoActorLabel(actorId: string, members: ReadonlyMap<string, string>): string {
	if (actorId.startsWith("system:")) return "系统";
	if (actorId === "instance-admin") return "实例管理密钥";
	return members.get(actorId) ?? actorId;
}

export function geoErrorMessage(error: unknown): string {
	return error instanceof Error && error.message ? error.message : "操作失败，请重试";
}
