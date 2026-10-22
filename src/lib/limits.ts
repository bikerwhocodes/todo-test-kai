// Plain constants shared by forms (client) and validation (server); no zod here so
// importing them doesn't pull the schema library into the client bundle.

export const TITLE_MAX = 500;
export const PROJECT_NAME_MAX = 100;
export const DESCRIPTION_MAX = 10_000;
export const ESTIMATE_MAX_MIN = 24 * 60;
/** Priority 4 means "no priority"; clearing the field sets it back to 4. */
export const NO_PRIORITY = 4;
