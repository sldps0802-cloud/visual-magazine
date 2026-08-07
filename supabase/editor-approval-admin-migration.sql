-- 에디터 가입 승인을 "관리자만" 할 수 있게 조인다.
--
-- 배경: editor_approvals 테이블과 is_approved_editor()를 만든 최초 마이그레이션이
-- 저장소에 없다(Supabase SQL 편집기에서 직접 실행하고 커밋 안 됨). 그래서 이 파일은
-- 테이블을 새로 만들지 않고 "정책만" 고친다 -- 구조를 건드리면 이미 승인된 계정이
-- 날아갈 수 있으므로 절대 drop/recreate 하지 않는다.
--
-- Supabase SQL Editor에서 그대로 실행하면 된다. 여러 번 실행해도 안전(멱등).

-- 1) 관리자 표시용 칸. 이메일/UID를 저장소에 남기지 않으려고 컬럼으로 둔다.
alter table editor_approvals add column if not exists is_admin boolean not null default false;

-- 2) 아직 관리자가 아무도 없으면 "가장 먼저 승인된 계정"을 관리자로 세운다.
--    이 줄이 없으면 정책을 조인 순간 아무도 승인을 못 해서 스스로 잠기게 된다.
update editor_approvals
   set is_admin = true
 where approved
   and not exists (select 1 from editor_approvals where is_admin)
   and user_id = (
     select user_id from editor_approvals
      where approved
      order by approved_at nulls first, user_id
      limit 1
   );

-- 3) 지금 로그인한 사람이 관리자인가.
--    security definer라야 정책 안에서 자기 테이블을 다시 읽을 때 재귀에 안 걸린다.
create or replace function is_card_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from editor_approvals
     where user_id = auth.uid() and approved and is_admin
  );
$$;

grant execute on function is_card_admin() to anon, authenticated;

-- 4) 대기 목록 열람·승인·거절은 관리자만.
--    (본인 행은 가입 직후 화면에서 필요하므로 자기 것은 계속 볼 수 있게 둔다.)
drop policy if exists "approved editors can read approvals" on editor_approvals;
drop policy if exists "editor approvals are viewable by editors" on editor_approvals;
drop policy if exists "admin reads approvals" on editor_approvals;
create policy "admin reads approvals"
  on editor_approvals for select
  using (is_card_admin() or user_id = auth.uid());

drop policy if exists "approved editors can update approvals" on editor_approvals;
drop policy if exists "editors can approve" on editor_approvals;
drop policy if exists "admin approves" on editor_approvals;
create policy "admin approves"
  on editor_approvals for update
  using (is_card_admin())
  with check (is_card_admin());

drop policy if exists "admin rejects" on editor_approvals;
create policy "admin rejects"
  on editor_approvals for delete
  using (is_card_admin());

-- 참고: 가입 시 본인 행을 넣는 insert 정책은 기존 것을 그대로 둔다(건드리면 가입이 막힌다).

-- 확인용:
--   select user_id, username, approved, is_admin from editor_approvals order by is_admin desc;
--   select is_card_admin();
