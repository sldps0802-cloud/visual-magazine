-- 글쓰기(작성/수정/삭제)를 관리자 한 명으로 제한
-- 'YOUR-ADMIN-UID' 부분을 실제 관리자 계정의 UID로 바꿔서 실행하세요.
-- UID 확인: Supabase 대시보드 > Authentication > Users > 계정 클릭 > User UID 복사
-- (이메일 대신 UID를 쓰는 이유: 이메일은 개인정보라 공개 저장소에 남기지 않기 위해)

drop policy if exists "authenticated users can insert their own posts" on posts;
create policy "only admin can insert posts"
  on posts for insert
  with check (auth.uid() = 'YOUR-ADMIN-UID');

drop policy if exists "users can update their own posts" on posts;
create policy "only admin can update posts"
  on posts for update
  using (auth.uid() = 'YOUR-ADMIN-UID');

drop policy if exists "users can delete their own posts" on posts;
create policy "only admin can delete posts"
  on posts for delete
  using (auth.uid() = 'YOUR-ADMIN-UID');
