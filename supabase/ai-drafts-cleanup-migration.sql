-- AI가 쓴 초안(ai_drafts)은 사람이 30시간 안에 검토(게시/반려)하지 않으면 자동으로
-- 지운다 -- 오래된 미검토 초안이 계속 쌓여서 검토 목록을 어지럽히는 걸 막는다.
-- 이미 게시(published)되었거나 반려(dismissed)된 건 건드리지 않는다 -- status가
-- 여전히 'pending'인 것만 대상이다.
--
-- Supabase Cron(pg_cron 확장)으로 매시 정각에 돈다 -- 사이트 방문이나 수동 호출과
-- 무관하게 항상 제때 지워지도록, DB 안에서 스스로 도는 방식을 썼다.
create extension if not exists pg_cron;

select cron.unschedule('cleanup-stale-ai-drafts')
where exists (select 1 from cron.job where jobname = 'cleanup-stale-ai-drafts');

select cron.schedule(
  'cleanup-stale-ai-drafts',
  '0 * * * *',
  $$ delete from ai_drafts where status = 'pending' and created_at < now() - interval '30 hours'; $$
);
