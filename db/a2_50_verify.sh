#!/usr/bin/env bash
# A2 step 5: verification — row counts by type, slice date window, and the
# fake-star spike timeline for each target repo.
source "$(dirname "${BASH_SOURCE[0]}")/a2_lib.sh"

echo "=== rows by event_type ==="
a2_ch "SELECT event_type, count() AS rows, uniqExact(repo_name) AS repos
       FROM ${A2_TARGET} GROUP BY event_type ORDER BY rows DESC
       FORMAT PrettyCompactMonoBlock" "&default_format=PrettyCompactMonoBlock"
echo
echo "=== total rows / date window ==="
a2_ch "SELECT count() AS total, min(created_at) AS min_ts, max(created_at) AS max_ts
       FROM ${A2_TARGET} FORMAT PrettyCompactMonoBlock" "&default_format=PrettyCompactMonoBlock"
echo
echo "=== duplicate check (should be 0) ==="
a2_ch "SELECT count() - uniqExact(event_type, repo_name, actor_login, created_at, comment_id, number) AS dupes
       FROM ${A2_TARGET} FORMAT PrettyCompactMonoBlock" "&default_format=PrettyCompactMonoBlock"
echo
echo "=== monthly star timeline per target repo (spike must be visible) ==="
a2_ch "SELECT repo_name, toStartOfMonth(created_at) AS month, count() AS stars,
              bar(count(), 0, 3500, 40) AS viz
       FROM ${A2_TARGET}
       WHERE event_type = 'WatchEvent' AND repo_name IN (${A2_REPOS_SQL})
         AND created_at >= '2023-10-01' AND created_at < '2025-01-01'
       GROUP BY repo_name, month ORDER BY repo_name, month
       FORMAT PrettyCompactMonoBlock" "&default_format=PrettyCompactMonoBlock"
echo
echo "=== daily star timeline, DashPlayer campaign (2024-05) ==="
a2_ch "SELECT toDate(created_at) AS day, count() AS stars, bar(count(), 0, 400, 40) AS viz
       FROM ${A2_TARGET}
       WHERE event_type = 'WatchEvent' AND repo_name = 'solidSpoon/DashPlayer'
         AND created_at >= '2024-04-15' AND created_at < '2024-06-15'
       GROUP BY day ORDER BY day
       FORMAT PrettyCompactMonoBlock" "&default_format=PrettyCompactMonoBlock"
echo
echo "=== low-activity-actor share among stargazers of target repos ==="
a2_ch "WITH actor_stars AS (
         SELECT actor_login, count() AS n_stars
         FROM ${A2_TARGET} WHERE event_type = 'WatchEvent'
           AND actor_login IN (${A2_ACTORS_SUBQ})
         GROUP BY actor_login)
       SELECT r.repo_name,
              count() AS stargazers,
              countIf(a.n_stars <= 2) AS low_activity,
              round(countIf(a.n_stars <= 2) / count(), 3) AS share
       FROM (SELECT DISTINCT repo_name, actor_login FROM ${A2_TARGET}
             WHERE event_type = 'WatchEvent' AND repo_name IN (${A2_REPOS_SQL})) r
       LEFT JOIN actor_stars a USING (actor_login)
       GROUP BY r.repo_name ORDER BY share DESC
       FORMAT PrettyCompactMonoBlock" "&default_format=PrettyCompactMonoBlock"
