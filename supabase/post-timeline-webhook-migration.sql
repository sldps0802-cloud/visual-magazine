-- 글이 posts 테이블에 INSERT되는 순간 자동으로 타임라인 생성을 트리거한다(관리자 패널이든
-- AI 에디터든 어떤 경로로 올라오든 잡아냄). Supabase 대시보드의 "Database Webhooks" 기능도
-- 결국 이 방식(pg_net 확장 + DB 트리거로 HTTP 요청)을 그대로 쓰는 거라, 대시보드에서 폼을
-- 채우는 대신 SQL로 직접 만든다.
--
-- 'YOUR-CRON-SECRET' 부분을 실제 CRON_SECRET 값으로 바꿔서 실행하세요
-- (Supabase 대시보드 → Edge Functions → Secrets에서 확인).

create extension if not exists pg_net;

create or replace function public.notify_post_timeline() returns trigger as $$
begin
  perform net.http_post(
    url := 'https://qvsptsspvbzjukjbdwdj.supabase.co/functions/v1/super-action',
    body := jsonb_build_object(
      'type', 'INSERT',
      'table', 'posts',
      'record', jsonb_build_object('id', new.id, 'title', new.title, 'created_at', new.created_at)
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_Wn9BkVEmKZgSq0uicBVx5A_Zevwunor',
      'Authorization', 'Bearer sb_publishable_Wn9BkVEmKZgSq0uicBVx5A_Zevwunor',
      'x-cron-secret', 'YOUR-CRON-SECRET'
    ),
    timeout_milliseconds := 5000
  );
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists post_timeline_on_insert on public.posts;
create trigger post_timeline_on_insert
  after insert on public.posts
  for each row
  execute function public.notify_post_timeline();

-- 위 트리거는 "앞으로 올라올 글"만 잡는다. 이미 있는 글들(post_timeline_status에 아직
-- 없는 글)을 지금 채워 넣기 위해, 기존에 만들어둔 refresh-coverage 액션을 한 번 호출한다
-- -- 이 액션은 이미 한 번에 최대 3개 글까지만 처리하도록 예산이 걸려 있어서(150초 타임아웃
-- 방지), 여러 번 실행해도 안전하다. 글이 3개보다 많이 밀려 있으면 이 select문을 몇 번 더
-- 실행하세요(한 번 실행할 때마다 3개씩 처리됨).
select net.http_post(
  url := 'https://qvsptsspvbzjukjbdwdj.supabase.co/functions/v1/super-action',
  body := jsonb_build_object('action', 'refresh-coverage'),
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'apikey', 'sb_publishable_Wn9BkVEmKZgSq0uicBVx5A_Zevwunor',
    'Authorization', 'Bearer sb_publishable_Wn9BkVEmKZgSq0uicBVx5A_Zevwunor',
    'x-cron-secret', 'YOUR-CRON-SECRET'
  ),
  timeout_milliseconds := 30000
);
