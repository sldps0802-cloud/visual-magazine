-- 에디터가 사건 타임라인을 직접 수정/추가/삭제하고, 글 단위로 아예 끌 수 있게 한다.
--
-- 1) posts.timeline_disabled -- 이 기사에는 타임라인이 필요 없다고 에디터가 판단하면
--    켜는 스위치. post.html이 이 값을 보고 자동생성 결과가 있어도 렌더링을 건너뛴다.
--    posts는 이미 is_approved_editor() update 정책이 있어서 새 정책 없이 바로 켤 수 있음.
alter table posts add column if not exists timeline_disabled boolean not null default false;

-- 2) post_timeline은 지금까지 공개 조회 정책만 있고 쓰기 정책이 아예 없었다(자동생성은
--    edge function이 service_role로 RLS를 우회해서 씀) -- 에디터가 관리자 패널에서 직접
--    행을 추가/수정/삭제하려면 로그인 세션(anon key + JWT)으로 쓰는 경로가 필요하다.
create policy "editors can insert post timeline rows"
  on post_timeline for insert
  with check (is_approved_editor());
create policy "editors can update post timeline rows"
  on post_timeline for update
  using (is_approved_editor());
create policy "editors can delete post timeline rows"
  on post_timeline for delete
  using (is_approved_editor());
