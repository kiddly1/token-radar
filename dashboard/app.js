// Token Radar dashboard (radar-3). Reads window.RADAR (written by main.ts
// from the same board), renders the sortable/filterable table, the detail
// view with the full curve equation and costed farm plan, the fitted size
// curve with its scatter chart, and the out-of-sample backtest. Static page,
// no network, no framework.
//
// The implied value shown is recomputed here from the row's own fields
// (TVL x curve multiple x growth) and compared with the board's stored
// value; a mismatch is flagged in the detail view.

const RADAR = window.RADAR;
const rows = RADAR.rows;
const live = RADAR.live;
const fit = RADAR.fit;
const offsets = new Map(RADAR.offsets.map((o) => [o.category, o]));

const $ = (id) => document.getElementById(id);
const fmtUsd = (n) => {
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(0) + "K";
  return "$" + n.toFixed(0);
};
const fmtPct = (x) =>
  x === null || x === undefined
    ? "—"
    : (x > 0 ? "+" : "") + x.toFixed(1) + "%";
const fmtAge = (d) => (d >= 365 ? (d / 365).toFixed(1) + "y" : d + "d");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function recomputed(r) {
  return Math.max(1, Math.round(r.tvl_usd * r.multiple * r.growth_mult));
}

function chainLabel(chains) {
  if (chains.length <= 3) return chains.join(", ");
  return chains.slice(0, 3).join(", ") + " +" + (chains.length - 3) + " more";
}

function verdictBadge(v) {
  const cls = v === "FARM" ? "farm" : v === "THIN" ? "thin" : "skip";
  return '<span class="verdict ' + cls + '">' + v + "</span>";
}

// ---------------------------------------------------------------- state
const params = new URLSearchParams(location.search);
const state = {
  tab: params.get("tab") === "live" ? "live" : "pre",
  q: params.get("q") ?? "",
  category: params.get("category") ?? "",
  sortKey: "rank",
  sortDir: 1,
};

// ---------------------------------------------------------------- header
$("meta").innerHTML =
  "Snapshot as of <b>" + esc(RADAR.asOf) + "</b> · floor <b>" + fmtUsd(RADAR.floorUsd) +
  "</b> · " + rows.length + " protocols ranked · model: fitted size curve on " + fit.n + " live tokens";
$("stats").innerHTML = [
  [rows.length, "protocols ranked"],
  [rows.filter((r) => r.on_watchlist).length, "watchlist covered"],
  [fit.n, "live tokens priced the curve"],
  ["R² " + fit.r2.toFixed(2), "curve fit (log-log)"],
]
  .map(([n, l]) => '<div class="stat"><div class="num">' + n + "</div><div class=\"lbl\">" + l + "</div></div>")
  .join("");

// category filter options, by row count
const catCounts = new Map();
for (const r of rows) catCounts.set(r.category, (catCounts.get(r.category) ?? 0) + 1);
$("category").innerHTML =
  '<option value="">All categories</option>' +
  [...catCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => '<option value="' + esc(c) + '"' + (state.category === c ? " selected" : "") + ">" + esc(c) + " (" + n + ")</option>")
    .join("");
$("q").value = state.q;

// formula + curve text
$("formula").textContent =
  "log10(implied) = " + fit.a.toFixed(3) + " + " + fit.b.toFixed(3) + " × log10(TVL) + category offset, then × growth";
$("curve-text").textContent =
  "Fitted on " + fit.n + " traded protocols in this snapshot (market cap and TVL both positive, wrapped/staked/bridged products excluded). " +
  "R² = " + fit.r2.toFixed(3) + ": TVL alone explains little of a token's value — the curve is the average shape, and the band below shows how wide the misses run. " +
  "The middle 50% of traded tokens landed between " + fit.bandLowMult.toFixed(2) + "× and " + fit.bandHighMult.toFixed(2) + "× of the curve.";

// offsets table
$("offsets").querySelector("tbody").innerHTML = RADAR.offsets
  .map(
    (o) =>
      "<tr><td>" + esc(o.category) + "</td><td class=\"num\">" + (o.offset >= 0 ? "+" : "") + o.offset.toFixed(3) + "</td><td class=\"num\">" + o.live_count + "</td></tr>",
  )
  .join("");

// backtest table
const bt = RADAR.backtest;
$("backtest").querySelector("tbody").innerHTML =
  "<tr><td>5-fold cross-validation</td><td class=\"num\">" + bt.cv.v1.medAbsLogErr.toFixed(3) + "</td><td class=\"num\">" + bt.cv.radar3.medAbsLogErr.toFixed(3) + "</td></tr>" +
  "<tr><td>Time-split holdout (listed after " + esc(bt.timeSplit.cut) + ")</td><td class=\"num\">" + bt.timeSplit.v1.medAbsLogErr.toFixed(3) + "</td><td class=\"num\">" + bt.timeSplit.radar3.medAbsLogErr.toFixed(3) + "</td></tr>" +
  "<tr><td>Within 2× of the true cap (5-fold)</td><td class=\"num\">" + bt.cv.v1.within2xPct.toFixed(1) + "%</td><td class=\"num\">" + bt.cv.radar3.within2xPct.toFixed(1) + "%</td></tr>";
