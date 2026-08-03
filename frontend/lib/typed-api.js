/**
 * Typed API client — thin JSDoc-typed wrappers over apiFetch that pull their
 * shapes from the auto-generated `api-types.ts` (produced by `npm run gen:api`
 * against the live FastAPI OpenAPI schema).
 *
 * The app is JavaScript, not TypeScript, so we get editor intellisense +
 * type-checking through JSDoc `import()` types instead of a full TS migration.
 * Regenerate `api-types.ts` whenever the backend response models change and
 * these return types update automatically.
 *
 * @typedef {import('./api-types').components['schemas']} Schemas
 */
import { apiFetch } from "./api";

/** @returns {Promise<Schemas['MeResponse']>} */
export const getMe = () => apiFetch("/auth/me");

/** @returns {Promise<Schemas['Scorecard'][]>} */
export const getScorecards = () => apiFetch("/scorecards");

/** @returns {Promise<Schemas['Rock'][]>} */
export const getRocks = () => apiFetch("/rocks");

/** @returns {Promise<Schemas['Issue'][]>} */
export const getIssues = () => apiFetch("/issues");

/** @returns {Promise<Schemas['Todo'][]>} */
export const getTodos = () => apiFetch("/todos");

/** @returns {Promise<Schemas['Meeting'][]>} */
export const getMeetings = () => apiFetch("/meetings");

/** @returns {Promise<Schemas['Seat'][]>} */
export const getSeats = () => apiFetch("/seats");

/** @returns {Promise<Schemas['Person'][]>} */
export const getDirectory = () => apiFetch("/directory");
