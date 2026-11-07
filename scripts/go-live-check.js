// Checks run ON the production machine by scripts/go-live-production-gmail.sh, the owner's
// one-command switch from the controlled Gmail test to real broker sends (runbook
// docs/runbooks/gmail-connect.md, Part C, step 5.9 and step 6).
//
//   node scripts/go-live-check.js before --app=NAME --secret-names=A,B --env-names=C,D [--keep-sheet-sources]
//       Is it safe to switch? Prints the plan.
//   node scripts/go-live-check.js after --app=NAME [--expect-unset=A,B]
//       Did the switch land as planned?
//
// On 2026-11-06 a secrets change took production down because nobody could test the app's
// startup check against the new settings before applying them. `before` boots the app's own
// getConfig + validateConfig against the settings the switch would leave, using the machine's
// real environment, so a combination that would not start is refused before anything changes.
//
// `fly secrets deploy` applies every change staged on Fly, not only the switch's own. The shell
// script refuses staged changes it can see in `fly secrets list`; a staged REMOVAL does not show
// there (the name is simply gone), so `before` is also given the names Fly will deploy
// (--secret-names, from `fly secrets list`) and the names fly.toml [env] and the image set
// (--env-names), and refuses when a setting the app reads is on this machine but in neither.
//
// It prints setting names, codes and labels only, never a setting's value. The last line is
// machine-read by the shell script:
//   GO_LIVE_CHECK result=ok|blocked [from=controlled|production] [unset=NAME,NAME]
import fs from 'node:fs';
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
const NAME = /^[A-Z][A-Z0-9_]*$/;

const present = (value) => String(value ?? '').trim() !== '';

