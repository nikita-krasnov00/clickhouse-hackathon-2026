-- ============================================================================
-- A3 — «Золотые запросы» детекции накрутки звёзд (Insight Desk)
-- ============================================================================
-- Датасет: github.github_events (слайс ~106М строк, 2011..2026-06).
-- Структура слайса (см. a2_lib.sh):
--   часть «а» — ВСЕ события целевых репо за всю историю;
--   часть «б» — ВСЕ WatchEvent каждого актора, звездившего целевые репо (2011+);
--   часть «в» — фон 2024-01-01..2024-07-01: все WatchEvent + CreateEvent(repo) +
--               ForkEvent + 25%-сэмпл PullRequestEvent.
-- Следствие: внутри окна 2024-01..07 покрытие звёзд ПОЛНОЕ для всех репо;
-- вне окна полная история есть только у целевых репо и «их» акторов.
--
-- Целевые репо (StarScout, документированные кампании накрутки):
--   solidSpoon/DashPlayer    p_fake=0.86  окно 2024-05-15..2024-05-25   ГЕРОЙ 1
--   deepseek-ai/DeepSeek-VL  p_fake=0.78  окно 2024-03-11..2024-03-17   ГЕРОЙ 2
--   OpenInterpreter/01       p_fake=0.46  запуск 03-21..22 (органика) +
--                                         хвост 03-23..25 (накрутка)   ГЕРОЙ 3
--   Zejun-Yang/AniPortrait   p_fake=0.83  окно 2024-03-27..2024-04-03  подтверждён
--   lavague-ai/LaVague       p_fake=0.76  окно 2024-03-13..2024-03-19  смешан с запуском
-- Контроль (чистая органика): xai-org/grok-1, релиз 2024-03-17.
--
-- ГЛАВНЫЙ ВЫВОД A3 (ломает наивную гипотезу — это и есть сюжет демо):
-- кампании 2024 года НЕ используют пустые свежие аккаунты. Ферма продаёт
-- «состаренные» аккаунты с камуфляжной активностью. Ботов выдают:
--   1) форма кривой: «прямоугольник» вместо «пик + распад» (Q5);
--   2) сериальное звездение: медиана 51-80 звёзд/полгода против 15 у органики (Q4);
--   3) портфель фермы: ко-старинг обскурных репо с лифтом 30-50x (Q3);
--   4) пересечение кампаний: 15% толпы DeepSeek-VL звездят AniPortrait
--      в ЕЁ окне (лифт 10.7x против контроля grok-1) (Q7).
-- «Молодые» аккаунты — вторичный сигнал: работает для OI01 (хвост 12.7% <1 дня
-- против 2.5% фона), но у DashPlayer инверсия — 86.5% старше года (Q2).
--
-- Все запросы прогнаны на admin-подключении 2026-07-18/19; тайминги в комментах.
-- Подстановка параметров: строки, помеченные -- PARAM.
-- ============================================================================


-- ============================================================================
-- Q1 (а) — Таймлайн звёзд по дням + окно аномалии
-- ----------------------------------------------------------------------------
-- Что показывает: дневную кривую звёзд репо; колонка in_anomaly_window
-- размечает окно кампании (для timeline-компонента → anomalyWindow).
-- Что ожидать (DashPlayer): январь-апрель 0-5 звёзд/день, 2024-05-17 — 300,
-- 2024-05-22 — 227; за май 1377 звёзд при 5 за янв+фев вместе.
-- Для grok-1 (замени repo/даты): 03-17 → 2452, 03-18 → 20150, дальше распад
-- 9403 → 4704 → 1861 → 963 — органика падает по экспоненте, накрутка держит полку.
-- Тайминг: ~0.3 s.
-- ============================================================================
SELECT
    toDate(created_at) AS day,
    count() AS stars,
    day BETWEEN '2024-05-15' AND '2024-05-25' AS in_anomaly_window,   -- PARAM окно
    bar(count(), 0, 320, 40) AS viz
FROM github.github_events
WHERE event_type = 'WatchEvent'
  AND repo_name = 'solidSpoon/DashPlayer'                             -- PARAM репо
  AND created_at >= '2024-04-01' AND created_at < '2024-07-01'        -- PARAM диапазон
GROUP BY day
ORDER BY day;


