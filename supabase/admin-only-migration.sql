-- 글쓰기(작성/수정/삭제)를 관리자 이메일 한 명으로 제한
-- 'sldps0802@gmail.com' 부분을 실제 관리자 계정 이메일로 바꿔서 실행하세요.

drop policy if exists "authenticated users can insert their own posts" on posts;
create policy "only admin can insert posts"
  on posts for insert
  with check (auth.email() = 'sldps0802@gmail.com');

drop policy if exists "users can update their own posts" on posts;
create policy "only admin can update posts"
  on posts for update
  using (auth.email() = 'sldps0802@gmail.com');

drop policy if exists "users can delete their own posts" on posts;
create policy "only admin can delete posts"
  on posts for delete
  using (auth.email() = 'sldps0802@gmail.com');
