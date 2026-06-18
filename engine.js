/* Travis Tax Protest — valuation engine
 *
 * Pure functions, no DOM. Used by demo.html / batch.html (and runnable in Node).
 * Implements the "uniform & equal" equity approach (Tex. Tax Code §41.43(b)(3)):
 *   1. select comparable properties from a pool (auto comp-selection)
 *   2. adjust each comp to the subject across all detectable factors
 *   3. take the median adjusted value = the proposed (defensible) value
 *   4. apply the homestead 10% cap to compute the actual taxable savings
 *
 * Adjustment rates are CALIBRATED from the pool by ridge regression of improvement
 * value on the building characteristics (see calibrate()). Any factor that is
 * constant in the pool, or whose coefficient comes out the wrong sign, falls back
 * to a documented default. With too few records (<12) the engine uses defaults.
 */
(function (global) {
  "use strict";

  var CONFIG = {
    taxRate: 0.0198,            // combined Travis County est. rate (override per parcel)
    feeRate: 0.30,             // contingency: 30% of year-1 savings
    appraisalYear: 2025,
    sizeRateMarginal: 0.40,    // fallback size rate = 40% of market $/sf
    minCalibrationN: 12,       // need at least this many comps to calibrate
    rates: {                   // documented fallback rates
      agePerYear: 800, qualityPerGrade: 18000, conditionPerGrade: 10000,
      bathPerFull: 12000, garagePerSpace: 8000, poolFlat: 25000
    },
    compCount: 6
  };

  var QUAL = { 1: "Low", 2: "Fair", 3: "Average", 4: "Good", 5: "Excellent" };
  var COND = { 1: "Poor", 2: "Fair", 3: "Average", 4: "Good", 5: "Excellent" };

  function median(arr) {
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function mean(arr) { return arr.reduce(function (a, b) { return a + b; }, 0) / arr.length; }
  function stdev(arr) {
    var mu = mean(arr);
    return Math.sqrt(mean(arr.map(function (x) { return (x - mu) * (x - mu); })));
  }
  function yearNum(p, fallback) { var y = parseInt(p.year, 10); return isNaN(y) ? fallback : y; }

  // Solve A x = b for small symmetric systems (Gaussian elimination, partial pivot).
  function solveLinear(A, b) {
    var n = A.length, i, j, k;
    var M = A.map(function (row, r) { return row.slice().concat([b[r]]); });
    for (i = 0; i < n; i++) {
      var piv = i;
      for (k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[piv][i])) piv = k;
      if (Math.abs(M[piv][i]) < 1e-12) return null;
      var tmp = M[i]; M[i] = M[piv]; M[piv] = tmp;
      for (k = i + 1; k < n; k++) {
        var f = M[k][i] / M[i][i];
        for (j = i; j <= n; j++) M[k][j] -= f * M[i][j];
      }
    }
    var x = new Array(n);
    for (i = n - 1; i >= 0; i--) {
      var s = M[i][n];
      for (j = i + 1; j < n; j++) s -= M[i][j] * x[j];
      x[i] = s / M[i][i];
    }
    return x;
  }

  // Fallback size rate from the subject's market area ($/sf x marginal factor).
  function deriveSizeRate(subject, pool, cfg) {
    var area = pool.filter(function (p) { return p.hood === subject.hood; });
    if (area.length < 3) area = pool;
    return Math.round(median(area.map(function (p) { return p.marketValue / p.sqft; })) * cfg.sizeRateMarginal);
  }

  // Calibrate adjustment rates from the pool via ridge regression of improvement
  // value (= market - land) on the building characteristics. Memoized per pool
  // (the regression is subject-independent), so scanning many properties is fast.
  var _calCache = { pool: null, res: null };
  function calibrate(subject, pool, cfg) {
    if (_calCache.pool === pool) return _calCache.res;
    var __r = _calibrate(subject, pool, cfg || CONFIG);
    _calCache.pool = pool; _calCache.res = __r;
    return __r;
  }
  function _calibrate(subject, pool, cfg) {
    var FEATS = [
      ["sqft", function (p) { return p.sqft; }, "sizeRate"],
      ["age", function (p) { return cfg.appraisalYear - yearNum(p, cfg.appraisalYear); }, "agePerYear"],
      ["quality", function (p) { return p.quality; }, "qualityPerGrade"],
      ["condition", function (p) { return p.condition; }, "conditionPerGrade"],
      ["baths", function (p) { return p.baths; }, "bathPerFull"],
      ["garage", function (p) { return p.garage; }, "garagePerSpace"],
      ["pool", function (p) { return p.pool; }, "poolFlat"]
    ];
    var r = cfg.rates;
    var rates = {
      sizeRate: deriveSizeRate(subject, pool, cfg),
      agePerYear: r.agePerYear, qualityPerGrade: r.qualityPerGrade,
      conditionPerGrade: r.conditionPerGrade, bathPerFull: r.bathPerFull,
      garagePerSpace: r.garagePerSpace, poolFlat: r.poolFlat
    };
    var sources = {}; FEATS.forEach(function (f) { sources[f[2]] = "default"; });

    var n = pool.length;
    if (n < cfg.minCalibrationN) return { rates: rates, calibrated: false, n: n, r2: null, sources: sources };

    var medianPSF = median(pool.map(function (p) { return p.marketValue / p.sqft; }));
    var BOUNDS = {                               // plausible ranges; outside -> keep default
      sizeRate: [10, medianPSF], agePerYear: [0, 8000], qualityPerGrade: [0, 80000],
      conditionPerGrade: [0, 60000], bathPerFull: [0, 50000], garagePerSpace: [0, 25000], poolFlat: [0, 80000]
    };
    var y = pool.map(function (p) { return p.marketValue - p.landValue; });
    var my = mean(y), yc = y.map(function (v) { return v - my; });

    var cols = [];
    FEATS.forEach(function (f) {
      var x = pool.map(f[1]); var mu = mean(x), sd = stdev(x);
      if (sd < 1e-9) return;                     // constant in pool -> keep default
      cols.push({ f: f, mu: mu, sd: sd, z: x.map(function (v) { return (v - mu) / sd; }) });
    });
    if (!cols.length) return { rates: rates, calibrated: false, n: n, r2: null, sources: sources };

    var k = cols.length, lambda = Math.max(1, 0.05 * n), i, j, rr, A = [], rhs = [];
    for (i = 0; i < k; i++) {
      A[i] = [];
      for (j = 0; j < k; j++) {
        var s = 0; for (rr = 0; rr < n; rr++) s += cols[i].z[rr] * cols[j].z[rr];
        A[i][j] = s + (i === j ? lambda : 0);
      }
      var sb = 0; for (rr = 0; rr < n; rr++) sb += cols[i].z[rr] * yc[rr]; rhs[i] = sb;
    }
    var b = solveLinear(A, rhs);
    if (!b) return { rates: rates, calibrated: false, n: n, r2: null, sources: sources };

    cols.forEach(function (c, idx) {
      var coef = b[idx] / c.sd;                  // marginal $ per unit, original scale
      var rateKey = c.f[2], bnd = BOUNDS[rateKey];
      var rate = (rateKey === "agePerYear") ? -coef : coef;  // older = less value
      if (isFinite(rate) && rate >= bnd[0] && rate <= bnd[1]) { rates[rateKey] = Math.round(rate); sources[rateKey] = "calibrated"; }
    });

    // R^2 of the ridge fit (standardized space)
    var ssr = 0, sst = 0;
    for (rr = 0; rr < n; rr++) {
      var pred = 0; for (i = 0; i < k; i++) pred += b[i] * cols[i].z[rr];
      ssr += (yc[rr] - pred) * (yc[rr] - pred); sst += yc[rr] * yc[rr];
    }
    var r2 = sst > 0 ? 1 - ssr / sst : null;
    return { rates: rates, calibrated: true, n: n, r2: r2, sources: sources };
  }

  function distance(subject, c) {
    var sqftPct = Math.abs(c.sqft - subject.sqft) / subject.sqft;
    return (c.hood === subject.hood ? 0 : 1000) + sqftPct * 100 +
      Math.abs(c.year - subject.year) * 1.5 + Math.abs(c.quality - subject.quality) * 8 +
      Math.abs(c.condition - subject.condition) * 5;
  }
  function matchLabel(d) { var x = d % 1000; return x < 18 ? "Strong" : x < 45 ? "Good" : "Fair"; }

  function quantile(sorted, q) {
    var pos = (sorted.length - 1) * q, b = Math.floor(pos), rest = pos - b;
    return sorted[b + 1] !== undefined ? sorted[b] + rest * (sorted[b + 1] - sorted[b]) : sorted[b];
  }
  function rankCandidates(subject, pool) {
    return pool.filter(function (p) { return p.acct !== subject.acct; })
      .map(function (p) { return { p: p, d: distance(subject, p) }; })
      .sort(function (a, b) { return a.d - b.d; });
  }

  function adjustComp(subject, comp, rates) {
    var a = {
      size: (subject.sqft - comp.sqft) * rates.sizeRate,
      age: (yearNum(subject, 0) - yearNum(comp, 0)) * rates.agePerYear,
      quality: (subject.quality - comp.quality) * rates.qualityPerGrade,
      condition: (subject.condition - comp.condition) * rates.conditionPerGrade,
      baths: (subject.baths - comp.baths) * rates.bathPerFull,
      garage: (subject.garage - comp.garage) * rates.garagePerSpace,
      pool: (subject.pool - comp.pool) * rates.poolFlat,
      land: subject.landValue - comp.landValue
    };
    a.total = a.size + a.age + a.quality + a.condition + a.baths + a.garage + a.pool + a.land;
    a.gross = Math.abs(a.size) + Math.abs(a.age) + Math.abs(a.quality) + Math.abs(a.condition) +
      Math.abs(a.baths) + Math.abs(a.garage) + Math.abs(a.pool) + Math.abs(a.land);
    a.adjustedValue = comp.marketValue + a.total;
    return a;
  }

  function confidence(adjVals, grosses, median0, count, sameHood, want) {
    var covPct = (stdev(adjVals) / mean(adjVals)) * 100;
    var grossPct = (mean(grosses) / median0) * 100;
    var level = (count >= 4 && covPct < 5 && grossPct < 10) ? "High"
      : (covPct < 9 && grossPct < 18) ? "Medium" : "Low";
    var reasons = [];
    if (sameHood < Math.min(4, want)) { reasons.push("few same-neighborhood comps"); if (level === "High") level = "Medium"; }
    if (count < 4) { reasons.push("only " + count + " comparable" + (count === 1 ? "" : "s")); level = "Low"; }
    if (grossPct >= 18) reasons.push("large adjustments");
    return { level: level, covPct: covPct, grossPct: grossPct, sameHood: sameHood, count: count, reasons: reasons };
  }

  function valuate(subject, pool, cfg) {
    cfg = cfg || CONFIG;
    var cal = calibrate(subject, pool, cfg);
    var rates = cal.rates;

    // 1) rank candidates (distance prefers same neighborhood + class + size/age); take a buffer
    var cands = rankCandidates(subject, pool).slice(0, cfg.compCount + 8).map(function (s) {
      return Object.assign({}, s.p, { match: matchLabel(s.d), adj: adjustComp(subject, s.p, rates) });
    });
    // 2) drop adjusted-value outliers (1.5*IQR fence) when there are enough candidates
    var kept = cands, dropped = 0;
    if (cands.length >= 5) {
      var sv = cands.map(function (c) { return c.adj.adjustedValue; }).sort(function (a, b) { return a - b; });
      var q1 = quantile(sv, 0.25), q3 = quantile(sv, 0.75), iqr = q3 - q1;
      var lo = q1 - 1.5 * iqr, hi = q3 + 1.5 * iqr;
      var f = cands.filter(function (c) { return c.adj.adjustedValue >= lo && c.adj.adjustedValue <= hi; });
      if (f.length >= 3) { dropped = cands.length - f.length; kept = f; }
    }
    // 3) keep the nearest compCount survivors
    var comps = kept.slice(0, cfg.compCount);

    var adjVals = comps.map(function (c) { return c.adj.adjustedValue; });
    var proposed = median(adjVals);
    var sameHood = comps.filter(function (c) { return c.hood === subject.hood; }).length;

    var capped = (subject.cappedValue != null) ? subject.cappedValue : subject.marketValue;
    var taxableNow = Math.min(capped, subject.marketValue);
    var newTaxable = Math.min(capped, proposed);
    var marketReduction = Math.max(0, subject.marketValue - proposed);
    var taxableReduction = Math.max(0, taxableNow - newTaxable);
    var rate = (subject.taxRate != null) ? subject.taxRate : cfg.taxRate;  // per-parcel rate if known
    var savings = taxableReduction * rate;
    var fee = savings * cfg.feeRate;
    // how much the cap already shields from tax now, and the annual saving a protest would
    // eventually unlock once the 10% cap rises to meet the (now lower) market value.
    var capProtection = Math.max(0, subject.marketValue - taxableNow);
    var futureSavings = marketReduction * rate;

    return {
      sizeRate: rates.sizeRate, rates: rates, calibration: cal,
      comps: comps, proposed: proposed,
      marketValue: subject.marketValue, cappedValue: capped,
      marketReduction: marketReduction, taxableReduction: taxableReduction,
      savings: savings, fee: fee, net: savings - fee, taxRate: rate, outliersDropped: dropped,
      capProtection: capProtection, futureSavings: futureSavings,
      win: taxableReduction > 0, cappedNoSavings: marketReduction > 0 && taxableReduction === 0,
      confidence: confidence(adjVals, comps.map(function (c) { return c.adj.gross; }), proposed, comps.length, sameHood, cfg.compCount)
    };
  }

  global.TTP = {
    CONFIG: CONFIG, QUAL: QUAL, COND: COND,
    valuate: valuate, calibrate: calibrate, rankCandidates: rankCandidates, median: median
  };
})(typeof window !== "undefined" ? window : this);
