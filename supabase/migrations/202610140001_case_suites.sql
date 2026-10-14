-- Compatible update: preserves all cases, results and reviews.
begin;
alter table public.pp_entities drop constraint if exists pp_entities_kind_check;
alter table public.pp_entities add constraint pp_entities_kind_check
  check(kind in ('project','version','case','model','run','result','review','suite'));
create unique index if not exists pp_suite_name
  on public.pp_entities ((data->>'project_id'),(data->>'name')) where kind='suite';
insert into public.pp_entities(id,kind,data)
select 'suite-'||md5(jsonb_build_array(project_id,name)::text),'suite',
 jsonb_build_object('id','suite-'||md5(jsonb_build_array(project_id,name)::text),
 'project_id',project_id,'name',name,'created_at',now())
from (select distinct data->>'project_id' project_id,data->>'suite' name
 from public.pp_entities where kind='case' and length(data->>'suite')>0) s
on conflict do nothing;
create or replace function public.pp_ensure_suite(p_project text,p_name text,p_fail_duplicate boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare existing jsonb; result jsonb; new_id text;
begin
 if p_name is null or length(btrim(p_name))=0 or length(p_name)>150 then raise exception '测试集名称必须为 1 至 150 个字符'; end if;
 if not exists(select 1 from pp_entities where id=p_project and kind='project') then raise exception '项目不存在'; end if;
 perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_project,p_name)::text,0));
 select data into existing from pp_entities where kind='suite' and data->>'project_id'=p_project and data->>'name'=p_name;
 if existing is not null then
  if p_fail_duplicate then raise exception '项目内测试集名称不能重复'; end if;
  return existing;
 end if;
 new_id:=replace(gen_random_uuid()::text,'-','');
 result:=jsonb_build_object('id',new_id,'project_id',p_project,'name',p_name,'created_at',now());
 insert into pp_entities(id,kind,data) values(new_id,'suite',result);
 return result;
end $$;
revoke all on function public.pp_ensure_suite(text,text,boolean) from public,anon,authenticated;
grant execute on function public.pp_ensure_suite(text,text,boolean) to service_role;
commit;
