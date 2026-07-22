-- ============================================================================
-- A3 — "Golden queries" for star-inflation detection (Insight Desk)
-- ============================================================================
-- Dataset: github.github_events (slice ~106M rows, 2011..2026-06).
-- Slice structure (see a2_lib.sh):
--   part "a" — ALL events for target repos across full history;
--   part "b" — ALL WatchEvents for each actor who starred target repos (2011+);
--   part "c" — background 2024-01-01..2024-07-01: all WatchEvents + CreateEvent(repo) +
--               ForkEvent + 25% sample of PullRequestEvent.
-- Consequence: within window 2024-01..07 star coverage is COMPLETE for all repos;
-- outside the window full history exists only for target repos and "their" actors.
--
-- Target repos (StarScout, documented inflation campaigns):
--   solidSpoon/DashPlayer    p_fake=0.86  window 2024-05-15..2024-05-25   HERO 1
--   deepseek-ai/DeepSeek-VL  p_fake=0.78  window 2024-03-11..2024-03-17   HERO 2
--   OpenInterpreter/01       p_fake=0.46  launch 03-21..22 (organic) +
--                                         tail 03-23..25 (inflation)       HERO 3
--   Zejun-Yang/AniPortrait   p_fake=0.83  window 2024-03-27..2024-04-03  confirmed
--   lavague-ai/LaVague       p_fake=0.76  window 2024-03-13..2024-03-19  mixed with launch
-- Control (clean organic): xai-org/grok-1, release 2024-03-17.
--
-- MAIN A3 FINDING (breaks the naive hypothesis — this is the demo narrative):
-- 2024 campaigns do NOT use empty fresh accounts. The farm sells
-- "aged" accounts with camouflage activity. Bots are exposed by:
--   1) shape: "rectangle" instead of "peak + decay" (Q5);
--   2) serial starring: median 51-80 stars/half-year vs 15 for organic (Q4);
--   3) farm portfolio: co-starring obscure repos with 30-50x lift (Q3);
--   4) campaign overlap: 15% of the DeepSeek-VL crowd starred AniPortrait
--      in HER window (10.7x lift vs grok-1 control) (Q7).
-- "Young" accounts are a secondary signal: works for OI01 (tail 12.7% <1 day
-- vs 2.5% background), but DashPlayer inverts — 86.5% older than a year (Q2).
--
-- All queries run on admin connection 2026-07-18/19; timings in comments.
-- Parameter substitution: lines marked -- PARAM.
-- ============================================================================


-- ============================================================================
-- Q1 (a) — Daily star timeline + anomaly window
-- ----------------------------------------------------------------------------
-- What it shows: daily star curve for a repo; in_anomaly_window column
-- marks the campaign window (for timeline component → anomalyWindow).
-- What to expect (DashPlayer): Jan-Apr 0-5 stars/day, 2024-05-17 — 300,
-- 2024-05-22 — 227; 1377 stars in May vs 5 in Jan+Feb combined.
-- For grok-1 (swap repo/dates): 03-17 → 2452, 03-18 → 20150, then decay
-- 9403 → 4704 → 1861 → 963 — organic drops exponentially, inflation holds a plateau.
-- Timing: ~0.3 s.
-- ============================================================================
SELECT
    toDate(created_at) AS day,
    count() AS stars,
    day BETWEEN '2024-05-15' AND '2024-05-25' AS in_anomaly_window,   -- PARAM window
    bar(count(), 0, 320, 40) AS viz
FROM github.github_events
WHERE event_type = 'WatchEvent'
  AND repo_name = 'solidSpoon/DashPlayer'                             -- PARAM repo
  AND created_at >= '2024-04-01' AND created_at < '2024-07-01'        -- PARAM range
GROUP BY day
ORDER BY day;