function sheetList(value) {
  return String(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

/** A label for the profile, never the raw setting (it could hold anything pasted into it). */
export function profileLabel(env) {
  const profile = String(env[PROFILE_KEY] ?? '').trim();
  if (profile === CONTROLLED_PROFILE) return 'controlled test';
  if (profile === PRODUCTION_PROFILE) return 'production';
  return profile ? '(something else)' : '(none)';
}

/** The setting names server/config.js reads: the ones that decide whether the app starts. */
export function appReadKeys(source = fs.readFileSync(new URL('../server/config.js', import.meta.url), 'utf8')) {
  const names = new Set();
  for (const match of source.matchAll(/\b(?:process\.env|environment)\.([A-Z][A-Z0-9_]*)/g)) names.add(match[1]);
  return names;
}

/** A comma list of setting names; anything that is not a plain name is dropped. */
export function parseNames(value) {
  return String(value ?? '').split(',').map((name) => name.trim()).filter((name) => NAME.test(name));
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
 * Settings the app reads that are on this machine but that Fly will not deploy: neither a Fly
 * secret nor set by fly.toml [env] or the image. A removal staged on Fly looks exactly like this.
 * The switch's own removals are left out (a re-run after a failed deploy has them staged).
 */
export function pendingRemovals(env, { secretNames, envNames, appKeys, plannedUnset = [] }) {
  const accounted = new Set([...secretNames, ...envNames, ...plannedUnset]);
  return Object.keys(env).filter((key) => appKeys.has(key) && !accounted.has(key)).sort();
}

/** Problems with where the check is running: it must see the production app's own settings. */
export function environmentProblems(env, { app, sqliteExists }) {
  const problems = [];
  const add = (code, message) => problems.push({ code, message });
  if (env.NODE_ENV !== 'production') add('not_production', 'This is not running with the production settings.');
  if (!present(env.SQLITE_PATH) || !sqliteExists) add('no_database', "Couldn't find the app's database.");
  if (!app) add('no_app_name', 'The app name was not given.');
  else if (present(env.FLY_APP_NAME) && env.FLY_APP_NAME !== app) {
    add('wrong_app', `This machine belongs to another app, not ${app}.`);
  }
  return problems;
}

/**
 * Why the switch must not run. `boot` is what the app's own startup check says about the target
 * environment: { errors, cimMode, cimProvider, deliveryProvider, sheetSourceCount }.
 * `liveSendingEnabled` is true, false, or null when it could not be read. `pending` is
 * pendingRemovals(), or null when the names Fly will deploy were not given.
 */
export function goLiveProblems({ env, boot, liveSendingEnabled, keepSheetSources = false, pending = [] }) {
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
  if (pending === null) {
    add('secret_names_missing', "Couldn't compare this machine's settings with what Fly will deploy.");
  } else if (pending.length) {
    add('removal_staged', `Fly will remove ${pending.join(', ')} at the next deploy (a staged change). Ask your engineer.`);
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
 * Confirms the switch landed: production profile, every planned removal gone, Live sending still
 * off, and the app's startup check clean on the environment it is running with now.
 */
export function goLiveAfterProblems({ env, boot, liveSendingEnabled, expectUnset = [] }) {
  const problems = [];
  const add = (code, message) => problems.push({ code, message });
  if (String(env[PROFILE_KEY] ?? '').trim() !== PRODUCTION_PROFILE) {
    add('profile_not_production', `${PROFILE_KEY} is not ${PRODUCTION_PROFILE}.`);
  }
  for (const key of new Set([...TEST_ONLY_KEYS, ...expectUnset])) {
    if (key in env) add('setting_left', `${key} is still set.`);
  }
  for (const key of REQUIRED_ON_KEYS) if (env[key] !== 'true') add('setting_off', `${key} is not true.`);
  if (liveSendingEnabled === true) add('live_sending_on', 'Live sending is on.');
  else if (liveSendingEnabled !== false) add('live_sending_unknown', "Couldn't read whether Live sending is on.");
  if (!boot) {
    add('boot_check_failed', "Couldn't run the app's startup check.");
    return problems;
  }
  for (const error of boot.errors ?? []) add('boot_error', `Startup check: ${error}`);
  if (boot.cimMode !== 'production-gmail' || boot.cimProvider !== 'gmail') {
    add('not_production_gmail', 'The app is not set to send broker email through Gmail in production mode.');
  }
  if (boot.deliveryProvider !== 'resend') add('app_email_off', "The app's own email is not going through Resend.");
  if (!(boot.sheetSourceCount >= 1)) add('no_sheet_source', 'The app has no deal feed Sheet.');
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

function option(argv, name) {
  const found = argv.find((arg) => arg.startsWith(`--${name}=`));
  return found === undefined ? undefined : found.slice(name.length + 3);
}

function bootLabel(boot) {
  if (!boot) return 'could not run';
  return boot.errors?.length ? 'fails' : 'passes';
}

function report(problems, lines, extras = '') {
  for (const line of lines) console.log(line);
  if (problems.length) {
    console.log('');
    console.log('Not safe to go on:');
    for (const problem of problems) console.log(`  - ${problem.message} [${problem.code}]`);
  }
  console.log(`GO_LIVE_CHECK result=${problems.length ? 'blocked' : 'ok'}${problems.length ? '' : extras}`);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv[0] === '--evaluate') return evaluateInThisProcess();
  const command = argv[0];
  if (command !== 'before' && command !== 'after') {
    console.log('Usage: node scripts/go-live-check.js before|after --app=NAME [options]');
    process.exitCode = 2;
    return;
  }
  const app = option(argv, 'app') ?? '';
  const sqliteExists = present(env.SQLITE_PATH) && fs.existsSync(env.SQLITE_PATH);
  const setup = environmentProblems(env, { app, sqliteExists });
  const liveSendingEnabled = sqliteExists ? await readLiveSendingEnabled(env.SQLITE_PATH) : null;
  const liveLine = `Live sending: ${liveSendingEnabled === null ? 'unknown' : liveSendingEnabled ? 'on' : 'off'}`;

  if (command === 'before') {
    const keepSheetSources = argv.includes('--keep-sheet-sources');
    const unset = goLiveUnsetKeys(env, { keepSheetSources });
    const secretNames = option(argv, 'secret-names');
    const envNames = option(argv, 'env-names');
    const pending = secretNames === undefined || envNames === undefined || !parseNames(secretNames).length
      ? null
      : pendingRemovals(env, { secretNames: parseNames(secretNames), envNames: parseNames(envNames),
        appKeys: appReadKeys(), plannedUnset: unset });
    const boot = bootCheck(goLiveTargetEnv(env, { keepSheetSources }));
    const problems = [...setup, ...goLiveProblems({ env, boot, liveSendingEnabled, keepSheetSources, pending })];
    const from = profileLabel(env) === 'production' ? 'production' : 'controlled';
    report(problems, [
      `Sending setup now: ${profileLabel(env)}`,
      liveLine,
      `The switch sets: ${PROFILE_KEY}=${PRODUCTION_PROFILE}`,
      `The switch removes: ${unset.length ? unset.join(', ') : '(nothing)'}`,
      `App startup check with the new settings: ${bootLabel(boot)}`,
    ], ` from=${from}${unset.length ? ` unset=${unset.join(',')}` : ''}`);
    return;
  }

  const current = bootCheck(env);
  const expectUnset = parseNames(option(argv, 'expect-unset'));
  const problems = [...setup, ...goLiveAfterProblems({ env, boot: current, liveSendingEnabled, expectUnset })];
  report(problems, [`Sending setup now: ${profileLabel(env)}`, liveLine, `App startup check: ${bootLabel(current)}`]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.log('The check stopped with an error.');
    console.log('GO_LIVE_CHECK result=blocked');
    process.exitCode = 1;
  });
}
