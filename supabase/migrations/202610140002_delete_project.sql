begin;
-- Serialize deletion with writes; reject late writes to removed parents.
create or replace function public.pp_check_parent()
returns trigger language plpgsql set search_path=public as $$
begin
 if new.kind in ('version','case','suite','run') and not exists(
  select 1 from pp_entities where kind='project' and id=new.data->>'project_id'
 ) then raise exception '项目不存在或已删除'; end if;
 if new.kind in ('result','review') and not exists(
  select 1 from pp_entities where kind='run' and id=new.data->>'run_id'
 ) then raise exception '评测记录不存在或已删除'; end if;
 return new;
end $$;
drop trigger if exists pp_parent_guard on public.pp_entities;
create trigger pp_parent_guard before insert or update on public.pp_entities
 for each row execute function public.pp_check_parent();

create or replace function public.pp_delete_project(p_id text,p_name text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare project_data jsonb; run_ids text[]; removed integer;
begin
 perform pg_advisory_xact_lock(81237645);
 lock table pp_entities in share row exclusive mode;
 select data into project_data from pp_entities where kind='project' and id=p_id;
 if project_data is null then raise exception '项目不存在或已删除'; end if;
 if p_name is distinct from project_data->>'name' then raise exception '项目名称不匹配，未删除'; end if;
 select coalesce(array_agg(id),array[]::text[]) into run_ids from pp_entities where kind='run' and data->>'project_id'=p_id;
 if exists(select 1 from pp_entities where id=any(run_ids) and data->>'status'='running')
 or exists(select 1 from pp_jobs where run_id=any(run_ids) and state in ('pending','running'))
 then raise exception '项目有评测正在运行，请等待完成后再删除'; end if;
 delete from pp_jobs where run_id=any(run_ids);
 delete from pp_entities where
  (kind in ('result','review') and data->>'run_id'=any(run_ids))
  or (kind in ('version','case','suite','run') and data->>'project_id'=p_id)
  or (kind='project' and id=p_id);
 get diagnostics removed=row_count;
 return jsonb_build_object('ok',true,'deleted_records',removed);
end $$;
revoke all on function public.pp_delete_project(text,text) from public,anon,authenticated;
grant execute on function public.pp_delete_project(text,text) to service_role;
commit;