-- ============================================================================
-- Q2 (б) — Профиль возраста аккаунтов на момент звезды: окно vs фон
-- ----------------------------------------------------------------------------
-- Возраст ≈ звезда минус первое событие актора в датасете (у всех звездивших
-- целевые репо в слайсе их полная Watch-история с 2011 — оценка честная).
-- Бакеты: <1 дня, 1д-1нед, 1нед-1мес, 1мес-1год, >1 года.
-- Что ожидать (фактические цифры):
--   OpenInterpreter/01  WINDOW(хвост 03-23..25): lt_1d = 0.127  (фон 0.025, x5!)
--   Zejun-Yang/AniPortrait WINDOW:               lt_1d = 0.063  (фон 0.021, x3)
--   solidSpoon/DashPlayer  WINDOW — ИНВЕРСИЯ:    lt_1d = 0.002, y1_plus = 0.865
--     (фон 0.751) — ферма состаренных аккаунтов, «слишком старые, чтобы быть
--     правдой» для узкоспециального китайского видеоплеера.
--   deepseek-ai/DeepSeek-VL WINDOW: возраст ровный (0.033 vs 0.042) — эту
--     кампанию возраст НЕ ловит, ловят Q3/Q4/Q5.
-- Тайминг: ~2.8 s.
-- ============================================================================
WITH stars AS (
    SELECT repo_name, actor_login, created_at AS star_ts,
      multiIf(
        repo_name='solidSpoon/DashPlayer'   AND toDate(created_at) BETWEEN '2024-05-15' AND '2024-05-25', 'WINDOW',
        repo_name='deepseek-ai/DeepSeek-VL' AND toDate(created_at) BETWEEN '2024-03-11' AND '2024-03-17', 'WINDOW',
        repo_name='Zejun-Yang/AniPortrait'  AND toDate(created_at) BETWEEN '2024-03-27' AND '2024-04-03', 'WINDOW',
        repo_name='OpenInterpreter/01'      AND toDate(created_at) BETWEEN '2024-03-23' AND '2024-03-25', 'WINDOW',
        'baseline') AS grp                                            -- PARAM окна
    FROM github.github_events
    WHERE event_type = 'WatchEvent'
      AND repo_name IN ('solidSpoon/DashPlayer','deepseek-ai/DeepSeek-VL',
                        'Zejun-Yang/AniPortrait','OpenInterpreter/01') -- PARAM репо
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
-- Q3 (в) — Матрица ко-старинга: что ещё звездили акторы окна (лифт)
-- ----------------------------------------------------------------------------
-- Сравнение в окне 2024-01..07 (там покрытие звёзд полное для ВСЕХ акторов):
--   suspects — звездившие репо в окне аномалии;
--   control  — 42 263 звездивших grok-1 в марте (эталон органической толпы).
-- lift = доля suspects, звездивших репо R / доля control, звездивших R.
-- Что ожидать (DashPlayer, ORDER BY lift): портфель фермы — обскурные
-- китайские утилиты с лифтом 30-50x:
--   Thisal-D/PyTube-Downloader lift 52x, unilei/aipan-netdisk-search 50x,
--   Spr-Aachen/Easy-Voice-Toolkit 48x, kangpeiqin/bilivideo_down 46x,
--   buxuku/VideoSubtitleGenerator 42x ... (5% толпы DashPlayer против 0.1%
--   толпы grok-1). Это отпечаток пула аккаунтов: одна ферма — общий портфель.
-- Для DeepSeek-VL: кластер CV-репо ELLA 28x, VisionLLaMA 24x, Bunny 22x.
-- ORDER BY s_share вместо lift показывает камуфляж: трендовые AI-репо
-- (Open-Sora 38%, OpenDevin 29%) — боты звездят тренды, чтобы выглядеть живыми.
-- Тайминг: ~4.6 s.
-- ============================================================================
WITH
suspects AS (
    SELECT DISTINCT actor_login FROM github.github_events
    WHERE event_type = 'WatchEvent'
      AND repo_name = 'solidSpoon/DashPlayer'                         -- PARAM репо
      AND toDate(created_at) BETWEEN '2024-05-15' AND '2024-05-25'    -- PARAM окно
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
  AND repo_name NOT IN ('solidSpoon/DashPlayer', 'xai-org/grok-1')    -- PARAM репо
GROUP BY repo_name
HAVING s_actors >= 25
ORDER BY lift DESC
LIMIT 20;


-- ============================================================================
-- Q4 (г) — «One-and-done» и сериальное звездение: инверсия наивного мифа
-- ----------------------------------------------------------------------------
-- Наивно ждём у ботов «звезда — единственное событие». РЕАЛЬНОСТЬ ОБРАТНАЯ:
--   one-and-done (за 2024-01..07): grok-1 органика 7.8% (живые люди-лурки!),
--   DashPlayer 0.8%, DeepSeek-VL 0.4% — у ботов ПУСТЫХ аккаунтов почти нет.
-- Зато сериальное звездение (медиана звёзд за полгода):
--   DeepSeek-VL w: 80 (!), AniPortrait w: 63, OI01 tail: 56, DashPlayer w: 51
--   против grok-1: 15. Доля звездивших 100+ репо за полгода: 32-44% против 12.6%.
--   Медиана активных дней: 33-52 против 13.
-- Ферма маскирует аккаунты непрерывным звездением всего подряд — камуфляж
-- и есть отпечаток.
-- Тайминг: ~4.1 s (самый тяжёлый; для drill материализовать в scratch).
-- ============================================================================
WITH grp_stars AS (
    SELECT DISTINCT actor_login,
      multiIf(
        repo_name='solidSpoon/DashPlayer'   AND toDate(created_at) BETWEEN '2024-05-15' AND '2024-05-25', 'DashPlayer w',
        repo_name='deepseek-ai/DeepSeek-VL' AND toDate(created_at) BETWEEN '2024-03-11' AND '2024-03-17', 'DeepSeekVL w',
        repo_name='Zejun-Yang/AniPortrait'  AND toDate(created_at) BETWEEN '2024-03-27' AND '2024-04-03', 'AniPortrait w',
        repo_name='OpenInterpreter/01'      AND toDate(created_at) BETWEEN '2024-03-23' AND '2024-03-25', 'OI01 tail',
        repo_name='xai-org/grok-1'          AND toDate(created_at) BETWEEN '2024-03-16' AND '2024-03-31', 'grok-1 organic',
        NULL) AS grp                                                  -- PARAM группы
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
-- Q5 (д) — Burst-метрики: пик, полка, доля топ-дня
-- ----------------------------------------------------------------------------
-- burst_ratio (max день / медиана активного дня) ловит АНОМАЛИЮ, но не
-- отличает фрод от виральности: grok-1 610x (!), OI01 149x, LaVague 89x.
-- Отличает ФОРМА — days_above_half_peak (дней с >=50% пика):
--   deepseek-ai/DeepSeek-VL: 5 дней полки (192-223 звёзд/день) — прямоугольник,
--   дрип-кампания «по квоте в день»; AniPortrait/OI01: 3; grok-1: 1 (пик+распад).
-- Фактура: grok-1 top_day_share 0.435 (20 150 из 46 316 звёзд за один день),
-- DashPlayer peak 300 (2024-05-17) при медиане активного дня 5.
-- Тайминг: ~0.4 s.
-- ============================================================================
WITH daily AS (
    SELECT repo_name, toDate(created_at) AS day, count() AS stars
    FROM github.github_events
    WHERE event_type = 'WatchEvent'
      AND repo_name IN ('lavague-ai/LaVague','Zejun-Yang/AniPortrait',
                        'deepseek-ai/DeepSeek-VL','solidSpoon/DashPlayer',
                        'OpenInterpreter/01','xai-org/grok-1')        -- PARAM репо
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
       countIf(d.stars >= 0.5 * p.peak) AS days_above_half_peak     -- полка = фрод
FROM daily d
JOIN peaks p USING (repo_name)
GROUP BY d.repo_name
ORDER BY days_above_half_peak DESC;


-- ============================================================================
-- Q6 (е) — Почасовой профиль звёзд в окне аномалии
-- ----------------------------------------------------------------------------
-- hourly_cv = stddev/avg по 24 часовым корзинам; min_over_avg — «дышит ли ночь».
-- Что ожидать:
--   grok-1 organic:  cv 0.50 — глобальная волна часовых поясов, суточный ритм;
--   DeepSeekVL w:    cv 0.38, min 28% от среднего — звёзды капают КРУГЛОСУТОЧНО
--                    ровнее органики (автоматика без сна);
--   AniPortrait w:   cv 0.39 — та же ровная подача;
--   DashPlayer w:    cv 0.66, min 6% — ферма-«дневная смена»: часы 18-23 UTC
--                    (2-7 утра в Китае) мертвы (8,9,6,3,11,26 звёзд), пик в
--                    китайский рабочий день. Два разных почерка ферм!
-- hours_utc отдаёт 24 числа — готовые данные для heatmap-компонента.
-- Тайминг: ~1.2 s.
-- ============================================================================
WITH hourly AS (
    SELECT
      multiIf(
        repo_name='solidSpoon/DashPlayer'   AND toDate(created_at) BETWEEN '2024-05-15' AND '2024-05-25', 'DashPlayer w',
        repo_name='deepseek-ai/DeepSeek-VL' AND toDate(created_at) BETWEEN '2024-03-11' AND '2024-03-17', 'DeepSeekVL w',
        repo_name='Zejun-Yang/AniPortrait'  AND toDate(created_at) BETWEEN '2024-03-27' AND '2024-04-03', 'AniPortrait w',
        repo_name='xai-org/grok-1'          AND toDate(created_at) BETWEEN '2024-03-16' AND '2024-03-31', 'grok-1 organic',
        NULL) AS grp,                                                 -- PARAM группы
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
-- Q7 (бонус) — Пересечение окон кампаний: одна ферма, разные клиенты
-- ----------------------------------------------------------------------------
-- Сколько акторов звездили в окнах ДВУХ разных кампаний, и лифт против
-- контроля grok-1. Фактические цифры (все пары окон):
--   AniPortrait∩OI01 213, LaVague∩OI01 194, AniPortrait∩DeepSeekVL 170,
--   DeepSeekVL∩OI01 133, DeepSeekVL∩LaVague 123, AniPortrait∩LaVague 120.
-- Ключевой лифт: P(звезда AniPortrait в её окне | толпа DeepSeekVL w) = 15.3%
-- против 1.4% у толпы grok-1 → лифт 10.7x. Пять несвязанных репо, одни руки.
-- Также: 1 514 акторов звездили 2+ целевых репо, 68 — четыре-пять из пяти.
-- Тайминг: ~2.6 s.
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
