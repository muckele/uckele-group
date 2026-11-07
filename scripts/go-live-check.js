// Checks run ON the production machine by scripts/go-live-production-gmail.sh, the owner's
// one-command switch from the controlled Gmail test to real broker sends (runbook
// docs/runbooks/gmail-connect.md, Part C, step 5.9 and step 6).
//
//   node scripts/go-live-check.js before   Is it safe to switch? Prints the plan.
//   node scripts/go-live-check.js after    Did the switch land as planned?
//
// On 2026-11-06 a secrets change took production down because nobody could test the app's
// startup check against the new settings before applying them. `before` boots the app's own
// getConfig + validateConfig against the settings the switch would leave, using the machine's
// real environment, so a combination that would not start is refused before anything changes.
//
// It prints setting NAMES, codes and true/false only, never a setting's value. The last line is
// machine-read by the shell script:
//   GO_LIVE_CHECK result=ok|blocked [unset=NAME,NAME]
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PRODUCTION_PROFILE = 'production-gmail-v1';
export const CONTROLLED_PROFILE = 'controlled-mailbox-v1';
export const PROFILE_KEY = 'DEAL_HUNTER_CIM_PROVIDER_PROFILE';
export const TEST_ONLY_KEYS = Object.freeze([
  'DEAL_HUNTER_CIM_MAILBOX_PROVIDER',
  'DEAL_HUNTER_CIM_MAILBOX_ALLOWED_RECIPIENTS',
]);
export const SHEET_SOURCES_KEY = 'DEAL_HUNTER_SHEET_CSV_URLS';
export const SHEET_FEED_KEY = 'DEAL_HUNTER_SHEET_CSV_URL';
/** Every name the switch may remove. The shell script refuses any other. */
export const REMOVABLE_KEYS = Object.freeze([...TEST_ONLY_KEYS, SHEET_SOURCES_KEY]);
export const REQUIRED_ON_KEYS = Object.freeze([
  'DEAL_HUNTER_CIM_PROVIDER_ENABLED',
  'DEAL_HUNTER_PURSUE_SENDER_ENABLED',
  'DEAL_HUNTER_PURSUE_REPLY_POLLER_ENABLED',
]);

const present = (value) => String(value ?? '').trim() !== '';

function sheetList(value) {
  return String(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

/**
 * The test listing Sheet was added (2026-11-06) as DEAL_HUNTER_SHEET_CSV_URLS = "<feed>,<test>",
 * with the feed also in DEAL_HUNTER_SHEET_CSV_URL. Removing the list leaves the feed alone.
 * Any other shape is not ours to guess at.
 */
export function sheetSourcesPlan(env) {
  if (!present(env[SHEET_SOURCES_KEY])) return { remove: false, problem: null };
  const sources = sheetList(env[SHEET_SOURCES_KEY]);
  const feed = String(env[SHEET_FEED_KEY] ?? '').trim();
  if (sources.length === 2 && feed && sources[0] === feed && sources[1] !== feed) {
    return { remove: true, problem: null };
  }
  return {
    remove: false,
    problem: { code: 'sheet_sources_unexpected',
      message: `${SHEET_SOURCES_KEY} is not the deal feed plus one test Sheet, so the switch won't change it. Ask your engineer.` },
  };
}

/** The names the switch removes, in a fixed order. */
export function goLiveUnsetKeys(env, { keepSheetSources = false } = {}) {
  const keys = TEST_ONLY_KEYS.filter((key) => key in env);
  if (!keepSheetSources && sheetSourcesPlan(env).remove) keys.push(SHEET_SOURCES_KEY);
  return keys;
}

/** The environment the app would start with after the switch. */
export function goLiveTargetEnv(env, options = {}) {
  const target = { ...env, [PROFILE_KEY]: PRODUCTION_PROFILE };
  for (const key of goLiveUnsetKeys(env, options)) delete target[key];
  return target;
}

/**
 * Why the switch must not run. `boot` is what the app's own startup check says about the target
 * environment: { errors, cimMode, cimProvider, deliveryProvider, sheetSourceCount }.
 * `liveSendingEnabled` is true, false, or null when it could not be read.
 */
export function goLiveProblems({ env, boot, liveSendingEnabled, keepSheetSources = false }) {
  const problems = [];
  const add = (code, message) => problems.push({ code, message });
  const profile = String(env[PROFILE_KEY] ?? '').trim();
  if (profile !== CONTROLLED_PROFILE && profile !== PRODUCTION_PROFILE) {
    add('profile_unexpected', `${PROFILE_KEY} is not the controlled test or production, so this switch doesn't apply. Ask your engineer.`);
  }
  for (const key of REQUIRED_ON_KEYS) {
    if (env[key] !== 'true') add('setting_off', `${key} must be true (runbook step 5).`);
  }
  if (liveSendingEnabled === true) {
    add('live_sending_on', 'Live sending is on. Click Turn off Live sending in the Email sending card first (runbook step 9.1).');
  } else if (liveSendingEnabled !== false) {
    add('live_sending_unknown', "Couldn't read whether Live sending is on, so the switch won't run.");
  }
  if (!keepSheetSources) {
    const sheet = sheetSourcesPlan(env);
    if (sheet.problem) add(sheet.problem.code, sheet.problem.message);
  }
  if (!boot) {
    add('boot_check_failed', "Couldn't run the app's startup check against the new settings.");
    return problems;
  }
  for (const error of boot.errors ?? []) add('boot_error', `The app would not start: ${error}`);
  if (boot.cimMode !== 'production-gmail' || boot.cimProvider !== 'gmail') {
    add('not_production_gmail', 'After the switch the app would not send broker email through Gmail in production mode.');
  }
  if (boot.deliveryProvider !== 'resend') {
    add('app_email_off', "After the switch the app's own email (digest, sign-in links) would not go through Resend.");
  }
  if (!(boot.sheetSourceCount >= 1)) add('no_sheet_source', 'After the switch the app would have no deal feed Sheet.');
  return problems;
}

/**
 * Confirms the switch landed: production profile, test-only settings gone, and the app's startup
 * check clean on the environment it is running with now.
 */
export function goLiveAfterProblems({ env, boot }) {
  const problems = [];
  const add = (code, message) => problems.push({ code, message });
  if (String(env[PROFILE_KEY] ?? '').trim() !== PRODUCTION_PROFILE) {
    add('profile_not_production', `${PROFILE_KEY} is not ${PRODUCTION_PROFILE}.`);
  }
  for (const key of TEST_ONLY_KEYS) if (key in env) add('test_setting_left', `${key} is still set.`);
  for (const key of REQUIRED_ON_KEYS) if (env[key] !== 'true') add('setting_off', `${key} is not true.`);
  if (!boot) {
    add('boot_check_failed', "Couldn't run the app's startup check.");
    return problems;
  }
  for (const error of boot.errors ?? []) add('boot_error', `Startup check: ${error}`);
  if (boot.cimMode !== 'production-gmail' || boot.cimProvider !== 'gmail') {
    add('not_production_gmail', 'The app is not set to send broker email through Gmail in production mode.');
  }
  if (boot.deliveryProvider !== 'resend') add('app_email_off', "The app's own email is not going through Resend.");
  return problems;
}

/** Runs the app's startup config check in a child process started with exactly `env`. */
export function bootCheck(env, { cwd } = {}) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--evaluate'], {
    encoding: 'utf8', env, cwd, timeout: 60_000,
  });
  if (child.status !== 0) return null;
  const line = String(child.stdout).trim().split('\n').at(-1) ?? '';
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function evaluateInThisProcess() {
  const { getConfig, validateConfig } = await import('../server/config.js');
  const config = getConfig();
  const { errors } = validateConfig(config);
  const cim = config.dealHunter?.cimProvider ?? {};
  console.log(JSON.stringify({
    errors,
    cimMode: cim.mode ?? '',
    cimProvider: cim.provider ?? '',
    deliveryProvider: config.delivery?.provider ?? '',
    sheetSourceCount: Array.isArray(config.dealHunter?.sheetCsvUrls) ? config.dealHunter.sheetCsvUrls.length : 0,
    sqlitePath: config.storage?.sqlitePath ?? '',
  }));
}

