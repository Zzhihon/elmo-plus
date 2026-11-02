import { IconAlertTriangle } from "@tabler/icons-react";
import { GEO_VERIFICATION_LABELS, type GeoVerificationStatus } from "@workspace/geo-domain";
import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<Alert>
			<IconAlertTriangle />
			<AlertTitle>{title}</AlertTitle>
			<AlertDescription>{children}</AlertDescription>
		</Alert>
	);
}

/** The agreed minimum for one question on one platform in one round is three valid samples. */
export const GEO_MIN_VALID_SAMPLES = 3;

export function GeoLowSampleNotice({
	validCount,
	required = GEO_MIN_VALID_SAMPLES,
}: {
	validCount: number;
	required?: number;
}) {
	if (validCount >= required) return null;
	return (
		<Notice title="样本不足">
			当前有效样本 {validCount} 个，低于 {required} 个，变化只能视为观察，不代表趋势。
		</Notice>
	);
}

/** Replaces a percentage when nothing valid was sampled: failed samples are not a 0% mention rate. */
export function GeoNoDataNotice() {
	return <Notice title="数据不足">当前条件下没有有效样本，失败或不可用的采样不计入分母，因此不显示比率。</Notice>;
}

export function GeoUnverifiedTargetNotice({ status, note }: { status: GeoVerificationStatus; note?: string | null }) {
	if (status === "PASSED") return null;
	return (
		<Notice title={`数据源${GEO_VERIFICATION_LABELS[status]}`}>
			此采样目标尚未通过数据源验证，结果不代表已全面支持该平台。{note}
		</Notice>
	);
}

export function GeoModelApiNotice() {
	return <Notice title="模型 API 代理评测">此结果来自模型 API，不等同于该平台面向用户的产品回答。</Notice>;
}
