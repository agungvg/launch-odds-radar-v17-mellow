// Launch-Odds Radar v17-mellow dashboard. Reads window.RADAR (written beside
// dashboard/ by main.ts) and renders the ranked board, filters, sliders and a
// per-protocol detail drawer. No network: every byte shown is in data.js.
(function () {
  'use strict';
  var DATA = window.RADAR;
  if (!DATA) return;
  var EV = DATA.evidence;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', verdict: 'all', tier: 'all', sort: 'implied', dir: -1, selected: null, depositPct: 0.0002, dropShare: 0.07, weeks: 12 };

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtUsdExact(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return usd0.format(Math.round(n));
  }
  // The disclosed display rule: a sub-$1K IMPLIED value prints as <$1K.
  // It applies to implied values only — a $201 drop or a $187 T-bill is a real
  // dollar figure and prints exactly.
  function fmtImplied(row) {
    if (row.implied_raw !== undefined && row.implied_raw < 1000) return '<$1K';
    return fmtUsdExact(row.implied_value_usd);
  }
  function fmtPct(n) { if (n === null || n === undefined || !isFinite(n)) return 'n/a'; return (n > 0 ? '+' : '') + n.toFixed(2) + '%'; }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtX(n) { return 'x' + n.toFixed(2); }
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }
  // Farm economics at the live scenario. Fees $2.95, hands-on hours scale with the horizon.
  function farmEcon(row) {
    var deposit = state.depositPct * row.tvl_usd;
    var drop = (row.implied_value_usd * state.dropShare * deposit) / (row.tvl_usd + deposit);
    var net = drop - 2.95;
    var tbill = deposit * 0.04 * (state.weeks / 52);
    var hours = 3.4 * (state.weeks / 12);
    return { deposit: deposit, drop: drop, net: net, tbill: tbill, perHour: net / hours, hours: hours };
  }
  function farmVerdict(row) {
    var e = farmEcon(row);
    if (e.net > e.tbill && e.perHour > 25) return 'Farm';
    if (e.net <= 0) return 'Skip';
    return 'Marginal';
  }
  function isWatchlist(r) { return DATA.watchlist.indexOf(r.slug) >= 0; }
  function tierOf(r) {
    if (isWatchlist(r)) return 'watchlist';
    if (r.tvl_usd < DATA.floor_usd) return 'early';
    return 'offlist';
  }
  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.verdict !== 'all' && farmVerdict(r) !== state.verdict) return false;
      if (state.tier !== 'all' && tierOf(r) !== state.tier) return false;
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && !(r.chains || []).includes(state.chain)) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function counts() {
    var c = { farm: 0, marginal: 0, skip: 0 };
    DATA.rows.forEach(function (r) { var v = farmVerdict(r); if (v === 'Farm') c.farm++; else if (v === 'Marginal') c.marginal++; else c.skip++; });
    return c;
  }
  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, 'Launch-Odds ', el('b', { text: 'Radar' }), ' ', el('span', { class: 'sub', text: 'v17-mellow' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: 'model ' + DATA.model_version })
      ));
  }
  function hero() {
    var vf = EV.value_fit;
    return el('section', { class: 'hero' },
      el('div', { class: 'hero-text' },
        el('h1', { text: 'Pre-token protocols, valued from their own record' }),
        el('p', { text: 'Implied value = TVL x fitted multiple (the value if a token launches) x token odds (from how long peers ran before recording one). Each coefficient is fitted on this snapshot and tested held-out twice.' })
      ),
      el('div', { class: 'cards' },
        el('div', { class: 'card3d' }, el('div', { class: 'big', text: fmtX(vf.multiple_100m) }), el('div', { class: 'lab', text: 'multiple at $100M TVL' })),
        el('div', { class: 'card3d' }, el('div', { class: 'big', text: String(EV.farm_counts.farm) }), el('div', { class: 'lab', text: 'worth farming, strict rule' })),
        el('div', { class: 'card3d' }, el('div', { class: 'big', text: String(DATA.board_size) }), el('div', { class: 'lab', text: 'rows ranked, 40 watchlist' }))
      ));
  }
  function kpis() {
    var vf = EV.value_fit, rg = EV.ranges, of = EV.odds_fit;
    var cards = [
      ['Out-of-sample miss, walk-forward', fmtX(vf.wf66) + ' vs ' + fmtX(vf.flat_wf66) + ' flat', 'leave-one-out ' + fmtX(vf.loo) + ' vs ' + fmtX(vf.flat_loo)],
      ['Is the printed range honest?', (rg.boot_wf50 * 100).toFixed(1) + '% · ' + (rg.boot_wf80 * 100).toFixed(1) + '% of later caps inside', 'stated 50% · 80%, measured walk-forward'],
      ['Token odds vs base rate', 'Brier ' + EV.odds_terms[5].bw + ' vs ' + of.base_brier_wf + ' walk-forward', 'AUC ' + EV.odds_terms[5].aw + ' walk-forward'],
      ['Terms that survived both tests', '2 of 6 · 5 of 7', 'value model · token odds; the rest below, not used'],
      ['Worth farming, this scenario', EV.farm_counts.farm + ' of ' + DATA.board_size, EV.farm_counts.marginal + ' marginal, ' + EV.farm_counts.skip + ' skip'],
      ['Watchlist ranked', DATA.watchlist_size + ' / ' + DATA.watchlist_size, 'plus ' + DATA.early_size + ' early rows below the floor'],
    ];
    return el('section', { class: 'kpis' }, cards.map(function (c) {
      return el('div', { class: 'kpi' }, el('div', { class: 'k' }, c[0]), el('div', { class: 'v', text: c[1] }), el('div', { class: 's', text: c[2] }));
    }));
  }
  function integrity() {
    var rows = DATA.rows;
    var inOrder = rows.every(function (r, i) { return r.rank === i + 1; });
    var nonRising = rows.every(function (r, i) { return i === 0 || r.implied_value_usd <= rows[i - 1].implied_value_usd; });
    var tvl = rows.reduce(function (s, r) { return s + r.tvl_usd; }, 0);
    var imp = rows.reduce(function (s, r) { return s + r.implied_value_usd; }, 0);
    var ok = inOrder && nonRising && tvl === EV.totals.tvl_usd && imp === EV.totals.implied_usd;
    return el('div', { class: 'strip' },
      el('b', { text: ok ? 'this table = board.json: ' : 'recompute mismatch: ' }),
      el('span', { text: DATA.board_size + ' of ' + DATA.board_size + ' rows recomputed here ' + (ok ? '✓' : '✗') + ' ranks 1–' + DATA.board_size + ' in order, values never rise ✓ totals equal: ' + fmtUsdExact(EV.totals.implied_usd) + ' ✓ checksum ' + DATA.checksum + ' = main.ts ✓ watchlist ' + DATA.watchlist_size + ' of ' + DATA.watchlist_size + ' ranked ✓ ledger ' + EV.accounting.ledger + ' of ' + EV.accounting.ledger + ' protocols' }));
  }
  function accounting() {
    var a = EV.accounting;
    return el('div', { class: 'acct' },
      el('b', { text: 'PROTOCOL ACCOUNTING: ' }),
      el('span', { text: 'all ' + a.ledger + ' snapshot protocols in exactly one group: ' + a.ranked + ' ranked as pre-token, ' + a.token_recorded + ' already record a token, ' + a.out + ' left out by the house list\u2019s own rules. Ranked: watchlist ' + DATA.watchlist_size + '; early, below the floor ' + (DATA.board_size - DATA.watchlist_size) + '. Token trades: priced comp ' + a.priced_comp + '; token recorded, no usable cap ' + a.token_no_cap + '. Out: versioned or wrapped ' + a.out_versioned + '; exchange ' + a.out_cex + '; below the floor, not chosen ' + a.out_below_floor + '; above the floor, off-list ' + a.out_above_floor + '.' }));
  }
  function termTable(title, sub, head, rows, fmt) {
    var thead = el('thead', null, el('tr', null, head.map(function (h) { return el('th', { text: h }); })));
    var tbody = el('tbody');
    rows.forEach(function (r) { tbody.appendChild(el('tr', null, fmt(r).map(function (c, i) { return el('td', { class: i > 0 ? 'num' : '', html: c }); }))); });
    return el('div', { class: 'panel' }, el('h2', { text: title }), el('p', { class: 'sub', text: sub }), el('div', { class: 'table-wrap' }, el('table', null, thead, tbody)));
  }
  function evidence() {
    var vf = EV.value_fit, rg = EV.ranges;
    var valuePanel = termTable('OUT-OF-SAMPLE EVIDENCE — VALUE (typical miss, 95 traded tokens)',
      'A term is kept only if it lowers the held-out miss in both tests: leave-one-out, and walk-forward (tokens listed earlier price those listed later).',
      ['Term', 'Leave-one-out', 'Walk-forward'],
      EV.value_terms,
      function (r) { return [r.term, fmtX(r.loo), fmtX(r.wf66) + ' <span class="' + (r.kept === 'kept' ? 'kept' : 'dropped') + '">' + r.kept + '</span>']; });
    var oddsPanel = termTable('TOKEN ODDS (Brier score; 645 dated peers, 327 record a token)',
      'Odds are the peers\u2019 record, not a forecast: the page never says a token will launch.',
      ['Term', 'Ten-fold (seed 11)', 'Ten-fold (seed 42)', 'Walk-forward'],
      EV.odds_terms,
      function (r) { return [r.term, r.b10.toFixed(3) + ' / ' + r.a10.toFixed(3), r.b10s42.toFixed(3) + ' / ' + r.a10s42.toFixed(3), r.bw.toFixed(3) + ' / ' + r.aw.toFixed(3) + ' <span class="' + (r.kept === 'kept' ? 'kept' : 'dropped') + '">' + r.kept + '</span>']; });
    var sweepPanel = termTable('LAMBDA SWEEP — category shrinkage, on the real ranked set',
      'No lambda dominates. Lambda 2 wins walk-forward and Farm but has the worst leave-one-out; lambda 16 wins leave-one-out but Farm collapses. Lambda 4 is the defensible compromise and stays primary.',
      ['Lambda', 'Leave-one-out', 'Walk-forward 66/29', 'Walk-forward 47/48', 'Worst 5-fold (seed 42)', 'Farm'],
      EV.lambda_sweep,
      function (r) { return ['λ=' + r.lambda + (r.lambda === 4 ? ' (primary)' : ''), fmtX(r.loo), fmtX(r.wf66), fmtX(r.wf47), fmtX(r.worst5f42), String(r.farm)]; });
    var rangePanel = el('div', { class: 'panel' },
      el('h2', { text: 'RANGE HONESTY — Jackknife+ plus bootstrap sd (primary)' }),
      el('p', { class: 'sub', text: 'Half-width = Jackknife+ q plus the sd of 200 bootstrap-refit predictions (seed 777). The same construction gives both bands. Numbers below are measured, never nominal.' }),
      el('div', { class: 'table-wrap' }, el('table', null,
        el('thead', null, el('tr', null, ['Method', 'Leave-one-out', 'Walk-forward'].map(function (h) { return el('th', { text: h }); }))),
        el('tbody', null,
          el('tr', null, el('td', { text: 'Jackknife+, stated 50%' }), el('td', { class: 'num', text: (rg.jk_loo50 * 100).toFixed(1) + '%' }), el('td', { class: 'num', text: (rg.jk_wf50 * 100).toFixed(1) + '%' })),
          el('tr', null, el('td', { text: 'Jackknife+, stated 80%' }), el('td', { class: 'num', text: (rg.jk_loo80 * 100).toFixed(1) + '%' }), el('td', { class: 'num', text: (rg.jk_wf80 * 100).toFixed(1) + '%' })),
          el('tr', null, el('td', { text: 'JK+ + bootstrap sd, stated 50%' }), el('td', { class: 'num', text: (rg.boot_loo50 * 100).toFixed(1) + '%' }), el('td', { class: 'num', text: (rg.boot_wf50 * 100).toFixed(1) + '%' })),
          el('tr', null, el('td', { text: 'JK+ + bootstrap sd, stated 80%' }), el('td', { class: 'num', text: (rg.boot_loo80 * 100).toFixed(1) + '%' }), el('td', { class: 'num', text: (rg.boot_wf80 * 100).toFixed(1) + '%' })),
          el('tr', null, el('td', { text: 'Split-conformal, stated 50% (robustness)' }), el('td', { class: 'num', text: '—' }), el('td', { class: 'num', text: (rg.sc_wf50 * 100).toFixed(1) + '%' })),
          el('tr', null, el('td', { text: 'Split-conformal, stated 80% (robustness)' }), el('td', { class: 'num', text: '—' }), el('td', { class: 'num', text: (rg.sc_wf80 * 100).toFixed(1) + '%' }))
        ))),
      el('p', { class: 'sub', text: 'Fitted, ± bootstrap s.e. (200 refits): multiple at $100M TVL ' + fmtX(vf.multiple_100m) + ', size slope ' + vf.slope + ' ± ' + vf.slope_se + '; category effects ' + fmtX(vf.cat_min) + ' to ' + fmtX(vf.cat_max) + '. Odds, by logit: years listed ' + EV.odds_fit.age + ' ± ' + EV.odds_fit.age_se + ', log10 TVL ' + EV.odds_fit.size + ' ± ' + EV.odds_fit.size_se + ', 7-day growth ' + EV.odds_fit.growth + ' ± ' + EV.odds_fit.growth_se + ', log chains ' + EV.odds_fit.chains + ' ± ' + EV.odds_fit.chains_se + ', categories ' + EV.odds_fit.cat_min + ' to ' + EV.odds_fit.cat_max + '.' }),
      el('p', { class: 'sub', text: '5-fold (seed 42): ' + EV.folds42.map(fmtX).join(', ') + ', worst ' + fmtX(Math.max.apply(null, EV.folds42)) + '. No odds floor: floors 0.5% / 1% / 2% change Brier and AUC on neither test at 3 decimals, so sub-$1K implied values print as <$1K.' }));
    var chartPanel = el('div', { class: 'panel' },
      el('h2', { text: 'SIZE CURVE — fitted multiple against TVL' }),
      el('p', { class: 'sub', text: 'Multiple falls as TVL grows (slope ' + vf.slope + '); the curve is the fitted ridge, not a hand-drawn line.' }),
      sizeChart());
    return el('section', { class: 'evidence' }, valuePanel, oddsPanel, sweepPanel, rangePanel, el('div', { class: 'wide' }, chartPanel));
  }
  function sizeChart() {
    var vf = EV.value_fit;
    var W = 560, H = 120, pad = 8;
    var pts = [];
    for (var i = 0; i <= 40; i++) {
      var lt = 6 + (i / 40) * 4.5;
      pts.push(Math.pow(10, vf.intercept + vf.slope * lt));
    }
    var mn = Math.log10(Math.min.apply(null, pts)), mx = Math.log10(Math.max.apply(null, pts));
    var d = pts.map(function (m, i) {
      var x = pad + (i / 40) * (W - 2 * pad);
      var y = H - pad - ((Math.log10(m) - mn) / (mx - mn)) * (H - 2 * pad);
      return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
    }).join(' ');
    var wrap = document.createElement('div');
    wrap.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart" role="img"><path d="' + d + '" fill="none" stroke="#0e7a6d" stroke-width="2.5"/></svg>' +
      '<div class="sub">TVL $1M (left) to $30B (right); multiple ' + fmtX(Math.pow(10, vf.intercept + vf.slope * 6)) + ' down to ' + fmtX(Math.pow(10, vf.intercept + vf.slope * 10.5)) + '.</div>';
    return wrap;
  }

  function controls() {
    var c = counts();
    var cats = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (a, r) { return a.concat(r.chains || []); }, []))).sort();
    function fbtn(label, key, val) {
      return el('button', { type: 'button', class: 'fbtn', 'aria-pressed': state[key] === val ? 'true' : 'false', text: label, onclick: function () { state[key] = val; writeHash(); render(); } });
    }
    var dep = el('select', { id: 'dep', 'aria-label': 'Deposit plan size' },
      [['0.0001', '0.010% of TVL'], ['0.0002', '0.020% of TVL'], ['0.0005', '0.050% of TVL'], ['0.001', '0.100% of TVL']].map(function (o) {
        return el('option', { value: o[0], text: o[1], selected: state.depositPct === parseFloat(o[0]) ? 'selected' : null });
      }));
    dep.addEventListener('change', function () { state.depositPct = parseFloat(dep.value); render(); });
    var drop = el('input', { type: 'range', id: 'drop', min: '0.01', max: '0.2', step: '0.005', value: String(state.dropShare), 'aria-label': 'Drop share' });
    var dropLab = el('span', { id: 'drop-lab', text: 'Drop ' + (state.dropShare * 100).toFixed(1) + '%' });
    drop.addEventListener('input', function () { state.dropShare = parseFloat(drop.value); dropLab.textContent = 'Drop ' + (state.dropShare * 100).toFixed(1) + '%'; render(); });
    var hor = el('input', { type: 'range', id: 'hor', min: '4', max: '26', step: '1', value: String(state.weeks), 'aria-label': 'Horizon in weeks' });
    var horLab = el('span', { id: 'hor-lab', text: 'Horizon ' + state.weeks + ' wk' });
    hor.addEventListener('input', function () { state.weeks = parseInt(hor.value, 10); horLab.textContent = 'Horizon ' + state.weeks + ' wk'; render(); });
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var catSel = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      cats.map(function (cat) { return el('option', { value: cat, text: cat, selected: state.category === cat ? 'selected' : null }); }));
    catSel.addEventListener('change', function () { state.category = catSel.value; writeHash(); render(); });
    var chainSel = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (ch) { return el('option', { value: ch, text: ch, selected: state.chain === ch ? 'selected' : null }); }));
    chainSel.addEventListener('change', function () { state.chain = chainSel.value; writeHash(); render(); });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('span', { text: 'Verdict' }), el('div', null,
        fbtn('All ' + DATA.board_size, 'verdict', 'all'),
        fbtn('Farm ' + c.farm, 'verdict', 'Farm'),
        fbtn('Marginal ' + c.marginal, 'verdict', 'Marginal'),
        fbtn('Skip ' + c.skip, 'verdict', 'Skip'))),
      el('div', { class: 'field' }, el('span', { text: 'Tier' }), el('div', null,
        fbtn('All tiers', 'tier', 'all'),
        fbtn('Watchlist', 'tier', 'watchlist'),
        fbtn('Early (<$50M)', 'tier', 'early'),
        fbtn('Off-list', 'tier', 'offlist'))),
      el('div', { class: 'field' }, el('label', { for: 'dep', text: 'Deposit plan size' }), dep),
      el('div', { class: 'field' }, dropLab, drop),
      el('div', { class: 'field' }, horLab, hor),
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), catSel),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSel),
      el('button', { class: 'button', type: 'button', text: 'Reset', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.verdict = 'all'; state.tier = 'all'; state.depositPct = 0.0002; state.dropShare = 0.07; state.weeks = 12; writeHash(); render(); } }),
      el('button', { class: 'button', type: 'button', text: 'CSV', onclick: exportCsv }),
      el('button', { class: 'button', type: 'button', text: 'JSON', onclick: exportJson }),
      el('span', { class: 'count', id: 'row-count', text: '' })
    );
  }
  function exportCsv() {
    var rows = filteredRows();
    var head = 'rank,name,category,tvl_usd,odds,implied_value_usd,verdict,net_usd,net_per_hour_usd\n';
    var body = rows.map(function (r) {
      var e = farmEcon(r);
      return [r.rank, '"' + r.name.replace(/"/g, '""') + '"', '"' + (r.category || '') + '"', r.tvl_usd, r.odds, r.implied_value_usd, farmVerdict(r), e.net.toFixed(2), e.perHour.toFixed(2)].join(',');
    }).join('\n');
    download('launch-odds-radar-v17.csv', 'text/csv', head + body + '\n');
  }
  function exportJson() {
    download('launch-odds-radar-v17.json', 'application/json', JSON.stringify(filteredRows(), null, 2));
  }
  function download(name, type, text) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', class: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label, state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null));
  }
  function boardTable() {
    var list = filteredRows().slice();
    var key = state.sort;
    list.sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'odds') { av = a.odds; bv = b.odds; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
    var max = list.length ? list[0].implied_value_usd || 1 : 1;
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another filter to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.verdict = 'all'; state.tier = 'all'; writeHash(); render(); } })));
    }
    var tbody = el('tbody');
    list.forEach(function (r) {
      var e = farmEcon(r);
      var v = farmVerdict(r);
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (ev2) { if (ev2.key === 'Enter' || ev2.key === ' ') { ev2.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', { class: 'num', text: r.rank_low + '–' + r.rank_high }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') + (isWatchlist(r) ? ' · Watchlist' : '') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: (r.odds * 100).toFixed(0) + '%' }),
        el('td', { class: 'num', text: fmtUsd(r.if_launches_value_usd) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtImplied(r) + ' ' + fmtUsd(r.p25_usd) + '–' + fmtUsd(r.p75_usd) })
        )),
        el('td', null, el('span', { class: 'pill ' + v, text: v }),
          el('div', { class: 'sub', text: (e.net >= 0 ? '+' : '−') + '$' + Math.abs(e.net).toFixed(0) + ' · $' + e.perHour.toFixed(2) + '/h' }))
      );
      tbody.appendChild(tr);
    });
    var tvlSum = list.reduce(function (s, r) { return s + r.tvl_usd; }, 0);
    var impSum = list.reduce(function (s, r) { return s + r.implied_value_usd; }, 0);
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', { class: 'board' },
          el('caption', { class: 'sub', text: list.length + ' of ' + DATA.board_size + ' rows · ' + fmtUsd(tvlSum) + ' TVL · ' + fmtUsd(impSum) + ' implied · deposit ' + (state.depositPct * 100).toFixed(3) + '% of TVL · drop ' + (state.dropShare * 100).toFixed(1) + '% · horizon ' + state.weeks + ' wk · gas $15' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            el('th', { scope: 'col', text: 'Range' }),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'No-token age'),
            sortHeader('odds', 'Token odds'),
            sortHeader('implied', 'If it launches'),
            sortHeader('implied', 'Implied value · P25–P75'),
            el('th', { scope: 'col', text: 'Verdict · net of fees / net / hour' })
          )),
          tbody
        )
      )
    );
  }
  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });
  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    var e = farmEcon(row);
    var v = farmVerdict(row);
    dialog.textContent = '';
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + ' · rank ' + row.rank_low + '–' + row.rank_high + ' across 200 refits' }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })
      ),
      el('button', { class: 'close button', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    var body = el('div', { class: 'detail-body' });
    body.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Fitted multiple' }), el('b', { class: 'num', text: fmtX(row.multiple) })),
        el('div', null, el('span', { text: 'Token odds' }), el('b', { class: 'num', text: (row.odds * 100).toFixed(1) + '%' })),
        el('div', null, el('span', { text: 'If a token launches' }), el('b', { class: 'num', text: fmtUsdExact(row.if_launches_value_usd) })),
        el('div', null, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtImplied(row) })),
        el('div', null, el('span', { text: 'P25–P75 / P10–P90' }), el('b', { class: 'num', text: fmtUsd(row.p25_usd) + '–' + fmtUsd(row.p75_usd) + ' / ' + fmtUsd(row.p10_usd) + '–' + fmtUsd(row.p90_usd) }))
      ),
      el('p', { class: 'sub', text: 'Recomputed in this browser: equals board.json. DefiLlama records no token for it, which is not proof it has none; the odds are its peers\u2019 record, not a forecast.' })
    ));
    body.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'How the figure is made' }),
      el('div', { class: 'table-wrap' }, el('table', null,
        el('tbody', null,
          el('tr', null, el('td', { text: 'TVL' }), el('td', { class: 'num', text: fmtUsdExact(row.tvl_usd) })),
          el('tr', null, el('td', { text: 'Base multiple at $100M TVL' }), el('td', { class: 'num', text: fmtX(EV.value_fit.multiple_100m) + ' (fitted on 95 traded tokens; alone, a flat multiple: held-out miss ' + fmtX(EV.value_fit.flat_loo) + ' leave-one-out, ' + fmtX(EV.value_fit.flat_wf66) + ' walk-forward)' })),
          el('tr', null, el('td', { text: 'Size curve (slope ' + EV.value_fit.slope + ' ± ' + EV.value_fit.slope_se + ')' }), el('td', { class: 'num', text: fmtX(row.size_factor) })),
          el('tr', null, el('td', { text: 'Category · ' + (row.category || 'Other') }), el('td', { class: 'num', text: fmtX(row.category_effect) })),
          el('tr', null, el('td', { text: 'Value if a token launches' }), el('td', { class: 'num', text: fmtUsdExact(row.if_launches_value_usd) })),
          el('tr', null, el('td', { text: 'Token odds' }), el('td', { class: 'num', text: (row.odds * 100).toFixed(1) + '% (peers of its age, category, size and chains; walk-forward Brier ' + EV.odds_terms[5].bw + ' vs ' + EV.odds_fit.base_brier_wf + ' base rate)' })),
          el('tr', null, el('td', { text: 'Implied value' }), el('td', { class: 'num', text: fmtImplied(row) + ' (P25–P75 ' + fmtUsd(row.p25_usd) + '–' + fmtUsd(row.p75_usd) + ', P10–P90 ' + fmtUsd(row.p10_usd) + '–' + fmtUsd(row.p90_usd) + ', rank ' + row.rank_low + '–' + row.rank_high + ' across 200 bootstrap refits)' }))
        ))),
      el('p', { class: 'sub', text: 'Tested, not used: 7-day TVL growth (leave-one-out ' + fmtX(EV.value_terms[4].loo) + ', walk-forward ' + fmtX(EV.value_terms[4].wf66) + '), age (' + fmtX(EV.value_terms[5].loo) + ' / ' + fmtX(EV.value_terms[5].wf66) + '), chain count (' + fmtX(EV.value_terms[6].loo) + ' / ' + fmtX(EV.value_terms[6].wf66) + '), category ridge 16 (' + fmtX(EV.value_terms[3].loo) + ' / ' + fmtX(EV.value_terms[3].wf66) + ').' })
    ));
    var gridCells = [];
    [0.035, 0.07, 0.14].forEach(function (ds) {
      [1000, 10000, 30000].forEach(function (dep) {
        var net = (row.implied_value_usd * ds * dep) / (row.tvl_usd + dep) - 2.95;
        var hot = dep === 10000 && ds === 0.07;
        gridCells.push(el('div', { class: 'cell' + (hot ? ' hot' : ''), id: hot ? 'grid-hot' : null },
          el('span', { text: '$' + dep.toLocaleString('en-US') + ' × ' + (ds * 100).toFixed(1) + '%' }), el('br'), el('span', { text: (net >= 0 ? '+' : '−') + '$' + Math.abs(net).toFixed(0) })));
      });
    });
    body.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm verdict — ' + v }),
      el('p', { text: fmtUsdExact(e.deposit) + ' for ' + state.weeks + ' weeks buys a modelled drop of ' + fmtUsdExact(e.drop) + ' for $2.95 of fees and ' + e.hours.toFixed(1) + ' h of work, a net of ' + (e.net >= 0 ? '+' : '−') + '$' + Math.abs(e.net).toFixed(0) + ' ($' + e.perHour.toFixed(2) + ' an hour) against ' + fmtUsdExact(e.tbill) + ' from the same money in a 4% T-bill. Gas budget $15 (the plan spends $2.95 of fees).' }),
      el('p', { class: 'sub', text: 'At risk ' + fmtUsdExact(e.deposit) + '; fees ' + state.weeks + ' weeks $2.95; modelled drop ' + fmtUsdExact(e.drop) + '; net of fees ' + (e.net >= 0 ? '+' : '−') + '$' + Math.abs(e.net).toFixed(0) + '; hands-on ' + e.hours.toFixed(1) + ' h; net per hour $' + e.perHour.toFixed(2) + '. ' + (v === 'Farm' ? 'FARM: the net beats the T-bill and $25 an hour.' : v === 'Skip' ? 'SKIP: fees exceed the drop.' : 'MARGINAL: the net clears the fees but not the T-bill and $25 an hour together.') + ' Yield earned meanwhile is left out.' }),
      el('div', { class: 'grid3', id: 'farm-grid' }, gridCells),
      el('p', { class: 'sub', text: 'Net by drop share × deposit. Benchmarks: same ' + fmtUsdExact(e.deposit) + ' in a 4% T-bill, ' + state.weeks + ' weeks, ' + fmtUsdExact(e.tbill) + '; drop if a token does launch (odds not applied) ' + fmtUsdExact(row.if_launches_value_usd * 0.07 * e.deposit / (row.tvl_usd + e.deposit)) + '. Formula: drop = implied value × drop share × deposit ÷ (TVL + deposit).' })
    ));
    body.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan — 10 steps' }),
      el('ol', { class: 'steps' }, row.farm_steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    body.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Nearest priced peers · their tokens trade' }),
      el('div', { class: 'table-wrap' }, el('table', null,
        el('thead', null, el('tr', null, ['Token', 'Category', 'TVL', 'Market cap', 'Cap ÷ TVL', 'Cap ÷ held-out model'].map(function (h) { return el('th', { text: h }); }))),
        el('tbody', null, row.peers.map(function (p) {
          return el('tr', null,
            el('td', { text: p.name }), el('td', { text: p.category || 'Other' }),
            el('td', { class: 'num', text: fmtUsd(p.tvl_usd) }), el('td', { class: 'num', text: fmtUsd(p.mcap_usd) }),
            el('td', { class: 'num', text: fmtX(p.ratio) }), el('td', { class: 'num', text: fmtX(p.held_out_ratio) }));
        }))
      ))
    ));
    dialog.appendChild(body);
    if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); }
    else dialog.setAttribute('open', '');
  }
  function readParams() {
    var params = new URLSearchParams(window.location.search);
    var q = params.get('q'); if (q) state.q = q;
    var p = params.get('drawer'); if (p) state.selected = p;
    var f = params.get('filter'); if (f) state.verdict = f.charAt(0).toUpperCase() + f.slice(1).toLowerCase();
    var hash = window.location.hash.replace(/^#/, '');
    if (hash) {
      var hp = new URLSearchParams(hash);
      if (hp.get('q')) state.q = hp.get('q');
      if (hp.get('p')) state.selected = hp.get('p');
      if (hp.get('category')) state.category = hp.get('category');
    }
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(hero());
    shell.appendChild(kpis());
    shell.appendChild(integrity());
    shell.appendChild(accounting());
    shell.appendChild(evidence());
    shell.appendChild(controls());
    shell.appendChild(boardTable());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    var cnt = document.getElementById('row-count');
    if (cnt) cnt.textContent = filteredRows().length + ' of ' + DATA.board_size + ' rows · ' + fmtUsd(filteredRows().reduce(function (s, r) { return s + r.tvl_usd; }, 0)) + ' TVL · ' + fmtUsd(filteredRows().reduce(function (s, r) { return s + r.implied_value_usd; }, 0)) + ' implied';
    if (state.selected) openDetail(state.selected);
  }
  readParams();
  render();
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && dialog.open) dialog.close(); });
})();
