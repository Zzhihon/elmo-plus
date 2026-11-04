import { useEffect, useState } from "react";

const TICK_MS = 30;
/** Long answers still finish in a few seconds; a client watching should not wait a minute. */
const MAX_DURATION_MS = 6000;
const MIN_CHARS_PER_TICK = 2;

function prefersReducedMotion(): boolean {
	return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** Remount (change the React key) to replay the animation for a different answer. */
export function useTypewriter(length: number, animate: boolean) {
	const [shown, setShown] = useState(length);

	useEffect(() => {
		if (!animate || prefersReducedMotion() || length === 0) {
			setShown(length);
			return;
		}
		setShown(0);
		const step = Math.max(MIN_CHARS_PER_TICK, Math.ceil(length / (MAX_DURATION_MS / TICK_MS)));
		const timer = window.setInterval(() => {
			setShown((current) => {
				const next = Math.min(length, current + step);
				if (next >= length) window.clearInterval(timer);
				return next;
			});
		}, TICK_MS);
		return () => window.clearInterval(timer);
	}, [length, animate]);

	return { shown, done: shown >= length, showAll: () => setShown(length) };
}