$("backtest-note").textContent =
  "Median absolute log10 error on held-out tokens — lower is better. " +
  "The v1 model is category-median multiples × growth × maturity, scored on the same holdouts. " +
  "A maturity (age) term was tested and dropped: it helped the cross-validation slightly but collapsed on the time-split holdout, so the shipped model has no age term.";

// scatter chart: log10(TVL) vs log10(mcap) for comps + fitted line
(function drawCurve() {
  const W = 460, H = 250, padL = 44, padB = 30, padT = 10, padR = 10;
  const xs = RADAR.comps.map((c) => Math.log10(c.tvl_usd));
  const ys = RADAR.comps.map((c) => Math.log10(c.mcap_usd));
  const x0 = Math.floor(Math.min(...xs)), x1 = Math.ceil(Math.max(...xs));
  const y0 = Math.floor(Math.min(...ys)), y1 = Math.ceil(Math.max(...ys));
  const X = (x) => padL + ((x - x0) / (x1 - x0)) * (W - padL - padR);
  const Y = (y) => H - padB - ((y - y0) / (y1 - y0)) * (H - padB - padT);
  let svg = '<svg viewBox="0 0 ' + W + " " + H + '" role="img">';
  for (let gx = x0; gx <= x1; gx++) {
    svg += '<line class="axis" x1="' + X(gx) + '" y1="' + Y(y0) + '" x2="' + X(gx) + '" y2="' + Y(y1) + '"/>';
    svg += '<text class="tick" x="' + X(gx) + '" y="' + (H - 12) + '" text-anchor="middle">10^' + gx + "</text>";
  }
  for (let gy = y0; gy <= y1; gy++) {
    svg += '<line class="axis" x1="' + X(x0) + '" y1="' + Y(gy) + '" x2="' + X(x1) + '" y2="' + Y(gy) + '"/>';
    svg += '<text class="tick" x="' + (padL - 6) + '" y="' + (Y(gy) + 3) + '" text-anchor="end">10^' + gy + "</text>";
  }
  svg += '<text class="axis-label" x="12" y="14">mcap $</text>';
  svg += '<text class="axis-label" x="' + (W - padR) + '" y="' + (H - 12) + '" text-anchor="end">TVL $</text>';
  svg += RADAR.comps.map((c) =>
    '<circle class="dot" cx="' + X(Math.log10(c.tvl_usd)).toFixed(1) + '" cy="' + Y(Math.log10(c.mcap_usd)).toFixed(1) + '" r="2.6"><title>' + esc(c.slug) + "</title></circle>",
  ).join("");
  const yA = fit.a + fit.b * x0, yB = fit.a + fit.b * x1;
  svg += '<line class="fitline" x1="' + X(x0) + '" y1="' + Y(yA) + '" x2="' + X(x1) + '" y2="' + Y(yB) + '"/>';
  svg += "</svg>";
  $("curve-chart").innerHTML = svg;
})();

// ---------------------------------------------------------------- table
function visibleRows() {
  const q = state.q.trim().toLowerCase();
  let list = rows.filter(
    (r) =>
      (!state.category || r.category === state.category) &&
      (!q || r.name.toLowerCase().includes(q) || r.slug.includes(q) || r.category.toLowerCase().includes(q)),
  );
  const k = state.sortKey;
  list = [...list].sort((a, b) => {
    const av = a[k];
    const bv = b[k];
    if (typeof av === "string") return state.sortDir * av.localeCompare(bv);
    return state.sortDir * (av - bv);
  });
  return list;
}

