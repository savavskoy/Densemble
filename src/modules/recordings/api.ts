/**
 * Public API of the recordings module: what core and dependent modules may import (FR-012). The spec 004
 * `recordings-status` CLI reads the module's status snapshot with the module's own formatter.
 */
export { formatStatus, readStatus, type RecordingStatus } from "./status.js";
