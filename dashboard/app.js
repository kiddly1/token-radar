// Token Radar dashboard. Reads window.RADAR (written by main.ts from the
// same board), renders the sortable/filterable table, the detail view with
// the full model equation, and the category-multiples table. Static page,
// no network, no framework.
//
// The implied value shown is recomputed here from the row's own fields
// (TVL x multiple x growth x maturity) and compared with the board's
// stored value; a mismatch is flagged in the detail view.

const RADAR = window.RADAR;
const rows = RADAR.rows;
const live = RADAR.live;
const multiples = new Map(RADAR.multiples.map((m) => [m.category, m]));

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
  return Math.max(1, Math.round(r.tvl_usd * r.multiple * r.growth_mult * r.maturity_mult));
}

function chainLabel(chains) {
  if (chains.length <= 3) return chains.join(", ");
  return chains.slice(0, 3).join(", ") + " +" + (chains.length - 3) + " more";
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
  "</b> · " + rows.length + " protocols ranked · model: comparable multiples from live peers";
$("stats").innerHTML = [
  [rows.length, "protocols ranked"],
  [rows.filter((r) => r.on_watchlist).length, "watchlist covered"],
  [live.length, "already trading (set aside)"],
  [RADAR.overallMultiple.toFixed(3) + "×", "overall live multiple"],
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

// multiples table
$("multiples").querySelector("tbody").innerHTML = RADAR.multiples
  .map(
    (m) =>
      "<tr><td>" + esc(m.category) + "</td><td class=\"num\">" + m.multiple.toFixed(3) + "×</td><td class=\"num\">" + m.live_count + "</td></tr>",
  )
  .join("") +
  '<tr><td>Overall live median (fallback)</td><td class="num">' + RADAR.overallMultiple.toFixed(3) + '×</td><td class="num">—</td></tr>';

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
        "<td><span class=\"name\">" + esc(r.name) + "</span>" + (r.on_watchlist ? '<span class="watch">watchlist</span>' : "") +
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
    const m = multiples.get(r.category);
    const multNote = m
      ? "Median market-cap/TVL of " + m.live_count + " live " + esc(r.category) + " protocols in this snapshot."
      : "Fewer than 3 live " + esc(r.category) + " peers in this snapshot — the overall live median is used.";
    const check = recomputed(r);
    body.innerHTML =
      "<h2>" + esc(r.name) + "</h2>" +
      '<p class="sub">' + esc(r.category) + " · " + esc(r.chains.join(", ")) + " · rank #" + r.rank + (r.on_watchlist ? " · watchlist" : "") + "</p>" +
      '<div class="equation">' + fmtUsd(r.tvl_usd) + " TVL × " + r.multiple.toFixed(3) + "× multiple × " + r.growth_mult.toFixed(3) + " growth × " + r.maturity_mult.toFixed(3) + " maturity<br>" +
      '<span class="total">= ' + fmtUsd(r.implied_value_usd) + " implied value</span></div>" +
      "<p class=\"note\">" + multNote + " Growth is the 7-day TVL change (" + fmtPct(r.change_7d) + "), clamped to −60%…+120% at half weight. Maturity is " + r.maturity_mult.toFixed(3) + " after " + fmtAge(r.age_days) + " with no token recorded. " +
      (check === r.implied_value_usd ? "Recomputed from these fields: matches." : '<span class="warn">Recomputed value ' + fmtUsd(check) + " does not match the board — do not trust this row.</span>") + "</p>" +
      "<h3>Farm plan — 6 steps</h3><ol>" + r.farm_steps.map((s) => "<li>" + esc(s) + "</li>").join("") + "</ol>" +
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