-- ============================================================================
-- Q2 (b) — Account age profile at star time: window vs baseline
-- ----------------------------------------------------------------------------
-- Age ≈ star minus actor's first event in the dataset (for all who starred
-- target repos in the slice their full Watch history since 2011 — estimate is fair).
-- Buckets: <1 day, 1d-1wk, 1wk-1mo, 1mo-1yr, >1 year.
-- What to expect (actual numbers):
--   OpenInterpreter/01  WINDOW(tail 03-23..25): lt_1d = 0.127  (baseline 0.025, x5!)
--   Zejun-Yang/AniPortrait WINDOW:               lt_1d = 0.063  (baseline 0.021, x3)
--   solidSpoon/DashPlayer  WINDOW — INVERSION:    lt_1d = 0.002, y1_plus = 0.865
--     (baseline 0.751) — farm of aged accounts, "too old to be true"
--     for a niche Chinese video player.
--   deepseek-ai/DeepSeek-VL WINDOW: age is flat (0.033 vs 0.042) — age does NOT
--     catch this campaign; Q3/Q4/Q5 do.
-- Timing: ~2.8 s.
-- ============================================================================
WITH stars AS (
    SELECT repo_name, actor_login, created_at AS star_ts,
      multiIf(
        repo_name='solidSpoon/DashPlayer'   AND toDate(created_at) BETWEEN '2024-05-15' AND '2024-05-25', 'WINDOW',
        repo_name='deepseek-ai/DeepSeek-VL' AND toDate(created_at) BETWEEN '2024-03-11' AND '2024-03-17', 'WINDOW',
        repo_name='Zejun-Yang/AniPortrait'  AND toDate(created_at) BETWEEN '2024-03-27' AND '2024-04-03', 'WINDOW',
        repo_name='OpenInterpreter/01'      AND toDate(created_at) BETWEEN '2024-03-23' AND '2024-03-25', 'WINDOW',
        'baseline') AS grp                                            -- PARAM windows
    FROM github.github_events
    WHERE event_type = 'WatchEvent'
      AND repo_name IN ('solidSpoon/DashPlayer','deepseek-ai/DeepSeek-VL',
                        'Zejun-Yang/AniPortrait','OpenInterpreter/01') -- PARAM repos
),
first_seen AS (
    SELECT actor_login, min(created_at) AS first_ts
    FROM github.github_events
    WHERE actor_login IN (SELECT actor_login FROM stars)
    GROUP BY actor_login
)
SELECT repo_name, grp, count() AS stars,
       round(countIf(star_ts - first_ts <    1*86400) / count(), 3) AS lt_1d,
       round(countIf(star_ts - first_ts >=   1*86400 AND star_ts - first_ts <   7*86400) / count(), 3) AS d1_w1,
       round(countIf(star_ts - first_ts >=   7*86400 AND star_ts - first_ts <  30*86400) / count(), 3) AS w1_m1,
       round(countIf(star_ts - first_ts >=  30*86400 AND star_ts - first_ts < 365*86400) / count(), 3) AS m1_y1,
       round(countIf(star_ts - first_ts >= 365*86400) / count(), 3) AS y1_plus
FROM stars s
JOIN first_seen f USING (actor_login)
GROUP BY repo_name, grp
ORDER BY repo_name, grp;


