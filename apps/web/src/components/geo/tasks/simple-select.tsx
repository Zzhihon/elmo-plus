import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@workspace/ui/components/select";
import { cn } from "@workspace/ui/lib/utils";

const NONE = "__none__";

/** A select over a fixed list; `null` maps to an explicit "none" entry when `noneLabel` is given. */
export function SimpleSelect<T extends string>({
	id,
	value,
	onChange,
	options,
	noneLabel,
	placeholder,
	className,
	disabled,
}: {
	id?: string;
	value: T | null;
	onChange: (value: T | null) => void;
	options: { value: T; label: string }[];
	noneLabel?: string;
	placeholder?: string;
	className?: string;
	disabled?: boolean;
}) {
	const items: Record<string, string> = Object.fromEntries(options.map((option) => [option.value, option.label]));
	if (noneLabel) items[NONE] = noneLabel;
	return (
		<Select
			items={items}
			value={value ?? (noneLabel ? NONE : null)}
			onValueChange={(next) => onChange(next === NONE || next === null ? null : (next as T))}
			disabled={disabled}
		>
			<SelectTrigger id={id} className={cn("w-full", className)}>
				<SelectValue placeholder={placeholder} />
			</SelectTrigger>
			<SelectContent>
				{noneLabel && <SelectItem value={NONE}>{noneLabel}</SelectItem>}
				{options.map((option) => (
					<SelectItem key={option.value} value={option.value}>
						{option.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
