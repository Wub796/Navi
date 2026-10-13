// Which deployment configuration a container verification run is about.
//
// The verifier used to know two shapes: the local file, or `--production` plus
// `NAVI_IMAGE`. The release pipeline needs a third: verify the shipped production file,
// built from the checkout rather than from a digest an operator selected. That is a
// decision about *which file* is being verified, and the receipt has to name it, so the
// resolution lives here — pure, with its inputs injected — instead of being spread
// across argv reads inside a script that then talks to Docker.

/** The development/verification file, and the receipt a run of it writes. */
export const DEFAULT_COMPOSE = 'docker-compose.yml';
export const DEFAULT_RECEIPT = 'reports/container-verification.json';
/** The file operators deploy, and the receipt a run of it writes. */
export const PRODUCTION_COMPOSE = 'deploy/docker-compose.prod.yml';
export const PRODUCTION_RECEIPT = 'reports/production-container-verification.json';

/**
 * @typedef {{composeFile: string, receiptPath: string, production: boolean, image: string}} ComposeTarget
 */

/**
 * Resolve the Compose file, image and receipt a verification run is about.
 *
 * `--production` keeps its original meaning — the shipped production file, selected by a
 * `NAVI_IMAGE` that must be set, writing the production receipt — and `--compose <file>`
 * names any file explicitly, which is what a release pipeline uses when it built the
 * image itself. An unknown flag is an error rather than something to ignore: a typo in a
 * release gate must not fall back to verifying a different file than the one intended.
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [env]
 * @returns {ComposeTarget}
 */
export function resolveComposeTarget(argv, env = {}) {
  const production = argv.includes('--production');
  const index = argv.indexOf('--compose');
  const explicit = index === -1 ? null : argv[index + 1] ?? null;
  if (index !== -1 && (explicit === null || explicit.startsWith('-'))) {
    throw new Error('--compose requires a file path, for example --compose deploy/docker-compose.prod.yml');
  }
  // Every argument is either a known flag or the value in --compose's own slot.
  const stray = argv.filter((value, position) => position !== index && position !== index + 1 && !['--production', '--compose'].includes(value));
  if (stray.length) throw new Error(`unknown flag(s) ${stray.join(', ')}; expected --production and/or --compose <file>`);
  if (production && explicit !== null && explicit !== PRODUCTION_COMPOSE) {
    throw new Error(`--production verifies ${PRODUCTION_COMPOSE}, so --compose ${explicit} would verify a different file`);
  }
  const composeFile = explicit ?? (production ? PRODUCTION_COMPOSE : DEFAULT_COMPOSE);
  return {
    composeFile,
    receiptPath: receiptPathFor(composeFile),
    production,
    // Only `--production` insists on an operator-selected digest; an explicitly named
    // file is verified against the image the caller built.
    image: production ? env.NAVI_IMAGE || 'navi:local' : 'navi:local'
  };
}

/**
 * The receipt names the deployment configuration it proves rather than the invocation
 * that produced it: one file verified through `--production` and through `--compose` is
 * the same evidence, so it is one receipt. A third file gets its own, named after it.
 * @param {string} composeFile
 * @returns {string}
 */
export function receiptPathFor(composeFile) {
  if (composeFile === PRODUCTION_COMPOSE) return PRODUCTION_RECEIPT;
  if (composeFile === DEFAULT_COMPOSE) return DEFAULT_RECEIPT;
  const name = composeFile.replace(/^.*\//, '').replace(/\.[^.]*$/, '').replace(/[^a-zA-Z0-9._-]+/g, '-');
  return `reports/container-verification-${name}.json`;
}