-- ============================================================================
-- Q3 (c) — Co-starring matrix: what else window actors starred (lift)
-- ----------------------------------------------------------------------------
-- Comparison in window 2024-01..07 (star coverage is complete for ALL actors there):
--   suspects — starred the repo in the anomaly window;
--   control  — 42,263 who starred grok-1 in March (organic crowd baseline).
-- lift = share of suspects who starred repo R / share of control who starred R.
-- What to expect (DashPlayer, ORDER BY lift): farm portfolio — obscure
-- Chinese utilities with 30-50x lift:
--   Thisal-D/PyTube-Downloader lift 52x, unilei/aipan-netdisk-search 50x,
--   Spr-Aachen/Easy-Voice-Toolkit 48x, kangpeiqin/bilivideo_down 46x,
--   buxuku/VideoSubtitleGenerator 42x ... (5% of DashPlayer crowd vs 0.1%
--   of grok-1 crowd). Account pool fingerprint: one farm — shared portfolio.
-- For DeepSeek-VL: CV repo cluster ELLA 28x, VisionLLaMA 24x, Bunny 22x.
-- ORDER BY s_share instead of lift shows camouflage: trending AI repos
-- (Open-Sora 38%, OpenDevin 29%) — bots star trends to look alive.
-- Timing: ~4.6 s.
-- ============================================================================
WITH
suspects AS (
    SELECT DISTINCT actor_login FROM github.github_events
    WHERE event_type = 'WatchEvent'
      AND repo_name = 'solidSpoon/DashPlayer'                         -- PARAM repo
      AND toDate(created_at) BETWEEN '2024-05-15' AND '2024-05-25'    -- PARAM window
),
control AS (
    SELECT DISTINCT actor_login FROM github.github_events
    WHERE event_type = 'WatchEvent' AND repo_name = 'xai-org/grok-1'
      AND created_at >= '2024-03-01' AND created_at < '2024-04-01'
),
n_s AS (SELECT count() FROM suspects),
n_c AS (SELECT count() FROM control)
SELECT repo_name,
       uniqExactIf(actor_login, actor_login IN (SELECT * FROM suspects)) AS s_actors,
       round(s_actors / (SELECT * FROM n_s), 3) AS s_share,
       uniqExactIf(actor_login, actor_login IN (SELECT * FROM control)) AS c_actors,
       round(c_actors / (SELECT * FROM n_c), 4) AS c_share,
       round(s_share / greatest(c_share, 0.0002), 1) AS lift
FROM github.github_events
WHERE event_type = 'WatchEvent'
  AND created_at >= '2024-01-01' AND created_at < '2024-07-01'
  AND repo_name NOT IN ('solidSpoon/DashPlayer', 'xai-org/grok-1')    -- PARAM repos
GROUP BY repo_name
HAVING s_actors >= 25
ORDER BY lift DESC
LIMIT 20;


-- ============================================================================
-- Q4 (d) — "One-and-done" and serial starring: inversion of the naive myth
-- ----------------------------------------------------------------------------
-- Naively we expect bots to have "star as only event". REALITY IS OPPOSITE:
--   one-and-done (for 2024-01..07): grok-1 organic 7.8% (live lurkers!),
--   DashPlayer 0.8%, DeepSeek-VL 0.4% — bots have almost NO empty accounts.
-- But serial starring (median stars per half-year):
--   DeepSeek-VL w: 80 (!), AniPortrait w: 63, OI01 tail: 56, DashPlayer w: 51
--   vs grok-1: 15. Share who starred 100+ repos per half-year: 32-44% vs 12.6%.
--   Median active days: 33-52 vs 13.
-- The farm masks accounts with continuous starring of everything — camouflage
-- is the fingerprint.
-- Timing: ~4.1 s (heaviest; for drill materialize into scratch).
-- ============================================================================
WITH grp_stars AS (
    SELECT DISTINCT actor_login,
      multiIf(
        repo_name='solidSpoon/DashPlayer'   AND toDate(created_at) BETWEEN '2024-05-15' AND '2024-05-25', 'DashPlayer w',
        repo_name='deepseek-ai/DeepSeek-VL' AND toDate(created_at) BETWEEN '2024-03-11' AND '2024-03-17', 'DeepSeekVL w',
        repo_name='Zejun-Yang/AniPortrait'  AND toDate(created_at) BETWEEN '2024-03-27' AND '2024-04-03', 'AniPortrait w',
        repo_name='OpenInterpreter/01'      AND toDate(created_at) BETWEEN '2024-03-23' AND '2024-03-25', 'OI01 tail',
        repo_name='xai-org/grok-1'          AND toDate(created_at) BETWEEN '2024-03-16' AND '2024-03-31', 'grok-1 organic',
        NULL) AS grp                                                  -- PARAM groups
    FROM github.github_events
    WHERE event_type = 'WatchEvent' AND grp IS NOT NULL
),
activity AS (
    SELECT actor_login,
           count() AS ev_6mo,
           countIf(event_type = 'WatchEvent') AS stars_6mo,
           uniqExact(toDate(created_at)) AS active_days
    FROM github.github_events
    WHERE created_at >= '2024-01-01' AND created_at < '2024-07-01'
      AND actor_login IN (SELECT actor_login FROM grp_stars)
    GROUP BY actor_login
)
SELECT grp,
       count() AS actors,
       round(countIf(a.ev_6mo = 1) / count(), 3) AS one_and_done_share,
       quantileExact(0.5)(a.stars_6mo) AS median_stars_6mo,
       round(countIf(a.stars_6mo >= 100) / count(), 3) AS share_starred_100plus,
       quantileExact(0.5)(a.active_days) AS median_active_days