/** Reads the Live sending control straight from the database, read-only. */
export async function readLiveSendingEnabled(sqlitePath) {
  try {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT enabled FROM deal_hunter_pursue_send_controls WHERE control_key = 'live_sending'").get();
      return row ? row.enabled === 1 : false;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function report(problems, lines, unset) {
  for (const line of lines) console.log(line);
  if (problems.length) {
    console.log('');
    console.log('Not safe to go on:');
    for (const problem of problems) console.log(`  - ${problem.message} [${problem.code}]`);
  }
  console.log(`GO_LIVE_CHECK result=${problems.length ? 'blocked' : 'ok'}${unset ? ` unset=${unset.join(',')}` : ''}`);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv[0] === '--evaluate') return evaluateInThisProcess();
  const keepSheetSources = argv.includes('--keep-sheet-sources');
  const current = bootCheck(env);
  if (argv[0] === 'before') {
    const unset = goLiveUnsetKeys(env, { keepSheetSources });
    const boot = bootCheck(goLiveTargetEnv(env, { keepSheetSources }));
    const liveSendingEnabled = current?.sqlitePath ? await readLiveSendingEnabled(current.sqlitePath) : null;
    const problems = goLiveProblems({ env, boot, liveSendingEnabled, keepSheetSources });
    const lines = [
      `Sending setup now: ${String(env[PROFILE_KEY] ?? '').trim() || '(none)'}`,
      `Live sending: ${liveSendingEnabled === null ? 'unknown' : liveSendingEnabled ? 'on' : 'off'}`,
      `The switch sets: ${PROFILE_KEY}=${PRODUCTION_PROFILE}`,
      `The switch removes: ${unset.length ? unset.join(', ') : '(nothing)'}`,
      `App startup check with the new settings: ${boot ? (boot.errors?.length ? 'fails' : 'passes') : 'could not run'}`,
    ];
    report(problems, lines, unset);
    return;
  }
  if (argv[0] === 'after') {
    const problems = goLiveAfterProblems({ env, boot: current });
    report(problems, [
      `Sending setup now: ${String(env[PROFILE_KEY] ?? '').trim() || '(none)'}`,
      `App startup check: ${current ? (current.errors?.length ? 'fails' : 'passes') : 'could not run'}`,
    ]);
    return;
  }
  console.log('Usage: node scripts/go-live-check.js before|after [--keep-sheet-sources]');
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.log(`Check failed: ${error?.message || error}`);
    console.log('GO_LIVE_CHECK result=blocked');
    process.exitCode = 1;
  });
}
