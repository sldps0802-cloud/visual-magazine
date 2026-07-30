-- 댓글 모더레이션: 링크 포함 댓글은 자동 숨김(hidden), 에디터 사이트에서 검토/해제/삭제 가능하게.
-- editor-approval-migration.sql의 is_approved_editor()를 그대로 재사용 -- posts와 같은 잣대로
-- "승인된 에디터"만 댓글도 관리할 수 있게 (관리자 이메일 하나만 하드코딩하지 않음).

alter table comments add column if not exists hidden boolean not null default false;
alter table comments add column if not exists hidden_reason text; -- 'link' | 'manual' | null

-- 공개 조회는 숨김 아닌 것만. 기존 "누구나 읽기 가능" 정책을 이걸로 교체.
drop policy if exists "comments are viewable by everyone" on comments;
create policy "visible comments are viewable by everyone"
  on comments for select
  using (hidden = false);

-- 승인된 에디터는 숨김 포함 전부 조회/수정(숨김 해제 등)/삭제 가능.
-- PostgreSQL의 permissive 정책은 OR로 합쳐지므로, 위 공개 정책과 공존해도
-- 일반 방문자는 여전히 hidden=false만 보임 (auth.email()/에디터 조건을 못 만족하니까).
create policy "approved editors can view all comments"
  on comments for select
  using (is_approved_editor());

create policy "approved editors can update comments"
  on comments for update
  using (is_approved_editor());

create policy "approved editors can delete comments"
  on comments for delete
  using (is_approved_editor());