function render() {
  const isLive = state.tab === "live";
  $("tab-pre").setAttribute("aria-selected", String(!isLive));
  $("tab-live").setAttribute("aria-selected", String(isLive));
  document.querySelectorAll("thead th").forEach((th) => {
    th.classList.toggle("sorted", !isLive && th.dataset.sort === state.sortKey);
  });
  const tbody = $("rows");
  if (isLive) {
    $("hint").textContent =
      "These protocols already have a token trading — they are set aside, not ranked. Shown to prove the board separates what trades from what is still to come.";
    tbody.innerHTML = live
      .map(
        (p) =>
          "<tr data-slug=\"" + esc(p.slug) + "\"><td class=\"num\">—</td>" +
          "<td><span class=\"name\">" + esc(p.name) + "</span><span class=\"sub\">" + esc(p.category) + " · " + esc(chainLabel(p.chains)) + "</span></td>" +
          "<td class=\"num\">" + fmtUsd(p.tvl_usd) + "</td>" +
          "<td class=\"num " + (p.change_7d > 0 ? "pos" : p.change_7d < 0 ? "neg" : "") + "\">" + fmtPct(p.change_7d) + "</td>" +
          "<td class=\"num\">—</td><td class=\"num\">—</td>" +
          "<td class=\"num\">" + fmtUsd(p.mcap_usd) + " mcap</td></tr>",
      )
      .join("");
    $("empty").hidden = true;
    return;
  }
  const list = visibleRows();
  const maxImplied = rows[0].implied_value_usd;
  $("hint").textContent =
    list.length + " of " + rows.length + " pre-token protocols · ranked by implied value · click a row for the model breakdown and farm plan";
  tbody.innerHTML = list
    .map(
      (r) =>
        "<tr data-slug=\"" + esc(r.slug) + "\"><td class=\"num\">" + r.rank + "</td>" +
        "<td><span class=\"name\">" + esc(r.name) + "</span>" + (r.on_watchlist ? '<span class="watch">watchlist</span>' : "") + verdictBadge(r.verdict) +
        "<span class=\"sub\">" + esc(r.category) + " · " + esc(chainLabel(r.chains)) + "</span></td>" +
        "<td class=\"num\">" + fmtUsd(r.tvl_usd) + "</td>" +
        "<td class=\"num " + (r.change_7d > 0 ? "pos" : r.change_7d < 0 ? "neg" : "") + "\">" + fmtPct(r.change_7d) + "</td>" +
        "<td class=\"num\">" + fmtAge(r.age_days) + "</td>" +
        "<td class=\"num\">" + r.multiple.toFixed(3) + "×</td>" +
        "<td class=\"num\"><span class=\"bar\" style=\"width:" + Math.max(4, Math.round((r.implied_value_usd / maxImplied) * 72)) + "px\"></span>" + fmtUsd(r.implied_value_usd) + "</td></tr>",
    )
    .join("");
  $("empty").hidden = list.length > 0;
}

// ---------------------------------------------------------------- detail
function showDetail(slug) {
  const r = rows.find((x) => x.slug === slug);
  const body = $("detail-body");
  if (!r) {
    body.innerHTML = "<h2>Not on the board</h2><p class=\"note\">This protocol is not ranked — it either already has a token or is a wrapped, staked, bridged or exchange product.</p>";
  } else {
    const o = offsets.get(r.category);
    const offsetNote = o
      ? "Category offset " + (o.offset >= 0 ? "+" : "") + o.offset.toFixed(3) + " (log10) from " + o.live_count + " live " + esc(r.category) + " protocol" + (o.live_count === 1 ? "" : "s") + " in this snapshot, shrunk by n/(n+5)."
      : "No live peers in this category in the snapshot — no offset is applied.";
    const check = recomputed(r);
    body.innerHTML =
      "<h2>" + esc(r.name) + "</h2>" +
      '<p class="sub">' + esc(r.category) + " · " + esc(r.chains.join(", ")) + " · rank #" + r.rank + (r.on_watchlist ? " · watchlist" : "") + "</p>" +
      '<div class="equation">curve: 10^(' + fit.a.toFixed(3) + " + " + fit.b.toFixed(3) + " × log10(" + fmtUsd(r.tvl_usd) + ")) = " + fmtUsd(Math.round(r.tvl_usd * r.multiple / r.growth_mult)) + "<br>" +
      "× growth " + r.growth_mult.toFixed(3) + " (7d " + fmtPct(r.change_7d) + ")<br>" +
      '<span class="total">= ' + fmtUsd(r.implied_value_usd) + " implied value</span><br>" +
      "band: " + fmtUsd(r.implied_low_usd) + " – " + fmtUsd(r.implied_high_usd) + " (middle 50% of traded tokens)</div>" +
      "<p class=\"note\">" + offsetNote + " Growth is the 7-day TVL change, clamped to −60%…+120% at half weight. " +
      (Math.abs(check - r.implied_value_usd) <= 1 ? "Recomputed from these fields: matches." : '<span class="warn">Recomputed value ' + fmtUsd(check) + " does not match the board — do not trust this row.</span>") + "</p>" +
      "<h3>Farm plan — 6 steps · costed · verdict " + r.verdict + " · plan cost $" + r.plan_cost_usd.toFixed(2) + "</h3><ol>" + r.farm_steps.map((s) => "<li>" + esc(s) + "</li>").join("") + "</ol>" +
      '<p class="note">The snapshot records no token for this protocol. That is the record, not proof — check the protocol itself before you farm.</p>';
  }
  $("detail").showModal();
}

// ---------------------------------------------------------------- events
$("q").addEventListener("input", (e) => { state.q = e.target.value; render(); });
$("category").addEventListener("change", (e) => { state.category = e.target.value; render(); });
$("tab-pre").addEventListener("click", () => { state.tab = "pre"; render(); });
$("tab-live").addEventListener("click", () => { state.tab = "live"; render(); });
document.querySelectorAll("thead th").forEach((th) => {
  th.addEventListener("click", () => {
    const k = th.dataset.sort;
    if (state.sortKey === k) state.sortDir = -state.sortDir;
    else { state.sortKey = k; state.sortDir = k === "name" ? 1 : -1; }
    render();
  });
});
$("rows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr");
  if (tr) showDetail(tr.dataset.slug);
});

render();
if (params.get("detail")) showDetail(params.get("detail"));
