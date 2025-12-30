export const MAX_TOTAL_EVIDENCE_CHARS = 30000 as const;

// Filesystem/search hard limits (extension-side SSOT)
export const MAX_HITS_PER_TOOL = 50 as const;
export const MAX_CHARS_PER_HIT = 200 as const;
export const READ_MULTIPLIER = 10 as const;
export const MAX_READ_CHARS = 2000 as const;

// Memory server recommended types (extension-side SSOT; do not import orchestrator)
export const ENTITY_TYPES = [
	'person',
	'organization',
	'event',
	'policy',
	'claim',
	'source',
	'location'
] as const;

export const RELATION_TYPES = [
	'works_at',
	'located_in',
	'related_to',
	'claims',
	'supports',
	'opposes',
	'occurred_at',
	'mentions',
	'member_of',
	'part_of'
] as const;