FROM grp_stars g
JOIN activity a USING (actor_login)
GROUP BY grp
ORDER BY median_stars_6mo DESC;


-- ============================================================================
-- Q5 (e) — Burst metrics: peak, plateau, top-day share
-- ----------------------------------------------------------------------------
-- burst_ratio (max day / median active day) catches ANOMALY but does not
-- separate fraud from virality: grok-1 610x (!), OI01 149x, LaVague 89x.
-- SHAPE differs — days_above_half_peak (days with >=50% of peak):
--   deepseek-ai/DeepSeek-VL: 5 plateau days (192-223 stars/day) — rectangle,
--   drip campaign "quota per day"; AniPortrait/OI01: 3; grok-1: 1 (peak+decay).
-- Detail: grok-1 top_day_share 0.435 (20,150 of 46,316 stars in one day),
-- DashPlayer peak 300 (2024-05-17) with median active day 5.
-- Timing: ~0.4 s.
-- ============================================================================
WITH daily AS (
    SELECT repo_name, toDate(created_at) AS day, count() AS stars
    FROM github.github_events
    WHERE event_type = 'WatchEvent'
      AND repo_name IN ('lavague-ai/LaVague','Zejun-Yang/AniPortrait',
                        'deepseek-ai/DeepSeek-VL','solidSpoon/DashPlayer',
                        'OpenInterpreter/01','xai-org/grok-1')        -- PARAM repos
      AND created_at >= '2024-01-01' AND created_at < '2024-07-01'
    GROUP BY repo_name, day
),
peaks AS (SELECT repo_name, max(stars) AS peak FROM daily GROUP BY repo_name)
SELECT d.repo_name,
       sum(d.stars) AS total_stars_6mo,
       any(p.peak) AS max_day,
       quantileExact(0.5)(d.stars) AS median_active_day,
       round(any(p.peak) / greatest(quantileExact(0.5)(d.stars), 1), 1) AS burst_ratio,
       round(any(p.peak) / sum(d.stars), 3) AS top_day_share,
       argMax(d.day, d.stars) AS peak_day,
       countIf(d.stars >= 0.5 * p.peak) AS days_above_half_peak     -- plateau = fraud
FROM daily d
JOIN peaks p USING (repo_name)
GROUP BY d.repo_name
ORDER BY days_above_half_peak DESC;


