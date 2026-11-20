// Token Radar — expected-value entry (Node 22, standard library only).
//
// Reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>),
// scores every pre-token protocol with the model in lib/model.ts (radar-4:
// a log-log size curve fitted on the snapshot's own traded protocols, with
// a chain-count term, shrunk category offsets and a bounded growth term,
// times launch odds from a logistic regression on all 758 protocols),
// writes the ranked board to /output/board.json, and copies this
// repository's dashboard/ and screenshots/ to /output. Last, it writes
// /output/dossier.json, the summary the judge reads, with the vendored
// make.fun library.
//
// The dashboard is a static page, no framework and no network:
// dashboard/index.html, dashboard/app.css and dashboard/app.js read
// /output/data.js, which this program writes from the same board.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  boardIssue,
  buildBoard,
  dataScript,
  type Snapshot,
} from "./lib/model.ts";
import { buildDossier } from "./vendor/makefun-board.ts";

const here = fileURLToPath(new URL(".", import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined
    ? fallback
    : withEquals.slice(name.length + 3);
}

const inputArg = arg("input", "/input");
const inputFile = inputArg.endsWith(".json")
  ? inputArg
  : join(inputArg, "snapshot.json");
if (!existsSync(inputFile)) {
  process.stderr.write(
    `token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`,
  );
  process.exit(2);
}
const out = arg("output", process.env.MAKEFUN_OUTPUT_DIR ?? "/output");

const snapshot = JSON.parse(readFileSync(inputFile, "utf8")) as Snapshot;
if (!Array.isArray(snapshot.protocols) || !Array.isArray(snapshot.watchlist)) {
  process.stderr.write("token radar: snapshot is not shaped like a snapshot\n");
  process.exit(2);
}

const board = buildBoard(snapshot);
const issues = boardIssue(snapshot, board.rows);
if (issues.length > 0) {
  process.stderr.write(
    `token radar: the model wrote a board the gate refuses: ${issues.join("; ")}\n`,
  );
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "board.json"), `${JSON.stringify({ rows: board.rows })}\n`);
writeFileSync(join(out, "data.js"), dataScript(snapshot, board));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith(".")) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, "dashboard"), join(out, "dashboard"));
const shots = copyFiles(join(here, "screenshots"), join(out, "screenshots"));
if (shots.length < 3) {
  process.stderr.write(
    `token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? "" : "s"}: hand in 3, the board, a detail view and a filtered view\n`,
  );
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(
      `token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`,
    );
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(
  join(out, "dossier.json"),
  buildDossier(out, {
    text_max_bytes: TEXT_MAX_BYTES,
    screenshots: SCREENSHOT_CAPS,
    dashboard: { max_files: 400, max_bytes: 4_194_304 },
  }),
);

const earlyCount = board.rows.filter((r) => !r.on_watchlist).length;
const bt = board.backtest;
process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.rows.length} rows scored (${earlyCount} early, ${board.live.length} live set aside)\n` +
    `token radar: curve log10(mcap) = ${board.fit.a.toFixed(4)} + ${board.fit.b.toFixed(4)} * log10(TVL) + ${board.fit.bChains.toFixed(4)} * log10(nChains), R2 = ${board.fit.r2.toFixed(3)}, ${board.fit.n} comps\n` +
    `token radar: backtest median |log10 error| — 5-fold CV v1 ${bt.cv.v1.medAbsLogErr} vs radar-3 ${bt.cv.radar3.medAbsLogErr} vs radar-4 ${bt.cv.radar4.medAbsLogErr}; time-split v1 ${bt.timeSplit.v1.medAbsLogErr} vs radar-3 ${bt.timeSplit.radar3.medAbsLogErr} vs radar-4 ${bt.timeSplit.radar4.medAbsLogErr}\n` +
    `token radar: odds backtest AUC/log-loss — 5-fold ${bt.odds.cv.auc}/${bt.odds.cv.logLoss} (base ${bt.odds.cv.baseLogLoss}); time-split ${bt.odds.timeSplit.auc}/${bt.odds.timeSplit.logLoss} (base ${bt.odds.timeSplit.baseLogLoss})\n` +
    `token radar: wrote ${join(out, "board.json")}, ${join(out, "data.js")}, ${join(out, "dashboard")} (3 files), ${join(out, "screenshots")} (${shots.length} images) and ${join(out, "dossier.json")}\n`,
);
