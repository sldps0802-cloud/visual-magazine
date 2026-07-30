-- AI 에디터(vcompany7/ai_editor.py)가 쓴 기사 초안. 절대 바로 발행되지 않는다 --
-- 승인된 에디터가 write.html에서 읽어보고 수정한 뒤 기존 게시 버튼으로 직접
-- posts에 올려야 실제로 사이트에 뜬다(is_approved_editor()는 editor-approval-migration.sql
-- 참고, 먼저 실행돼 있어야 함).

create table ai_drafts (
  id bigint generated always as identity primary key,
  title text not null,
  body text not null,
  source_url text,
  source_title text,
  status text not null default 'pending' check (status in ('pending','published','dismissed')),
  created_at timestamptz not null default now()
);
alter table ai_drafts enable row level security;

-- 승인된 에디터만 초안을 보고(대기열), 상태를 바꿀 수 있다(발행함/무시함 표시).
create policy "approved editors can view ai drafts"
  on ai_drafts for select
  using (is_approved_editor());

create policy "approved editors can update ai drafts"
  on ai_drafts for update
  using (is_approved_editor());

-- insert 정책은 없다 -- ai_editor.py가 service_role 키로만 쓴다(사람도 API로도
-- 초안을 몰래 끼워넣을 수 없게).
