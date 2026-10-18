import path from 'node:path';

// Deliberately does not copy process.env. No deployment/provider configuration
// or existing user HOME is inherited by the backend or browser.
export function fixtureEnvironment(root, browserExecutable) {
  if (!path.isAbsolute(root) || !path.isAbsolute(browserExecutable)) {
    throw new Error('FL05 fixture and browser paths must be absolute.');
  }
  return {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp'),
    XDG_CONFIG_HOME: path.join(root, 'home', '.config'),
    XDG_CACHE_HOME: path.join(root, 'home', '.cache'),
    LANG: 'en_US.UTF-8', TZ: 'UTC', NODE_ENV: 'test',
    FL05_FIXTURE_ROOT: root, FL05_FIXTURE_MODE: 'synthetic-local-only',
    FL05_BROWSER_EXECUTABLE: browserExecutable,
    SQLITE_PATH: path.join(root, 'owner.sqlite'), STORAGE_PROVIDER: 'sqlite',
    SECURE_DOCUMENTS_STORAGE_DIR: path.join(root, 'documents'),
    SECURE_DOCUMENTS_TOKEN_SECRET: 'fl05-synthetic-document-secret',
    ACQUISITION_COMMAND_CENTER_SOURCE_HEALTH_PATH: path.join(root, 'source-health.json'),
    ADMIN_AUTH_MODE: 'password', ADMIN_USERNAME: 'fl05-owner',
    ADMIN_PASSWORD: 'synthetic-owner-password', ADMIN_EMAIL: 'owner@example.test',
    ADMIN_VIEWER_USERNAME: 'fl05-viewer', ADMIN_VIEWER_PASSWORD: 'synthetic-viewer-password',
    ADMIN_SESSION_SECRET: 'fl05-synthetic-session-secret',
    DELIVERY_PROVIDER: 'console', CRM_PROVIDER: 'console', BACKUP_ENABLED: 'false',
    ANALYTICS_ENABLED: 'false', DEAL_HUNTER_AIRTABLE_ENABLED: 'false',
    DEAL_HUNTER_SHEET_CSV_URL: '', DEAL_HUNTER_SHEET_CSV_URLS: '',
    DEAL_HUNTER_DAILY_EMAIL_ENABLED: 'false', DEAL_HUNTER_CIM_FOLLOW_UP_ENABLED: 'false',
    DEAL_HUNTER_CIM_AUTOMATION_SCHEDULER_ENABLED: 'false',
    DEAL_HUNTER_CIM_AUTOMATION_PAUSED: 'true', DEAL_HUNTER_CIM_OUTREACH_PAUSED: 'true',
  };
}