-- ============================================================================
-- Q6 (f) — Hourly star profile in the anomaly window
-- ----------------------------------------------------------------------------
-- hourly_cv = stddev/avg over 24 hourly buckets; min_over_avg — "does night breathe".
-- What to expect:
--   grok-1 organic:  cv 0.50 — global timezone wave, daily rhythm;
--   DeepSeekVL w:    cv 0.38, min 28% of average — stars drip ROUND-THE-CLOCK
--                    more evenly than organic (automation without sleep);
--   AniPortrait w:   cv 0.39 — same flat delivery;
--   DashPlayer w:    cv 0.66, min 6% — farm "day shift": hours 18-23 UTC
--                    (2-7 AM in China) dead (8,9,6,3,11,26 stars), peak in
--                    Chinese business hours. Two different farm signatures!
-- hours_utc returns 24 numbers — ready data for the heatmap component.
-- Timing: ~1.2 s.
-- ============================================================================
WITH hourly AS (
    SELECT
      multiIf(
        repo_name='solidSpoon/DashPlayer'   AND toDate(created_at) BETWEEN '2024-05-15' AND '2024-05-25', 'DashPlayer w',
        repo_name='deepseek-ai/DeepSeek-VL' AND toDate(created_at) BETWEEN '2024-03-11' AND '2024-03-17', 'DeepSeekVL w',
        repo_name='Zejun-Yang/AniPortrait'  AND toDate(created_at) BETWEEN '2024-03-27' AND '2024-04-03', 'AniPortrait w',
        repo_name='xai-org/grok-1'          AND toDate(created_at) BETWEEN '2024-03-16' AND '2024-03-31', 'grok-1 organic',
        NULL) AS grp,                                                 -- PARAM groups
      toHour(created_at) AS hr,
      count() AS c
    FROM github.github_events
    WHERE event_type = 'WatchEvent' AND grp IS NOT NULL
    GROUP BY grp, hr
)
SELECT grp,
       round(stddevPop(c) / avg(c), 2) AS hourly_cv,
       round(min(c) / avg(c), 2) AS min_over_avg,
       groupArray(24)(c) AS hours_utc
FROM (SELECT * FROM hourly ORDER BY grp, hr)
GROUP BY grp
ORDER BY hourly_cv;


-- ============================================================================
-- Q7 (bonus) — Campaign window overlap: one farm, different clients
-- ----------------------------------------------------------------------------
-- How many actors starred in the windows of TWO different campaigns, and lift
-- vs grok-1 control. Actual numbers (all window pairs):
--   AniPortrait∩OI01 213, LaVague∩OI01 194, AniPortrait∩DeepSeekVL 170,
--   DeepSeekVL∩OI01 133, DeepSeekVL∩LaVague 123, AniPortrait∩LaVague 120.
-- Key lift: P(star AniPortrait in her window | DeepSeekVL w crowd) = 15.3%
-- vs 1.4% for grok-1 crowd → lift 10.7x. Five unrelated repos, same hands.
-- Also: 1,514 actors starred 2+ target repos, 68 — four or five of five.
-- Timing: ~2.6 s.
-- ============================================================================
WITH win_stars AS (
    SELECT DISTINCT actor_login,
      multiIf(
        repo_name='lavague-ai/LaVague'      AND toDate(created_at) BETWEEN '2024-03-13' AND '2024-03-19', 'LaVague',
        repo_name='deepseek-ai/DeepSeek-VL' AND toDate(created_at) BETWEEN '2024-03-11' AND '2024-03-17', 'DeepSeekVL',
        repo_name='Zejun-Yang/AniPortrait'  AND toDate(created_at) BETWEEN '2024-03-27' AND '2024-04-03', 'AniPortrait',
        repo_name='solidSpoon/DashPlayer'   AND toDate(created_at) BETWEEN '2024-05-15' AND '2024-05-25', 'DashPlayer',
        repo_name='OpenInterpreter/01'      AND toDate(created_at) BETWEEN '2024-03-21' AND '2024-03-27', 'OI01',
        NULL) AS win
    FROM github.github_events
    WHERE event_type = 'WatchEvent' AND win IS NOT NULL
)
SELECT a.win AS window_a, b.win AS window_b,
       uniqExact(a.actor_login) AS shared_actors
FROM win_stars a
JOIN win_stars b USING (actor_login)
WHERE a.win < b.win
GROUP BY window_a, window_b
ORDER BY shared_actors DESC;
