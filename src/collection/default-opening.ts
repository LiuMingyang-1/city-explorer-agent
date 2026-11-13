import type{Schedule}from"../data/schedule.ts";
export const DEFAULT_ATTRACTION_HOURS_NOTE="默认开放时间：每天09:00–17:00（非来源确认，按项目默认规则用于规划）";
export function defaultAttractionSchedule():Schedule{return{timezone:"Asia/Shanghai",mode:"weekly",weekly:[{weekdays:[1,2,3,4,5,6,7],windows:[{start:"09:00",end:"17:00"}]}],note:DEFAULT_ATTRACTION_HOURS_NOTE};}
export function isDefaultAttractionSchedule(s:Schedule|null|undefined):boolean{return !!s&&JSON.stringify(s)===JSON.stringify(defaultAttractionSchedule());}
export const DEFAULT_ATTRACTION_BUDGET_CENTS=2000;
export function applyDefaultAttractionBudget(value:Record<string,any>):boolean{
  if(value.record_type!=="attraction"||value.budget_min!=null||value.budget_max!=null)return false;
  value.budget_min=DEFAULT_ATTRACTION_BUDGET_CENTS;value.budget_max=DEFAULT_ATTRACTION_BUDGET_CENTS;
  value.budget_note=["默认预算：每人20元（项目默认估算，非已核实门票）",value.budget_note].filter(Boolean).join("\n");return true;
}
/** User-approved planning fallback, never a claim of verified venue hours. */
export function applyDefaultAttractionHours(value:Record<string,any>,source=""):boolean{
  if(value.record_type!=="attraction"||["paused","cancelled","past","ended"].includes(value.status)||value.time_status==="conflicting")return false;
  if(value.valid_from||value.valid_to||value.start_at||value.end_at)return false;
  let schedule=value.schedule_json;try{if(typeof schedule==="string")schedule=JSON.parse(schedule);}catch{return false;}
  if(schedule&&schedule.mode!=="unknown")return false;
  const text=source+"\n"+(value.time_note??"");
  if(/\d{1,2}[:：]\d{2}|\d{1,2}[点时]|24小时|全天|全年无休|冬季|夏季|春季|秋季|寒暑假|闭馆|暂停|每周|周[一二三四五六日天]/.test(text))return false;
  value.schedule_json=defaultAttractionSchedule();value.time_status="partial";
  value.time_note=[value.time_note,DEFAULT_ATTRACTION_HOURS_NOTE].filter(Boolean).join("\n");return true;
}
