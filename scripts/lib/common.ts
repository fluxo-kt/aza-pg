/**
 * @deprecated This file has been deprecated. All Docker utility functions have been
 * consolidated into scripts/utils/docker.ts
 *
 * MIGRATION GUIDE:
 *   Old: import { ... } from './lib/common.ts'
 *   New: import { ... } from '../utils/docker'
 *
 * Functions moved:
 *   - checkDockerDaemon() -> scripts/utils/docker.ts
 *   - checkCommand() -> scripts/utils/docker.ts
 *   - dockerCleanup() -> scripts/utils/docker.ts
 *   - waitForPostgres() -> scripts/utils/docker.ts
 *   - WaitForPostgresOptions -> scripts/utils/docker.ts
 *
 * Logging functions were previously moved to scripts/utils/logger.ts
 *
 * This file is kept for backward compatibility but will be removed in a future release.
 * Please update your imports to use scripts/utils/docker.ts instead.
 */

// Re-export from the new location for backward compatibility
export {
  checkDockerDaemon,
  checkCommand,
  dockerCleanup,
  waitForPostgres,
  type WaitForPostgresOptions,
} from "../utils/docker";
