import type { GeoBrandKind, GeoDictionarySnapshot } from "@workspace/geo-domain";
import { dictionaryTerms, findAliasHits } from "./alias-match";

export interface AnswerSegment {
	text: string;
	start: number;
	end: number;
	/** Null for plain text between mentions. */
	kind: GeoBrandKind | null;
	entityId: string | null;
	entityName: string | null;
}

export interface MentionRange {
	brandEntityId: string;
	kind: GeoBrandKind;
	name: string;
	start: number;
	end: number;
}

/** Brand and competitor mentions found the same way an evaluation finds them. */
export function findMentionRanges(answer: string, dictionary: GeoDictionarySnapshot): MentionRange[] {
	return findAliasHits(answer, dictionaryTerms(dictionary)).map((hit) => ({
		brandEntityId: hit.entityId,
		kind: hit.kind,
		name: hit.entityName,
		start: hit.start,
		end: hit.end,
	}));
}

/**
 * Cuts the whole answer into consecutive pieces so it can be rendered with every mention
 * marked. Ranges that overlap an earlier one or fall outside the text are dropped, so
 * stored ranges from an edited dictionary can never garble the answer.
 */
export function splitAnswerByMentions(answer: string, mentions: readonly MentionRange[]): AnswerSegment[] {
	const segments: AnswerSegment[] = [];
	let cursor = 0;
	const plain = (end: number) => {
		if (end > cursor) {
			segments.push({
				text: answer.slice(cursor, end),
				start: cursor,
				end,
				kind: null,
				entityId: null,
				entityName: null,
			});
		}
	};
	for (const mention of [...mentions].sort((a, b) => a.start - b.start)) {
		if (mention.start < cursor || mention.end <= mention.start || mention.end > answer.length) continue;
		plain(mention.start);
		segments.push({
			text: answer.slice(mention.start, mention.end),
			start: mention.start,
			end: mention.end,
			kind: mention.kind,
			entityId: mention.brandEntityId,
			entityName: mention.name,
		});
		cursor = mention.end;
	}
	plain(answer.length);
	return segments;
}
